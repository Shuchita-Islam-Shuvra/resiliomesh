from datetime import datetime, timedelta, timezone

import httpx

from app.services.weather import DHAKA_TZ, CircuitBreaker, MemoryCache, WeatherClient


def good_payload():
    now = datetime.now(DHAKA_TZ).replace(minute=0, second=0, microsecond=0, tzinfo=None)
    times = [(now + timedelta(hours=h)).strftime("%Y-%m-%dT%H:%M") for h in range(-24, 24)]
    precip = [1.0] * 24 + [2.0] * 23 + [12.0]
    return {"latitude": 23.75, "longitude": 90.4,
            "hourly": {"time": times, "precipitation": precip, "precipitation_probability": [80] * 48}}


def client_with(handler, **kw):
    calls = {"n": 0}

    def wrapped(request):
        calls["n"] += 1
        return handler(request, calls["n"])

    c = WeatherClient(transport=httpx.MockTransport(wrapped), sleep=lambda s: None, cache=MemoryCache(), **kw)
    return c, calls


def test_live_success_is_summarised():
    c, calls = client_with(lambda r, n: httpx.Response(200, json=good_payload()))
    out = c.get("W1", 23.75, 90.4)
    assert out["source"] == "live" and not out["degraded"]
    assert out["rain_past_24h_mm"] == 24.0
    assert out["rain_next_24h_mm"] == 58.0
    assert out["max_hourly_mm"] == 12.0
    assert calls["n"] == 1


def test_second_call_served_from_fresh_cache():
    c, calls = client_with(lambda r, n: httpx.Response(200, json=good_payload()))
    c.get("W1", 23.75, 90.4)
    out = c.get("W1", 23.75, 90.4)
    assert out["source"] == "cache" and calls["n"] == 1


def test_timeout_retries_then_falls_back_to_climatology():
    def timeout(r, n):
        raise httpx.ReadTimeout("slow", request=r)
    c, calls = client_with(timeout, max_retries=3)
    out = c.get("W1", 23.75, 90.4)
    assert calls["n"] == 3
    assert out["source"] == "climatology" and out["degraded"]
    assert out["rain_next_24h_mm"] >= 0 and "ReadTimeout" in out["error"]


def test_transient_500_then_success_recovers_on_retry():
    c, calls = client_with(lambda r, n: httpx.Response(503) if n < 3 else httpx.Response(200, json=good_payload()))
    out = c.get("W1", 23.75, 90.4)
    assert out["source"] == "live" and out["attempts"] == 3


def test_malformed_payload_is_rejected_without_retry_storm():
    bad = {"latitude": 1, "longitude": 2, "hourly": {"time": ["2026-01-01T00:00", "x"], "precipitation": [-5]}}
    c, calls = client_with(lambda r, n: httpx.Response(200, json=bad))
    out = c.get("W1", 23.75, 90.4)
    assert calls["n"] == 1
    assert out["source"] == "climatology" and "MalformedResponse" in out["error"]


def test_non_json_body_is_handled():
    c, _ = client_with(lambda r, n: httpx.Response(200, text="<html>gateway</html>"))
    assert c.get("W1", 23.75, 90.4)["source"] == "climatology"


def test_stale_cache_preferred_over_climatology():
    c, _ = client_with(lambda r, n: httpx.Response(503))
    c.cache.data["W1"] = ({"rain_past_24h_mm": 9, "rain_next_24h_mm": 42, "max_hourly_mm": 8,
                           "max_precip_prob": 70, "hourly": []},
                          datetime.now(timezone.utc) - timedelta(hours=3))
    out = c.get("W1", 23.75, 90.4)
    assert out["source"] == "stale_cache" and out["rain_next_24h_mm"] == 42 and out["degraded"]


def test_circuit_breaker_opens_and_skips_upstream():
    def timeout(r, n):
        raise httpx.ConnectTimeout("down", request=r)
    clock = {"t": 0.0}
    c, calls = client_with(timeout, max_retries=1,
                           breaker=CircuitBreaker(threshold=2, reset_s=60, clock=lambda: clock["t"]))
    c.get("A", 23.7, 90.4)
    c.get("B", 23.7, 90.4)
    assert c.breaker.state == "open"
    before = calls["n"]
    out = c.get("C", 23.7, 90.4)
    assert calls["n"] == before
    assert "circuit breaker open" in out["error"]
    clock["t"] = 61
    assert c.breaker.state == "half_open"


def test_chaos_mode_simulates_outage():
    c, calls = client_with(lambda r, n: httpx.Response(200, json=good_payload()))
    c.chaos_mode = "malformed"
    assert c.get("W1", 23.7, 90.4)["source"] == "climatology"
    c.chaos_mode = "normal"
    c.breaker.success()
    assert c.get("W1", 23.7, 90.4)["source"] == "live"
