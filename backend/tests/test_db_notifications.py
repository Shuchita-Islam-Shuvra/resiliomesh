"""Migration 023: notifications (in-app + e-mail/SMS outbox) and admin resolve-at-any-stage."""
import json
import os
import random
import uuid

import pytest

from .dbutil import DSN, as_user, nearest_ward, new_auth_user, open_session, random_dhaka_point, raw, verify_staff_session

pytestmark = pytest.mark.skipif(not DSN, reason="TEST_DATABASE_URL not set")

if DSN:
    import psycopg

SOUTH = "11111111-1111-1111-1111-111111111102"
SHOBAR = "11111111-1111-1111-1111-111111111103"
NODI = "11111111-1111-1111-1111-111111111104"


def _phone():
    return "+8801" + random.choice("3456789") + "".join(random.choices("0123456789", k=8))


@pytest.fixture(scope="module")
def users():
    ids = {}
    with raw() as c:
        old = c.execute("select citizen_reports_per_hour h, citizen_reports_per_day d from security_settings where id").fetchone()
        c.execute("update security_settings set citizen_reports_per_hour = 1000, citizen_reports_per_day = 5000 where id")
        for key, role, org, home in [("citizen", "citizen", None, None), ("officer", "city_officer", SOUTH, None),
                                     ("officer2", "city_officer", SOUTH, None), ("admin", "admin", None, None),
                                     ("field", "field_worker", SOUTH, None),
                                     ("ngo", "ngo_coordinator", SHOBAR, "DSCC-10"),
                                     ("ngo_north", "ngo_coordinator", NODI, "DNCC-02")]:
            try:
                uid = new_auth_user(c, f"nt-{key}")
            except psycopg.Error as e:
                pytest.skip(f"cannot create auth users in this database: {e}")
            c.execute("update profiles set role=%s, organization_id=%s, ward_id=coalesce(%s, ward_id), phone=%s where id=%s",
                      (role, org, home, _phone() if role != "citizen" else None, uid))
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


def report(uid, severity=2, depth=10, area="DSCC"):
    lat, lng = random_dhaka_point(area)
    with raw() as c:
        ward = nearest_ward(c, lat, lng)
    with as_user(uid) as c:
        return c.execute("""insert into incidents(reporter_id, ward_id, category, title, description, severity_reported,
                             water_depth_cm, people_affected, lat, lng)
                            values (%s, %s, 'blocked_drain', %s, 'Notification test incident text', %s, %s, 40, %s, %s)
                            returning *""",
                         (uid, ward, f"Notify test {uuid.uuid4().hex[:6]}", severity, depth, lat, lng)).fetchone()


def inbox(uid, incident_id=None, kind=None):
    with raw() as c:
        return c.execute("""select n.*, coalesce((select array_agg(channel order by channel) from notification_deliveries d
                                                   where d.notification_id = n.id), '{}') channels
                              from notifications n
                             where recipient_id = %s and (%s::uuid is null or incident_id = %s::uuid)
                               and (%s::text is null or kind = %s::text)
                             order by created_at""", (uid, incident_id, incident_id, kind, kind)).fetchall()


def test_new_report_notifies_area_officers_not_reporter(users):
    inc = report(users["citizen"])
    got = inbox(users["officer"], inc["id"], "new_report")
    assert len(got) == 1 and got[0]["severity"] == "normal" and got[0]["channels"] == []
    assert got[0]["link"] == f"/incidents/{inc['id']}"
    assert inbox(users["citizen"], inc["id"]) == []


def test_critical_citizen_report_emails_officers_but_no_sms(users):
    inc = report(users["citizen"], severity=5, depth=60)
    got = inbox(users["officer"], inc["id"], "new_report")[0]
    assert got["severity"] == "critical" and got["channels"] == ["email"]


def test_critical_admin_report_emails_and_texts_officers(users):
    inc = report(users["admin"], severity=5, depth=60)
    got = inbox(users["officer"], inc["id"], "new_report")[0]
    assert got["severity"] == "critical" and got["channels"] == ["email", "sms"]
    assert "(Admin)" in got["body"]
    assert inbox(users["admin"], inc["id"]) == []


def test_notifications_are_private_and_marked_read_by_owner(users):
    inc = report(users["citizen"])
    with as_user(users["officer2"]) as c:
        assert c.execute("select count(*) n from notifications where recipient_id=%s", (users["officer"],)).fetchone()["n"] == 0
        assert c.execute("select count(*) n from notification_deliveries").fetchone()["n"] == 0
    with as_user(users["officer"]) as c:
        nid = c.execute("select id from notifications where incident_id=%s", (inc["id"],)).fetchone()["id"]
        assert c.execute("update notifications set title='x' where id=%s returning id", (nid,)).fetchall() == []
        assert c.execute("select mark_notifications_read(array[%s]::uuid[]) n", (nid,)).fetchone()["n"] == 1
        assert c.execute("select read_at from notifications where id=%s", (nid,)).fetchone()["read_at"] is not None


def test_internal_notify_functions_are_not_callable_by_users(users):
    for fn in ("select rm_notify(array[%s]::uuid[], 'alert', 'high', 't', 'b')",
               "select * from rm_claim_deliveries(%s)"):
        with pytest.raises(psycopg.Error, match="permission denied"):
            with as_user(users["officer"]) as c:
                c.execute(fn, (users["officer"],))


def test_officer_alerts_ngo_and_field_of_area_only_and_is_throttled(users):
    inc = report(users["citizen"])
    with as_user(users["officer"]) as c:
        r = c.execute("select send_incident_alert(%s, array['ngo','field'], 'Families stranded, send relief now', true) r",
                      (inc["id"],)).fetchone()["r"]
    assert r["ok"] and r["sent"] >= 2
    ngo = inbox(users["ngo"], inc["id"], "alert")
    assert len(ngo) == 1 and ngo[0]["severity"] == "critical" and ngo[0]["channels"] == ["email", "sms"]
    assert "Families stranded" in ngo[0]["body"]
    assert inbox(users["ngo_north"], inc["id"], "alert") == []
    assert len(inbox(users["field"], inc["id"], "alert")) == 1
    with pytest.raises(psycopg.Error, match="RATE_LIMITED"):
        with as_user(users["officer"]) as c:
            c.execute("select send_incident_alert(%s, array['ngo'], 'Second alert too soon', false)", (inc["id"],))


def test_alert_rules(users):
    inc = report(users["citizen"])
    with pytest.raises(psycopg.Error, match="FORBIDDEN"):
        with as_user(users["citizen"]) as c:
            c.execute("select send_incident_alert(%s, array['officers'], 'please come here', false)", (inc["id"],))
    with pytest.raises(psycopg.Error, match="VALIDATION"):
        with as_user(users["admin"]) as c:
            c.execute("select send_incident_alert(%s, array['everyone'], 'please come here', false)", (inc["id"],))
    with as_user(users["admin"]) as c:
        r = c.execute("select send_incident_alert(%s, array['officers'], 'Go check this drain today', false) r",
                      (inc["id"],)).fetchone()["r"]
    assert r["ok"] and inbox(users["officer"], inc["id"], "alert")[0]["channels"] == ["email"]


def test_relief_need_notifies_home_area_ngo_coordinators(users):
    with as_user(users["officer"]) as c:
        need = c.execute("""insert into community_needs(ward_id, need_type, quantity, households, contact_name)
                            values ('DSCC-10', 'relief_kit', 5, 120, %s) returning id""",
                         (f"nt {uuid.uuid4().hex[:6]}",)).fetchone()["id"]
    with raw() as c:
        n = c.execute("""select n.severity, array_agg(d.channel order by d.channel) ch from notifications n
                         left join notification_deliveries d on d.notification_id = n.id
                         where n.recipient_id = %s and n.dedup_key = %s group by 1""",
                      (users["ngo"], f"need:{need}")).fetchone()
        north = c.execute("select count(*) k from notifications where recipient_id=%s and dedup_key=%s",
                          (users["ngo_north"], f"need:{need}")).fetchone()["k"]
    assert n["severity"] == "high" and n["ch"] == ["email", "sms"]
    assert north == 0

    with as_user(users["ngo"]) as c:
        c.execute("select request_ngo_backup(%s, true, 'Out of kits')", (need,))
    with raw() as c:
        assert c.execute("select count(*) k from notifications where recipient_id=%s and kind='ngo_backup' and body like '%%Out of kits%%'",
                         (users["ngo_north"],)).fetchone()["k"] == 1


# ------------------------------------------------------------------ admin resolve
@pytest.fixture
def pump():
    with raw() as c:
        return c.execute("""insert into resources(organization_id, resource_type, name, quantity_total, quantity_available, lat, lng)
                            values (%s,'pump',%s,4,4,23.74,90.41) returning id""", (SOUTH, f"nt pump {uuid.uuid4()}")).fetchone()["id"]


def _dispatched_incident(users, pump):
    inc = report(users["citizen"])
    with raw() as c:
        c.execute("update incidents set status='verified' where id=%s", (inc["id"],))
        c.execute("update incidents set status='assessed', risk_score=81, risk_level='critical', priority=88 where id=%s", (inc["id"],))
        plan = c.execute("""insert into allocation_plans(incident_ids, feasible, assignments, explanation, constraints, created_by)
                            values (array[%s]::uuid[], true, %s, '{}', '{}', %s) returning id, version""",
                         (inc["id"], json.dumps([{"incident_id": str(inc["id"]), "resource_id": str(pump),
                                                  "resource_type": "pump", "quantity": 2}]), users["officer"])).fetchone()
    with as_user(users["officer"]) as c:
        c.execute("select approve_plan(%s,%s,null)", (plan["id"], plan["version"]))
    from app.workflow.engine import WorkflowEngine
    from app.workflow.pg_store import PgStore, claim_run
    eng = WorkflowEngine(PgStore(), backoff_base_s=0)
    while (run := claim_run("pytest-nt")) is not None:
        eng.execute(run)
    with raw() as c:
        cur = c.execute("select * from incidents where id=%s", (inc["id"],)).fetchone()
        crew = [r["worker_id"] for r in c.execute(
            "select ta.worker_id from task_assignees ta join tasks t on t.id=ta.task_id where t.incident_id=%s", (inc["id"],))]
    assert cur["status"] == "in_progress" and crew
    return cur, crew


def test_dispatch_notifies_crew_with_sms_and_email(users, pump):
    inc, crew = _dispatched_incident(users, pump)
    got = inbox(crew[0], inc["id"], "task_assigned")
    assert len(got) == 1 and got[0]["link"] == "/field"
    with raw() as c:
        phone = c.execute("select phone from profiles where id=%s", (crew[0],)).fetchone()["phone"]
    assert "sms" in got[0]["channels"] or phone is None


def test_admin_resolves_mid_dispatch_cancels_tasks_returns_stock_and_tells_everyone(users, pump):
    inc, crew = _dispatched_incident(users, pump)
    with raw() as c:
        assert c.execute("select quantity_available q from resources where id=%s", (pump,)).fetchone()["q"] == 2
    with pytest.raises(psycopg.Error, match="FORBIDDEN"):
        with as_user(users["officer"]) as c:
            c.execute("select resolve_incident(%s,%s,'water is gone')", (inc["id"], inc["version"]))
    with pytest.raises(psycopg.Error, match="VALIDATION"):
        with as_user(users["admin"]) as c:
            c.execute("select resolve_incident(%s,%s,'  ')", (inc["id"], inc["version"]))
    with as_user(users["admin"]) as c:
        stale = c.execute("select resolve_incident(%s,%s,'water is gone') r", (inc["id"], inc["version"] - 1)).fetchone()["r"]
        assert stale["conflict"] is True
        r = c.execute("select resolve_incident(%s,%s,'Water drained on its own overnight') r",
                      (inc["id"], inc["version"])).fetchone()["r"]
    assert r["ok"] and r["tasks_cancelled"] >= 1 and r["equipment_returned"] >= 1
    with raw() as c:
        assert c.execute("select status::text s from incidents where id=%s", (inc["id"],)).fetchone()["s"] == "resolved"
        assert c.execute("select count(*) n from tasks where incident_id=%s and status <> 'cancelled'",
                         (inc["id"],)).fetchone()["n"] == 0
        assert c.execute("select quantity_available q from resources where id=%s", (pump,)).fetchone()["q"] == 4
        h = c.execute("""select note, changed_by from incident_status_history
                          where incident_id=%s and to_status='resolved'""", (inc["id"],)).fetchone()
    assert "Water drained" in h["note"] and str(h["changed_by"]) == users["admin"]

    cancelled = inbox(crew[0], inc["id"], "task_cancelled")
    assert len(cancelled) >= 1 and "Water drained" in cancelled[0]["body"]
    assert len(inbox(crew[0], inc["id"], "incident_resolved")) == 1
    assert len(inbox(users["officer"], inc["id"], "incident_resolved")) == 1
    reporter = inbox(users["citizen"], inc["id"], "incident_resolved")
    assert len(reporter) == 1 and reporter[0]["channels"] == ["email"]
    assert inbox(users["admin"], inc["id"], "incident_resolved") == []

    with pytest.raises(psycopg.Error, match="INVALID_STATE"):
        with as_user(users["admin"]) as c:
            v = c.execute("select version from incidents where id=%s", (inc["id"],)).fetchone()["version"]
            c.execute("select resolve_incident(%s,%s,'again please')", (inc["id"], v))


def test_admin_can_resolve_a_fresh_report_but_officers_still_cannot_skip_steps(users):
    inc = report(users["officer"])
    with pytest.raises(psycopg.Error, match="INVALID_TRANSITION"):
        with as_user(users["officer2"]) as c:
            c.execute("select transition_incident(%s,'resolved',%s,null,null)", (inc["id"], inc["version"]))
    with as_user(users["admin"]) as c:
        r = c.execute("select resolve_incident(%s,%s,'Checked by phone, already cleared') r",
                      (inc["id"], inc["version"])).fetchone()["r"]
    assert r["ok"] and r["incident"]["status"] == "resolved" and r["tasks_cancelled"] == 0
    assert len(inbox(users["officer2"], inc["id"], "incident_resolved")) == 1


def test_outbox_is_claimed_once_and_sent_outside_the_transaction(users):
    from app.services.notifier import PgDeliveryStore, Sent, process_batch
    inc = report(users["admin"], severity=5, depth=80)

    class Recorder:
        name = "fake"

        def __init__(self):
            self.to = []

        def send(self, destination, d):
            self.to.append((destination, d["title"]))
            return Sent("sent", "fake", ref="m-1")

    with raw() as c:
        c.execute("""update notification_deliveries set next_attempt_at = now() + interval '1 hour'
                      where status = 'queued' and notification_id not in
                            (select id from notifications where incident_id = %s)""", (inc["id"],))
    rec = Recorder()
    store = PgDeliveryStore()
    counts = process_batch(store, {"email": rec, "sms": rec}, "pytest-nt", limit=100)
    assert counts["sent"] >= 2 and any("Critical report" in t for _, t in rec.to)
    assert process_batch(store, {"email": rec, "sms": rec}, "pytest-nt", limit=100)["sent"] == 0
    with raw() as c:
        rows = c.execute("""select d.status, d.provider, d.sent_at, d.locked_by from notification_deliveries d
                             join notifications n on n.id = d.notification_id where n.incident_id = %s""", (inc["id"],)).fetchall()
    assert rows and all(r["status"] == "sent" and r["provider"] == "fake" and r["sent_at"] and r["locked_by"] is None
                        for r in rows)


# ------------------------------------------------------------------ 024: who registers needs, confirm before stock
def _kits(org):
    with raw() as c:
        return c.execute("""insert into resources(organization_id, resource_type, name, quantity_total, quantity_available, lat, lng)
                            values (%s,'relief_kit',%s,20,20,23.74,90.37) returning id""", (org, f"nt kits {uuid.uuid4()}")).fetchone()["id"]


def _log_need(uid, ward="DSCC-10", households=8):
    with as_user(uid) as c:
        return c.execute("""insert into community_needs(ward_id, need_type, quantity, households, contact_name, dedup_key)
                            values (%s, 'relief_kit', 4, %s, %s, 'x') returning *""",
                         (ward, households, f"nt {uuid.uuid4().hex[:8]}")).fetchone()


def test_citizens_cannot_register_needs(users):
    with pytest.raises(psycopg.Error, match="row-level security"):
        _log_need(users["citizen"])


def test_field_worker_need_waits_for_confirmation_before_stock(users):
    need = _log_need(users["field"])
    assert need["confirmed_at"] is None and str(need["submitted_by"]) == users["field"]
    kits = _kits(SHOBAR)
    note = inbox(users["ngo"], kind="relief_need")
    assert any(n["dedup_key"] == f"need:{need['id']}" and n["title"].startswith("Confirm a need") for n in note)

    with pytest.raises(psycopg.Error, match="not confirmed yet"):
        with as_user(users["ngo"]) as c:
            c.execute("select allocate_to_need(%s,%s,2,%s)", (need["id"], kits, str(uuid.uuid4())))
    with raw() as c:
        assert c.execute("select quantity_available q from resources where id=%s", (kits,)).fetchone()["q"] == 20

    for who in ("field", "citizen", "ngo_north"):
        with pytest.raises(psycopg.Error, match="FORBIDDEN"):
            with as_user(users[who]) as c:
                c.execute("select confirm_need(%s)", (need["id"],))
    with pytest.raises(psycopg.Error, match="FORBIDDEN"):
        with as_user(users["ngo"]) as c:
            c.execute("update community_needs set confirmed_at = now() where id=%s", (need["id"],))

    with as_user(users["ngo"]) as c:
        assert c.execute("select confirm_need(%s) r", (need["id"],)).fetchone()["r"]["ok"]
        assert c.execute("select allocate_to_need(%s,%s,2,%s) r", (need["id"], kits, str(uuid.uuid4()))).fetchone()["r"]["ok"]
    assert any(n["title"].startswith("Need confirmed") for n in inbox(users["field"], kind="relief_need"))


def test_officer_of_the_area_can_confirm_a_field_need(users):
    need = _log_need(users["field"])
    with as_user(users["officer"]) as c:
        assert c.execute("select confirm_need(%s) r", (need["id"],)).fetchone()["r"]["ok"]


def test_field_worker_cannot_register_outside_own_area(users):
    with pytest.raises(psycopg.Error, match="outside your area"):
        _log_need(users["field"], ward="DNCC-02")


def test_coordinator_and_officer_needs_are_confirmed_at_once(users):
    for who in ("ngo", "officer"):
        need = _log_need(users[who])
        assert need["confirmed_at"] is not None and str(need["confirmed_by"]) == users[who]


# ------------------------------------------------------------------ 025: analytics mean what they say
def _raw_incident(users, ward, created_sql, status="reported", resolved_sql=None):
    with raw() as c:
        lat, lng = c.execute("select lat, lng from wards where id=%s", (ward,)).fetchone().values()
        return c.execute(f"""insert into incidents(reporter_id, ward_id, category, title, description, severity_reported,
                               people_affected, lat, lng, status, created_at, resolved_at)
                             values (%s, %s, 'waterlogging', %s, 'Analytics test incident', 2, 5, %s, %s, %s,
                                     {created_sql}, {resolved_sql or 'null'}) returning id""",
                         (users["citizen"], ward, f"An {uuid.uuid4().hex[:6]}", lat, lng, status)).fetchone()["id"]


def _dash(uid, days=30, ward=None):
    with as_user(uid) as c:
        return c.execute("select analytics_dashboard(%s, %s) d", (days, ward)).fetchone()["d"]


def _day(d, day):
    return next(x for x in d["daily"] if x["day"] == str(day))


def test_analytics_counts_resolution_on_its_own_dhaka_day(users):
    ward = "DSCC-05"
    with raw() as c:
        today = c.execute("select (now() at time zone 'Asia/Dhaka')::date d").fetchone()["d"]
    from datetime import timedelta
    three_ago, yesterday = today - timedelta(days=3), today - timedelta(days=1)
    before = _dash(users["admin"], 30, ward)
    # reported 3 Dhaka days ago, resolved today
    _raw_incident(users, ward, f"(('{three_ago} 12:00')::timestamp at time zone 'Asia/Dhaka')", "resolved", "now()")
    # 02:00 Dhaka yesterday = 20:00 UTC the day before: must count on Dhaka "yesterday"
    _raw_incident(users, ward, f"(('{yesterday} 02:00')::timestamp at time zone 'Asia/Dhaka')")
    after = _dash(users["admin"], 30, ward)
    assert _day(after, three_ago)["reported"] - _day(before, three_ago)["reported"] == 1
    assert _day(after, three_ago)["resolved"] == _day(before, three_ago)["resolved"]
    assert _day(after, today)["resolved"] - _day(before, today)["resolved"] == 1
    assert _day(after, yesterday)["reported"] - _day(before, yesterday)["reported"] == 1
    assert after["daily"][-1]["day"] == str(today) and len(after["daily"]) == 30


def test_open_now_includes_old_reports_and_rate_ignores_rejected_and_duplicates(users):
    ward = "DSCC-06"
    before = _dash(users["admin"], 30, ward)
    _raw_incident(users, ward, "now() - interval '40 days'")
    mid = _dash(users["admin"], 30, ward)
    assert mid["totals"]["open_now"] - before["totals"]["open_now"] == 1
    assert mid["totals"]["reports"] == before["totals"]["reports"]

    with raw() as c:
        c.execute("delete from incidents where ward_id='DSCC-07' and title like 'An %%'")
    ok = _raw_incident(users, "DSCC-07", "now() - interval '1 hour'", "resolved", "now()")
    _raw_incident(users, "DSCC-07", "now() - interval '1 hour'", "rejected")
    with raw() as c:
        c.execute("""insert into incidents(reporter_id, ward_id, category, title, description, severity_reported,
                       lat, lng, status, duplicate_of) select reporter_id, ward_id, category, 'An dup', description, 2,
                       lat, lng, 'duplicate', id from incidents where id=%s""", (ok,))
    d = _dash(users["admin"], 1, "DSCC-07")
    rows = d["totals"]
    others = rows["reports"] - 2  # anything other tests put in this ward today
    if others == 0:
        assert rows["resolution_rate"] == 100
    assert rows["duplicates"] >= 1 and rows["rejected"] >= 1
    assert sum(x["reported"] for x in d["daily"]) == rows["reports"]


def test_analytics_stock_follows_role_and_ngo_gets_relief_numbers(users):
    ngo = _dash(users["ngo"])
    assert {r["resource_type"] for r in ngo["resources"]}.isdisjoint({"pump", "crew"})
    assert {"needs_logged", "households_waiting", "units_requested", "units_delivered",
            "avg_hours_to_first_relief", "by_type", "awaiting_confirmation"} <= set(ngo["relief"])
    officer = _dash(users["officer"])
    assert officer["historical"]["synthetic"] is True
    with raw() as c:
        north = c.execute("select count(*) n from wards where city_corporation='DNCC'").fetchone()["n"]
    assert all(not w["ward_id"].startswith("DNCC") for w in officer["by_ward"]) and north > 0
