from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT_DIR = Path(__file__).resolve().parents[3]
BACKEND_DIR = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=(BACKEND_DIR / ".env"), extra="ignore")

    app_env: str = "development"
    # Supabase
    supabase_url: str = ""
    supabase_jwt_secret: str = ""          # legacy HS256 secret (optional)
    supabase_service_role_key: str = ""    # only used by seed scripts
    database_url: str = ""                 # direct / pooler Postgres connection string
    demo_password: str = ""                # only for scripts/seed_demo.py

    # CORS
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    # Weather API (Open-Meteo, no key required)
    weather_base_url: str = "https://api.open-meteo.com/v1/forecast"
    weather_timeout_s: float = 4.0
    weather_max_retries: int = 3
    weather_cache_fresh_min: int = 30
    weather_cache_stale_hours: int = 24
    circuit_fail_threshold: int = 3
    circuit_reset_s: int = 60

    # Rate limiting for our own API
    rate_limit_per_minute: int = 120

    # Workflow worker
    worker_in_process: bool = True
    worker_poll_s: float = 2.0
    worker_id: str = "worker-1"

    # ML
    model_path: str = str(BACKEND_DIR / "models" / "risk_xgb.json")
    historical_csv: str = str(ROOT_DIR / "data" / "historical_rainfall_events.csv")
    climatology_csv: str = str(ROOT_DIR / "data" / "dhaka_monthly_climatology.csv")

    # Built React app (frontend/dist). When set, the API also serves the website,
    # so frontend + backend deploy as one service on one URL. Empty = API only.
    frontend_dist: str = ""

    @property
    def cors_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
