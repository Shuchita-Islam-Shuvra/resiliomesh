"""Risk assessment pipeline: DB context + live weather -> XGBoost -> rule engine -> persist."""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from ..core import db
from ..core.areas import assert_wards_in_area, officer_area
from ..core.auth import CurrentUser
from ..core.config import get_settings
from ..core.errors import AppError
from ..ml.features import monsoon_factor
from ..ml.model import get_model
from ..ml.rules import apply_rules, priority
from .optimizer import derive_demand
from .weather import get_weather_client

log = logging.getLogger("resiliomesh.risk")


def model():
    s = get_settings()
    return get_model(s.model_path, s.historical_csv)


def score(features: dict, context: dict) -> dict:
    ml = model().predict(features)
    ruled = apply_rules(ml["score"], {**ml["features"], **context})
    return {
        "ml_score": ml["score"], "score": ruled["score"], "level": ruled["level"],
        "baseline": ml["baseline"], "contributions": ml["contributions"],
        "rules_fired": ruled["rules_fired"], "features": ml["features"], "model_version": model().version,
    }


_CONTEXT_SQL = """
select i.id, i.status::text as status, i.category::text as category, i.water_depth_cm, i.people_affected,
       i.severity_reported, i.lat, i.lng, i.created_at, i.version, i.ward_id,
       w.drainage_capacity_mm_hr, w.impervious_pct, w.elevation_m, w.historical_events_10y,
       a.condition_score as asset_condition, a.status::text as asset_status,
       (select round(avg(condition_score)) from drainage_assets where ward_id = i.ward_id) as ward_asset_condition,
       (select count(*) from drainage_assets where ward_id = i.ward_id and status = 'blocked') as blocked_assets,
       (select count(*) from incidents o where o.id <> i.id
          and o.created_at > now() - interval '6 hours'
          and st_dwithin(o.location, i.location, 300)) as recent_reports_6h
from incidents i
join wards w on w.id = i.ward_id
left join drainage_assets a on a.id = i.asset_id
where i.id = %s
"""


def assess_incident(incident_id: str, user: CurrentUser) -> dict:
    # 1) read context (no lock held during the external API call)
    with db.tx() as conn:
        ctx = db.fetch_one(conn, _CONTEXT_SQL, (incident_id,))
        if ctx:
            assert_wards_in_area(conn, user, [ctx["ward_id"]])
    if not ctx:
        raise AppError(404, "NOT_FOUND", "Incident not found")
    if ctx["status"] not in ("verified", "assessed"):
        raise AppError(409, "INVALID_STATE",
                       f"Incident is '{ctx['status']}'. Only verified incidents can be assessed by the AI.")

    weather = get_weather_client().get(ctx["ward_id"], ctx["lat"], ctx["lng"])
    month = datetime.now(timezone.utc).month
    features = {
        "rain_past_24h_mm": weather["rain_past_24h_mm"], "rain_next_24h_mm": weather["rain_next_24h_mm"],
        "max_hourly_mm": weather["max_hourly_mm"],
        "drainage_capacity_mm_hr": ctx["drainage_capacity_mm_hr"], "impervious_pct": ctx["impervious_pct"],
        "elevation_m": ctx["elevation_m"],
        "asset_condition": ctx["asset_condition"] if ctx["asset_condition"] is not None else ctx["ward_asset_condition"],
        "blocked_assets": ctx["blocked_assets"], "historical_events_10y": ctx["historical_events_10y"],
        "recent_reports_6h": ctx["recent_reports_6h"], "monsoon": monsoon_factor(month),
    }
    context = {"water_depth_cm": ctx["water_depth_cm"], "people_affected": ctx["people_affected"],
               "category": ctx["category"], "asset_status": ctx["asset_status"]}
    result = score(features, context)
    age_h = (datetime.now(timezone.utc) - ctx["created_at"]).total_seconds() / 3600
    prio = priority(result["score"], ctx["people_affected"], ctx["severity_reported"], age_h)

    # 2) write atomically, re-checking state under row lock
    with db.tx(actor_id=user.id, note="AI risk assessment") as conn:
        cur = db.fetch_one(conn, "select status::text as status from incidents where id = %s for update", (incident_id,))
        if cur["status"] not in ("verified", "assessed"):
            raise AppError(409, "INVALID_STATE", f"Incident changed to '{cur['status']}' during assessment")
        ra = db.fetch_one(conn, """
            insert into risk_assessments(incident_id, ward_id, score, level, model_version, features,
                                         contributions, rules_fired, weather_source, created_by)
            values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) returning id, created_at""",
            (incident_id, ctx["ward_id"], result["score"], result["level"], result["model_version"],
             db.as_json({**result["features"], "ml_score": result["ml_score"]}),
             db.as_json(result["contributions"]), db.as_json(result["rules_fired"]), weather["source"], user.id))
        conn.execute("""update incidents set risk_score = %s, risk_level = %s, priority = %s,
                        status = case when status = 'verified' then 'assessed'::incident_status else status end
                        where id = %s""", (result["score"], result["level"], prio, incident_id))

    demand = derive_demand(ctx["category"], ctx["water_depth_cm"], ctx["people_affected"], result["level"])
    return {"assessment_id": str(ra["id"]), "incident_id": incident_id, "priority": prio,
            "weather": {k: weather.get(k) for k in ("source", "degraded", "rain_past_24h_mm", "rain_next_24h_mm",
                                                    "max_hourly_mm", "error", "fetched_at")},
            "recommended_demand": demand, **result}


def refresh_wards(user: CurrentUser) -> dict:
    """Re-score wards with live weather. Officers re-score only their own area."""
    with db.tx() as conn:
        area = officer_area(conn, user)
        wards = db.fetch_all(conn, """
          select w.*, (select round(avg(condition_score)) from drainage_assets a where a.ward_id = w.id) as asset_condition,
                 (select count(*) from drainage_assets a where a.ward_id = w.id and a.status = 'blocked') as blocked_assets,
                 (select count(*) from incidents i where i.ward_id = w.id and i.created_at > now() - interval '6 hours'
                    and i.status <> 'rejected') as recent_reports_6h
          from wards w where %(area)s::text is null or w.city_corporation = %(area)s order by id""", {"area": area})
    client = get_weather_client()
    with ThreadPoolExecutor(max_workers=5) as pool:
        weathers = list(pool.map(lambda w: client.get(w["id"], w["lat"], w["lng"]), wards))

    month = datetime.now(timezone.utc).month
    out = []
    with db.tx(actor_id=user.id) as conn:
        for w, wx in zip(wards, weathers):
            feats = {"rain_past_24h_mm": wx["rain_past_24h_mm"], "rain_next_24h_mm": wx["rain_next_24h_mm"],
                     "max_hourly_mm": wx["max_hourly_mm"], "drainage_capacity_mm_hr": w["drainage_capacity_mm_hr"],
                     "impervious_pct": w["impervious_pct"], "elevation_m": w["elevation_m"],
                     "asset_condition": w["asset_condition"], "blocked_assets": w["blocked_assets"],
                     "historical_events_10y": w["historical_events_10y"],
                     "recent_reports_6h": w["recent_reports_6h"], "monsoon": monsoon_factor(month)}
            r = score(feats, {})
            conn.execute("update wards set current_risk_score=%s, current_risk_level=%s, risk_updated_at=now() where id=%s",
                         (r["score"], r["level"], w["id"]))
            out.append({"ward_id": w["id"], "name": w["name"], "score": r["score"], "level": r["level"],
                        "weather_source": wx["source"], "rain_next_24h_mm": wx["rain_next_24h_mm"]})
    degraded = sum(1 for wx in weathers if wx.get("degraded"))
    return {"updated": len(out), "degraded_weather": degraded, "area": area, "wards": out}
