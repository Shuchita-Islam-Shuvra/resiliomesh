import json
import uuid

import pytest

from .dbutil import (DSN, SESSIONS, as_user, nearest_ward, new_auth_user, open_session, random_dhaka_point, raw,
                     settings, verify_staff_session)

pytestmark = pytest.mark.skipif(not DSN, reason="TEST_DATABASE_URL not set")

if DSN:
    import psycopg

NORTH = "11111111-1111-1111-1111-111111111101"
SOUTH = "11111111-1111-1111-1111-111111111102"
SHOBAR = "11111111-1111-1111-1111-111111111103"


def uniq(prefix):
    return f"{prefix}-{uuid.uuid4().hex[:6].upper()}"


def bd_mobile():
    n = uuid.uuid4().int
    return f"8801{3 + n % 7}{n // 7 % 10**8:08d}"


def staff(role, org=None, employee_id=None, *, verified=True, email=None):
    with raw() as c:
        uid = new_auth_user(c, role, email=email)
        c.execute("update profiles set role=%s, organization_id=%s, employee_id=%s where id=%s",
                  (role, org, employee_id, uid))
        open_session(c, uid)
        if verified:
            verify_staff_session(c, uid)
    return uid


def citizen(**meta):
    with raw() as c:
        uid = new_auth_user(c, "citizen", meta=meta)
        open_session(c, uid)
    return uid


def eff_role(uid, **kw):
    with as_user(uid, **kw) as c:
        return c.execute("select rm_role()::text r").fetchone()["r"]


def report(uid, lat=None, lng=None, ward=None, headers=None, **extra):
    if lat is None:
        lat, lng = random_dhaka_point()
    lat_j = lat
    with raw() as c:
        ward = ward or nearest_ward(c, lat_j, lng)
    with as_user(uid, headers=headers) as c:
        return c.execute("""insert into incidents(reporter_id, ward_id, category, title, description, severity_reported, lat, lng, trust_flags)
                            values (%s,%s,%s,'Identity test report','Identity test description',3,%s,%s,%s) returning *""",
                         (uid, ward, extra.get("category", "blocked_drain"), lat_j, lng, extra.get("trust_flags", []))).fetchone()


@pytest.fixture(scope="module")
def admins():
    a1 = staff("admin", employee_id=uniq("ADM"))
    a2 = staff("admin", employee_id=uniq("ADM"))
    return a1, a2


def test_password_only_session_gets_citizen_privileges():
    officer = staff("city_officer", SOUTH, uniq("DSCC"), verified=False)
    assert eff_role(officer) == "citizen"
    with as_user(officer) as c:
        assert c.execute("select count(*) n from resources").fetchone()["n"] == 0
        with pytest.raises(psycopg.Error, match="FORBIDDEN"):
            c.execute("select analytics_dashboard(30, null)")


def test_staff_id_verified_server_side_unlocks_role():
    emp = uniq("DSCC")
    officer = staff("city_officer", SOUTH, emp, verified=False)
    with as_user(officer) as c:
        bad = c.execute("select rm_verify_staff_login('city_officer', 'WRONG-ID', null) r").fetchone()["r"]
    assert bad["ok"] is False and bad["code"] == "ID_MISMATCH" and bad["attempts_left"] == 4
    assert eff_role(officer) == "citizen"
    with as_user(officer) as c:
        wrong_role = c.execute("select rm_verify_staff_login('admin', %s, null) r", (emp,)).fetchone()["r"]
        ok = c.execute("select rm_verify_staff_login('city_officer', %s, null) r", (emp.lower(),)).fetchone()["r"]
    assert wrong_role["code"] == "ROLE_MISMATCH" and wrong_role["actual_role"] == "city_officer"
    assert ok["ok"] is True
    assert eff_role(officer) == "city_officer"
    with raw() as c:
        rows = c.execute("select succeeded, reason from staff_login_attempts where user_id=%s order by id", (officer,)).fetchall()
    assert [(r["succeeded"], r["reason"]) for r in rows] == [(False, "ID_MISMATCH"), (True, None)]


def test_ngo_coordinator_second_factor_is_the_ngo():
    ngo = staff("ngo_coordinator", SHOBAR, verified=False)
    with as_user(ngo) as c:
        assert c.execute("select rm_verify_staff_login('ngo_coordinator', null, %s) r", (NORTH,)).fetchone()["r"]["code"] == "ORG_MISMATCH"
        assert c.execute("select rm_verify_staff_login('ngo_coordinator', null, %s) r", (SHOBAR,)).fetchone()["r"]["ok"]
    assert eff_role(ngo) == "ngo_coordinator"


def test_wrong_ids_lock_the_account():
    emp = uniq("FW")
    fw = staff("field_worker", SOUTH, emp, verified=False)
    with as_user(fw) as c:
        for _ in range(5):
            c.execute("select rm_verify_staff_login('field_worker', 'NOPE-1', null)")
        locked = c.execute("select rm_verify_staff_login('field_worker', %s, null) r", (emp,)).fetchone()["r"]
    assert locked["ok"] is False and locked["code"] == "LOCKED" and locked["retry_after_s"] > 0
    assert eff_role(fw) == "citizen"


def test_verified_session_cannot_be_borrowed_by_another_user():
    victim = staff("city_officer", SOUTH, uniq("DSCC"))
    attacker = staff("city_officer", SOUTH, uniq("DSCC"), verified=False)
    stolen = SESSIONS[victim]
    assert eff_role(attacker, session=stolen) == "citizen"
    with as_user(attacker, session=stolen) as c:
        r = c.execute("select rm_verify_staff_login('city_officer', 'X-X-X', null) r").fetchone()["r"]
    assert r == {"ok": False, "code": "SESSION_INVALID"}


def test_sign_out_expiry_and_role_change_end_staff_privileges(admins):
    officer = staff("city_officer", SOUTH, uniq("DSCC"))
    assert eff_role(officer) == "city_officer"
    with raw() as c:
        c.execute("update staff_sessions set expires_at = now() - interval '1 minute' where user_id=%s", (officer,))
    assert eff_role(officer) == "citizen"
    with raw() as c:
        verify_staff_session(c, officer)
    assert eff_role(officer) == "city_officer"
    with as_user(officer) as c:
        c.execute("select rm_end_staff_session()")
    assert eff_role(officer) == "citizen"
    with raw() as c:
        verify_staff_session(c, officer)
        c.execute("delete from auth.sessions where id=%s", (SESSIONS[officer],))
    assert eff_role(officer) == "citizen"


def test_authenticator_app_requires_aal2():
    officer = staff("city_officer", SOUTH, uniq("DSCC"))
    with raw() as c:
        c.execute("insert into auth.mfa_factors(user_id, status) values (%s,'verified')", (officer,))
    assert eff_role(officer, aal="aal1") == "citizen"
    assert eff_role(officer, aal="aal2") == "city_officer"
    admin = staff("admin", employee_id=uniq("ADM"))
    with settings(mfa_required_roles="{admin}"):
        assert eff_role(admin, aal="aal1") == "citizen"
        assert eff_role(admin, aal="aal2") == "admin"
    assert eff_role(admin, aal="aal1") == "admin"


def test_backend_api_sees_the_same_effective_role(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", DSN)
    from app.core import auth, config, db
    config.get_settings.cache_clear()
    db.close_pool()
    auth._profile_cache.clear()
    try:
        officer = staff("city_officer", SOUTH, uniq("DSCC"), verified=False)
        sid = SESSIONS[officer]
        assert auth.load_profile(officer, None, "aal1")["role"] == "citizen"
        assert auth.load_profile(officer, sid, "aal1")["role"] == "citizen"
        with raw() as c:
            verify_staff_session(c, officer)
        auth._profile_cache.clear()
        p = auth.load_profile(officer, sid, "aal1")
        assert p["role"] == "city_officer" and p["account_role"] == "city_officer"
    finally:
        auth._profile_cache.clear()
        db.close_pool()
        config.get_settings.cache_clear()


def test_phone_must_be_bangladeshi_and_is_normalised():
    cz = citizen()
    with as_user(cz) as c:
        c.execute("update profiles set phone='01712-345678' where id=%s", (cz,))
        assert c.execute("select phone from profiles where id=%s", (cz,)).fetchone()["phone"] == "+8801712345678"
    for bad in ("+14155550100", "+447700900123", "0171234"):
        with pytest.raises(psycopg.Error, match="Bangladeshi"):
            with as_user(cz) as c:
                c.execute("update profiles set phone=%s where id=%s", (bad, cz))


def test_signup_with_foreign_phone_stores_no_phone():
    cz = citizen(phone="+14155550100")
    with raw() as c:
        assert c.execute("select phone from profiles where id=%s", (cz,)).fetchone()["phone"] is None


def test_phone_verified_flag_only_comes_from_otp():
    cz = citizen()
    with pytest.raises(psycopg.Error, match="FORBIDDEN"):
        with as_user(cz) as c:
            c.execute("update profiles set phone_verified_at = now() where id=%s", (cz,))
    with raw() as c:
        phone = bd_mobile()
        c.execute("update auth.users set phone=%s, phone_confirmed_at=now() where id=%s", (phone, cz))
        p = c.execute("select phone, phone_verified_at from profiles where id=%s", (cz,)).fetchone()
    assert p["phone"] == "+" + phone and p["phone_verified_at"] is not None
    with as_user(cz) as c:
        c.execute("update profiles set phone=%s where id=%s", ("+" + bd_mobile(), cz))
        assert c.execute("select phone_verified_at from profiles where id=%s", (cz,)).fetchone()["phone_verified_at"] is None


def test_verified_phone_required_to_report_when_enabled():
    cz = citizen()
    with settings(require_phone_verification=True):
        with pytest.raises(psycopg.Error, match="PHONE_NOT_VERIFIED"):
            report(cz)
        with raw() as c:
            c.execute("update auth.users set phone=%s, phone_confirmed_at=now() where id=%s", (bd_mobile(), cz))
        assert report(cz)["status"] in ("reported", "duplicate")


def test_report_must_be_inside_dhaka_and_match_its_ward():
    cz = citizen()
    with pytest.raises(psycopg.Error, match="Dhaka service area"):
        report(cz, lat=22.33, lng=91.83, ward="DSCC-02")
    with pytest.raises(psycopg.Error, match="km from"):
        report(cz, lat=23.8759, lng=90.3795, ward="DSCC-10")


def test_citizen_report_rate_limit():
    cz = citizen()
    with settings(citizen_reports_per_hour=2):
        report(cz, category="blocked_drain")
        report(cz, category="overflow")
        with pytest.raises(psycopg.Error, match="RATE_LIMITED"):
            report(cz, category="road_flooded")


def test_trust_flags_are_computed_by_the_server():
    cz = citizen()
    inc = report(cz, headers={"cf-ipcountry": "US"}, trust_flags=[])
    assert "foreign_network" in inc["trust_flags"] and inc["reporter_country"] == "US"
    assert "phone_unverified" in inc["trust_flags"] and "new_account" in inc["trust_flags"]
    tor = report(cz, headers={"cf-ipcountry": "T1"}, category="overflow")
    assert "tor_network" in tor["trust_flags"]
    with pytest.raises(psycopg.Error, match="FORBIDDEN"):
        with as_user(cz) as c:
            c.execute("update incidents set trust_flags='{}' where id=%s", (inc["id"],))
    with pytest.raises(psycopg.Error, match="Dhaka service area|FORBIDDEN"):
        with as_user(cz) as c:
            c.execute("update incidents set lat=22.3 where id=%s", (inc["id"],))


def signup(c, email, role, org=None, **meta):
    return new_auth_user(c, "applicant", email=email, meta={"requested_role": role, "organization_id": org or "", **meta})


def test_city_officer_needs_city_corporation_email():
    with raw() as c:
        with pytest.raises(psycopg.Error, match="city corporation e-mail"):
            signup(c, f"{uuid.uuid4().hex[:8]}@gmail.com", "city_officer", SOUTH, employee_id=uniq("DSCC"), designation="Engineer")
        with pytest.raises(psycopg.Error, match="city corporation e-mail"):
            signup(c, f"{uuid.uuid4().hex[:8]}@dncc.gov.bd", "city_officer", SOUTH, employee_id=uniq("DSCC"), designation="Engineer")
        uid = signup(c, f"{uuid.uuid4().hex[:8]}@dscc.gov.bd", "city_officer", SOUTH, employee_id=uniq("DSCC"), designation="Engineer")
        assert c.execute("select count(*) n from role_requests where user_id=%s and status='pending'", (uid,)).fetchone()["n"] == 1


def test_ngo_coordinator_cannot_use_public_mail():
    with raw() as c:
        with pytest.raises(psycopg.Error, match="organisation's e-mail"):
            signup(c, f"{uuid.uuid4().hex[:8]}@yahoo.com", "ngo_coordinator", None, organization_name="Some NGO", registration_no="9999")


def test_admin_cannot_put_public_mail_on_org_domains(admins):
    with pytest.raises(psycopg.Error, match="public mail provider"):
        with as_user(admins[0]) as c:
            c.execute("update organizations set email_domains='{gmail.com}' where id=%s", (SOUTH,))


def request_of(c, uid):
    return c.execute("select * from role_requests where user_id=%s and status='pending'", (uid,)).fetchone()


def add_document(uid, rid):
    with as_user(uid, session=None) as c:
        c.execute("insert into role_request_documents(request_id, kind, storage_path, file_name, mime_type, size_bytes) "
                  "values (%s,'id_card',%s,'id.pdf','application/pdf',1000)", (rid, f"{uid}/{rid}/id.pdf"))


def checks(admin, rid):
    with as_user(admin) as c:
        return c.execute("select verification(r) v from role_requests r where id=%s", (rid,)).fetchone()["v"]


def review(admin, rid, approve=True, org=None, note=None):
    with as_user(admin) as c:
        return c.execute("select rm_review_role_request(%s,%s,%s,%s) r", (rid, approve, org, note)).fetchone()["r"]


def test_city_officer_needs_documents_and_two_different_admins(admins):
    a1, a2 = admins
    emp, email = uniq("DSCC"), f"{uuid.uuid4().hex[:8]}@dscc.gov.bd"
    with as_user(a1) as c:
        c.execute("select rm_import_staff_roster(%s, %s, false)", (SOUTH, json.dumps([{"employee_id": emp, "official_email": email}])))
    with raw() as c:
        uid = signup(c, email, "city_officer", SOUTH, employee_id=emp, designation="Assistant Engineer")
        rid = request_of(c, uid)["id"]

    v = checks(a2, rid)
    assert v["email_domain"] == "official" and v["roster"] == "verified" and v["flags"] == []
    assert "documents_missing" in v["blockers"] and v["required_approvals"] == 2
    with pytest.raises(psycopg.Error, match="documents missing"):
        review(a2, rid)
    add_document(uid, rid)

    first = review(a2, rid, note="ID card checked")
    assert first == {"status": "pending", "approvals": 1, "required": 2}
    with pytest.raises(psycopg.Error, match="different admin"):
        review(a2, rid)
    with raw() as c:
        assert c.execute("select role::text r from profiles where id=%s", (uid,)).fetchone()["r"] == "citizen"
    with pytest.raises(psycopg.Error, match="roster uploaded by reviewer"):
        review(a1, rid)
    second = review(a1, rid, note="Roster file came from the DSCC HR office, verified by phone")
    assert second["status"] == "approved" and second["approvals"] == 2
    with raw() as c:
        p = c.execute("select role::text r, organization_id::text o, upper(employee_id) e from profiles where id=%s", (uid,)).fetchone()
    assert p == {"r": "city_officer", "o": SOUTH, "e": emp}


def test_roster_uploaded_by_the_reviewer_does_not_count_as_independent(admins):
    a1, a2 = admins
    emp, email = uniq("FW"), f"{uuid.uuid4().hex[:8]}@dscc.gov.bd"
    with as_user(a1) as c:
        c.execute("select rm_import_staff_roster(%s, %s, false)", (SOUTH, json.dumps([{"employee_id": emp, "official_email": email}])))
    with raw() as c:
        uid = signup(c, email, "field_worker", SOUTH, employee_id=emp, team="Drainage crew", ward_id="DSCC-02")
        rid = request_of(c, uid)["id"]
    add_document(uid, rid)
    assert checks(a2, rid)["required_approvals"] == 1
    v1 = checks(a1, rid)
    assert "roster_uploaded_by_reviewer" in v1["flags"] and v1["required_approvals"] == 2


def test_unlisted_staff_id_is_flagged_and_needs_note_plus_two_admins(admins):
    a1, a2 = admins
    with raw() as c:
        uid = signup(c, f"{uuid.uuid4().hex[:8]}@gmail.com", "field_worker", SOUTH, employee_id=uniq("FAKE"), team="Pump operator", ward_id="DSCC-02")
        rid = request_of(c, uid)["id"]
    add_document(uid, rid)
    v = checks(a1, rid)
    assert v["roster"] == "not_found" and set(v["flags"]) >= {"roster", "email_domain"} and v["required_approvals"] == 2
    with pytest.raises(psycopg.Error, match="explain in the note"):
        review(a1, rid)
    assert review(a1, rid, note="Called the zone office, confirmed new hire")["status"] == "pending"


def test_ngoab_registration_is_checked(admins):
    a1, _ = admins
    reg = uniq("BOGUS")
    with raw() as c:
        uid = signup(c, f"{uuid.uuid4().hex[:8]}@newngo.org.bd", "ngo_coordinator", None,
                     organization_name="New Relief NGO", registration_no=reg, designation="Coordinator", ward_id="DSCC-02")
        rid = request_of(c, uid)["id"]
    assert checks(a1, rid)["ngoab"] == "not_found"
    with as_user(a1) as c:
        c.execute("select rm_import_ngo_registry(%s)", (json.dumps([{"registration_no": reg.lower(), "name": "New Relief NGO"}]),))
    assert checks(a1, rid)["ngoab"] == "verified"


def test_unconfirmed_email_blocks_approval(admins):
    a1, _ = admins
    with raw() as c:
        uid = new_auth_user(c, "applicant", email=f"{uuid.uuid4().hex[:8]}@dscc.gov.bd", confirmed=False,
                            meta={"requested_role": "field_worker", "organization_id": SOUTH, "employee_id": uniq("FW"),
                                  "team": "Drainage crew", "ward_id": "DSCC-02"})
        rid = request_of(c, uid)["id"]
    add_document(uid, rid)
    assert "email_unconfirmed" in checks(a1, rid)["blockers"]
    with pytest.raises(psycopg.Error, match="email unconfirmed"):
        review(a1, rid, note="looks fine to me")


def test_applicant_cannot_see_checks_or_add_documents_to_others(admins):
    with raw() as c:
        uid = signup(c, f"{uuid.uuid4().hex[:8]}@dscc.gov.bd", "field_worker", SOUTH, employee_id=uniq("FW"), team="Drainage crew", ward_id="DSCC-02")
        rid = request_of(c, uid)["id"]
    with as_user(uid, session=None) as c:
        assert c.execute("select verification(r) v from role_requests r where id=%s", (rid,)).fetchone()["v"] is None
    other = citizen()
    with pytest.raises(psycopg.Error, match="FORBIDDEN"):
        with as_user(other) as c:
            c.execute("insert into role_request_documents(request_id, kind, storage_path) values (%s,'id_card',%s)",
                      (rid, f"{other}/x.pdf"))


def test_admin_cannot_promote_directly_but_can_revoke(admins):
    a1, a2 = admins
    cz = citizen()
    with pytest.raises(psycopg.Error, match="second admin"):
        with as_user(a1) as c:
            c.execute("update profiles set role='admin' where id=%s", (cz,))
    officer = staff("city_officer", SOUTH, uniq("DSCC"))
    with pytest.raises(psycopg.Error, match="second admin"):
        with as_user(a1) as c:
            c.execute("update profiles set organization_id=%s where id=%s", (NORTH, officer))
    with as_user(a1) as c:
        c.execute("update profiles set role='citizen' where id=%s", (officer,))
    assert eff_role(officer) == "citizen"


def test_admin_proposal_needs_a_second_admin(admins):
    a1, a2 = admins
    cz = citizen()
    emp = uniq("ADM")
    with as_user(a1) as c:
        out = c.execute("select rm_admin_propose_role_change(%s,'admin',null,%s,'New platform engineer, approved by CTO') r",
                        (cz, emp)).fetchone()["r"]
    rid = out["request_id"]
    assert out["approvals"] == 1 and out["required"] == 2
    with pytest.raises(psycopg.Error, match="different admin|proposed this change"):
        review(a1, rid)
    assert review(a2, rid)["status"] == "approved"
    with raw() as c:
        assert c.execute("select role::text r from profiles where id=%s", (cz,)).fetchone()["r"] == "admin"
    with raw() as c:
        open_session(c, cz)
    assert eff_role(cz) == "citizen"
    with as_user(cz) as c:
        assert c.execute("select rm_verify_staff_login('admin', %s, null) r", (emp,)).fetchone()["r"]["ok"]
    assert eff_role(cz) == "admin"


def test_only_admins_touch_registries():
    officer = staff("city_officer", SOUTH, uniq("DSCC"))
    with pytest.raises(psycopg.Error, match="FORBIDDEN"):
        with as_user(officer) as c:
            c.execute("select rm_import_staff_roster(%s, '[]'::jsonb, false)", (SOUTH,))
    with as_user(officer) as c:
        assert c.execute("select count(*) n from staff_roster").fetchone()["n"] == 0
    for sql in ("select * from security_settings", "update security_settings set require_documents = false"):
        with pytest.raises(psycopg.Error, match="permission denied"):
            with as_user(officer) as c:
                c.execute(sql)


def _reviewer():
    uid = staff("admin", employee_id=uniq("ADM"))
    with raw() as c:
        c.execute("update profiles set admin_scope='reviewer' where id=%s", (uid,))
    return uid


def test_reviewer_runs_access_but_not_platform_setup(admins):
    owner, _ = admins
    rev = _reviewer()
    row = '[{"employee_id":"%s","full_name":"Roster Test","role":"field_worker"}]' % uniq("FW")
    with pytest.raises(psycopg.Error, match="system owner"):
        with as_user(rev) as c:
            c.execute("select rm_import_staff_roster(%s, %s::jsonb, false)", (SOUTH, row))
    with pytest.raises(psycopg.Error, match="system owner"):
        with as_user(rev) as c:
            c.execute("insert into staff_roster(organization_id, employee_id, full_name) values (%s,%s,'x')", (SOUTH, uniq("FW")))
    with as_user(rev) as c:
        assert c.execute("select count(*) n from staff_roster").fetchone()["n"] > 0
        assert c.execute("update organizations set email_domains=email_domains where id=%s", (SOUTH,)).rowcount == 0
        assert c.execute("select count(*) n from audit_logs").fetchone()["n"] > 0
    with as_user(owner) as c:
        assert c.execute("select rm_import_staff_roster(%s, %s::jsonb, false) r", (SOUTH, row)).fetchone()["r"]["inserted"] == 1
        assert c.execute("update organizations set email_domains=email_domains where id=%s", (SOUTH,)).rowcount == 1


def test_no_admin_can_change_their_own_duty(admins):
    owner, _ = admins
    rev = _reviewer()
    for who, scope in ((rev, "owner"), (owner, "reviewer")):
        with pytest.raises(psycopg.Error, match="platform team"):
            with as_user(who) as c:
                c.execute("update profiles set admin_scope=%s where id=auth.uid()", (scope,))
    with pytest.raises(psycopg.Error, match="platform team"):
        with as_user(owner) as c:
            c.execute("update profiles set admin_scope='owner' where id=%s", (rev,))


def test_two_person_rule_still_works_across_duties_and_new_admins_start_as_reviewer(admins):
    owner, _ = admins
    rev = _reviewer()
    cz = citizen()
    with as_user(rev) as c:
        rid = c.execute("select rm_admin_propose_role_change(%s,'admin',null,%s,'Night-shift access reviewer') r",
                        (cz, uniq("ADM"))).fetchone()["r"]["request_id"]
    assert review(owner, rid)["status"] == "approved"
    with raw() as c:
        p = c.execute("select role::text r, admin_scope s from profiles where id=%s", (cz,)).fetchone()
    assert p == {"r": "admin", "s": "reviewer"}
