"""Constraint-based resource allocation with Google OR-Tools CP-SAT (A02).

Decision variable x[i,r] = units of resource pool r sent to incident i.

Hard constraints
  * sum_i x[i,r] <= available_r * (1 - reserve_ratio)          (stock + strategic reserve)
  * sum_{r of type t} x[i,r] <= demand[i,t]                    (no over-supply)
  * x[i,r] = 0 if distance(i,r) > max_distance_km              (response-time radius)
  * pumps at i  =>  at least one crew at i                     (pump needs operators)
  * (optional) every CRITICAL incident fully covered           (may be infeasible!)
  * (optional) only pools of allowed organisations

Objective: maximise risk-weighted fractional coverage, minus travel distance.

If the hard model is INFEASIBLE we return a diagnosis (which incident / which
resource type is short, by how much, which constraint conflicts) and — when
allowed — a relaxed best-effort plan clearly flagged `relaxed=true`.
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass, field

from ortools.sat.python import cp_model


@dataclass
class IncidentDemand:
    id: str
    lat: float
    lng: float
    risk_score: float
    risk_level: str
    demand: dict[str, int]
    priority: int = 50
    label: str = ""


@dataclass
class ResourcePool:
    id: str
    resource_type: str
    available: int
    lat: float
    lng: float
    organization_id: str | None = None
    name: str = ""


@dataclass
class Constraints:
    max_distance_km: float = 10.0
    reserve_ratio: float = 0.0
    require_full_coverage_critical: bool = True
    pump_requires_crew: bool = True
    allowed_org_ids: list[str] | None = None
    allow_relaxation: bool = True
    time_limit_s: float = 5.0


@dataclass
class PlanResult:
    feasible: bool
    relaxed: bool
    status: str
    objective: float | None
    assignments: list[dict] = field(default_factory=list)
    coverage: list[dict] = field(default_factory=list)
    shortages: list[dict] = field(default_factory=list)
    conflicts: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    solve_ms: int = 0

    def to_dict(self) -> dict:
        return self.__dict__.copy()


REUSABLE = {"pump", "crew", "boat", "water_tank"}


def haversine_km(lat1, lng1, lat2, lng2) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def derive_demand(category: str, water_depth_cm: int | None, people_affected: int | None, risk_level: str | None) -> dict[str, int]:
    """Rule-based demand estimation from a field report."""
    depth = water_depth_cm or 0
    people = people_affected or 0
    households = math.ceil(people / 4.5) if people else 0
    d: dict[str, int] = {}
    if category in ("waterlogging", "road_flooded", "overflow"):
        if depth >= 20:
            d["pump"] = min(4, max(1, math.ceil(depth / 30)))
        d["crew"] = 2 if risk_level == "critical" else 1
        if category == "overflow":
            d["sandbag"] = 150 if depth >= 40 else 80
        if depth >= 90:
            d["boat"] = 1
    elif category == "blocked_drain":
        d["crew"] = 2 if risk_level in ("high", "critical") else 1
        if depth >= 30:
            d["pump"] = 1
    elif category == "relief_need":
        if households:
            d["relief_kit"] = households
            d["medical_kit"] = max(1, math.ceil(households * 0.2))
            if households >= 50:
                d["water_tank"] = 1
    if risk_level == "critical" and people >= 200 and category != "relief_need":
        d["relief_kit"] = min(150, households)
    return {k: v for k, v in d.items() if v > 0}


def _precheck(incidents, pools, c: Constraints) -> list[str]:
    conflicts = []
    if not (0 <= c.reserve_ratio < 1):
        conflicts.append(f"reserve_ratio={c.reserve_ratio} must be in [0,1): reserving 100% leaves nothing to allocate")
    if c.max_distance_km <= 0:
        conflicts.append("max_distance_km must be positive: no resource can ever be in range")
    if c.allowed_org_ids is not None and len(c.allowed_org_ids) == 0:
        conflicts.append("allowed_org_ids is empty: every resource pool is excluded")
    if not incidents:
        conflicts.append("no incidents supplied")
    for inc in incidents:
        for t, q in inc.demand.items():
            if q < 0:
                conflicts.append(f"incident {inc.label or inc.id}: negative demand for {t}")
    return conflicts


def optimize(incidents: list[IncidentDemand], pools: list[ResourcePool], c: Constraints | None = None) -> PlanResult:
    c = c or Constraints()
    t0 = time.perf_counter()

    conflicts = _precheck(incidents, pools, c)
    if conflicts:
        return PlanResult(False, False, "INVALID_CONSTRAINTS", None, conflicts=conflicts,
                          notes=["Request rejected before solving: constraints contradict each other."])

    pools = [p for p in pools if p.available > 0 and
             (c.allowed_org_ids is None or p.organization_id in c.allowed_org_ids)]
    usable = {p.id: int(math.floor(p.available * (1 - c.reserve_ratio))) for p in pools}

    # pump => crew coupling adds implied crew demand
    for inc in incidents:
        if c.pump_requires_crew and inc.demand.get("pump", 0) > 0 and inc.demand.get("crew", 0) == 0:
            inc.demand["crew"] = 1

    dist = {(i.id, p.id): haversine_km(i.lat, i.lng, p.lat, p.lng) for i in incidents for p in pools}

    # --- feasibility diagnosis for hard critical coverage ------------
    shortages = []
    for inc in incidents:
        for t, q in inc.demand.items():
            reach = sum(usable[p.id] for p in pools if p.resource_type == t and dist[(inc.id, p.id)] <= c.max_distance_km)
            if reach < q:
                shortages.append({"incident_id": inc.id, "incident": inc.label, "risk_level": inc.risk_level,
                                  "resource_type": t, "required": q, "reachable": reach, "short_by": q - reach})
    # aggregate shortage across critical incidents competing for same pools
    crit = [i for i in incidents if i.risk_level == "critical"]
    for t in {t for i in crit for t in i.demand}:
        need = sum(i.demand.get(t, 0) for i in crit)
        total = sum(usable[p.id] for p in pools if p.resource_type == t)
        if need > total and not any(s["resource_type"] == t and s.get("aggregate") for s in shortages):
            shortages.append({"aggregate": True, "resource_type": t, "required": need, "reachable": total,
                              "short_by": need - total, "incident": "all critical incidents combined"})

    def build(hard_critical: bool):
        m = cp_model.CpModel()
        x = {}
        for inc in incidents:
            for p in pools:
                if p.resource_type in inc.demand and dist[(inc.id, p.id)] <= c.max_distance_km and usable[p.id] > 0:
                    ub = min(usable[p.id], inc.demand[p.resource_type])
                    x[(inc.id, p.id)] = m.NewIntVar(0, ub, f"x_{inc.id[:8]}_{p.id[:8]}")
        for p in pools:
            terms = [x[(i.id, p.id)] for i in incidents if (i.id, p.id) in x]
            if terms:
                m.Add(sum(terms) <= usable[p.id])
        objective = []
        for inc in incidents:
            weight = int(inc.risk_score * 10 + inc.priority * 2 + (500 if inc.risk_level == "critical" else 0))
            for t, q in inc.demand.items():
                terms = [x[(inc.id, p.id)] for p in pools if p.resource_type == t and (inc.id, p.id) in x]
                if terms:
                    m.Add(sum(terms) <= q)
                    if hard_critical and c.require_full_coverage_critical and inc.risk_level == "critical":
                        m.Add(sum(terms) == q)
                    per_unit = max(1, weight * 100 // q)
                    objective += [per_unit * v for v in terms]
                elif hard_critical and c.require_full_coverage_critical and inc.risk_level == "critical":
                    # critical demand with no reachable pool: provably infeasible
                    never = m.NewIntVar(0, 0, f"never_{inc.id[:8]}_{t}")
                    m.Add(never == 1)
            if c.pump_requires_crew and "pump" in inc.demand:
                pumps = [x[(inc.id, p.id)] for p in pools if p.resource_type == "pump" and (inc.id, p.id) in x]
                crews = [x[(inc.id, p.id)] for p in pools if p.resource_type == "crew" and (inc.id, p.id) in x]
                if pumps:
                    has_pump = m.NewBoolVar(f"hp_{inc.id[:8]}")
                    m.Add(sum(pumps) >= 1).OnlyEnforceIf(has_pump)
                    m.Add(sum(pumps) == 0).OnlyEnforceIf(has_pump.Not())
                    if crews:
                        m.Add(sum(crews) >= 1).OnlyEnforceIf(has_pump)
                    else:
                        m.Add(has_pump == 0)
        for (iid, pid), v in x.items():
            objective.append(-int(dist[(iid, pid)] * 10) * v)
        m.Maximize(sum(objective) if objective else 0)
        return m, x

    def solve(hard: bool):
        model, x = build(hard)
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = c.time_limit_s
        solver.parameters.num_workers = 4
        st = solver.Solve(model)
        return solver, st, x

    solver, st, x = solve(True)
    relaxed = False
    notes = []
    if st == cp_model.INFEASIBLE:
        notes.append("Hard constraints are infeasible: not every CRITICAL incident can be fully covered "
                     "with reachable stock after the strategic reserve.")
        if not c.allow_relaxation:
            return PlanResult(False, False, "INFEASIBLE", None, shortages=shortages, notes=notes,
                              solve_ms=int((time.perf_counter() - t0) * 1000))
        solver, st, x = solve(False)
        relaxed = True
        notes.append("Returned a RELAXED best-effort plan (critical full-coverage softened). "
                     "Coordinator must review shortages before approval.")

    if st not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return PlanResult(False, relaxed, solver.StatusName(st), None, shortages=shortages, notes=notes,
                          solve_ms=int((time.perf_counter() - t0) * 1000))

    pool_by_id = {p.id: p for p in pools}
    inc_by_id = {i.id: i for i in incidents}
    assignments = []
    for (iid, pid), v in x.items():
        q = solver.Value(v)
        if q > 0:
            p = pool_by_id[pid]
            assignments.append({"incident_id": iid, "incident": inc_by_id[iid].label, "resource_id": pid,
                                "resource_name": p.name, "resource_type": p.resource_type, "quantity": int(q),
                                "distance_km": round(dist[(iid, pid)], 2), "reusable": p.resource_type in REUSABLE})
    coverage = []
    for inc in incidents:
        for t, q in inc.demand.items():
            got = sum(a["quantity"] for a in assignments if a["incident_id"] == inc.id and a["resource_type"] == t)
            coverage.append({"incident_id": inc.id, "incident": inc.label, "resource_type": t,
                             "required": q, "allocated": got, "pct": round(100 * got / q, 1) if q else 100})
    if not assignments:
        notes.append("No resource within range could be allocated.")
    return PlanResult(
        feasible=not relaxed and bool(assignments), relaxed=relaxed, status=solver.StatusName(st),
        objective=float(solver.ObjectiveValue()), assignments=assignments, coverage=coverage,
        shortages=shortages if relaxed or any(cv["pct"] < 100 for cv in coverage) else [],
        notes=notes, solve_ms=int((time.perf_counter() - t0) * 1000),
    )
