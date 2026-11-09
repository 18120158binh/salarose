"""Studio's own interfaces, called the way studio's pages call them (SIM-FR-17).

The service account signs in through the staff identity provider's classic hosted sign-in page, with a cookie-carrying
HTTP client and no browser (SIM-NFR-07). Studio runs the PKCE flow on its own server, so the client only carries
cookies through the redirects and posts the provider's form. Catalog and publish operations are Next.js server
actions. Their ids change with every studio build, so the client reads them from studio's client bundles after
sign-in. Both depend on markup outside this repository (the contract's Risks section): a change there fails
preparation, and the run stops before it sends anything.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from html.parser import HTMLParser
from urllib.parse import parse_qs, urljoin, urlparse

import requests

SESSION_COOKIE = "cdp_admin_session"
LOGIN_ROUTE = "/api/auth/oidc/login?provider=default"
# The pages whose client bundles import the actions the simulator calls. A builder page renders for any id.
DISCOVERY_PAGES = ("/admin/events", "/campaign", "/campaign/sim_discovery")
CHUNK_URL = re.compile(r"/_next/static/chunks/[A-Za-z0-9_.\-/]+\.js")
# A client reference as the bundler emits it: createServerReference("<id>", callServer, void 0, findSourceMapURL, "<name>").
SERVER_REFERENCE = re.compile(r'createServerReference\)?\(\s*"([0-9a-f]{40,})"\s*,[^;"]*?,\s*"([A-Za-z_$][\w$]*)"\s*\)')
MAX_REDIRECTS = 10
TIMEOUT_S = 20


class StudioError(Exception):
    """A step against studio or the identity provider failed. The message never holds a credential."""


@dataclass(frozen=True)
class ServiceAccount:
    user: str
    password: str = field(repr=False)


def service_account(secret_id: str, entry: str) -> ServiceAccount:
    """The service account's sign-in, read at run time from Secrets Manager with the pod's node role."""
    import boto3

    try:
        secret = boto3.client("secretsmanager").get_secret_value(SecretId=secret_id)
        login = json.loads(secret["SecretString"])[entry]
        return ServiceAccount(user=login["user"], password=login["password"])
    except Exception as error:  # noqa: BLE001  A boto3, JSON, or key error. Name its type only: the text may quote the secret.
        raise StudioError(f"service account: could not read entry {entry} of secret {secret_id} ({type(error).__name__})") from None


@dataclass(frozen=True)
class LoginForm:
    action: str
    hidden: dict[str, str]


class _FormParser(HTMLParser):
    """Collects the first form that has a password input: its action and its hidden inputs, first value per name."""

    def __init__(self) -> None:
        super().__init__()
        self.forms: list[tuple[str, dict[str, str], set[str]]] = []
        self._open = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = {name: value or "" for name, value in attrs}
        if tag == "form":
            self.forms.append((values.get("action", ""), {}, set()))
            self._open = True
        elif tag == "input" and self._open:
            _, hidden, names = self.forms[-1]
            names.add(values.get("name", ""))
            if values.get("type", "").lower() == "hidden" and values.get("name"):
                hidden.setdefault(values["name"], values.get("value", ""))

    def handle_endtag(self, tag: str) -> None:
        if tag == "form":
            self._open = False


def parse_login_form(html: str) -> LoginForm:
    parser = _FormParser()
    parser.feed(html)
    for action, hidden, names in parser.forms:
        if {"username", "password"} <= names:
            if "_csrf" not in hidden:
                raise StudioError("sign-in: the provider's sign-in form has no _csrf field")
            return LoginForm(action=action, hidden=hidden)
    raise StudioError("sign-in: the provider's page has no sign-in form with username and password")


def chunk_urls(html: str) -> list[str]:
    """The client chunk paths a studio page names, in its script tags and in its inline flight data."""
    return list(dict.fromkeys(CHUNK_URL.findall(html)))


def server_references(script: str) -> dict[str, set[str]]:
    """Each server action a client bundle imports, by its export name, with every id that name was given."""
    found: dict[str, set[str]] = {}
    for action_id, name in SERVER_REFERENCE.findall(script):
        found.setdefault(name, set()).add(action_id)
    return found


def encode_args(args: tuple) -> str:
    """A fetch action's body for plain JSON arguments, as React's encodeReply writes it: a string that starts with $
    is escaped with one more $."""

    def escape(value: object) -> object:
        if isinstance(value, str):
            return "$" + value if value.startswith("$") else value
        if isinstance(value, dict):
            return {key: escape(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [escape(item) for item in value]
        return value

    return json.dumps(escape(list(args)), separators=(",", ":"))


def flight_rows(body: bytes) -> dict[str, object]:
    """The rows of a React Flight reply by id. A text row (`<id>:T<hex length>,<bytes>`) can hold newlines, so the
    reply is scanned by length, not split by line. A row with a one-letter tag keeps the tag in front of its JSON."""
    rows: dict[str, object] = {}
    at = 0
    while at < len(body):
        colon = body.index(b":", at)
        row_id = body[at:colon].decode()
        start = colon + 1
        if body[start:start + 1] == b"T":
            comma = body.index(b",", start)
            length = int(body[start + 1:comma], 16)
            rows[row_id] = body[comma + 1:comma + 1 + length].decode()
            at = comma + 1 + length
            continue
        end = body.find(b"\n", start)
        end = len(body) if end < 0 else end
        text = body[start:end].decode()
        tagged = text[:1].isalpha() and text[1:2] in ("{", "[", '"')
        try:
            rows[row_id] = (text[0], json.loads(text[1:])) if tagged else json.loads(text)
        except ValueError:
            rows[row_id] = text
        at = end + 1
    return rows


def action_result(body: bytes) -> object:
    """The value a fetch action returned: field `a` of the root row, with its references followed."""
    rows = flight_rows(body)

    def revive(value: object, depth: int = 0) -> object:
        if depth > 50:
            raise StudioError("action reply: references nest too deep")
        if isinstance(value, str) and value.startswith("$"):
            if value.startswith("$$"):
                return value[1:]
            if value == "$undefined":
                return None
            reference = value[2:] if value.startswith("$@") else value[1:]
            if reference in rows:
                return revive(rows[reference], depth + 1)
            return value
        if isinstance(value, dict):
            return {key: revive(item, depth + 1) for key, item in value.items()}
        if isinstance(value, list):
            return [revive(item, depth + 1) for item in value]
        return value

    for row_id, row in rows.items():
        if isinstance(row, tuple) and row[0] == "E":
            raise StudioError(f"action reply: studio threw an error in row {row_id}: {_error_text(row[1])}")
    root = rows.get("0")
    if not isinstance(root, dict) or "a" not in root:
        raise StudioError("action reply: no root row with an action result")
    return revive(root["a"])


def _error_text(error: object) -> str:
    if isinstance(error, dict):
        return str(error.get("message") or error.get("digest") or "no message")
    return str(error)


@dataclass(frozen=True)
class Action:
    name: str
    action_id: str
    page: str


class Studio:
    """A signed-in studio session."""

    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")
        self._session = requests.Session()
        self._actions: dict[str, Action] = {}

    def _follow(self, response: requests.Response) -> requests.Response:
        for _ in range(MAX_REDIRECTS):
            if response.status_code not in (301, 302, 303, 307, 308):
                return response
            target = urljoin(response.url, response.headers["Location"])
            response = self._session.get(target, allow_redirects=False, timeout=TIMEOUT_S)
        raise StudioError(f"too many redirects, last at {urlparse(response.url).netloc}{urlparse(response.url).path}")

    def sign_in(self, account: ServiceAccount) -> None:
        page = self._follow(self._session.get(self.base_url + LOGIN_ROUTE, allow_redirects=False, timeout=TIMEOUT_S))
        if page.status_code != 200:
            raise StudioError(f"sign-in: the provider's sign-in page answered HTTP {page.status_code}")
        form = parse_login_form(page.text)
        fields = {
            **form.hidden,
            "username": account.user,
            "password": account.password,
            "cognitoAsfData": "",
            "signInSubmitButton": "Sign in",
        }
        posted = self._session.post(urljoin(page.url, form.action), data=fields, allow_redirects=False, timeout=TIMEOUT_S)
        if posted.status_code == 200:
            raise StudioError(
                "sign-in: the provider showed its page again: a wrong password, or a challenge such as a new password or MFA"
            )
        landed = self._follow(posted)
        error = parse_qs(urlparse(landed.url).query).get("error")
        if error:
            raise StudioError(f"sign-in: studio refused the sign-in with {error[0]}")
        if not self._session.cookies.get(SESSION_COOKIE):
            raise StudioError(f"sign-in: no studio session after the callback (HTTP {landed.status_code})")

    def discover(self, needed: set[str]) -> None:
        """Reads the action ids from the client bundles of studio's pages. Fails naming each action it did not find."""
        scripts: dict[str, str] = {}
        ids: dict[str, set[str]] = {}
        pages: dict[str, str] = {}
        for page in DISCOVERY_PAGES:
            response = self._session.get(self.base_url + page, allow_redirects=False, timeout=TIMEOUT_S)
            if response.status_code != 200:
                raise StudioError(f"action discovery: GET {page} answered HTTP {response.status_code}")
            for chunk in chunk_urls(response.text):
                if chunk not in scripts:
                    script = self._session.get(self.base_url + chunk, timeout=TIMEOUT_S)
                    scripts[chunk] = script.text if script.ok else ""
                for name, action_ids in server_references(scripts[chunk]).items():
                    ids.setdefault(name, set()).update(action_ids)
                    pages.setdefault(name, page)
        if missing := sorted(needed - ids.keys()):
            raise StudioError(f"action discovery: studio's bundles import no action named {', '.join(missing)}")
        if ambiguous := sorted(name for name in needed if len(ids[name]) > 1):
            raise StudioError(f"action discovery: studio's bundles give more than one id to {', '.join(ambiguous)}")
        self._actions = {name: Action(name, next(iter(ids[name])), pages[name]) for name in needed}

    def call(self, name: str, *args: object) -> object:
        """Calls one server action and returns its result. An `{error}` result raises with studio's message."""
        action = self._actions.get(name)
        if action is None:
            raise StudioError(f"{name}: not discovered")
        response = self._session.post(
            self.base_url + action.page,
            data=encode_args(args).encode(),
            headers={
                "Next-Action": action.action_id,
                "Accept": "text/x-component",
                "Content-Type": "text/plain;charset=UTF-8",
                "Origin": self.base_url,
            },
            allow_redirects=False,
            timeout=TIMEOUT_S,
        )
        if response.status_code in (303, 307) and "/login" in response.headers.get("Location", ""):
            raise StudioError(f"{name}: the studio session ended")
        if response.status_code == 404 and response.headers.get("x-nextjs-action-not-found"):
            raise StudioError(f"{name}: studio no longer knows action id {action.action_id}; it was redeployed mid-run")
        if response.status_code != 200:
            raise StudioError(f"{name}: HTTP {response.status_code}")
        result = action_result(response.content)
        if isinstance(result, dict) and result.get("error"):
            raise StudioError(f"{name}: {result['error']}")
        return result
