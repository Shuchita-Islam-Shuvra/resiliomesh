"""Sliding-window rate limiter (per bearer token / client IP)."""
from __future__ import annotations

import hashlib
import threading
import time
from collections import defaultdict, deque

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware


class SlidingWindowLimiter:
    def __init__(self, limit: int, window_s: float = 60.0):
        self.limit, self.window = limit, window_s
        self._hits: dict[str, deque] = defaultdict(deque)
        self._lock = threading.Lock()

    def allow(self, key: str, now: float | None = None) -> tuple[bool, int]:
        now = now if now is not None else time.monotonic()
        with self._lock:
            q = self._hits[key]
            while q and now - q[0] > self.window:
                q.popleft()
            if len(q) >= self.limit:
                retry = int(self.window - (now - q[0])) + 1
                return False, retry
            q.append(now)
            return True, 0


class RateLimitMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, limiter: SlidingWindowLimiter):
        super().__init__(app)
        self.limiter = limiter

    async def dispatch(self, request: Request, call_next):
        # only the API is limited; website files (JS/CSS chunks) must not use up a visitor's quota
        if not request.url.path.startswith("/api") or request.method == "OPTIONS":
            return await call_next(request)
        auth = request.headers.get("authorization", "")
        ident = hashlib.sha256(auth.encode()).hexdigest()[:16] if auth else (request.client.host if request.client else "anon")
        ok, retry = self.limiter.allow(ident)
        if not ok:
            return JSONResponse(status_code=429, headers={"Retry-After": str(retry)},
                                content={"error": "RATE_LIMITED", "message": f"Too many requests. Retry in {retry}s"})
        return await call_next(request)
