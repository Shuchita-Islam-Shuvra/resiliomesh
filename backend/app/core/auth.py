"""Supabase JWT verification + role-based dependencies.

Supports both Supabase signing schemes:
  * new asymmetric keys (ES256/RS256) via the project's JWKS endpoint
  * legacy HS256 shared secret (SUPABASE_JWT_SECRET)
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Callable

import jwt
import psycopg
from fastapi import Depends, HTTPException, Request, status

from .config import get_settings
from . import db

_jwks_client: jwt.PyJWKClient | None = None
_profile_cache: dict[str, tuple[float, dict]] = {}
PROFILE_TTL_S = 30


@dataclass
class CurrentUser:
    id: str
    email: str | None
    role: str
    organization_id: str | None
    full_name: str | None = None

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"


def _jwks() -> jwt.PyJWKClient:
    global _jwks_client
    if _jwks_client is None:
        url = get_settings().supabase_url.rstrip("/") + "/auth/v1/.well-known/jwks.json"
        _jwks_client = jwt.PyJWKClient(url, cache_keys=True, lifespan=3600)
    return _jwks_client


def decode_token(token: str) -> dict:
    settings = get_settings()
    try:
        header = jwt.get_unverified_header(token)
        alg = header.get("alg", "")
        if alg == "HS256":
            if not settings.supabase_jwt_secret:
                raise HTTPException(status.HTTP_401_UNAUTHORIZED, "HS256 token but no JWT secret configured")
            return jwt.decode(token, settings.supabase_jwt_secret, algorithms=["HS256"], audience="authenticated")
        key = _jwks().get_signing_key_from_jwt(token)
        return jwt.decode(token, key.key, algorithms=["ES256", "RS256"], audience="authenticated")
    except jwt.ExpiredSignatureError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired, please sign in again")
    except jwt.PyJWTError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, f"Invalid token: {exc}")


_effective_role_sql: bool | None = None     # None = not probed yet; False = migration 008 not applied


def load_profile(user_id: str, session_id: str | None = None, aal: str | None = None) -> dict:
    """Profile with the *effective* role for this JWT session.

    Staff privileges are bound to a session that passed the server-side staff-ID
    check (and TOTP where required) — see rm_effective_role() in migration 008.
    A password-only session of a staff account is treated as a citizen here too,
    so the API cannot be used to bypass the second sign-in step.
    """
    global _effective_role_sql
    now = time.time()
    key = f"{user_id}|{session_id}|{aal}"
    cached = _profile_cache.get(key)
    if cached and now - cached[0] < PROFILE_TTL_S:
        return cached[1]
    with db.tx() as conn:
        row = None
        if _effective_role_sql is not False:
            try:
                with conn.transaction():          # savepoint: a missing function must not poison the tx
                    row = db.fetch_one(
                        conn,
                        """select id, email, full_name, organization_id, is_active, role::text as account_role,
                                  rm_effective_role(id, %s::uuid, %s)::text as role
                             from profiles where id = %s""",
                        (session_id, aal or "aal1", user_id),
                    )
                _effective_role_sql = True
            except psycopg.errors.UndefinedFunction:   # migration 008 not applied yet
                _effective_role_sql = False
        if _effective_role_sql is False:
            row = db.fetch_one(
                conn,
                "select id, email, full_name, role::text as role, role::text as account_role, organization_id, is_active "
                "from profiles where id = %s",
                (user_id,),
            )
    if not row:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Profile not found")
    if not row["is_active"] or row["role"] is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Account is deactivated")
    if len(_profile_cache) > 5000:
        _profile_cache.clear()
    _profile_cache[key] = (now, row)
    return row


def get_current_user(request: Request) -> CurrentUser:
    auth = request.headers.get("authorization", "")
    if not auth.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing bearer token")
    claims = decode_token(auth.split(" ", 1)[1].strip())
    sub = claims.get("sub")
    if not sub:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token has no subject")
    profile = load_profile(sub, claims.get("session_id"), claims.get("aal"))
    user = CurrentUser(
        id=sub,
        email=claims.get("email"),
        role=profile["role"],
        organization_id=str(profile["organization_id"]) if profile["organization_id"] else None,
        full_name=profile.get("full_name"),
    )
    request.state.user = user
    return user


def require_roles(*roles: str) -> Callable[[CurrentUser], CurrentUser]:
    def checker(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
        if user.role not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"Role '{user.role}' is not allowed to perform this action")
        return user

    return checker


STAFF = ("city_officer", "ngo_coordinator", "field_worker", "admin")
COORDINATORS = ("city_officer", "ngo_coordinator", "admin")
# Pump / crew planning and the dispatch workflow belong to Water Resilience Officers (015).
OFFICERS = ("city_officer", "admin")
