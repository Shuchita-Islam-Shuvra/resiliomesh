from functools import lru_cache
from pathlib import Path

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT_DIR = Path(__file__).resolve().parents[3]
BACKEND_DIR = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=(BACKEND_DIR / ".env"), extra="ignore")

    app_env: str = "development"
    supabase_url: str = ""
    supabase_jwt_secret: str = ""
    supabase_service_role_key: str = ""
    database_url: str = ""
    supabase_anon_key: str = Field("", validation_alias=AliasChoices("SUPABASE_ANON_KEY", "VITE_SUPABASE_ANON_KEY"))

    demo_mode: bool = False
    demo_password: str = ""
    demo_access_code: str = ""

    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    weather_base_url: str = "https://api.open-meteo.com/v1/forecast"
    weather_timeout_s: float = 4.0
    weather_max_retries: int = 3
    weather_cache_fresh_min: int = 30
    weather_cache_stale_hours: int = 24
    circuit_fail_threshold: int = 3
    circuit_reset_s: int = 60

    rate_limit_per_minute: int = 120

    worker_in_process: bool = True
    worker_poll_s: float = 2.0
    worker_id: str = "worker-1"

    model_path: str = str(BACKEND_DIR / "models" / "risk_xgb.json")
    historical_csv: str = str(ROOT_DIR / "data" / "historical_rainfall_events.csv")
    climatology_csv: str = str(ROOT_DIR / "data" / "dhaka_monthly_climatology.csv")

    frontend_dist: str = ""

    @property
    def cors_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
