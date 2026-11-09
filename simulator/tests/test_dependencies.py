"""The installed packages are the locked ones, and pg8000 signs in as it must to CloudNativePG.

CloudNativePG accepts SSL and offers SCRAM-SHA-256-PLUS, so every connection takes pg8000's TLS and channel-binding
path, which depends on scramp's API. An unlocked scramp once broke that path in the image while every other test passed.
"""

from __future__ import annotations

import re
import socket
import ssl
import struct
import threading
import tomllib
from importlib import metadata
from pathlib import Path

import scramp
import trustme

from cdp_sim.db import Database

SIMULATOR = Path(__file__).parents[1]
LOCK = SIMULATOR / "requirements.lock"
PASSWORD = "test-only"
SSL_REQUEST = 80877103


def locked_pins() -> dict[str, str]:
    return dict(re.findall(r"^([A-Za-z0-9._-]+)==(\S+)", LOCK.read_text(encoding="utf-8"), re.MULTILINE))


def test_every_direct_dependency_is_pinned_in_the_lock_at_the_same_version():
    project = tomllib.loads((SIMULATOR / "pyproject.toml").read_text(encoding="utf-8"))["project"]
    pins = locked_pins()
    for requirement in project["dependencies"]:
        name, version = requirement.split("==")
        assert pins.get(name) == version, f"{requirement} differs from requirements.lock"


def test_the_installed_packages_are_the_locked_versions():
    installed = {name: metadata.version(name) for name in locked_pins()}
    assert installed == locked_pins()


def _recv(sock: socket.socket, size: int) -> bytes:
    data = b""
    while len(data) < size:
        chunk = sock.recv(size - len(data))
        if not chunk:
            raise ConnectionError("client closed the connection")
        data += chunk
    return data


def _read_message(sock: socket.socket) -> bytes:
    (length,) = struct.unpack("!i", _recv(sock, 5)[1:])
    return _recv(sock, length - 4)


def _message(code: bytes, payload: bytes) -> bytes:
    return code + struct.pack("!i", len(payload) + 4) + payload


def _auth(code: int, payload: bytes = b"") -> bytes:
    return _message(b"R", struct.pack("!i", code) + payload)


def _serve_one_sign_in(listener: socket.socket, certificate: trustme.LeafCert, seen: dict) -> None:
    try:
        connection, _ = listener.accept()
        with connection:
            _, request = struct.unpack("!ii", _recv(connection, 8))
            seen["ssl_request"] = request == SSL_REQUEST
            connection.sendall(b"S")
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            certificate.configure_cert(context)
            with context.wrap_socket(connection, server_side=True) as tls:
                (length,) = struct.unpack("!i", _recv(tls, 4))
                _recv(tls, length - 4)
                tls.sendall(_auth(10, b"SCRAM-SHA-256-PLUS\0SCRAM-SHA-256\0\0"))

                mechanism_name, initial = _read_message(tls).split(b"\0", 1)
                seen["mechanism"] = mechanism_name.decode()
                mechanism = scramp.ScramMechanism(seen["mechanism"])
                auth_info = mechanism.make_auth_info(PASSWORD)
                leaf_pem = certificate.cert_chain_pems[0].bytes().decode()
                server = mechanism.make_server(
                    lambda _username: auth_info, channel_binding=("tls-server-end-point", leaf_pem)
                )
                server.set_client_first(initial[4:].decode())
                tls.sendall(_auth(11, server.get_server_first().encode()))
                server.set_client_final(_read_message(tls).decode())
                tls.sendall(_auth(12, server.get_server_final().encode()) + _auth(0) + _message(b"Z", b"I"))
                seen["signed_in"] = True
                _read_message(tls)
    except Exception as error:
        seen["error"] = repr(error)


def test_connects_over_tls_with_scram_channel_binding_as_cloudnativepg_requires(monkeypatch):
    with socket.create_server(("127.0.0.1", 0)) as listener:
        listener.settimeout(10)
        seen: dict = {}
        certificate = trustme.CA().issue_cert("localhost")
        server = threading.Thread(target=_serve_one_sign_in, args=(listener, certificate, seen), daemon=True)
        server.start()
        monkeypatch.setenv("PGHOST", "127.0.0.1")
        monkeypatch.setenv("PGPORT", str(listener.getsockname()[1]))
        monkeypatch.setenv("PGDATABASE", "app")
        monkeypatch.setenv("PGUSER", "sim")
        monkeypatch.setenv("PGPASSWORD", PASSWORD)

        Database.connect(writable=True).close()
        server.join(10)

    assert seen == {"ssl_request": True, "mechanism": "SCRAM-SHA-256-PLUS", "signed_in": True}
