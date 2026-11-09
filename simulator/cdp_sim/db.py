"""Postgres, read with the standard libpq variables PGHOST, PGPORT, PGDATABASE, PGUSER, and PGPASSWORD.

The Job fills them from the CloudNativePG app secret. Every session a run opens is read-only, so a run never writes a
row. Only clean-up opens a writable session, and only after the engineer asks it to apply.
"""

from __future__ import annotations

import os

import pg8000.native


class Database:
    def __init__(self, connection: pg8000.native.Connection) -> None:
        self._connection = connection

    @classmethod
    def connect(cls, writable: bool = False) -> Database:
        env = os.environ
        missing = [name for name in ("PGHOST", "PGDATABASE", "PGUSER", "PGPASSWORD") if not env.get(name)]
        if missing:
            raise RuntimeError(f"Postgres: {', '.join(missing)} not set")
        connection = pg8000.native.Connection(
            user=env["PGUSER"],
            password=env["PGPASSWORD"],
            host=env["PGHOST"],
            port=int(env.get("PGPORT", "5432")),
            database=env["PGDATABASE"],
            application_name="cdp-sim",
            timeout=30,
        )
        if not writable:
            connection.run("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY")
        return cls(connection)

    def rows(self, sql: str, **params: object) -> list[dict]:
        result = self._connection.run(sql, **params)
        names = [column["name"] for column in self._connection.columns or []]
        return [dict(zip(names, row)) for row in result or []]

    def execute(self, sql: str, **params: object) -> int:
        self._connection.run(sql, **params)
        return self._connection.row_count

    def close(self) -> None:
        self._connection.close()
