from __future__ import annotations

import hmac
import logging
from typing import Literal

import httpx
from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from ..core.config import get_settings
from ..core.errors import AppError
from ..core.ratelimit import SlidingWindowLimiter

log = logging.getLogger("resiliomesh.demo")
router = APIRouter(prefix="/api/demo", tags=["demo"])

SHOBAR = "11111111-1111-1111-1111-111111111103"
NODI = "11111111-1111-1111-1111-111111111104"
PROFILES: dict[str, tuple[str, str, dict]] = {
    "citizen": ("citizen@resiliomesh.demo", "citizen", {}),
    "citizen_north": ("citizen2@resiliomesh.demo", "citizen", {}),
    "officer_south": ("officer@resiliomesh.demo", "city_officer", {"employee_id": "DSCC-OFF-01"}),
    "officer_north": ("officer2@resiliomesh.demo", "city_officer", {"employee_id": "DNCC-OFF-02"}),
    "ngo": ("ngo@resiliomesh.demo", "ngo_coordinator", {"organization_id": SHOBAR}),
    "ngo_north": ("ngo2@resiliomesh.demo", "ngo_coordinator", {"organization_id": NODI}),
    "field": ("field1@resiliomesh.demo", "field_worker", {"employee_id": "FW-001"}),
    "field_north": ("field2@resiliomesh.demo", "field_worker", {"employee_id": "FW-002"}),
    "field_relief": ("field3@resiliomesh.demo", "field_worker", {"employee_id": "FW-003"}),
    "field_pump_south": ("field4@resiliomesh.demo", "field_worker", {"employee_id": "FW-004"}),
    "field_drain_north": ("field5@resiliomesh.demo", "field_worker", {"employee_id": "FW-005"}),
    "field_drain_south": ("field6@resiliomesh.demo", "field_worker", {"employee_id": "FW-006"}),
    "field_medical": ("field7@resiliomesh.demo", "field_worker", {"employee_id": "FW-007"}),
    "admin": ("admin@resiliomesh.demo", "admin", {"employee_id": "ADM-001"}),
    "admin2": ("admin2@resiliomesh.demo", "admin", {"employee_id": "ADM-002"}),
}
ProfileKey = Literal["citizen", "citizen_north", "officer_south", "officer_north", "ngo", "ngo_north", "field", "field_north", "field_relief",
                     "field_pump_south", "field_drain_north", "field_drain_south", "field_medical", "admin", "admin2"]

_attempts = SlidingWindowLimiter(limit=10, window_s=60.0)


def enabled() -> bool:
    s = get_settings()
    return bool(s.demo_mode and s.demo_password and s.supabase_url and _apikey())


def _apikey() -> str:
    s = get_settings()
    return s.supabase_anon_key or s.supabase_service_role_key


def code_required() -> bool:
    return bool(get_settings().demo_access_code.strip())


def _client_ip(request: Request) -> str:
    ip = request.headers.get("true-client-ip", "").strip()
    if not ip:
        ip = request.headers.get("x-forwarded-for", "").split(",")[-1].strip()
    return ip or (request.client.host if request.client else "anon")


def password_grant(email: str, password: str) -> dict:
    s = get_settings()
    r = httpx.post(f"{s.supabase_url.rstrip('/')}/auth/v1/token", params={"grant_type": "password"},
                   headers={"apikey": _apikey()}, json={"email": email, "password": password}, timeout=15.0)
    if r.status_code != 200:
        raise RuntimeError(f"Supabase Auth answered {r.status_code}")
    return r.json()


class DemoSessionIn(BaseModel):
    profile: ProfileKey
    code: str = Field("", max_length=100)


@router.get("")
def demo_status() -> dict:
    return {"enabled": enabled(), "code_required": enabled() and code_required()}


@router.post("/session")
def demo_session(body: DemoSessionIn, request: Request) -> dict:
    if not enabled():
        raise AppError(404, "DEMO_OFF", "Demo sign-in is turned off. Use the sign-in form with your own account.")
    ip = _client_ip(request)
    ok, retry = _attempts.allow(ip)
    if not ok:
        raise AppError(429, "RATE_LIMITED", f"Too many attempts. Try again in {retry} s.")
    s = get_settings()
    if code_required() and not hmac.compare_digest(body.code.strip().encode(), s.demo_access_code.strip().encode()):
        log.warning("demo sign-in: wrong access code from %s", ip)
        raise AppError(403, "DEMO_CODE", "That judge access code is not correct.")

    email, role, extra = PROFILES[body.profile]
    try:
        session = password_grant(email, s.demo_password)
    except (httpx.HTTPError, RuntimeError, ValueError) as e:
        log.error("demo sign-in for %s failed: %s", body.profile, e)
        raise AppError(502, "DEMO_UNAVAILABLE",
                       "The demo account could not sign in right now. Please use the sign-in form, or try again shortly.")
    log.info("demo sign-in: %s (%s) from %s", body.profile, role, ip)
    return {"access_token": session["access_token"], "refresh_token": session["refresh_token"],
            "role": role, "extra": extra}
