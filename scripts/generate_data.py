from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.ml.synth import generate

WARDS = [f"DNCC-{i:02d}" for i in range(1, 11)] + [f"DSCC-{i:02d}" for i in range(1, 11)]


def bulk_sample(n: int = 120_000, seed: int = 11) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    dates = pd.date_range("1995-01-01", "2014-12-31", freq="D")
    df = pd.DataFrame({
        "ward_id": rng.choice(WARDS, n),
        "event_date": rng.choice(dates, n),
        "rainfall_mm": rng.gamma(2.0, 30.0, n).round(1),
        "max_depth_cm": rng.integers(5, 120, n),
        "duration_hr": rng.uniform(0.5, 30, n).round(1),
        "households_affected": rng.integers(0, 4000, n),
    })
    df["event_date"] = pd.to_datetime(df["event_date"]).dt.strftime("%Y-%m-%d")
    for col, frac in [("rainfall_mm", 0.06), ("max_depth_cm", 0.05), ("duration_hr", 0.08), ("households_affected", 0.1)]:
        idx = rng.choice(n, int(n * frac), replace=False)
        df[col] = df[col].astype(object)
        df.loc[idx, col] = ""
    bad = rng.choice(n, 300, replace=False)
    df.loc[bad[:100], "ward_id"] = "UNKNOWN-99"
    df.loc[bad[100:200], "event_date"] = "not-a-date"
    df.loc[bad[200:], "rainfall_mm"] = -12
    dups = df.sample(frac=0.04, random_state=seed)
    df = pd.concat([df, dups], ignore_index=True).sample(frac=1, random_state=seed)
    return df


if __name__ == "__main__":
    out = ROOT / "data"
    out.mkdir(exist_ok=True)
    train = generate()
    train.to_csv(out / "historical_rainfall_events.csv", index=False)
    print(f"training set: {len(train)} rows")
    bulk = bulk_sample()
    bulk.to_csv(out / "bulk_import_sample.csv", index=False)
    print(f"bulk import sample: {len(bulk)} rows")
