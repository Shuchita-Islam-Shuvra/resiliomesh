from __future__ import annotations

import numpy as np
import pandas as pd

from .features import FEATURES, monsoon_factor

CLIMATOLOGY = {
    1: (7, 1), 2: (19, 2), 3: (40, 3), 4: (110, 7), 5: (260, 12), 6: (360, 17),
    7: (400, 21), 8: (320, 19), 9: (300, 15), 10: (170, 7), 11: (30, 1), 12: (10, 1),
}


def severity(df: pd.DataFrame, rng: np.random.Generator | None = None) -> np.ndarray:
    cond = 0.45 + 0.55 * (df["asset_condition"] / 100.0)
    eff_capacity = df["drainage_capacity_mm_hr"] * cond * np.maximum(0.5, 1 - 0.08 * df["blocked_assets"])
    excess = np.clip(df["max_hourly_mm"] - eff_capacity, 0, None)
    storage = np.clip((df["rain_past_24h_mm"] + 0.6 * df["rain_next_24h_mm"]) / 150.0, 0, 1.6)
    s = (
        excess * 1.35
        + storage * 22
        + (df["impervious_pct"] - 60).clip(lower=0) * 0.35
        + (7.5 - df["elevation_m"]).clip(lower=0) * 4.0
        + df["historical_events_10y"] * 0.22
        + np.minimum(df["recent_reports_6h"], 8) * 2.5
        + df["monsoon"] * 4
    )
    if rng is not None:
        s = s + rng.normal(0, 4.0, len(df))
    return np.clip(s, 0, 100)


def generate(n: int = 24000, seed: int = 7) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    month = rng.integers(1, 13, n)
    mean_mm = np.array([CLIMATOLOGY[m][0] for m in month])
    rainy = np.array([CLIMATOLOGY[m][1] for m in month])
    p_rain = rainy / 30.0
    is_rain_past = rng.random(n) < p_rain
    is_rain_next = rng.random(n) < p_rain
    per_event = mean_mm / np.maximum(rainy, 1)
    past = np.where(is_rain_past, rng.gamma(1.4, per_event / 1.4), 0.0)
    nxt = np.where(is_rain_next, rng.gamma(1.4, per_event / 1.4), 0.0)
    burst = rng.random(n) < 0.02
    nxt = np.where(burst, nxt + rng.uniform(80, 250, n), nxt)
    max_hourly = np.where(nxt > 0, nxt * rng.uniform(0.18, 0.45, n), 0.0)

    df = pd.DataFrame({
        "rain_past_24h_mm": past.round(1),
        "rain_next_24h_mm": nxt.round(1),
        "max_hourly_mm": max_hourly.round(1),
        "drainage_capacity_mm_hr": rng.uniform(15, 45, n).round(1),
        "impervious_pct": rng.uniform(60, 96, n).round(1),
        "elevation_m": rng.uniform(3.5, 8.5, n).round(2),
        "asset_condition": rng.uniform(15, 95, n).round(0),
        "blocked_assets": rng.poisson(0.8, n),
        "historical_events_10y": rng.integers(5, 60, n),
        "recent_reports_6h": rng.poisson(np.where(nxt > 30, 2.5, 0.3)),
        "monsoon": [monsoon_factor(int(m)) for m in month],
    })
    df["month"] = month
    df["severity"] = severity(df, rng).round(2)
    return df[FEATURES + ["month", "severity"]]
