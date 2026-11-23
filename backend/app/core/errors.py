"""Translate Postgres business-rule exceptions into clean HTTP errors."""
from __future__ import annotations

import logging

from fastapi import Request
from fastapi.responses import JSONResponse
from psycopg import errors as pg

log = logging.getLogger("resiliomesh.errors")

PREFIX_STATUS = {
    "FORBIDDEN": 403,
    "NOT_FOUND": 404,
    "INSUFFICIENT_STOCK": 409,
    "INVALID_TRANSITION": 409,
    "INVALID_STATE": 409,
    "STALE_PLAN": 409,
    "INFEASIBLE": 422,
    "VALIDATION": 422,
}


class AppError(Exception):
    def __init__(self, status_code: int, code: str, message: str, details: dict | None = None):
        self.status_code, self.code, self.message, self.details = status_code, code, message, details or {}
        super().__init__(message)


def from_db_error(exc: Exception) -> AppError:
    msg = str(getattr(exc, "diag", None) and exc.diag.message_primary or exc)
    code = msg.split(":", 1)[0].strip()
    if code in PREFIX_STATUS:
        return AppError(PREFIX_STATUS[code], code, msg)
    if isinstance(exc, pg.UniqueViolation):
        return AppError(409, "DUPLICATE", "This record already exists")
    if isinstance(exc, pg.CheckViolation):
        return AppError(422, "VALIDATION", msg)
    if isinstance(exc, pg.ForeignKeyViolation):
        return AppError(422, "VALIDATION", "Referenced record does not exist")
    if isinstance(exc, pg.InsufficientPrivilege):
        return AppError(403, "FORBIDDEN", msg)
    log.exception("Unhandled database error")
    return AppError(500, "DB_ERROR", "Database error")


async def app_error_handler(_: Request, exc: AppError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code,
                        content={"error": exc.code, "message": exc.message, "details": exc.details})


async def db_error_handler(request: Request, exc: pg.Error) -> JSONResponse:
    return await app_error_handler(request, from_db_error(exc))
