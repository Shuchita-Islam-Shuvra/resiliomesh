"""A05 / M04 / A03 against a REAL Supabase Postgres with the migrations applied.

    set TEST_DATABASE_URL=postgresql://postgres:...@db.<ref>.supabase.co:5432/postgres
    pytest tests/test_db_integration.py -v

Skipped automatically when TEST_DATABASE_URL is not set.
"""
import os
import threading
import uuid

import pytest

DSN = os.getenv("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not DSN, reason="TEST_DATABASE_URL not set")

if DSN:
    import psycopg
    from psycopg.rows import dict_row


def conn():
    return psycopg.connect(DSN, row_factory=dict_row, autocommit=True, prepare_threshold=None)


@pytest.fixture
def last_pump():
    """A resource pool with exactly ONE unit left."""
    with conn() as c:
        org = c.execute("select id from organizations limit 1").fetchone()["id"]
        rid = c.execute("""insert into resources(organization_id, resource_type, name, quantity_total, quantity_available, lat, lng)
                           values (%s,'pump',%s,5,1,23.75,90.40) returning id""",
                        (org, f"TEST last pump {uuid.uuid4()}")).fetchone()["id"]
        ward = c.execute("select id from wards limit 1").fetchone()["id"]
        _NEED["id"] = c.execute("""insert into community_needs(ward_id, need_type, quantity, households, dedup_key, contact_name)
                                   values (%s,'pump',1,1,'x',%s) returning id""", (ward, str(uuid.uuid4()))).fetchone()["id"]
    yield rid
    with conn() as c:
        c.execute("delete from allocations where resource_id = %s", (rid,))
        c.execute("delete from resources where id = %s", (rid,))
        c.execute("delete from community_needs where id = %s", (_NEED["id"],))


_NEED: dict = {}


def reserve(rid, key, qty=1):
    with conn() as c:
        return c.execute("select * from rm_reserve_resource(%s,%s,%s,null,%s,null,null)",
                         (rid, qty, key, _NEED["id"])).fetchone()


def test_many_users_race_for_the_final_unit(last_pump):
    n = 25
    results, barrier = [], threading.Barrier(n)

    def worker(i):
        barrier.wait()
        try:
            reserve(last_pump, f"race-{last_pump}-{i}")
            results.append("ok")
        except psycopg.Error as e:
            results.append("stock" if "INSUFFICIENT_STOCK" in str(e) else f"other:{e}")

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert results.count("ok") == 1, results
    assert results.count("stock") == n - 1
    with conn() as c:
        row = c.execute("select quantity_available from resources where id=%s", (last_pump,)).fetchone()
        assert row["quantity_available"] == 0
        assert c.execute("select count(*) n from allocations where resource_id=%s", (last_pump,)).fetchone()["n"] == 1


def test_same_idempotency_key_concurrently_reserves_once(last_pump):
    key = f"idem-{uuid.uuid4()}"
    out, barrier = [], threading.Barrier(10)

    def worker():
        barrier.wait()
        out.append(str(reserve(last_pump, key)["id"]))

    threads = [threading.Thread(target=worker) for _ in range(10)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert len(set(out)) == 1                     # all callers get the same allocation
    with conn() as c:
        assert c.execute("select quantity_available q from resources where id=%s", (last_pump,)).fetchone()["q"] == 0


def test_release_is_idempotent(last_pump):
    alloc = reserve(last_pump, f"rel-{uuid.uuid4()}")
    with conn() as c:
        c.execute("select rm_release_allocation(%s,'test')", (alloc["id"],))
        c.execute("select rm_release_allocation(%s,'test again')", (alloc["id"],))
        assert c.execute("select quantity_available q from resources where id=%s", (last_pump,)).fetchone()["q"] == 1


def test_invalid_quantity_rejected(last_pump):
    with pytest.raises(psycopg.Error, match="VALIDATION"):
        reserve(last_pump, f"neg-{uuid.uuid4()}", qty=-1)


def test_check_constraint_prevents_negative_stock(last_pump):
    with conn() as c, pytest.raises(psycopg.errors.CheckViolation):
        c.execute("update resources set quantity_available = -1 where id = %s", (last_pump,))


def test_incident_state_machine_blocks_illegal_jump():
    with conn() as c:
        ward = c.execute("select id from wards limit 1").fetchone()["id"]
        uid = c.execute("select id from profiles limit 1").fetchone()
        if not uid:
            pytest.skip("no profiles yet: run scripts/seed_demo.py")
        inc = c.execute("""insert into incidents(reporter_id, ward_id, category, title, description, severity_reported, lat, lng)
                           values (%s,%s,'waterlogging','TEST illegal jump','integration test incident',3,26.5,92.5)
                           returning id""", (uid["id"], ward)).fetchone()["id"]
        try:
            with pytest.raises(psycopg.Error, match="INVALID_TRANSITION"):
                c.execute("update incidents set status='resolved' where id=%s", (inc,))
        finally:
            c.execute("delete from incidents where id=%s", (inc,))


def test_audit_log_is_append_only():
    with conn() as c:
        row = c.execute("select id from audit_logs limit 1").fetchone()
        if not row:
            pytest.skip("audit log empty")
        with pytest.raises(psycopg.Error, match="append-only"):
            c.execute("delete from audit_logs where id=%s", (row["id"],))
