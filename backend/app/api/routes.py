"""HTTP API. Simple CRUD goes straight from the browser to Supabase (RLS-protected);
this service hosts the AI, optimisation, external-API, workflow and bulk-import logic."""
from __future__ import annotations

import time
from typing import Literal

from fastapi import APIRouter, Depends, File, Header, UploadFile
from pydantic import BaseModel, Field, field_validator

from ..core import db
from ..core.areas import assert_ward_visible
from ..core.auth import OFFICERS, STAFF, CurrentUser, get_current_user, require_roles
from ..core.errors import AppError
from ..ml.features import FEATURE_LABELS, FEATURES
from ..services import importer, planning, risk
from ..services.optimizer import Constraints
from ..services.weather import get_weather_client
from ..workflow import worker

router = APIRouter(prefix="/api")


# ------------------------------------------------------------------ me
@router.get("/me")
def me(user: CurrentUser = Depends(get_current_user)):
    return user.__dict__


# ------------------------------------------------------------------ weather (A06)
@router.get("/weather/wards/{ward_id}")
def ward_weather(ward_id: str, refresh: bool = False, user: CurrentUser = Depends(get_current_user)):
    with db.tx() as conn:
        w = db.fetch_one(conn, "select id, name, lat, lng from wards where id = %s", (ward_id,))
        if w:
            assert_ward_visible(conn, user, ward_id)          # North / South staff: own area only
    if not w:
        raise AppError(404, "NOT_FOUND", "Unknown ward")
    data = get_weather_client().get(w["id"], w["lat"], w["lng"], force_live=refresh and user.role != "citizen")
    return {"ward": w, **data}


@router.get("/weather/status")
def weather_status(user: CurrentUser = Depends(require_roles(*STAFF))):
    c = get_weather_client()
    return {"breaker": c.breaker.state, "consecutive_failures": c.breaker.failures, "stats": c.stats,
            "chaos_mode": c.chaos_mode, "timeout_s": c.timeout_s, "max_retries": c.max_retries}


class ChaosIn(BaseModel):
    weather_mode: Literal["normal", "timeout", "malformed", "error500"]


@router.post("/admin/chaos")
def set_chaos(body: ChaosIn, user: CurrentUser = Depends(require_roles("admin"))):
    c = get_weather_client()
    c.chaos_mode = body.weather_mode
    if body.weather_mode == "normal":
        c.breaker.success()
    return {"weather_mode": c.chaos_mode, "breaker": c.breaker.state}


# ------------------------------------------------------------------ AI risk (A02)
@router.post("/risk/incidents/{incident_id}/assess")
def assess(incident_id: str, user: CurrentUser = Depends(require_roles("city_officer", "admin"))):
    return risk.assess_incident(incident_id, user)


@router.post("/risk/wards/refresh")
def refresh_wards(user: CurrentUser = Depends(require_roles("city_officer", "admin"))):
    return risk.refresh_wards(user)


class SimulateIn(BaseModel):
    features: dict[str, float]
    context: dict = Field(default_factory=dict)


@router.post("/risk/simulate")
def simulate(body: SimulateIn, user: CurrentUser = Depends(require_roles(*STAFF))):
    unknown = set(body.features) - set(FEATURES)
    if unknown:
        raise AppError(422, "VALIDATION", f"Unknown features: {sorted(unknown)}")
    return risk.score(body.features, body.context)


@router.get("/risk/model")
def model_info(user: CurrentUser = Depends(require_roles(*STAFF))):
    m = risk.model()
    gain = m.booster.get_score(importance_type="gain")
    total = sum(gain.values()) or 1
    return {"version": m.version, "metrics": m.metrics, "features": FEATURES, "labels": FEATURE_LABELS,
            "importance": sorted([{"feature": f, "label": FEATURE_LABELS[f], "gain_pct": round(100 * gain.get(f, 0) / total, 1)}
                                  for f in FEATURES], key=lambda d: -d["gain_pct"])}


# ------------------------------------------------------------------ optimisation (A02)
class ConstraintsIn(BaseModel):
    max_distance_km: float = Field(10.0, description="Response radius")
    reserve_ratio: float = Field(0.0, description="Fraction of each stock kept in reserve")
    require_full_coverage_critical: bool = True
    pump_requires_crew: bool = True
    allowed_org_ids: list[str] | None = None
    allow_relaxation: bool = True


class OptimizeIn(BaseModel):
    incident_ids: list[str] = Field(min_length=1, max_length=25)
    constraints: ConstraintsIn = Field(default_factory=ConstraintsIn)
    demand_overrides: dict[str, dict[str, int]] | None = None

    @field_validator("incident_ids")
    @classmethod
    def uuids(cls, v):
        import uuid
        for x in v:
            uuid.UUID(x)
        return v


_idem_cache: dict[str, tuple[float, dict]] = {}


@router.post("/plans/optimize")
def optimize_plan(body: OptimizeIn, idempotency_key: str | None = Header(default=None),
                  user: CurrentUser = Depends(require_roles(*OFFICERS))):
    if idempotency_key:
        hit = _idem_cache.get(f"{user.id}:{idempotency_key}")
        if hit and time.time() - hit[0] < 600:
            return {**hit[1], "replayed": True}
    c = Constraints(**body.constraints.model_dump(), time_limit_s=5.0)
    out = planning.create_plan(body.incident_ids, c, user, body.demand_overrides)
    if idempotency_key:
        _idem_cache[f"{user.id}:{idempotency_key}"] = (time.time(), out)
    return out


# ------------------------------------------------------------------ workflow (A07)
@router.get("/workflows/worker")
def worker_status(user: CurrentUser = Depends(require_roles(*OFFICERS))):
    return worker.status


@router.post("/workflows/process-now")
def process_now(user: CurrentUser = Depends(require_roles(*OFFICERS))):
    """Drain the queue synchronously (useful on free hosting where the worker may sleep)."""
    from ..workflow.engine import WorkflowEngine
    from ..workflow.pg_store import PgStore
    engine, results = WorkflowEngine(PgStore()), []
    for _ in range(10):
        r = worker.run_once(engine, f"api-{user.id[:8]}")
        if r is None:
            break
        results.append(r)
    return {"processed": len(results), "results": results}


# ------------------------------------------------------------------ analytics import (A08)
@router.post("/analytics/import")
async def import_history(file: UploadFile = File(...), user: CurrentUser = Depends(require_roles("admin", "city_officer"))):
    if not (file.filename or "").lower().endswith(".csv"):
        raise AppError(422, "VALIDATION", "Upload a .csv file")
    content = await file.read()
    if len(content) > 40 * 1024 * 1024:
        raise AppError(413, "TOO_LARGE", "CSV larger than 40 MB")
    try:
        return importer.import_csv(content, user.id)
    except ValueError as exc:
        raise AppError(422, "VALIDATION", str(exc))


# ------------------------------------------------------------------ admin health
@router.get("/admin/health")
def admin_health(user: CurrentUser = Depends(require_roles("admin"))):
    t0 = time.perf_counter()
    with db.tx() as conn:
        counts = db.fetch_one(conn, """select
            (select count(*) from incidents) incidents, (select count(*) from tasks) tasks,
            (select count(*) from workflow_runs where status in ('queued','retrying','running')) queued_runs,
            (select count(*) from workflow_runs where status in ('failed','compensated')) failed_runs,
            (select count(*) from historical_flood_events) historical_rows,
            (select count(*) from audit_logs) audit_rows""")
    c = get_weather_client()
    return {"db_latency_ms": round((time.perf_counter() - t0) * 1000, 1), "counts": counts, "worker": worker.status,
            "weather": {"breaker": c.breaker.state, "stats": c.stats, "chaos_mode": c.chaos_mode},
            "model": {"version": risk.model().version, "metrics": risk.model().metrics}}
