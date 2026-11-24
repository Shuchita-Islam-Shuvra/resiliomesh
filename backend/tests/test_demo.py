"""Judge demo sign-in (M03 / S03): off by default, private access code, no password leaves the server."""
import pytest

from app.api import demo
from app.core import config

CODE = "judge-code-123456"


@pytest.fixture
def demo_on(monkeypatch):
    for k, v in {"DEMO_MODE": "true", "DEMO_PASSWORD": "server-only-password", "DEMO_ACCESS_CODE": CODE,
                 "SUPABASE_URL": "https://example.supabase.co", "SUPABASE_ANON_KEY": "anon"}.items():
        monkeypatch.setenv(k, v)
    config.get_settings.cache_clear()
    demo._attempts._hits.clear()
    calls = []

    def fake_grant(email, password):
        calls.append((email, password))
        return {"access_token": "at", "refresh_token": "rt"}
    monkeypatch.setattr(demo, "password_grant", fake_grant)
    yield calls
    config.get_settings.cache_clear()


@pytest.fixture(autouse=True)
def fresh_settings():
    config.get_settings.cache_clear()
    yield
    config.get_settings.cache_clear()


def test_off_by_default(client_as, monkeypatch):
    monkeypatch.setenv("DEMO_MODE", "false")
    config.get_settings.cache_clear()
    c = client_as(None)
    assert c.get("/api/demo").json() == {"enabled": False, "code_required": False}
    r = c.post("/api/demo/session", json={"profile": "admin", "code": CODE})
    assert r.status_code == 404 and r.json()["error"] == "DEMO_OFF"


def test_wrong_code_is_refused(client_as, demo_on):
    r = client_as(None).post("/api/demo/session", json={"profile": "admin", "code": "guess"})
    assert r.status_code == 403 and r.json()["error"] == "DEMO_CODE"
    assert demo_on == []                                  # never reached Supabase Auth


def test_right_code_returns_session_and_second_factor(client_as, demo_on):
    c = client_as(None)
    assert c.get("/api/demo").json() == {"enabled": True, "code_required": True}
    r = c.post("/api/demo/session", json={"profile": "officer_north", "code": f"  {CODE} "})
    body = r.json()
    assert r.status_code == 200
    assert body == {"access_token": "at", "refresh_token": "rt", "role": "city_officer",
                    "extra": {"employee_id": "DNCC-OFF-02"}}
    assert demo_on == [("officer2@resiliomesh.demo", "server-only-password")]
    assert "server-only-password" not in r.text


def test_unknown_profile_is_a_validation_error(client_as, demo_on):
    r = client_as(None).post("/api/demo/session", json={"profile": "root", "code": CODE})
    assert r.status_code == 422


def test_code_guessing_is_rate_limited(client_as, demo_on):
    c = client_as(None)
    codes = [c.post("/api/demo/session", json={"profile": "citizen", "code": f"x{i}"}).status_code for i in range(12)]
    assert codes[:10] == [403] * 10 and codes[10:] == [429, 429]


def test_supabase_failure_is_reported_cleanly(client_as, demo_on, monkeypatch):
    def boom(*_):
        raise RuntimeError("Supabase Auth answered 400")
    monkeypatch.setattr(demo, "password_grant", boom)
    r = client_as(None).post("/api/demo/session", json={"profile": "admin", "code": CODE})
    assert r.status_code == 502 and r.json()["error"] == "DEMO_UNAVAILABLE"


def test_without_an_access_code_profiles_open_with_one_click(client_as, demo_on, monkeypatch):
    monkeypatch.setenv("DEMO_ACCESS_CODE", "")
    config.get_settings.cache_clear()
    c = client_as(None)
    assert c.get("/api/demo").json() == {"enabled": True, "code_required": False}
    r = c.post("/api/demo/session", json={"profile": "citizen"})
    assert r.status_code == 200 and r.json()["role"] == "citizen"
    assert demo_on == [("citizen@resiliomesh.demo", "server-only-password")]
