from __future__ import annotations

import csv
import logging
import random
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Protocol

import httpx
from pydantic import BaseModel, ValidationError, field_validator, model_validator

log = logging.getLogger("resiliomesh.weather")
DHAKA_TZ = timezone(timedelta(hours=6))


class _Hourly(BaseModel):
    time: list[str]
    precipitation: list[float | None]
    precipitation_probability: list[float | None] | None = None

    @model_validator(mode="after")
    def same_length(self):
        if not self.time:
            raise ValueError("empty hourly series")
        if len(self.precipitation) != len(self.time):
            raise ValueError("precipitation/time length mismatch")
        if self.precipitation_probability is not None and len(self.precipitation_probability) != len(self.time):
            raise ValueError("probability/time length mismatch")
        return self

    @field_validator("precipitation")
    @classmethod
    def sane_precip(cls, v):
        for x in v:
            if x is not None and not (0 <= x <= 500):
                raise ValueError(f"implausible hourly precipitation {x}")
        return v


class OpenMeteoResponse(BaseModel):
    latitude: float
    longitude: float
    hourly: _Hourly


class MalformedResponse(Exception):
    pass


class UpstreamUnavailable(Exception):
    pass


class CircuitBreaker:
    def __init__(self, threshold: int = 3, reset_s: float = 60, clock=time.monotonic):
        self.threshold, self.reset_s, self.clock = threshold, reset_s, clock
        self.failures = 0
        self.opened_at: float | None = None
        self._lock = threading.Lock()

    @property
    def state(self) -> str:
        if self.opened_at is None:
            return "closed"
        if self.clock() - self.opened_at >= self.reset_s:
            return "half_open"
        return "open"

    def allow(self) -> bool:
        return self.state != "open"

    def success(self) -> None:
        with self._lock:
            self.failures, self.opened_at = 0, None

    def failure(self) -> None:
        with self._lock:
            self.failures += 1
            if self.failures >= self.threshold or self.state == "half_open":
                self.opened_at = self.clock()


class WeatherCache(Protocol):
    def get(self, key: str) -> tuple[dict, datetime] | None: ...
    def put(self, key: str, payload: dict, source: str) -> None: ...


class MemoryCache:
    def __init__(self):
        self.data: dict[str, tuple[dict, datetime]] = {}

    def get(self, key):
        return self.data.get(key)

    def put(self, key, payload, source):
        self.data[key] = (payload, datetime.now(timezone.utc))


class PgWeatherCache:
    def __init__(self):
        self.mem = MemoryCache()

    def get(self, key):
        hit = self.mem.get(key)
        if hit:
            return hit
        try:
            from ..core import db
            with db.tx() as conn:
                row = db.fetch_one(conn, "select payload, fetched_at from weather_cache where ward_id = %s", (key,))
            if row:
                self.mem.data[key] = (row["payload"], row["fetched_at"])
                return row["payload"], row["fetched_at"]
        except Exception as exc:
            log.warning("weather cache read failed: %s", exc)
        return None

    def put(self, key, payload, source):
        self.mem.put(key, payload, source)
        try:
            from ..core import db
            with db.tx() as conn:
                conn.execute(
                    """insert into weather_cache(ward_id, payload, source, fetched_at)
                       values (%s, %s, %s, now())
                       on conflict (ward_id) do update set payload = excluded.payload,
                         source = excluded.source, fetched_at = now()""",
                    (key, db.as_json(payload), source),
                )
        except Exception as exc:
            log.warning("weather cache write failed: %s", exc)


_CLIM_DEFAULT = {1: 7, 2: 19, 3: 40, 4: 110, 5: 260, 6: 360, 7: 400, 8: 320, 9: 300, 10: 170, 11: 30, 12: 10}
_DAYS_DEFAULT = {1: 1, 2: 2, 3: 3, 4: 7, 5: 12, 6: 17, 7: 21, 8: 19, 9: 15, 10: 7, 11: 1, 12: 1}


def load_climatology(path: str | None) -> dict[int, dict]:
    out = {m: {"mean_mm": _CLIM_DEFAULT[m], "rainy_days": _DAYS_DEFAULT[m]} for m in range(1, 13)}
    if path and Path(path).exists():
        try:
            with open(path, newline="") as fh:
                for r in csv.DictReader(fh):
                    out[int(r["month"])] = {"mean_mm": float(r["mean_monthly_mm"]), "rainy_days": float(r["rainy_days"])}
        except Exception as exc:
            log.warning("climatology CSV unreadable, using defaults: %s", exc)
    return out


@dataclass
class WeatherClient:
    base_url: str = "https://api.open-meteo.com/v1/forecast"
    timeout_s: float = 4.0
    max_retries: int = 3
    fresh_minutes: int = 30
    stale_hours: int = 24
    cache: WeatherCache = field(default_factory=MemoryCache)
    breaker: CircuitBreaker = field(default_factory=CircuitBreaker)
    transport: httpx.BaseTransport | None = None
    climatology_path: str | None = None
    sleep: callable = time.sleep
    chaos_mode: str = "normal"

    def __post_init__(self):
        self.climatology = load_climatology(self.climatology_path)
        self.stats = {"live": 0, "cache": 0, "stale_cache": 0, "climatology": 0, "failures": 0}

    def _fetch_live(self, lat: float, lng: float) -> tuple[dict, int]:
        params = {
            "latitude": round(lat, 4), "longitude": round(lng, 4),
            "hourly": "precipitation,precipitation_probability",
            "past_days": 1, "forecast_days": 2, "timezone": "Asia/Dhaka",
        }
        transport = self._chaos_transport() or self.transport
        last_exc: Exception | None = None
        attempts = 0
        with httpx.Client(timeout=self.timeout_s, transport=transport) as client:
            for attempt in range(1, self.max_retries + 1):
                attempts = attempt
                try:
                    resp = client.get(self.base_url, params=params)
                    if resp.status_code == 429 or resp.status_code >= 500:
                        raise UpstreamUnavailable(f"HTTP {resp.status_code}")
                    if resp.status_code >= 400:
                        raise MalformedResponse(f"HTTP {resp.status_code}: {resp.text[:120]}")
                    try:
                        data = OpenMeteoResponse.model_validate(resp.json())
                    except (ValueError, ValidationError) as exc:
                        raise MalformedResponse(f"schema validation failed: {str(exc)[:200]}")
                    return self._summarise(data), attempts
                except MalformedResponse as exc:
                    last_exc = exc
                    break
                except (httpx.TimeoutException, httpx.TransportError, UpstreamUnavailable) as exc:
                    last_exc = exc
                    if attempt < self.max_retries:
                        backoff = (0.4 * 2 ** (attempt - 1)) + random.uniform(0, 0.25)
                        self.sleep(backoff)
        raise last_exc or UpstreamUnavailable("unknown failure")

    def _summarise(self, data: OpenMeteoResponse) -> dict:
        now = datetime.now(DHAKA_TZ).replace(minute=0, second=0, microsecond=0, tzinfo=None)
        past, nxt, hourly = 0.0, 0.0, []
        max_hourly, max_prob = 0.0, 0.0
        probs = data.hourly.precipitation_probability or [None] * len(data.hourly.time)
        for t, p, pr in zip(data.hourly.time, data.hourly.precipitation, probs):
            ts = datetime.fromisoformat(t)
            p = p or 0.0
            if now - timedelta(hours=24) <= ts < now:
                past += p
            elif now <= ts < now + timedelta(hours=24):
                nxt += p
                max_hourly = max(max_hourly, p)
                max_prob = max(max_prob, pr or 0)
                hourly.append({"time": t, "precip_mm": round(p, 2), "prob": pr})
        return {
            "rain_past_24h_mm": round(past, 1), "rain_next_24h_mm": round(nxt, 1),
            "max_hourly_mm": round(max_hourly, 1), "max_precip_prob": max_prob, "hourly": hourly,
        }

    def _climatology_estimate(self) -> dict:
        m = datetime.now(DHAKA_TZ).month
        c = self.climatology[m]
        per_rain_day = c["mean_mm"] / max(c["rainy_days"], 1)
        p = min(1.0, c["rainy_days"] / 30)
        est = round(per_rain_day * 1.3 * (1 if p > 0.4 else p * 2), 1)
        return {"rain_past_24h_mm": est, "rain_next_24h_mm": est, "max_hourly_mm": round(est * 0.3, 1),
                "max_precip_prob": round(p * 100), "hourly": []}

    def get(self, key: str, lat: float, lng: float, force_live: bool = False) -> dict:
        now = datetime.now(timezone.utc)
        cached = self.cache.get(key)
        if cached and not force_live and self.chaos_mode == "normal":
            payload, fetched = cached
            if now - _aware(fetched) < timedelta(minutes=self.fresh_minutes):
                self.stats["cache"] += 1
                return {**payload, "source": "cache", "degraded": False, "fetched_at": _aware(fetched).isoformat(),
                        "breaker": self.breaker.state}

        error = None
        attempts = 0
        if self.breaker.allow():
            try:
                summary, attempts = self._fetch_live(lat, lng)
                self.breaker.success()
                self.cache.put(key, summary, "live")
                self.stats["live"] += 1
                return {**summary, "source": "live", "degraded": False, "fetched_at": now.isoformat(),
                        "attempts": attempts, "breaker": self.breaker.state}
            except Exception as exc:
                self.breaker.failure()
                self.stats["failures"] += 1
                error = f"{type(exc).__name__}: {exc}"
                log.warning("Open-Meteo failed for %s: %s", key, error)
        else:
            error = "circuit breaker open — upstream skipped"

        if cached:
            payload, fetched = cached
            if now - _aware(fetched) < timedelta(hours=self.stale_hours):
                self.stats["stale_cache"] += 1
                return {**payload, "source": "stale_cache", "degraded": True, "error": error,
                        "fetched_at": _aware(fetched).isoformat(), "breaker": self.breaker.state}

        self.stats["climatology"] += 1
        return {**self._climatology_estimate(), "source": "climatology", "degraded": True, "error": error,
                "fetched_at": now.isoformat(), "breaker": self.breaker.state}

    def _chaos_transport(self) -> httpx.BaseTransport | None:
        mode = self.chaos_mode
        if mode == "normal":
            return None

        def handler(request: httpx.Request) -> httpx.Response:
            if mode == "timeout":
                raise httpx.ReadTimeout("simulated timeout", request=request)
            if mode == "error500":
                return httpx.Response(503, text="simulated outage")
            return httpx.Response(200, json={"latitude": 23.7, "longitude": 90.4,
                                             "hourly": {"time": ["2026-01-01T00:00"], "precipitation": ["NaN?", -4]}})
        return httpx.MockTransport(handler)


def _aware(dt) -> datetime:
    if isinstance(dt, str):
        dt = datetime.fromisoformat(dt)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


_client: WeatherClient | None = None


def get_weather_client() -> WeatherClient:
    global _client
    if _client is None:
        from ..core.config import get_settings
        s = get_settings()
        _client = WeatherClient(
            base_url=s.weather_base_url, timeout_s=s.weather_timeout_s, max_retries=s.weather_max_retries,
            fresh_minutes=s.weather_cache_fresh_min, stale_hours=s.weather_cache_stale_hours,
            cache=PgWeatherCache() if s.database_url else MemoryCache(),
            breaker=CircuitBreaker(s.circuit_fail_threshold, s.circuit_reset_s),
            climatology_path=s.climatology_csv,
        )
    return _client
