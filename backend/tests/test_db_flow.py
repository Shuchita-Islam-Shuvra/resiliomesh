"""End-to-end business flow + security against a REAL database (A03, A05, A07, M04).

Simulates PostgREST exactly: `set local role authenticated` + JWT claims, so every
statement is subject to the same RLS policies and RPC checks the browser hits.

    TEST_DATABASE_URL=postgresql://... pytest tests/test_db_flow.py -v
"""
import json
import os
import threading
import uuid

import pytest

from .dbutil import (DSN, SESSIONS, as_user, nearest_ward, new_auth_user, open_session, random_dhaka_point, raw,
                     verify_staff_session)

pytestmark = pytest.mark.skipif(not DSN, reason="TEST_DATABASE_URL not set")

if DSN:
    import psycopg

SOUTH = "11111111-1111-1111-1111-111111111102"
SHOBAR = "11111111-1111-1111-1111-111111111103"
NODI = "11111111-1111-1111-1111-111111111104"


@pytest.fixture(scope="module")
def users():
    ids = {}
    with raw() as c:
        old = c.execute("select citizen_reports_per_hour h, citizen_reports_per_day d from security_settings where id").fetchone()
        c.execute("update security_settings set citizen_reports_per_hour = 1000, citizen_reports_per_day = 5000 where id")
        for key, role, org in [("citizen", "citizen", None), ("citizen2", "citizen", None), ("officer", "city_officer", SOUTH),
                               ("admin", "admin", None), ("field", "field_worker", SOUTH),
                               ("ngo", "ngo_coordinator", SHOBAR), ("ngo_b", "ngo_coordinator", SHOBAR)]:
            try:
                uid = new_auth_user(c, key)
            except psycopg.Error as e:
                pytest.skip(f"cannot create auth users in this database: {e}")
            c.execute("update profiles set role=%s, organization_id=%s where id=%s", (role, org, uid))
            open_session(c, uid)                       # signed in ...
            if role != "citizen":
                verify_staff_session(c, uid)           # ... and passed the server-side staff-ID step
            ids[key] = uid
    # make the backend use this database too (workflow engine via PgStore)
    os.environ["DATABASE_URL"] = DSN
    from app.core import config, db
    config.get_settings.cache_clear()
    db.close_pool()
    yield ids
    db.close_pool()
    with raw() as c:
        c.execute("update security_settings set citizen_reports_per_hour = %s, citizen_reports_per_day = %s where id",
                  (old["h"], old["d"]))


def ensure_staff_session(uid):
    with raw() as c:
        if str(uid) not in SESSIONS:
            open_session(c, str(uid))
        verify_staff_session(c, str(uid))


def new_incident(uid, **kw):
    lat, lng = random_dhaka_point("DSCC")              # spread out: avoid geo-duplicate; in the officer's area
    lat, lng = kw.get("lat", lat), kw.get("lng", lng)
    with raw() as c:
        ward = nearest_ward(c, lat, lng)               # the pin must belong to the chosen ward
    with as_user(uid) as c:
        return c.execute("""insert into incidents(reporter_id, ward_id, category, title, description, severity_reported,
                             water_depth_cm, people_affected, lat, lng, status, risk_score)
                            values (%(r)s, %(w)s, 'waterlogging', %(t)s, 'Flow test incident description', 4, 50, 200,
                                    %(lat)s, %(lng)s, %(st)s, %(rs)s) returning *""",
                         {"r": kw.get("reporter", uid), "w": ward, "t": kw.get("title", "Flow test incident"),
                          "lat": lat, "lng": lng,
                          "st": kw.get("status", "reported"), "rs": kw.get("risk_score")}).fetchone()


# ------------------------------------------------------------------ A03 security
def test_client_cannot_forge_status_reporter_or_risk(users):
    inc = new_incident(users["citizen"], reporter=users["officer"], status="approved", risk_score=99)
    assert inc["status"] == "reported"
    assert str(inc["reporter_id"]) == users["citizen"]
    assert inc["risk_score"] is None


def test_citizen_cannot_escalate_own_role(users):
    with pytest.raises(psycopg.Error, match="FORBIDDEN"):
        with as_user(users["citizen"]) as c:
            c.execute("update profiles set role='admin' where id=%s", (users["citizen"],))


def test_citizen_cannot_read_other_citizens_reports_or_audit(users):
    other = new_incident(users["citizen2"])
    with as_user(users["citizen"]) as c:
        assert c.execute("select count(*) n from incidents where id=%s", (other["id"],)).fetchone()["n"] == 0
        assert c.execute("select count(*) n from audit_logs").fetchone()["n"] == 0
        assert c.execute("select count(*) n from resources").fetchone()["n"] == 0


def test_citizen_cannot_modify_another_users_record(users):
    other = new_incident(users["citizen2"])
    with as_user(users["citizen"]) as c:
        updated = c.execute("update incidents set description='hacked by citizen 1' where id=%s returning id",
                            (other["id"],)).fetchall()
    assert updated == []                         # RLS hides the row: zero rows affected


def test_ngo_cannot_touch_other_orgs_stock(users):
    with as_user(users["ngo"]) as c:
        n = c.execute("update resources set quantity_available = 0 where organization_id = %s returning id", (NODI,)).fetchall()
    assert n == []


def test_audit_trail_records_actor(users):
    inc = new_incident(users["citizen"])
    with raw() as c:
        row = c.execute("select actor_id, actor_role, action from audit_logs where table_name='incidents' and record_id=%s",
                        (str(inc["id"]),)).fetchone()
    assert str(row["actor_id"]) == users["citizen"] and row["actor_role"] == "citizen" and row["action"] == "INSERT"


# ------------------------------------------------------------------ M04 / A01
def test_officer_transition_with_optimistic_lock(users):
    inc = new_incident(users["citizen"])
    with as_user(users["officer"]) as c:
        r = c.execute("select transition_incident(%s,'verified',%s,null,null) r", (inc["id"], inc["version"])).fetchone()["r"]
    assert r["ok"] is True
    # second officer still holds the old version -> conflict, not overwrite
    with as_user(users["officer"]) as c:
        r2 = c.execute("select transition_incident(%s,'rejected',%s,'stale',null) r", (inc["id"], inc["version"])).fetchone()["r"]
    assert r2["conflict"] is True and r2["current"]["status"] == "verified"


def test_role_rules_on_transitions(users):
    inc = new_incident(users["citizen"])
    with pytest.raises(psycopg.Error, match="FORBIDDEN"):
        with as_user(users["citizen"]) as c:
            c.execute("select transition_incident(%s,'verified',%s,null,null)", (inc["id"], inc["version"]))
    with pytest.raises(psycopg.Error, match="INVALID_STATE"):   # cannot assess without AI score
        with as_user(users["officer"]) as c:
            v = c.execute("select transition_incident(%s,'verified',%s,null,null) r", (inc["id"], inc["version"])).fetchone()["r"]
            c.execute("select transition_incident(%s,'assessed',%s,null,null)", (inc["id"], v["incident"]["version"]))


def test_geospatial_duplicate_detection(users):
    lat, lng = random_dhaka_point()
    a = new_incident(users["citizen"], lat=lat, lng=lng)
    b = new_incident(users["citizen2"], lat=lat + 0.0001, lng=lng + 0.0001)      # ~15 m away
    assert a["status"] == "reported"
    assert b["status"] == "duplicate" and b["duplicate_of"] == a["id"]


# ------------------------------------------------------------------ A05 NGO race
def test_two_coordinators_race_for_last_relief_kits(users):
    with raw() as c:
        rid = c.execute("""insert into resources(organization_id, resource_type, name, quantity_total, quantity_available, lat, lng)
                           values (%s,'relief_kit',%s,100,5,23.74,90.37) returning id""", (SHOBAR, f"race kits {uuid.uuid4()}")).fetchone()["id"]
        needs = [c.execute("""insert into community_needs(ward_id, need_type, quantity, households, dedup_key, contact_name)
                              values ('DSCC-10','relief_kit',5,5,'x',%s) returning id""", (str(uuid.uuid4()),)).fetchone()["id"]
                 for _ in range(2)]
    out, barrier = [], threading.Barrier(2)

    def go(uid, need):
        barrier.wait()
        try:
            with as_user(uid) as c:
                c.execute("select allocate_to_need(%s,%s,5,%s)", (need, rid, str(uuid.uuid4())))
            out.append("ok")
        except psycopg.Error as e:
            out.append("stock" if "INSUFFICIENT_STOCK" in str(e) else str(e))

    ts = [threading.Thread(target=go, args=(users["ngo"], needs[0])), threading.Thread(target=go, args=(users["ngo_b"], needs[1]))]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert sorted(out) == ["ok", "stock"], out
    with raw() as c:
        assert c.execute("select quantity_available q from resources where id=%s", (rid,)).fetchone()["q"] == 0
        statuses = sorted(r["status"] for r in c.execute("select status::text from community_needs where id = any(%s)", (needs,)).fetchall())
    assert statuses == ["fulfilled", "open"]       # the loser's need stays open, never half-written


# ------------------------------------------------------------------ A07 workflow on real DB
def _assessed_incident_with_plan(users, pump_id, qty=2):
    inc = new_incident(users["citizen"])
    with raw() as c:
        c.execute("update incidents set status='verified' where id=%s", (inc["id"],))
        c.execute("update incidents set status='assessed', risk_score=81, risk_level='critical', priority=88 where id=%s", (inc["id"],))
        crew = c.execute("select id from resources where resource_type='crew' and quantity_available>0 limit 1").fetchone()["id"]
        plan = c.execute("""insert into allocation_plans(incident_ids, feasible, assignments, explanation, constraints, created_by)
                            values (array[%s]::uuid[], true, %s, '{}', '{}', %s) returning id, version""",
                         (inc["id"], json.dumps([
                             {"incident_id": str(inc["id"]), "resource_id": str(pump_id), "resource_type": "pump", "quantity": qty},
                             {"incident_id": str(inc["id"]), "resource_id": str(crew), "resource_type": "crew", "quantity": 1}]),
                          users["officer"])).fetchone()
    return inc, plan


def _drain_queue():
    from app.workflow.engine import WorkflowEngine
    from app.workflow.pg_store import PgStore, claim_run
    with raw() as c:   # make retries immediately runnable for the test
        c.execute("update workflow_runs set next_run_at = now() where status = 'retrying'")
    results = []
    eng = WorkflowEngine(PgStore(), backoff_base_s=0)
    while (run := claim_run("pytest")) is not None:
        results.append(eng.execute(run))
    return results


@pytest.fixture
def pump():
    with raw() as c:
        rid = c.execute("""insert into resources(organization_id, resource_type, name, quantity_total, quantity_available, lat, lng)
                           values (%s,'pump',%s,4,4,23.74,90.41) returning id""", (SOUTH, f"flow pump {uuid.uuid4()}")).fetchone()["id"]
    return rid


def test_full_dispatch_then_field_completion_returns_equipment(users, pump):
    inc, plan = _assessed_incident_with_plan(users, pump)
    with as_user(users["officer"]) as c:
        r = c.execute("select approve_plan(%s,%s,null) r", (plan["id"], plan["version"])).fetchone()["r"]
        again = c.execute("select approve_plan(%s,%s,null) r", (plan["id"], plan["version"])).fetchone()["r"]
    assert r["ok"] and again["replayed"] and again["run_id"] == r["run_id"]     # double-click safe

    res = _drain_queue()
    assert {"status": "succeeded"} in res
    with raw() as c:
        assert c.execute("select quantity_available q from resources where id=%s", (pump,)).fetchone()["q"] == 2
        assert c.execute("select status::text s from incidents where id=%s", (inc["id"],)).fetchone()["s"] == "in_progress"
        tasks = c.execute("select id, version, status::text, assigned_to from tasks where incident_id=%s", (inc["id"],)).fetchall()
    assert tasks and all(t["status"] == "assigned" for t in tasks)

    # field worker completes every task -> incident resolved, pumps back in stock
    for t in tasks:
        ensure_staff_session(t["assigned_to"])
        with as_user(t["assigned_to"]) as c:
            v = t["version"]
            for st in ("in_progress", "completed"):
                out = c.execute("select update_task_status(%s,%s,%s,'done') r", (t["id"], st, v)).fetchone()["r"]
                assert out["ok"], out
                v = out["task"]["version"]
    with raw() as c:
        assert c.execute("select status::text s from incidents where id=%s", (inc["id"],)).fetchone()["s"] == "resolved"
        assert c.execute("select quantity_available q from resources where id=%s", (pump,)).fetchone()["q"] == 4


def test_field_worker_cannot_update_someone_elses_task(users, pump):
    inc, plan = _assessed_incident_with_plan(users, pump, qty=1)
    with as_user(users["officer"]) as c:
        c.execute("select approve_plan(%s,%s,null)", (plan["id"], plan["version"]))
    _drain_queue()
    with raw() as c:
        t = c.execute("select id, version from tasks where incident_id=%s limit 1", (inc["id"],)).fetchone()
    with pytest.raises(psycopg.Error, match="FORBIDDEN"):
        with as_user(users["citizen"]) as c:
            c.execute("select update_task_status(%s,'completed',%s,null)", (t["id"], t["version"]))


def test_intermediate_step_failure_compensates_everything(users, pump):
    inc, plan = _assessed_incident_with_plan(users, pump)
    with pytest.raises(psycopg.Error, match="FORBIDDEN"):          # only admins may inject faults
        with as_user(users["officer"]) as c:
            c.execute("select approve_plan(%s,%s,'create_tasks')", (plan["id"], plan["version"]))
    with as_user(users["admin"]) as c:
        run_id = c.execute("select approve_plan(%s,%s,'create_tasks') r", (plan["id"], plan["version"])).fetchone()["r"]["run_id"]

    for _ in range(3):        # attempt 1, 2 -> retrying ; attempt 3 -> compensated
        _drain_queue()
    with raw() as c:
        run = c.execute("select status::text s, attempts from workflow_runs where id=%s", (run_id,)).fetchone()
        steps = {r["step_name"]: r["status"] for r in c.execute("select step_name, status from workflow_steps where run_id=%s", (run_id,)).fetchall()}
        pump_q = c.execute("select quantity_available q from resources where id=%s", (pump,)).fetchone()["q"]
        inc_s = c.execute("select status::text s from incidents where id=%s", (inc["id"],)).fetchone()["s"]
        plan_s = c.execute("select status::text s from allocation_plans where id=%s", (plan["id"],)).fetchone()["s"]
        allocs = c.execute("select status from allocations where plan_id=%s", (plan["id"],)).fetchall()
    assert run["s"] == "compensated" and run["attempts"] == 3
    assert steps["reserve_resources"] == "compensated" and steps["create_tasks"] == "failed"
    assert pump_q == 4 and inc_s == "assessed" and plan_s == "failed"
    assert allocs and all(a["status"] == "released" for a in allocs)

    # recovery: admin retries -> succeeds without double reservation
    with as_user(users["admin"]) as c:
        c.execute("select retry_workflow_run(%s)", (run_id,))
    _drain_queue()
    with raw() as c:
        assert c.execute("select status::text s from workflow_runs where id=%s", (run_id,)).fetchone()["s"] == "succeeded"
        assert c.execute("select quantity_available q from resources where id=%s", (pump,)).fetchone()["q"] == 2


def test_analytics_is_staff_only(users):
    with as_user(users["officer"]) as c:
        out = c.execute("select analytics_dashboard(30, null) a").fetchone()["a"]
    assert out["historical"]["total_records"] > 0 and "by_ward" in out
    with pytest.raises(psycopg.Error, match="FORBIDDEN"):
        with as_user(users["citizen"]) as c:
            c.execute("select analytics_dashboard(30, null)")
