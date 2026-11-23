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


def load_profile(user_id: str) -> dict:
    now = time.time()
    cached = _profile_cache.get(user_id)
    if cached and now - cached[0] < PROFILE_TTL_S:
        return cached[1]
    with db.tx() as conn:
        row = db.fetch_one(
            conn,
            "select id, email, full_name, role::text as role, organization_id, is_active from profiles where id = %s",
            (user_id,),
        )
    if not row:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Profile not found")
    if not row["is_active"]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Account is deactivated")
    _profile_cache[user_id] = (now, row)
    return row


def get_current_user(request: Request) -> CurrentUser:
    auth = request.headers.get("authorization", "")
    if not auth.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing bearer token")
    claims = decode_token(auth.split(" ", 1)[1].strip())
    sub = claims.get("sub")
    if not sub:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token has no subject")
    profile = load_profile(sub)
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
