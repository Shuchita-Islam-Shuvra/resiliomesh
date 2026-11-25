"""One person, one NGO Coordinator post (migration 010) against a REAL database.

NGO coordinators and field workers serve the whole city (no Dhaka North / South
split). A coordinator is employed by one NGO, so the same person (same Bangladeshi
mobile number) must not hold a second coordinator post, or another staff post
next to it, on another account. A move to another NGO is a two-admin transfer.

    TEST_DATABASE_URL=postgresql://... pytest tests/test_db_ngo_seat.py -v
"""
import uuid

import pytest

from .dbutil import DSN, as_user, new_auth_user, open_session, raw, verify_staff_session

pytestmark = pytest.mark.skipif(not DSN, reason="TEST_DATABASE_URL not set")

if DSN:
    import psycopg

SOUTH = "11111111-1111-1111-1111-111111111102"
SHOBAR = "11111111-1111-1111-1111-111111111103"
NODI = "11111111-1111-1111-1111-111111111104"


def bd_mobile():
    n = uuid.uuid4().int
    return f"+8801{3 + n % 7}{n // 7 % 10**8:08d}"


def staff(role, org=None, phone=None, *, employee_id=None):
    with raw() as c:
        uid = new_auth_user(c, role)
        c.execute("update profiles set role=%s, organization_id=%s, employee_id=%s, phone=%s where id=%s",
                  (role, org, employee_id, phone, uid))
        open_session(c, uid)
        verify_staff_session(c, uid)
    return uid


@pytest.fixture(scope="module")
def admins():
    return (staff("admin", employee_id=f"ADM-{uuid.uuid4().hex[:6].upper()}"),
            staff("admin", employee_id=f"ADM-{uuid.uuid4().hex[:6].upper()}"))


def apply_as_coordinator(org, phone):
    """Self-service sign-up as NGO Coordinator, with the ID card uploaded."""
    with raw() as c:
        uid = new_auth_user(c, "applicant", email=f"{uuid.uuid4().hex[:8]}@relief-ngo.org.bd",
                            meta={"requested_role": "ngo_coordinator", "organization_id": org, "phone": phone or "",
                                  "designation": "Relief Coordinator", "ward_id": "DSCC-02"})
        rid = c.execute("select id from role_requests where user_id=%s and status='pending'", (uid,)).fetchone()["id"]
    with as_user(uid, session=None) as c:
        c.execute("insert into role_request_documents(request_id, kind, storage_path, file_name, mime_type, size_bytes) "
                  "values (%s,'id_card',%s,'id.pdf','application/pdf',1000)", (rid, f"{uid}/{rid}/id.pdf"))
    return uid, rid


def checks(admin, rid):
    with as_user(admin) as c:
        return c.execute("select verification(r) v from role_requests r where id=%s", (rid,)).fetchone()["v"]


def review(admin, rid, note="Checked with the NGO head office by phone"):
    with as_user(admin) as c:
        return c.execute("select rm_review_role_request(%s,true,null,%s) r", (rid, note)).fetchone()["r"]


def profile(uid):
    with raw() as c:
        return c.execute("select role::text, organization_id::text org, is_active from profiles where id=%s", (uid,)).fetchone()


# ------------------------------------------------------------------ the rule
def test_same_person_cannot_become_coordinator_of_a_second_ngo(admins):
    a1, a2 = admins
    phone = bd_mobile()
    staff("ngo_coordinator", SHOBAR, phone)                    # already coordinates Shobar Jonno
    uid, rid = apply_as_coordinator(NODI, phone)               # second account, other NGO, same mobile

    v = checks(a1, rid)
    assert "ngo_seat_taken" in v["blockers"]
    assert "Shobar Jonno" in v["ngo_seat"]
    with pytest.raises(psycopg.Error, match="ngo seat taken"):
        review(a1, rid)
    assert profile(uid)["role"] == "citizen"


def test_second_coordinator_account_at_the_same_ngo_is_blocked_too(admins):
    a1, _ = admins
    phone = bd_mobile()
    staff("ngo_coordinator", SHOBAR, phone)
    _, rid = apply_as_coordinator(SHOBAR, phone)
    assert "ngo_seat_taken" in checks(a1, rid)["blockers"]


def test_coordinator_cannot_also_hold_a_field_post_elsewhere():
    phone = bd_mobile()
    staff("ngo_coordinator", SHOBAR, phone)
    with pytest.raises(psycopg.Error, match="only one NGO Coordinator post"):
        staff("field_worker", SOUTH, phone, employee_id=f"FW-{uuid.uuid4().hex[:6].upper()}")


def test_guard_holds_even_for_direct_sql_and_frees_the_mobile_when_the_post_ends():
    phone = bd_mobile()
    first = staff("ngo_coordinator", SHOBAR, phone)
    with raw() as c:
        other = new_auth_user(c, "dup")
        c.execute("update profiles set phone=%s where id=%s", (phone, other))      # a citizen may share it
        with pytest.raises(psycopg.Error, match="only one NGO Coordinator post"):
            c.execute("update profiles set role='ngo_coordinator', organization_id=%s where id=%s", (NODI, other))
    with raw() as c:
        c.execute("update profiles set is_active=false where id=%s", (first,))     # left Shobar Jonno
        c.execute("update profiles set role='ngo_coordinator', organization_id=%s where id=%s", (NODI, other))
    assert profile(other)["org"] == NODI


def test_non_admin_is_not_told_whose_number_it_is():
    phone = bd_mobile()
    staff("ngo_coordinator", SHOBAR, phone)
    worker = staff("field_worker", SOUTH, bd_mobile(), employee_id=f"FW-{uuid.uuid4().hex[:6].upper()}")
    with pytest.raises(psycopg.Error) as e:
        with as_user(worker) as c:
            c.execute("update profiles set phone=%s where id=%s", (phone, worker))
    assert "another staff account" in str(e.value) and "Shobar" not in str(e.value)


def test_coordinator_request_needs_a_mobile_number(admins):
    a1, _ = admins
    _, rid = apply_as_coordinator(NODI, None)
    assert "phone_missing" in checks(a1, rid)["blockers"]


def test_moving_to_another_ngo_is_a_two_admin_transfer(admins):
    a1, a2 = admins
    coord = staff("ngo_coordinator", SHOBAR, bd_mobile())
    with as_user(a1) as c:
        rid = c.execute("select rm_admin_propose_role_change(%s,'ngo_coordinator',%s,null,%s) r",
                        (coord, NODI, "Transferred to Nodi, letter ref 2026/88")).fetchone()["r"]["request_id"]
    v = checks(a2, rid)
    assert "ngo_transfer" in v["flags"] and v["ngo_transfer_from"] == "Shobar Jonno Relief Network"
    assert v["required_approvals"] == 2 and "ngo_seat_taken" not in v["blockers"]
    assert review(a2, rid)["status"] == "approved"
    p = profile(coord)
    assert p["role"] == "ngo_coordinator" and p["org"] == NODI      # one post: the Shobar post ended


# ------------------------------------------------------------------ NGOs may LOG needs in both areas (responsibility per area: 014)
def test_ngo_coordinator_works_in_both_dhaka_north_and_south():
    coord = staff("ngo_coordinator", SHOBAR, bd_mobile())
    with as_user(coord) as c:
        for ward in ("DNCC-02", "DSCC-02"):
            c.execute("""insert into community_needs(ward_id, need_type, quantity, households, dedup_key, contact_name)
                         values (%s,'relief_kit',3,3,'x',%s)""", (ward, str(uuid.uuid4())))
        assert c.execute("select rm_area() a").fetchone()["a"] is None
