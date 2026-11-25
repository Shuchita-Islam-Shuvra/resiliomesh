import pytest

from app.ml.features import FEATURES, clean_features
from app.ml.rules import apply_rules, level_for, priority
from app.services.risk import model, score

BASE = {
    "rain_past_24h_mm": 20, "rain_next_24h_mm": 30, "max_hourly_mm": 10, "drainage_capacity_mm_hr": 25,
    "impervious_pct": 85, "elevation_m": 5.5, "asset_condition": 60, "blocked_assets": 1,
    "historical_events_10y": 30, "recent_reports_6h": 0, "monsoon": 1,
}


def test_shap_contributions_explain_the_score():
    out = model().predict(BASE)
    total = out["baseline"] + sum(c["contribution"] for c in out["contributions"])
    assert out["score"] == pytest.approx(min(100, max(0, total)), abs=0.5)
    assert {c["feature"] for c in out["contributions"]} == set(FEATURES)


def test_more_rain_means_higher_risk():
    low = model().predict({**BASE, "rain_next_24h_mm": 5, "max_hourly_mm": 2})["score"]
    high = model().predict({**BASE, "rain_next_24h_mm": 180, "max_hourly_mm": 70})["score"]
    assert high > low + 15


def test_blocked_drains_and_poor_condition_raise_risk():
    good = model().predict({**BASE, "max_hourly_mm": 35, "asset_condition": 95, "blocked_assets": 0})["score"]
    bad = model().predict({**BASE, "max_hourly_mm": 35, "asset_condition": 15, "blocked_assets": 4})["score"]
    assert bad > good


def test_missing_and_garbage_features_are_imputed_not_crashing():
    feats = clean_features({"rain_past_24h_mm": None, "max_hourly_mm": "abc", "blocked_assets": float("nan"),
                            "impervious_pct": -5})
    assert all(isinstance(v, float) for v in feats.values())
    assert feats["impervious_pct"] == 80.0
    model().predict({})


@pytest.mark.parametrize("score,level", [(0, "low"), (34.9, "low"), (35, "moderate"), (55, "high"),
                                         (74.99, "high"), (75, "critical"), (100, "critical")])
def test_level_boundaries(score, level):
    assert level_for(score) == level


def test_depth_rule_forces_floor():
    r = apply_rules(20, {"water_depth_cm": 50})
    assert r["level"] == "high" and r["score"] == 55
    r = apply_rules(20, {"water_depth_cm": 80})
    assert r["level"] == "critical"
    assert {f["code"] for f in r["rules_fired"]} >= {"DEPTH_45CM", "DEPTH_75CM"}


def test_blocked_asset_with_heavy_forecast_is_critical():
    r = apply_rules(40, {"asset_status": "blocked", "rain_next_24h_mm": 60})
    assert r["level"] == "critical"


def test_dry_spell_caps_false_alarms():
    r = apply_rules(70, {"rain_past_24h_mm": 0, "rain_next_24h_mm": 0, "water_depth_cm": 5})
    assert r["score"] <= 45


def test_rules_never_exceed_bounds():
    r = apply_rules(98, {"recent_reports_6h": 9, "people_affected": 5000, "water_depth_cm": 200})
    assert r["score"] == 100


def test_priority_combines_risk_people_age():
    assert priority(80, 1000, 5, 10) > priority(80, 10, 1, 0)
    assert 0 <= priority(100, 10**6, 5, 1000) <= 100


def test_full_pipeline_score():
    r = score({**BASE, "max_hourly_mm": 60, "rain_next_24h_mm": 150}, {"water_depth_cm": 60, "category": "waterlogging"})
    assert r["level"] in ("high", "critical")
    assert r["model_version"]
