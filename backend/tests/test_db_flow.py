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
                               ("ngo", "ngo_coordinator", SHOBAR), ("ngo_b", "ngo_coordinator", SHOBAR),
                               ("ngo_north", "ngo_coordinator", NODI)]:
            try:
                uid = new_auth_user(c, key)
            except psycopg.Error as e:
                pytest.skip(f"cannot create auth users in this database: {e}")
            home = {"ngo": "DSCC-10", "ngo_b": "DSCC-10", "ngo_north": "DNCC-02"}.get(key)
            c.execute("update profiles set role=%s, organization_id=%s, ward_id=coalesce(%s, ward_id) where id=%s",
                      (role, org, home, uid))
            open_session(c, uid)
            if role != "citizen":
                verify_staff_session(c, uid)
            ids[key] = uid
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
    lat, lng = random_dhaka_point("DSCC")
    lat, lng = kw.get("lat", lat), kw.get("lng", lng)
    with raw() as c:
        ward = nearest_ward(c, lat, lng)
    with as_user(uid) as c:
        return c.execute("""insert into incidents(reporter_id, ward_id, category, title, description, severity_reported,
                             water_depth_cm, people_affected, lat, lng, status, risk_score)
                            values (%(r)s, %(w)s, 'waterlogging', %(t)s, 'Flow test incident description', 4, 50, 200,
                                    %(lat)s, %(lng)s, %(st)s, %(rs)s) returning *""",
                         {"r": kw.get("reporter", uid), "w": ward, "t": kw.get("title", "Flow test incident"),
                          "lat": lat, "lng": lng,
                          "st": kw.get("status", "reported"), "rs": kw.get("risk_score")}).fetchone()


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
    assert updated == []


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


def test_officer_transition_with_optimistic_lock(users):
    inc = new_incident(users["citizen"])
    with as_user(users["officer"]) as c:
        r = c.execute("select transition_incident(%s,'verified',%s,null,null) r", (inc["id"], inc["version"])).fetchone()["r"]
    assert r["ok"] is True
    with as_user(users["officer"]) as c:
        r2 = c.execute("select transition_incident(%s,'rejected',%s,'stale',null) r", (inc["id"], inc["version"])).fetchone()["r"]
    assert r2["conflict"] is True and r2["current"]["status"] == "verified"


def test_role_rules_on_transitions(users):
    inc = new_incident(users["citizen"])
    with pytest.raises(psycopg.Error, match="FORBIDDEN"):
        with as_user(users["citizen"]) as c:
            c.execute("select transition_incident(%s,'verified',%s,null,null)", (inc["id"], inc["version"]))
    with pytest.raises(psycopg.Error, match="INVALID_STATE"):
        with as_user(users["officer"]) as c:
            v = c.execute("select transition_incident(%s,'verified',%s,null,null) r", (inc["id"], inc["version"])).fetchone()["r"]
            c.execute("select transition_incident(%s,'assessed',%s,null,null)", (inc["id"], v["incident"]["version"]))


def test_reporter_cannot_verify_own_report_four_eyes(users):
    inc = new_incident(users["officer"], title="Officer field report")
    assert str(inc["reporter_id"]) == users["officer"] and inc["status"] == "reported"
    with pytest.raises(psycopg.Error, match="four-eyes"):
        with as_user(users["officer"]) as c:
            c.execute("select transition_incident(%s,'verified',%s,null,null)", (inc["id"], inc["version"]))
    with pytest.raises(psycopg.Error, match="four-eyes"):
        with as_user(users["officer"]) as c:
            c.execute("update incidents set status='verified' where id=%s", (inc["id"],))
    with as_user(users["admin"]) as c:
        r = c.execute("select transition_incident(%s,'verified',%s,null,null) r", (inc["id"], inc["version"])).fetchone()["r"]
    assert r["ok"] is True and str(r["incident"]["verified_by"]) == users["admin"]

    own = new_incident(users["officer"], title="Officer report withdrawn")
    with as_user(users["officer"]) as c:
        r = c.execute("select transition_incident(%s,'rejected',%s,'Water cleared before crews arrived',null) r",
                      (own["id"], own["version"])).fetchone()["r"]
    assert r["ok"] is True and r["incident"]["status"] == "rejected"


def test_geospatial_duplicate_detection(users):
    lat, lng = random_dhaka_point()
    a = new_incident(users["citizen"], lat=lat, lng=lng)
    b = new_incident(users["citizen2"], lat=lat + 0.0001, lng=lng + 0.0001)
    assert a["status"] == "reported"
    assert b["status"] == "duplicate" and b["duplicate_of"] == a["id"]


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
    assert statuses == ["fulfilled", "open"]


def test_ngo_allocation_lifecycle_cancel_returns_stock_and_deliver_keeps_it(users):
    with raw() as c:
        rid = c.execute("""insert into resources(organization_id, resource_type, name, quantity_total, quantity_available, lat, lng)
                           values (%s,'relief_kit',%s,10,10,23.74,90.37) returning id""", (SHOBAR, f"life kits {uuid.uuid4()}")).fetchone()["id"]
        need = c.execute("""insert into community_needs(ward_id, need_type, quantity, households, dedup_key, contact_name)
                            values ('DSCC-10','relief_kit',6,6,'x',%s) returning id""", (str(uuid.uuid4()),)).fetchone()["id"]
    with as_user(users["ngo"]) as c:
        a1 = c.execute("select allocate_to_need(%s,%s,4,%s) r", (need, rid, str(uuid.uuid4()))).fetchone()["r"]["allocation"]["id"]
    with as_user(users["ngo"]) as c:
        with pytest.raises(psycopg.Error, match="INVALID_STATE"):
            c.execute("select cancel_need(%s,null)", (need,))
    with as_user(users["ngo"]) as c:
        assert c.execute("select ngo_update_allocation(%s,'cancel') r", (a1,)).fetchone()["r"]["ok"]
        assert c.execute("select ngo_update_allocation(%s,'cancel') r", (a1,)).fetchone()["r"]["replayed"]
    with raw() as c:
        assert c.execute("select quantity_available q from resources where id=%s", (rid,)).fetchone()["q"] == 10
        n = c.execute("select status::text s, fulfilled_qty f from community_needs where id=%s", (need,)).fetchone()
    assert (n["s"], n["f"]) == ("open", 0)
    with as_user(users["ngo"]) as c:
        a2 = c.execute("select allocate_to_need(%s,%s,6,%s) r", (need, rid, str(uuid.uuid4()))).fetchone()["r"]["allocation"]["id"]
        c.execute("select ngo_update_allocation(%s,'dispatch')", (a2,))
        c.execute("select ngo_update_allocation(%s,'deliver')", (a2,))
    with as_user(users["ngo"]) as c:
        with pytest.raises(psycopg.Error, match="INVALID_STATE"):
            c.execute("select ngo_update_allocation(%s,'cancel')", (a2,))
    with raw() as c:
        assert c.execute("select quantity_available q from resources where id=%s", (rid,)).fetchone()["q"] == 4
        assert c.execute("select status::text s from community_needs where id=%s", (need,)).fetchone()["s"] == "fulfilled"


def test_ngo_cannot_manage_another_ngos_allocation_or_cancel_its_need(users):
    with raw() as c:
        rid = c.execute("""insert into resources(organization_id, resource_type, name, quantity_total, quantity_available, lat, lng)
                           values (%s,'relief_kit',%s,5,5,23.74,90.37) returning id""", (NODI, f"nodi kits {uuid.uuid4()}")).fetchone()["id"]
        need = c.execute("""insert into community_needs(ward_id, need_type, quantity, households, dedup_key, contact_name)
                            values ('DSCC-10','relief_kit',2,2,'x',%s) returning id""", (str(uuid.uuid4()),)).fetchone()["id"]
        alloc = c.execute("select (rm_reserve_resource(%s,2,%s,null,%s,null,null)).id id", (rid, str(uuid.uuid4()), need)).fetchone()["id"]
        c.execute("update community_needs set organization_id=%s where id=%s", (NODI, need))
    with as_user(users["ngo"]) as c:
        with pytest.raises(psycopg.Error, match="FORBIDDEN"):
            c.execute("select ngo_update_allocation(%s,'cancel')", (alloc,))
    with as_user(users["ngo"]) as c:
        with pytest.raises(psycopg.Error, match="FORBIDDEN"):
            c.execute("select cancel_need(%s,null)", (need,))
    with as_user(users["citizen"]) as c:
        with pytest.raises(psycopg.Error, match="FORBIDDEN"):
            c.execute("select ngo_update_allocation(%s,'deliver')", (alloc,))


def _need_and_stock(ward, org):
    with raw() as c:
        rid = c.execute("""insert into resources(organization_id, resource_type, name, quantity_total, quantity_available, lat, lng)
                           values (%s,'relief_kit',%s,20,20,23.74,90.37) returning id""", (org, f"area kits {uuid.uuid4()}")).fetchone()["id"]
        need = c.execute("""insert into community_needs(ward_id, need_type, quantity, households, dedup_key, contact_name)
                            values (%s,'relief_kit',6,6,'x',%s) returning id""", (ward, str(uuid.uuid4()))).fetchone()["id"]
    return need, rid


def test_coordinator_handles_own_area_and_helps_other_area_only_on_request(users):
    with raw() as c:
        c.execute("delete from ngo_area_backup")
    need, _ = _need_and_stock("DNCC-02", NODI)
    _, south_stock = _need_and_stock("DSCC-10", SHOBAR)
    with as_user(users["ngo"]) as c:
        assert c.execute("select rm_ngo_area() a").fetchone()["a"] == "DSCC"
        assert c.execute("select rm_ngo_access(%s) a", (need,)).fetchone()["a"] is None
        with pytest.raises(psycopg.Error, match="FORBIDDEN"):
            c.execute("select allocate_to_need(%s,%s,2,%s)", (need, south_stock, str(uuid.uuid4())))
    with as_user(users["ngo"]) as c:
        with pytest.raises(psycopg.Error, match="FORBIDDEN"):
            c.execute("select request_ngo_backup(%s,true,null)", (need,))

    with as_user(users["ngo_north"]) as c:
        assert c.execute("select rm_ngo_access(%s) a", (need,)).fetchone()["a"] == "home"
        c.execute("select request_ngo_backup(%s,true,'boats stuck, need kits fast')", (need,))
    with as_user(users["ngo"]) as c:
        r = c.execute("select allocate_to_need(%s,%s,2,%s) r", (need, south_stock, str(uuid.uuid4()))).fetchone()["r"]
        assert r["ok"] and r["access"] == "backup"
    with as_user(users["ngo"]) as c:
        with pytest.raises(psycopg.Error, match="FORBIDDEN"):
            c.execute("select cancel_need(%s,null)", (need,))

    need2, _ = _need_and_stock("DNCC-02", NODI)
    with as_user(users["ngo_north"]) as c:
        c.execute("select set_ngo_area_backup(true,'North overwhelmed')")
    with as_user(users["ngo"]) as c:
        assert c.execute("select rm_ngo_access(%s) a", (need2,)).fetchone()["a"] == "backup"
        status = {r["area"]: r for r in c.execute("select * from ngo_area_status()").fetchall()}
        assert status["DNCC"]["area_backup"] is True
    with as_user(users["ngo_north"]) as c:
        c.execute("select set_ngo_area_backup(false)")
    with as_user(users["ngo"]) as c:
        assert c.execute("select rm_ngo_access(%s) a", (need2,)).fetchone()["a"] is None


def test_vice_versa_north_helps_south_and_area_change_needs_admin(users):
    need, _ = _need_and_stock("DSCC-10", SHOBAR)
    _, north_stock = _need_and_stock("DNCC-02", NODI)
    with as_user(users["ngo"]) as c:
        c.execute("select request_ngo_backup(%s,true,null)", (need,))
    with as_user(users["ngo_north"]) as c:
        assert c.execute("select allocate_to_need(%s,%s,1,%s) r", (need, north_stock, str(uuid.uuid4()))).fetchone()["r"]["ok"]
    with as_user(users["ngo"]) as c:
        with pytest.raises(psycopg.Error, match="FORBIDDEN"):
            c.execute("update profiles set ward_id='DNCC-02' where id=%s", (users["ngo"],))


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
    with raw() as c:
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
    assert r["ok"] and again["replayed"] and again["run_id"] == r["run_id"]

    res = _drain_queue()
    assert {"status": "succeeded"} in res
    with raw() as c:
        assert c.execute("select quantity_available q from resources where id=%s", (pump,)).fetchone()["q"] == 2
        assert c.execute("select status::text s from incidents where id=%s", (inc["id"],)).fetchone()["s"] == "in_progress"
        tasks = c.execute("select id, version, status::text, assigned_to from tasks where incident_id=%s", (inc["id"],)).fetchall()
    assert tasks and all(t["status"] == "assigned" for t in tasks)

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


def test_officer_sets_crew_and_worker_declines_with_handover(users, pump):
    inc, plan = _assessed_incident_with_plan(users, pump, qty=1)
    with as_user(users["officer"]) as c:
        c.execute("select approve_plan(%s,%s,null)", (plan["id"], plan["version"]))
    _drain_queue()
    with raw() as c:
        t = c.execute("select id, assigned_to from tasks where incident_id=%s limit 1", (inc["id"],)).fetchone()
        crew = c.execute("select worker_id, is_lead from task_assignees where task_id=%s", (t["id"],)).fetchall()
    assert crew and sum(r["is_lead"] for r in crew) == 1
    assert next(r["worker_id"] for r in crew if r["is_lead"]) == t["assigned_to"]

    with pytest.raises(psycopg.Error, match="FORBIDDEN"):
        with as_user(users["citizen"]) as c:
            c.execute("select assign_task_crew(%s, array[%s]::uuid[], null)", (t["id"], users["field"]))
    with as_user(users["officer"]) as c:
        out = c.execute("select assign_task_crew(%s, array[%s]::uuid[], null) r", (t["id"], users["field"])).fetchone()["r"]
    assert out["ok"] and str(out["task"]["assigned_to"]) == str(users["field"])

    with pytest.raises(psycopg.Error, match="VALIDATION"):
        with as_user(users["field"]) as c:
            c.execute("select decline_task(%s, '')", (t["id"],))
    with as_user(users["field"]) as c:
        r = c.execute("select decline_task(%s, 'Sick today, cannot go') r", (t["id"],)).fetchone()["r"]
    with raw() as c:
        after = c.execute("select status::text s, assigned_to from tasks where id=%s", (t["id"],)).fetchone()
        gone = c.execute("select 1 from task_assignees where task_id=%s and worker_id=%s", (t["id"], users["field"])).fetchone()
        logged = c.execute("select 1 from task_declines where task_id=%s and worker_id=%s", (t["id"], users["field"])).fetchone()
    assert gone is None and logged is not None
    assert (after["s"] == "pending") == (r["replacement"] is None)


def test_worker_reports_problem_after_accepting_and_officer_restaffs(users, pump):
    inc, plan = _assessed_incident_with_plan(users, pump, qty=1)
    with as_user(users["officer"]) as c:
        c.execute("select approve_plan(%s,%s,null)", (plan["id"], plan["version"]))
    _drain_queue()
    with raw() as c:
        t = c.execute("select id from tasks where incident_id=%s limit 1", (inc["id"],)).fetchone()
    with as_user(users["officer"]) as c:
        v = c.execute("select assign_task_crew(%s, array[%s]::uuid[], null) r", (t["id"], users["field"])).fetchone()["r"]["task"]["version"]

    ensure_staff_session(users["field"])
    with as_user(users["field"]) as c:
        v = c.execute("select update_task_status(%s,'accepted',%s) r", (t["id"], v)).fetchone()["r"]["task"]["version"]
    with pytest.raises(psycopg.Error, match="VALIDATION"):
        with as_user(users["field"]) as c:
            c.execute("select update_task_status(%s,'failed',%s,'  ') r", (t["id"], v))
    with as_user(users["field"]) as c:
        out = c.execute("select update_task_status(%s,'failed',%s,'Road blocked by a fallen tree',23.73,90.41) r",
                        (t["id"], v)).fetchone()["r"]
    assert out["ok"] and out["task"]["status"] == "failed"
    assert out["task"]["finished_lat"] == 23.73 and str(out["task"]["finished_by"]) == str(users["field"])
    with pytest.raises(psycopg.Error, match="FORBIDDEN"):
        with as_user(users["field"]) as c:
            c.execute("select update_task_status(%s,'cancelled',%s)", (t["id"], out["task"]["version"]))

    with as_user(users["officer"]) as c:
        again = c.execute("select assign_task_crew(%s, array[%s]::uuid[], null) r", (t["id"], users["field"])).fetchone()["r"]
    assert again["task"]["status"] == "assigned"


def test_intermediate_step_failure_compensates_everything(users, pump):
    inc, plan = _assessed_incident_with_plan(users, pump)
    with pytest.raises(psycopg.Error, match="FORBIDDEN"):
        with as_user(users["officer"]) as c:
            c.execute("select approve_plan(%s,%s,'create_tasks')", (plan["id"], plan["version"]))
    with as_user(users["admin"]) as c:
        run_id = c.execute("select approve_plan(%s,%s,'create_tasks') r", (plan["id"], plan["version"])).fetchone()["r"]["run_id"]

    for _ in range(3):
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


def test_ngo_coordinator_cannot_approve_or_reject_pump_and_crew_plans(users, pump):
    inc, plan = _assessed_incident_with_plan(users, pump)
    for ngo in ("ngo", "ngo_north"):
        with as_user(users[ngo]) as c:
            with pytest.raises(psycopg.Error, match="FORBIDDEN"):
                c.execute("select approve_plan(%s,%s,null)", (plan["id"], plan["version"]))
        with as_user(users[ngo]) as c:
            with pytest.raises(psycopg.Error, match="FORBIDDEN"):
                c.execute("select reject_plan(%s,'not ours')", (plan["id"],))
    with as_user(users["ngo"]) as c:
        assert c.execute("select count(*) n from incidents where id=%s", (inc["id"],)).fetchone()["n"] == 1
    with raw() as c:
        assert c.execute("select status from allocation_plans where id=%s", (plan["id"],)).fetchone()["status"] == "pending_approval"


def test_ngo_relief_is_not_auto_delivered_when_the_report_is_resolved(users):
    inc = new_incident(users["citizen"])
    with raw() as c:
        c.execute("update incidents set status='verified' where id=%s", (inc["id"],))
        rid = c.execute("""insert into resources(organization_id, resource_type, name, quantity_total, quantity_available, lat, lng)
                           values (%s,'relief_kit',%s,5,5,23.74,90.37) returning id""", (SHOBAR, f"link kits {uuid.uuid4()}")).fetchone()["id"]
        ward = c.execute("select ward_id from incidents where id=%s", (inc["id"],)).fetchone()["ward_id"]
        need = c.execute("""insert into community_needs(ward_id, incident_id, need_type, quantity, households, dedup_key, contact_name)
                            values (%s,%s,'relief_kit',2,2,'x',%s) returning id""", (ward, inc["id"], str(uuid.uuid4()))).fetchone()["id"]
        c.execute("update community_needs set backup_requested_at = now() where id=%s", (need,))
    with as_user(users["ngo"]) as c:
        a = c.execute("select allocate_to_need(%s,%s,2,%s) r", (need, rid, str(uuid.uuid4()))).fetchone()["r"]["allocation"]
    assert a["need_id"] == str(need) and a["incident_id"] is None


def test_ngo_sees_only_own_stock_and_cannot_register_pumps(users):
    with raw() as c:
        nodi = c.execute("""insert into resources(organization_id, resource_type, name, quantity_total, quantity_available, lat, lng)
                            values (%s,'relief_kit',%s,5,5,23.74,90.37) returning id""", (NODI, f"nodi only {uuid.uuid4()}")).fetchone()["id"]
        pump = c.execute("""insert into resources(organization_id, resource_type, name, quantity_total, quantity_available, lat, lng)
                            values (%s,'pump',%s,2,2,23.74,90.37) returning id""", (SOUTH, f"south pump {uuid.uuid4()}")).fetchone()["id"]
    with as_user(users["ngo"]) as c:
        orgs = {r["organization_id"] for r in c.execute("select organization_id::text from resources").fetchall()}
        assert orgs <= {SHOBAR}
        assert c.execute("select count(*) n from resources where id = any(%s)", ([nodi, pump],)).fetchone()["n"] == 0
        with pytest.raises(psycopg.Error):
            c.execute("""insert into resources(organization_id, resource_type, name, quantity_total, quantity_available, lat, lng)
                         values (%s,'pump','our pump',1,1,23.74,90.37)""", (SHOBAR,))
    with as_user(users["officer"]) as c:
        assert c.execute("select count(*) n from resources where id=%s", (pump,)).fetchone()["n"] == 1
        assert c.execute("select count(*) n from resources where id=%s", (nodi,)).fetchone()["n"] == 0
