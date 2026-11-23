"""M03 auth/authorization + M06 validation at the HTTP layer."""
from app.core.ratelimit import SlidingWindowLimiter


def test_health_is_public(client_as):
    assert client_as(None).get("/health").json()["status"] == "ok"


def test_protected_route_requires_token(client_as):
    r = client_as(None).get("/api/me")
    assert r.status_code == 401


def test_garbage_token_rejected(client_as):
    r = client_as(None).get("/api/me", headers={"Authorization": "Bearer not.a.jwt"})
    assert r.status_code == 401


def test_citizen_cannot_run_optimizer(client_as):
    r = client_as("citizen").post("/api/plans/optimize", json={"incident_ids": ["00000000-0000-0000-0000-000000000001"]})
    assert r.status_code == 403


def test_field_worker_cannot_assess_risk(client_as):
    r = client_as("field_worker").post("/api/risk/incidents/00000000-0000-0000-0000-000000000001/assess")
    assert r.status_code == 403


def test_only_admin_can_toggle_chaos(client_as):
    assert client_as("city_officer").post("/api/admin/chaos", json={"weather_mode": "timeout"}).status_code == 403
    r = client_as("admin").post("/api/admin/chaos", json={"weather_mode": "normal"})
    assert r.status_code == 200


def test_invalid_payloads_return_structured_422(client_as):
    c = client_as("city_officer")
    r = c.post("/api/plans/optimize", json={"incident_ids": ["not-a-uuid"]})
    assert r.status_code == 422 and r.json()["error"] == "VALIDATION"
    r = c.post("/api/plans/optimize", json={"incident_ids": []})
    assert r.status_code == 422
    r = client_as("admin").post("/api/admin/chaos", json={"weather_mode": "explode"})
    assert r.status_code == 422


def test_simulate_endpoint_explains_score(client_as):
    r = client_as("city_officer").post("/api/risk/simulate", json={
        "features": {"rain_next_24h_mm": 120, "max_hourly_mm": 45}, "context": {"water_depth_cm": 50}})
    assert r.status_code == 200
    body = r.json()
    assert body["level"] in ("high", "critical") and len(body["contributions"]) == 11


def test_simulate_rejects_unknown_features(client_as):
    r = client_as("city_officer").post("/api/risk/simulate", json={"features": {"hack": 1}})
    assert r.status_code == 422


def test_rate_limiter_sliding_window():
    lim = SlidingWindowLimiter(limit=3, window_s=60)
    assert [lim.allow("u", now=t)[0] for t in (0, 1, 2, 3)] == [True, True, True, False]
    assert lim.allow("u", now=61)[0] is True       # window slid
    assert lim.allow("other", now=3)[0] is True    # per-identity buckets
