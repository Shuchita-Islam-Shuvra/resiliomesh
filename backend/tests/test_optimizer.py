"""A02 — constraint optimisation incl. conflicting / infeasible requests."""
from app.services.optimizer import Constraints, IncidentDemand, ResourcePool, derive_demand, optimize

DHAKA = (23.75, 90.40)


def inc(id, level="high", score=60, demand=None, lat=DHAKA[0], lng=DHAKA[1]):
    return IncidentDemand(id=id, lat=lat, lng=lng, risk_score=score, risk_level=level,
                          demand=demand or {"pump": 2, "crew": 1}, label=id)


def pool(id, t, n, lat=DHAKA[0] + 0.01, lng=DHAKA[1]):
    return ResourcePool(id=id, resource_type=t, available=n, lat=lat, lng=lng, name=id)


def total(res, t):
    return sum(a["quantity"] for a in res.assignments if a["resource_type"] == t)


def test_basic_plan_is_feasible_and_respects_stock():
    r = optimize([inc("i1"), inc("i2")], [pool("p", "pump", 3), pool("c", "crew", 5)])
    assert r.feasible and r.status in ("OPTIMAL", "FEASIBLE")
    assert total(r, "pump") <= 3
    assert all(a["quantity"] > 0 for a in r.assignments)


def test_never_oversupplies_demand():
    r = optimize([inc("i1", demand={"pump": 1, "crew": 1})], [pool("p", "pump", 10), pool("c", "crew", 10)])
    assert total(r, "pump") == 1 and total(r, "crew") == 1


def test_last_pump_goes_to_highest_risk():
    low = inc("low", level="moderate", score=40, demand={"pump": 1, "crew": 1})
    crit = inc("crit", level="critical", score=90, demand={"pump": 1, "crew": 1})
    r = optimize([low, crit], [pool("p", "pump", 1), pool("c", "crew", 2)])
    pumps = [a for a in r.assignments if a["resource_type"] == "pump"]
    assert len(pumps) == 1 and pumps[0]["incident_id"] == "crit"


def test_distance_constraint_excludes_far_resources():
    far = pool("far", "pump", 5, lat=24.5, lng=91.5)   # ~120 km away
    r = optimize([inc("i1", demand={"pump": 1})], [far, pool("c", "crew", 1)], Constraints(max_distance_km=10))
    assert total(r, "pump") == 0


def test_pump_requires_crew_coupling():
    # pumps available but zero crews -> pumps must not be sent alone
    r = optimize([inc("i1", level="high", demand={"pump": 2})], [pool("p", "pump", 4)],
                 Constraints(pump_requires_crew=True))
    assert total(r, "pump") == 0


def test_infeasible_critical_returns_diagnosis_and_relaxed_plan():
    crit = inc("crit", level="critical", score=95, demand={"pump": 5, "crew": 1})
    r = optimize([crit], [pool("p", "pump", 2), pool("c", "crew", 3)])
    assert r.relaxed is True and r.feasible is False
    assert total(r, "pump") == 2               # best effort still dispatches what exists
    short = [s for s in r.shortages if s["resource_type"] == "pump"]
    assert short and short[0]["short_by"] == 3
    assert any("RELAXED" in n for n in r.notes)


def test_infeasible_without_relaxation_is_rejected():
    crit = inc("crit", level="critical", score=95, demand={"pump": 5, "crew": 1})
    r = optimize([crit], [pool("p", "pump", 2), pool("c", "crew", 3)], Constraints(allow_relaxation=False))
    assert r.status == "INFEASIBLE" and r.assignments == []


def test_conflicting_constraints_detected_before_solving():
    r = optimize([inc("i1")], [pool("p", "pump", 3)], Constraints(reserve_ratio=1.0, max_distance_km=0))
    assert r.status == "INVALID_CONSTRAINTS"
    assert len(r.conflicts) == 2


def test_reserve_ratio_keeps_strategic_stock():
    r = optimize([inc("i1", demand={"pump": 10, "crew": 1})], [pool("p", "pump", 10), pool("c", "crew", 2)],
                 Constraints(reserve_ratio=0.3, require_full_coverage_critical=False))
    assert total(r, "pump") == 7


def test_org_isolation_constraint():
    a = pool("a", "relief_kit", 50); a.organization_id = "ngo-a"
    b = pool("b", "relief_kit", 50); b.organization_id = "ngo-b"
    r = optimize([inc("i1", demand={"relief_kit": 30})], [a, b], Constraints(allowed_org_ids=["ngo-b"]))
    assert {x["resource_id"] for x in r.assignments} == {"b"}


def test_demand_derivation_rules():
    d = derive_demand("waterlogging", 65, 300, "critical")
    assert d["pump"] == 3 and d["crew"] == 2 and d["relief_kit"] > 0
    d = derive_demand("relief_need", None, 450, "moderate")
    assert d["relief_kit"] == 100 and d["water_tank"] == 1
    assert derive_demand("blocked_drain", 0, 0, "low") == {"crew": 1}
