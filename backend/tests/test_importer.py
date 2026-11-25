import time

import numpy as np
import pandas as pd

from app.services.importer import clean_events

WARDS = {"DNCC-01", "DSCC-02"}


def test_duplicates_missing_and_invalid_rows():
    df = pd.DataFrame({
        "ward_id": ["dncc-01", "DNCC-01", "DNCC-01", "DSCC-02", "BAD-1", "DSCC-02"],
        "event_date": ["2020-07-01", "2020-07-01", "2020-07-02", "2020/07/03", "2020-07-04", "garbage"],
        "rainfall_mm": ["80", "", "60", "-3", "50", "40"],
        "max_depth_cm": ["40", "40", "", "30", "10", "10"],
        "duration_hr": ["", "4", "5", "6", "1", "1"],
        "households_affected": ["100", "", "", "20", "1", "1"],
    })
    clean, rep = clean_events(df, WARDS)
    assert rep["rows_read"] == 6
    assert rep["rejected_invalid_key"] == 2
    assert rep["duplicates_in_file"] == 1
    assert rep["clean_rows"] == 3
    assert clean.isna().sum().sum() == 0
    row = clean[(clean.ward_id == "DNCC-01") & (clean.event_date.astype(str) == "2020-07-01")].iloc[0]
    assert row.rainfall_mm == 80
    assert (clean.rainfall_mm >= 0).all()


def test_missing_required_column_is_reported():
    try:
        clean_events(pd.DataFrame({"ward_id": ["DNCC-01"]}), WARDS)
    except ValueError as e:
        assert "event_date" in str(e)
    else:
        raise AssertionError("expected ValueError")


def test_large_volume_120k_rows_is_fast():
    n = 120_000
    rng = np.random.default_rng(1)
    df = pd.DataFrame({
        "ward_id": rng.choice(sorted(WARDS), n),
        "event_date": pd.to_datetime(rng.integers(0, 3650, n), unit="D", origin="2000-01-01").strftime("%Y-%m-%d"),
        "rainfall_mm": rng.gamma(2, 30, n).round(1).astype(str),
        "max_depth_cm": rng.integers(0, 100, n).astype(str),
    })
    df.loc[rng.choice(n, 5000, replace=False), "rainfall_mm"] = ""
    t0 = time.perf_counter()
    clean, rep = clean_events(df, WARDS)
    elapsed = time.perf_counter() - t0
    assert elapsed < 15, f"too slow: {elapsed:.1f}s"
    assert rep["clean_rows"] == len(clean) == clean[["ward_id", "event_date"]].drop_duplicates().shape[0]
    assert rep["clean_rows"] <= 2 * 3650
    assert clean.record_hash.is_unique
