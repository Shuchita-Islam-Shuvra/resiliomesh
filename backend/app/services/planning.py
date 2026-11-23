"""Builds optimizer input from the database and stores the resulting plan."""
from __future__ import annotations

from dataclasses import asdict

from ..core import db
from ..core.auth import CurrentUser
from ..core.errors import AppError
from .optimizer import Constraints, IncidentDemand, ResourcePool, derive_demand, optimize


def create_plan(incident_ids: list[str], constraints: Constraints, user: CurrentUser,
                demand_overrides: dict[str, dict[str, int]] | None = None) -> dict:
    if not incident_ids:
        raise AppError(422, "VALIDATION", "Select at least one incident")
    if len(set(incident_ids)) != len(incident_ids):
        raise AppError(422, "VALIDATION", "Duplicate incident ids in request")
    if len(incident_ids) > 25:
        raise AppError(422, "VALIDATION", "At most 25 incidents per optimisation run")

    with db.tx() as conn:
        incs = db.fetch_all(conn, """
            select id::text, reference_code, title, category::text, status::text, water_depth_cm, people_affected,
                   risk_score, risk_level::text, priority, lat, lng
            from incidents where id = any(%s::uuid[])""", (incident_ids,))
        pools = db.fetch_all(conn, """
            select id::text, resource_type::text, quantity_available, lat, lng, organization_id::text, name
            from resources where quantity_available > 0""")

    found = {i["id"] for i in incs}
    missing = [i for i in incident_ids if i not in found]
    if missing:
        raise AppError(404, "NOT_FOUND", f"Incidents not found: {missing}")
    not_ready = [f"{i['reference_code']} ({i['status']})" for i in incs if i["status"] != "assessed"]
    if not_ready:
        raise AppError(409, "INVALID_STATE", f"Only AI-assessed incidents can be planned. Not ready: {', '.join(not_ready)}")

    demands = []
    for i in incs:
        d = derive_demand(i["category"], i["water_depth_cm"], i["people_affected"], i["risk_level"])
        if demand_overrides and i["id"] in demand_overrides:
            for k, v in demand_overrides[i["id"]].items():
                if v < 0 or v > 10000:
                    raise AppError(422, "VALIDATION", f"Invalid demand override {k}={v}")
                d[k] = int(v)
            d = {k: v for k, v in d.items() if v > 0}
        demands.append(IncidentDemand(id=i["id"], lat=i["lat"], lng=i["lng"], risk_score=float(i["risk_score"] or 0),
                                      risk_level=i["risk_level"] or "low", demand=d, priority=i["priority"] or 50,
                                      label=i["reference_code"]))
    result = optimize(demands, [ResourcePool(id=p["id"], resource_type=p["resource_type"],
                                             available=p["quantity_available"], lat=p["lat"], lng=p["lng"],
                                             organization_id=p["organization_id"], name=p["name"]) for p in pools],
                      constraints)

    explanation = {"status": result.status, "coverage": result.coverage, "shortages": result.shortages,
                   "conflicts": result.conflicts, "notes": result.notes, "solve_ms": result.solve_ms,
                   "demand": {d.label: d.demand for d in demands}}
    with db.tx(actor_id=user.id) as conn:
        row = db.fetch_one(conn, """
            insert into allocation_plans(incident_ids, status, feasible, relaxed, objective, assignments,
                                         explanation, constraints, created_by)
            values (%s::uuid[], %s, %s, %s, %s, %s, %s, %s, %s)
            returning id::text, status::text, version, created_at""",
            (incident_ids, "pending_approval" if result.assignments else "rejected",
             result.feasible, result.relaxed, result.objective, db.as_json(result.assignments),
             db.as_json(explanation), db.as_json(asdict(constraints)), user.id))
    return {"plan": row, "result": result.to_dict()}
