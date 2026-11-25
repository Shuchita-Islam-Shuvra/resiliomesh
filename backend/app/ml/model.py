from __future__ import annotations

import json
import logging
import threading
from pathlib import Path

import numpy as np
import pandas as pd
import xgboost as xgb

from .features import FEATURE_LABELS, FEATURES, clean_features

log = logging.getLogger("resiliomesh.ml")
MODEL_VERSION = "xgb-risk-1.2"


class RiskModel:
    def __init__(self, booster: xgb.Booster, metrics: dict | None = None):
        self.booster = booster
        self.metrics = metrics or {}
        self.version = MODEL_VERSION

    @classmethod
    def train(cls, df: pd.DataFrame, seed: int = 7) -> "RiskModel":
        df = df.drop_duplicates()
        X, y = df[FEATURES].astype(float), df["severity"].astype(float)
        rng = np.random.default_rng(seed)
        idx = rng.permutation(len(df))
        cut = int(len(df) * 0.8)
        tr, te = idx[:cut], idx[cut:]
        dtrain = xgb.DMatrix(X.iloc[tr], label=y.iloc[tr], feature_names=FEATURES)
        dtest = xgb.DMatrix(X.iloc[te], label=y.iloc[te], feature_names=FEATURES)
        params = {"objective": "reg:squarederror", "max_depth": 5, "eta": 0.08, "subsample": 0.9,
                  "colsample_bytree": 0.9, "min_child_weight": 3, "seed": seed, "eval_metric": "mae"}
        booster = xgb.train(params, dtrain, num_boost_round=350, evals=[(dtest, "test")],
                            early_stopping_rounds=30, verbose_eval=False)
        pred = booster.predict(dtest, iteration_range=(0, booster.best_iteration + 1))
        mae = float(np.mean(np.abs(pred - y.iloc[te].values)))
        ss_res = float(np.sum((pred - y.iloc[te].values) ** 2))
        ss_tot = float(np.sum((y.iloc[te].values - y.iloc[te].mean()) ** 2))
        metrics = {"mae": round(mae, 3), "r2": round(1 - ss_res / ss_tot, 4),
                   "n_train": int(len(tr)), "n_test": int(len(te)), "best_iteration": int(booster.best_iteration)}
        log.info("Trained risk model %s", metrics)
        return cls(booster, metrics)

    def save(self, path: str | Path) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        self.booster.save_model(str(path))
        path.with_suffix(".meta.json").write_text(json.dumps({"version": self.version, "metrics": self.metrics}))

    @classmethod
    def load(cls, path: str | Path) -> "RiskModel":
        path = Path(path)
        booster = xgb.Booster()
        booster.load_model(str(path))
        meta_path = path.with_suffix(".meta.json")
        metrics = json.loads(meta_path.read_text()).get("metrics", {}) if meta_path.exists() else {}
        return cls(booster, metrics)

    def predict(self, raw_features: dict) -> dict:
        feats = clean_features(raw_features)
        dm = xgb.DMatrix(pd.DataFrame([feats], columns=FEATURES).astype(float), feature_names=FEATURES)
        score = float(np.clip(self.booster.predict(dm)[0], 0, 100))
        contribs = self.booster.predict(dm, pred_contribs=True)[0]
        bias = float(contribs[-1])
        items = [
            {"feature": f, "label": FEATURE_LABELS[f], "value": feats[f], "contribution": round(float(c), 2)}
            for f, c in zip(FEATURES, contribs[:-1])
        ]
        items.sort(key=lambda d: abs(d["contribution"]), reverse=True)
        return {"score": round(score, 2), "baseline": round(bias, 2), "features": feats, "contributions": items}


_model: RiskModel | None = None
_lock = threading.Lock()


def get_model(path: str, csv_path: str | None = None) -> RiskModel:
    global _model
    with _lock:
        if _model is not None:
            return _model
        if Path(path).exists():
            _model = RiskModel.load(path)
        else:
            from .synth import generate
            df = pd.read_csv(csv_path) if csv_path and Path(csv_path).exists() else generate()
            _model = RiskModel.train(df)
            try:
                _model.save(path)
            except OSError:
                log.warning("Could not persist model to %s", path)
        return _model
