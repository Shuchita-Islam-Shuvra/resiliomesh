from __future__ import annotations

import json
import logging
from contextlib import contextmanager
from typing import Any, Iterator

from psycopg import Connection
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .config import get_settings

log = logging.getLogger("resiliomesh.db")
_pool: ConnectionPool | None = None


def get_pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        url = get_settings().database_url
        if not url:
            raise RuntimeError("DATABASE_URL is not configured")
        _pool = ConnectionPool(
            url,
            min_size=1,
            max_size=10,
            kwargs={"row_factory": dict_row, "prepare_threshold": None},
            open=True,
            timeout=10,
        )
    return _pool


def close_pool() -> None:
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None


@contextmanager
def tx(actor_id: str | None = None, note: str | None = None) -> Iterator[Connection]:
    with get_pool().connection() as conn:
        with conn.transaction():
            if actor_id:
                conn.execute("select set_config('rm.actor', %s, true)", (str(actor_id),))
            if note:
                conn.execute("select set_config('rm.note', %s, true)", (note,))
            yield conn


def fetch_one(conn: Connection, sql: str, params: Any = None) -> dict | None:
    return conn.execute(sql, params).fetchone()


def fetch_all(conn: Connection, sql: str, params: Any = None) -> list[dict]:
    return conn.execute(sql, params).fetchall()


def as_json(value: Any) -> str:
    return json.dumps(value, default=str)
