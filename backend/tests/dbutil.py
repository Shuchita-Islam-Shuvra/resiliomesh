"""Helpers for tests that run against a real Postgres with the Supabase migrations applied.

`as_user` simulates PostgREST exactly: `set local role authenticated` + JWT claims
(sub, role, session_id, aal), so every statement goes through the same RLS policies,
triggers and RPC checks the browser hits.
"""
from __future__ import annotations

import json
import os
import random
import uuid
from contextlib import contextmanager

DSN = os.getenv("TEST_DATABASE_URL")

if DSN:
    import psycopg
    from psycopg.rows import dict_row

# auth session id per user (the `session_id` claim Supabase puts in every JWT)
SESSIONS: dict[str, str] = {}

DHAKA = (23.62, 23.93, 90.27, 90.53)        # inside the service-area box used by the DB


def raw():
    """Trusted backend connection (no JWT) = "system" context."""
    return psycopg.connect(DSN, row_factory=dict_row, autocommit=True, prepare_threshold=None)


@contextmanager
def as_user(uid, *, session: str | None = "default", aal: str = "aal1", headers: dict | None = None):
    """One transaction with the privileges of an end user (like the browser)."""
    claims = {"sub": str(uid), "role": "authenticated", "aal": aal}
    sid = SESSIONS.get(str(uid)) if session == "default" else session
    if sid:
        claims["session_id"] = sid
    with psycopg.connect(DSN, row_factory=dict_row, prepare_threshold=None) as c:
        with c.transaction():
            c.execute("set local role authenticated")
            c.execute("select set_config('request.jwt.claims', %s, true)", (json.dumps(claims),))
            if headers:
                c.execute("select set_config('request.headers', %s, true)", (json.dumps(headers),))
            yield c


def new_auth_user(c, key: str, *, email: str | None = None, meta: dict | None = None, confirmed: bool = True) -> str:
    uid = str(uuid.uuid4())
    c.execute("insert into auth.users(id, email, raw_user_meta_data, email_confirmed_at) values (%s,%s,%s, case when %s then now() end)",
              (uid, email or f"{key}-{uid[:6]}@flow.test", json.dumps({"full_name": f"Flow {key}", **(meta or {})}), confirmed))
    return uid


def open_session(c, uid: str) -> str:
    """Create a live Supabase auth session for the user (what sign-in does)."""
    sid = c.execute("insert into auth.sessions(user_id) values (%s) returning id", (uid,)).fetchone()["id"]
    SESSIONS[str(uid)] = str(sid)
    return str(sid)


def verify_staff_session(c, uid: str) -> None:
    """Mark the user's current session as having passed the staff-ID step (system shortcut)."""
    c.execute("""insert into staff_sessions(session_id, user_id, role, organization_id, expires_at)
                 select %s, p.id, p.role, p.organization_id, now() + interval '12 hours' from profiles p where p.id = %s
                 on conflict (session_id) do update set role = excluded.role, organization_id = excluded.organization_id,
                                                         expires_at = excluded.expires_at""",
              (SESSIONS[str(uid)], uid))


def nearest_ward(c, lat: float, lng: float) -> str:
    return c.execute("select id from wards order by st_distance(location, st_setsrid(st_makepoint(%s,%s),4326)::geography) limit 1",
                     (lng, lat)).fetchone()["id"]


def random_dhaka_point(area: str | None = None) -> tuple[float, float]:
    """Random point in the service area; with `area` ('DNCC' / 'DSCC') one whose nearest ward is in that area."""
    while True:
        lat, lng = random.uniform(DHAKA[0], DHAKA[1]), random.uniform(DHAKA[2], DHAKA[3])
        if area is None:
            return lat, lng
        with raw() as c:
            if nearest_ward(c, lat, lng).startswith(area):
                return lat, lng


@contextmanager
def settings(**values):
    """Temporarily change security_settings (system context), restoring afterwards."""
    cols = ", ".join(values)
    with raw() as c:
        old = c.execute(f"select {cols} from security_settings where id").fetchone()
        c.execute(f"update security_settings set {', '.join(f'{k} = %({k})s' for k in values)} where id", values)
    try:
        yield
    finally:
        with raw() as c:
            c.execute(f"update security_settings set {', '.join(f'{k} = %({k})s' for k in old)} where id", old)
