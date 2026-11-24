"""Drainage Officer areas (migration 009) against a REAL database.

A Drainage Officer of the South authority (DSCC) may only change things in
Dhaka South wards, and the other way round. Admins stay city-wide. Officers can
still read the whole city.

    TEST_DATABASE_URL=postgresql://... pytest tests/test_db_areas.py -v
"""
import json
import os
import uuid

import pytest

from .dbutil import DSN, as_user, nearest_ward, new_auth_user, open_session, random_dhaka_point, raw, verify_staff_session

pytestmark = pytest.mark.skipif(not DSN, reason="TEST_DATABASE_URL not set")

if DSN:
    import psycopg

NORTH = "11111111-1111-1111-1111-111111111101"
SOUTH = "11111111-1111-1111-1111-111111111102"
SHOBAR = "11111111-1111-1111-1111-111111111103"


def staff(role, org):
    with raw() as c:
        uid = new_auth_user(c, role)
        c.execute("update profiles set role=%s, organization_id=%s, employee_id=%s where id=%s",
                  (role, org, f"T-{uuid.uuid4().hex[:8].upper()}" if role != "ngo_coordinator" else None, uid))
        open_session(c, uid)
        verify_staff_session(c, uid)
    return uid


@pytest.fixture(scope="module")
def people():
    with raw() as c:
        reporter = new_auth_user(c, "citizen")
    return {"reporter": reporter, "south": staff("city_officer", SOUTH), "north": staff("city_officer", NORTH),
            "admin": staff("admin", None)}


def incident(people, area, status="reported", **extra):
    """System-created incident in a ward of the given area ('DNCC' / 'DSCC')."""
    lat, lng = random_dhaka_point(area)
    with raw() as c:
        ward = nearest_ward(c, lat, lng)
        inc = c.execute("""insert into incidents(reporter_id, ward_id, category, title, description, severity_reported,
                                                 people_affected, lat, lng)
                           values (%s,%s,'waterlogging','Area test incident','Area test incident description',3,10,%s,%s)
                           returning *""", (people["reporter"], ward, lat, lng)).fetchone()
        if status in ("verified", "assessed"):
            c.execute("update incidents set status='verified' where id=%s", (inc["id"],))
        if status == "assessed":
            c.execute("update incidents set status='assessed', risk_score=80, risk_level='high', priority=70 where id=%s",
                      (inc["id"],))
        return c.execute("select * from incidents where id=%s", (inc["id"],)).fetchone()


def verify(uid, inc):
    with as_user(uid) as c:
        return c.execute("select transition_incident(%s,'verified',%s) r", (inc["id"], inc["version"])).fetchone()["r"]


# ------------------------------------------------------------------ set-up
def test_authorities_have_their_area():
    with raw() as c:
        rows = {r["id"]: r["city_corporation"] for r in
                c.execute("select id::text, city_corporation from organizations where id = any(%s::uuid[])",
                          ([NORTH, SOUTH, SHOBAR],)).fetchall()}
    assert rows == {NORTH: "DNCC", SOUTH: "DSCC", SHOBAR: None}


def test_only_city_authorities_can_have_an_area():
    with raw() as c, pytest.raises(psycopg.errors.CheckViolation):
        c.execute("update organizations set city_corporation='DSCC' where id=%s", (SHOBAR,))


def test_area_cannot_be_changed_by_an_admin_once_set(people):
    with as_user(people["admin"]) as c, pytest.raises(psycopg.errors.InsufficientPrivilege):
        c.execute("update organizations set city_corporation='DNCC' where id=%s", (SOUTH,))


# ------------------------------------------------------------------ incidents
def test_officer_acts_in_own_area(people):
    inc = incident(people, "DSCC")
    assert verify(people["south"], inc)["ok"] is True


def test_officer_cannot_act_in_the_other_area(people):
    inc = incident(people, "DNCC")
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="Dhaka North, outside your area \\(Dhaka South\\)"):
        verify(people["south"], inc)
    assert verify(people["north"], inc)["ok"] is True


def test_admin_is_city_wide(people):
    assert verify(people["admin"], incident(people, "DNCC"))["ok"] is True
    assert verify(people["admin"], incident(people, "DSCC"))["ok"] is True


def test_officer_can_read_but_not_edit_the_other_area(people):
    inc = incident(people, "DNCC")
    with as_user(people["south"]) as c:
        assert c.execute("select id from incidents where id=%s", (inc["id"],)).fetchone() is not None
        changed = c.execute("update incidents set priority=99 where id=%s returning id", (inc["id"],)).fetchall()
    assert changed == []


def test_officer_cannot_move_an_incident_into_the_other_area(people):
    inc = incident(people, "DSCC")
    with raw() as c:
        north_ward = c.execute("select id from wards where city_corporation='DNCC' limit 1").fetchone()["id"]
    with as_user(people["south"]) as c, pytest.raises(psycopg.errors.InsufficientPrivilege):
        c.execute("update incidents set ward_id=%s where id=%s", (north_ward, inc["id"]))


def test_officer_without_an_area_can_change_nothing(people):
    with raw() as c:
        org = c.execute("insert into organizations(name, type) values (%s, 'city_authority') returning id",
                        (f"Arealess authority {uuid.uuid4().hex[:6]}",)).fetchone()["id"]
    officer = staff("city_officer", org)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        verify(officer, incident(people, "DSCC"))


# ------------------------------------------------------------------ plans, assets
def plan_for(people, inc):
    with raw() as c:
        return c.execute("""insert into allocation_plans(incident_ids, feasible, assignments, explanation, constraints, created_by)
                            values (array[%s]::uuid[], true, %s, '{}', '{}', %s) returning id, version""",
                         (inc["id"], json.dumps([{"incident_id": str(inc["id"]), "resource_type": "pump", "quantity": 1}]),
                          people["admin"])).fetchone()


def test_officer_cannot_approve_or_reject_a_plan_in_the_other_area(people):
    plan = plan_for(people, incident(people, "DNCC", status="assessed"))
    with as_user(people["south"]) as c, pytest.raises(psycopg.errors.InsufficientPrivilege, match="outside your area"):
        c.execute("select approve_plan(%s,%s,null)", (plan["id"], plan["version"]))
    with as_user(people["south"]) as c, pytest.raises(psycopg.errors.InsufficientPrivilege, match="outside your area"):
        c.execute("select reject_plan(%s,'not ours')", (plan["id"],))
    with as_user(people["north"]) as c:
        assert c.execute("select reject_plan(%s,'checked by North') r", (plan["id"],)).fetchone()["r"]["ok"] is True


def test_officer_adds_assets_only_in_own_area(people):
    with raw() as c:
        north_ward = c.execute("select id from wards where city_corporation='DNCC' limit 1").fetchone()["id"]
        south_ward = c.execute("select id from wards where city_corporation='DSCC' limit 1").fetchone()["id"]

    def add(ward):
        code = f"DR-T{uuid.uuid4().hex[:2].upper()}-{uuid.uuid4().int % 1000:03d}"
        with as_user(people["south"]) as c:
            c.execute("""insert into drainage_assets(code, name, asset_type, ward_id, owner_org_id, lat, lng)
                         values (%s, 'Area test drain', 'drain', %s, %s, 23.73, 90.41)""", (code, ward, SOUTH))

    add(south_ward)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        add(north_ward)


# ------------------------------------------------------------------ backend endpoints (trusted connection)
@pytest.fixture()
def backend_db():
    os.environ["DATABASE_URL"] = DSN
    from app.core import config, db
    config.get_settings.cache_clear()
    db.close_pool()
    yield
    db.close_pool()


def test_backend_blocks_ai_assessment_and_planning_outside_area(people, backend_db):
    from app.core.auth import CurrentUser
    from app.core.errors import AppError
    from app.services import planning, risk
    from app.services.optimizer import Constraints

    south = CurrentUser(id=people["south"], email=None, role="city_officer", organization_id=SOUTH)
    north_inc = incident(people, "DNCC", status="verified")
    with pytest.raises(AppError) as e:
        risk.assess_incident(str(north_inc["id"]), south)
    assert e.value.status_code == 403 and "Dhaka North" in e.value.message

    assessed = incident(people, "DNCC", status="assessed")
    with pytest.raises(AppError) as e:
        planning.create_plan([str(assessed["id"])], Constraints(), south)
    assert e.value.status_code == 403
