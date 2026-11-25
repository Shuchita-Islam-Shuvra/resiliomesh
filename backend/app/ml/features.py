from __future__ import annotations

FEATURES: list[str] = [
    "rain_past_24h_mm",
    "rain_next_24h_mm",
    "max_hourly_mm",
    "drainage_capacity_mm_hr",
    "impervious_pct",
    "elevation_m",
    "asset_condition",
    "blocked_assets",
    "historical_events_10y",
    "recent_reports_6h",
    "monsoon",
]

FEATURE_LABELS: dict[str, str] = {
    "rain_past_24h_mm": "Rainfall last 24h",
    "rain_next_24h_mm": "Forecast rain next 24h",
    "max_hourly_mm": "Peak hourly intensity",
    "drainage_capacity_mm_hr": "Drainage capacity",
    "impervious_pct": "Impervious surface",
    "elevation_m": "Ground elevation",
    "asset_condition": "Drainage asset condition",
    "blocked_assets": "Blocked drains in ward",
    "historical_events_10y": "Historical waterlogging events",
    "recent_reports_6h": "Nearby reports (6h)",
    "monsoon": "Monsoon season",
}


def monsoon_factor(month: int) -> float:
    if 6 <= month <= 9:
        return 1.0
    if month in (5, 10):
        return 0.5
    return 0.0


def clean_features(raw: dict) -> dict[str, float]:
    defaults = {
        "rain_past_24h_mm": 0.0, "rain_next_24h_mm": 0.0, "max_hourly_mm": 0.0,
        "drainage_capacity_mm_hr": 25.0, "impervious_pct": 80.0, "elevation_m": 5.5,
        "asset_condition": 60.0, "blocked_assets": 0.0, "historical_events_10y": 20.0,
        "recent_reports_6h": 0.0, "monsoon": 0.0,
    }
    out: dict[str, float] = {}
    for f in FEATURES:
        v = raw.get(f)
        try:
            v = float(v)
            if v != v or v < 0 and f != "elevation_m":
                v = defaults[f]
        except (TypeError, ValueError):
            v = defaults[f]
        out[f] = v
    return out
