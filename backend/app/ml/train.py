"""Train and persist the risk model:  python -m app.ml.train"""
from __future__ import annotations

import json
import logging
from pathlib import Path

import pandas as pd

from ..core.config import get_settings
from .model import RiskModel
from .synth import generate


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    s = get_settings()
    csv = Path(s.historical_csv)
    df = pd.read_csv(csv) if csv.exists() else generate()
    model = RiskModel.train(df)
    model.save(s.model_path)
    print(json.dumps({"saved": s.model_path, "metrics": model.metrics}, indent=2))


if __name__ == "__main__":
    main()
