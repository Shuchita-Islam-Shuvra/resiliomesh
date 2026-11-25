from __future__ import annotations

import hashlib
import io
import time

import numpy as np
import pandas as pd

from ..core import db

REQUIRED = ["ward_id", "event_date"]
NUMERIC = ["rainfall_mm", "max_depth_cm", "duration_hr", "households_affected"]
MAX_ROWS = 500_000


def clean_events(df: pd.DataFrame, valid_wards: set[str]) -> tuple[pd.DataFrame, dict]:
    t0 = time.perf_counter()
    report = {"rows_read": int(len(df))}
    df.columns = [c.strip().lower() for c in df.columns]
    missing_cols = [c for c in REQUIRED if c not in df.columns]
    if missing_cols:
        raise ValueError(f"missing required columns: {missing_cols}")
    for c in NUMERIC:
        if c not in df.columns:
            df[c] = np.nan

    df["ward_id"] = df["ward_id"].astype(str).str.strip().str.upper()
    df["event_date"] = pd.to_datetime(df["event_date"], errors="coerce", format="mixed").dt.date
    for c in NUMERIC:
        df[c] = pd.to_numeric(df[c], errors="coerce")
        df.loc[df[c] < 0, c] = np.nan

    bad_key = df["event_date"].isna() | ~df["ward_id"].isin(valid_wards)
    report["rejected_invalid_key"] = int(bad_key.sum())
    df = df[~bad_key].copy()

    report["missing_values_imputed"] = {c: int(df[c].isna().sum()) for c in NUMERIC}
    df["_completeness"] = df[NUMERIC].notna().sum(axis=1)
    df = df.sort_values("_completeness", ascending=False)
    before = len(df)
    df = df.drop_duplicates(subset=["ward_id", "event_date"], keep="first")
    report["duplicates_in_file"] = int(before - len(df))

    df["_month"] = pd.to_datetime(df["event_date"]).dt.month
    defaults = {"rainfall_mm": 40.0, "max_depth_cm": 20.0, "duration_hr": 3.0, "households_affected": 0.0}
    for c in NUMERIC:
        grp = df.groupby(["ward_id", "_month"])[c].transform("median")
        df[c] = df[c].fillna(grp).fillna(df[c].median()).fillna(defaults[c])
    df["max_depth_cm"] = df["max_depth_cm"].clip(0, 300).round().astype(int)
    df["households_affected"] = df["households_affected"].clip(0, 1_000_000).round().astype(int)
    df["rainfall_mm"] = df["rainfall_mm"].clip(0, 600).round(1)
    df["duration_hr"] = df["duration_hr"].clip(0, 240).round(1)
    df["record_hash"] = [hashlib.md5(f"{w}{d}".encode()).hexdigest() for w, d in zip(df["ward_id"], df["event_date"])]
    df = df.drop(columns=["_completeness", "_month"]).sort_values(["ward_id", "event_date"])
    report["clean_rows"] = int(len(df))
    report["clean_ms"] = int((time.perf_counter() - t0) * 1000)
    return df[["ward_id", "event_date", "rainfall_mm", "max_depth_cm", "duration_hr", "households_affected",
               "record_hash"]], report


def import_csv(content: bytes, actor_id: str) -> dict:
    t0 = time.perf_counter()
    df = pd.read_csv(io.BytesIO(content), dtype=str, keep_default_na=True, nrows=MAX_ROWS + 1)
    if len(df) > MAX_ROWS:
        raise ValueError(f"file exceeds {MAX_ROWS} rows")
    with db.tx() as conn:
        wards = {r["id"] for r in db.fetch_all(conn, "select id from wards")}
    clean, report = clean_events(df, wards)

    with db.tx(actor_id=actor_id) as conn:
        conn.execute("""create temp table _hfe_import (ward_id text, event_date date, rainfall_mm numeric,
                        max_depth_cm int, duration_hr numeric, households_affected int, record_hash text) on commit drop""")
        with conn.cursor().copy("copy _hfe_import from stdin") as cp:
            for row in clean.itertuples(index=False):
                cp.write_row(tuple(v.item() if hasattr(v, "item") else v for v in row))
        inserted = conn.execute("""
            with ins as (
              insert into historical_flood_events(ward_id, event_date, rainfall_mm, max_depth_cm, duration_hr,
                                                  households_affected, source, record_hash)
              select ward_id, event_date, rainfall_mm, max_depth_cm, duration_hr, households_affected, 'csv-import', record_hash
              from _hfe_import
              on conflict (record_hash) do nothing returning 1)
            select count(*) as n from ins""").fetchone()["n"]
    report["inserted"] = int(inserted)
    report["duplicates_existing_in_db"] = report["clean_rows"] - int(inserted)
    report["total_ms"] = int((time.perf_counter() - t0) * 1000)
    return report
