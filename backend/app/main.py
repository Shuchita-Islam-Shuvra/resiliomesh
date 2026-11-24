from __future__ import annotations

import logging
import threading
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from psycopg import Error as PgError

from .api.demo import router as demo_router
from .api.routes import router
from .core.config import get_settings
from .core.errors import AppError, app_error_handler, db_error_handler
from .core.ratelimit import RateLimitMiddleware, SlidingWindowLimiter

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("resiliomesh")


@asynccontextmanager
async def lifespan(app: FastAPI):
    s = get_settings()

    def warm():
        try:
            from .services.risk import model
            model()
            log.info("risk model ready")
        except Exception:
            log.exception("model warm-up failed")
    threading.Thread(target=warm, daemon=True).start()

    if s.worker_in_process and s.database_url:
        from .workflow import worker
        worker.start_background()
    yield
    from .core.db import close_pool
    from .workflow import worker as w
    w.stop()
    close_pool()


def create_app() -> FastAPI:
    s = get_settings()
    app = FastAPI(title="ResilioMesh API", version="1.0.0", lifespan=lifespan,
                  description="Flood-risk AI, resource optimisation and automated dispatch for Dhaka.")
    app.add_middleware(RateLimitMiddleware, limiter=SlidingWindowLimiter(s.rate_limit_per_minute))
    app.add_middleware(CORSMiddleware, allow_origins=s.cors_list, allow_credentials=True,
                       allow_methods=["*"], allow_headers=["*"])
    app.add_exception_handler(AppError, app_error_handler)
    app.add_exception_handler(PgError, db_error_handler)

    @app.exception_handler(RequestValidationError)
    async def validation_handler(_: Request, exc: RequestValidationError):
        return JSONResponse(status_code=422, content={
            "error": "VALIDATION", "message": "Invalid request",
            "details": [{"field": ".".join(str(p) for p in e["loc"][1:]), "message": e["msg"]} for e in exc.errors()]})

    @app.get("/health")
    def health():
        return {"status": "ok", "service": "resiliomesh-api"}

    app.include_router(router)
    app.include_router(demo_router)

    dist = Path(s.frontend_dist) if s.frontend_dist else None
    if dist and (dist / "index.html").is_file():
        mount_frontend(app, dist)
    else:
        @app.get("/")
        def root():
            return {"name": "ResilioMesh API", "docs": "/docs", "health": "/health"}
    return app


SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
}


def mount_frontend(app: FastAPI, dist: Path) -> None:
    """Serve the built React SPA from the same service (one deploy, one URL, no CORS).
    Registered after the API router, so /api/*, /health and /docs always win."""
    dist = dist.resolve()
    index = dist / "index.html"
    if (dist / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

    @app.middleware("http")
    async def static_headers(request: Request, call_next):
        res = await call_next(request)
        for k, v in SECURITY_HEADERS.items():
            res.headers.setdefault(k, v)
        if request.url.path.startswith("/assets/"):
            res.headers["Cache-Control"] = "public, max-age=31536000, immutable"  # hashed file names
        return res

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str):
        if full_path == "api" or full_path.startswith("api/"):
            return JSONResponse(status_code=404, content={"error": "NOT_FOUND", "message": "Unknown API route"})
        f = (dist / full_path).resolve()
        if full_path and f.is_file() and dist in f.parents:
            return FileResponse(f, headers={"Cache-Control": "no-cache"} if f.name == "sw.js" else None)
        # client-side routes (/dashboard, /incidents/123, ...) all load the SPA shell
        return FileResponse(index, headers={"Cache-Control": "no-cache"})

    log.info("serving frontend from %s", dist)


app = create_app()
