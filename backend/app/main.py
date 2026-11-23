from __future__ import annotations

import logging
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from psycopg import Error as PgError

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

    @app.get("/")
    def root():
        return {"name": "ResilioMesh API", "docs": "/docs", "health": "/health"}

    app.include_router(router)
    return app


app = create_app()
