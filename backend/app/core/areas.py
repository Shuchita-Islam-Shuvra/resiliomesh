"""Drainage Officer areas: Dhaka North (DNCC) and Dhaka South (DSCC).

Mirrors rm_can_manage_ward() from migration 009 for the endpoints that write with
the trusted backend connection (where RLS does not apply). An officer's area is
their organisation's `city_corporation`. Admins and other roles are city-wide.
"""
from __future__ import annotations

from collections.abc import Iterable

from psycopg import Connection

from . import db
from .auth import CurrentUser
from .errors import AppError

AREA_LABEL = {"DNCC": "Dhaka North", "DSCC": "Dhaka South"}


def area_label(area: str | None) -> str:
    return AREA_LABEL.get(area or "", "no area")


def officer_area(conn: Connection, user: CurrentUser) -> str | None:
    """The officer's area, or None when the user is not area-bound (admin, NGO, ...).

    An officer whose organisation has no area may not change anything (fail-safe).
    """
    if user.role != "city_officer":
        return None
    row = None
    if user.organization_id:
        # to_jsonb(): still a valid query if migration 009 has not added the column yet
        row = db.fetch_one(conn, "select to_jsonb(o)->>'city_corporation' as area from organizations o where o.id = %s",
                           (user.organization_id,))
    if not row or not row["area"]:
        raise AppError(403, "FORBIDDEN",
                       "FORBIDDEN: your authority has no area (Dhaka North / Dhaka South) set. Ask an admin.")
    return row["area"]


def assert_wards_in_area(conn: Connection, user: CurrentUser, ward_ids: Iterable[str]) -> None:
    area = officer_area(conn, user)
    if area is None:
        return
    rows = db.fetch_all(conn, "select id, city_corporation from wards where id = any(%s)", (sorted(set(ward_ids)),))
    outside = sorted({r["city_corporation"] for r in rows if r["city_corporation"] != area})
    if outside:
        raise AppError(403, "FORBIDDEN",
                       f"FORBIDDEN: this is in {', '.join(area_label(a) for a in outside)}, "
                       f"outside your area ({area_label(area)})")
