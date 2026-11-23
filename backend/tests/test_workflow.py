"""A07 — multi-step workflow: retries, intermediate failure, compensation, idempotent resume."""
import pytest

from app.workflow.engine import STEPS, WorkflowEngine
from app.workflow.memory_store import MemoryStore


@pytest.fixture
def store():
    s = MemoryStore()
    s.resources = {"pump": {"available": 3}, "crew": {"available": 2}}
    s.incidents = {"inc-1": {"status": "approved"}, "inc-2": {"status": "approved"}}
    s.plans = {"plan-1": {"id": "plan-1", "status": "approved", "incident_ids": ["inc-1", "inc-2"], "assignments": [
        {"incident_id": "inc-1", "resource_id": "pump", "resource_type": "pump", "quantity": 2},
        {"incident_id": "inc-1", "resource_id": "crew", "resource_type": "crew", "quantity": 1},
        {"incident_id": "inc-2", "resource_id": "crew", "resource_type": "crew", "quantity": 1},
    ]}}
    s.runs = {"run-1": {"id": "run-1", "plan_id": "plan-1", "status": "running", "attempts": 1, "max_attempts": 3,
                        "inject_failure": None, "created_by": None}}
    return s


def test_happy_path_all_steps_succeed(store):
    res = WorkflowEngine(store).execute(dict(store.runs["run-1"]))
    assert res["status"] == "succeeded"
    assert all(store.get_steps("run-1")[s] == "succeeded" for s in STEPS)
    assert store.resources["pump"]["available"] == 1 and store.resources["crew"]["available"] == 0
    assert {i["status"] for i in store.incidents.values()} == {"in_progress"}
    assert store.plans["plan-1"]["status"] == "executed"
    assert len(store.tasks) == 3            # inc-1: pump+drain, inc-2: drain
    assert all(a["status"] == "dispatched" for a in store.allocations.values())


def test_intermediate_failure_after_reservations_compensates(store):
    """Reservations succeed, create_tasks keeps failing -> retries exhausted -> stock returned."""
    store.runs["run-1"]["inject_failure"] = "create_tasks"
    eng = WorkflowEngine(store, backoff_base_s=0)
    run = lambda: store.runs["run-1"]   # noqa: E731 (store rolls back by replacing dicts)
    r1 = eng.execute(dict(run()))
    assert r1["status"] == "retrying" and run()["status"] == "retrying"
    assert store.resources["pump"]["available"] == 1          # reserved, kept during retry
    run()["attempts"] = 2
    assert eng.execute(dict(run()))["status"] == "retrying"
    run()["attempts"] = 3
    r3 = eng.execute(dict(run()))
    assert r3["status"] == "compensated"
    # compensation restored everything
    assert store.resources["pump"]["available"] == 3 and store.resources["crew"]["available"] == 2
    assert all(a["status"] == "released" for a in store.allocations.values())
    assert {i["status"] for i in store.incidents.values()} == {"assessed"}
    assert store.plans["plan-1"]["status"] == "failed"
    steps = store.get_steps("run-1")
    assert steps["reserve_resources"] == "compensated" and steps["create_tasks"] == "failed"


def test_transient_failure_resumes_without_duplicating_side_effects(store):
    store.fail_notify_times = 1
    eng = WorkflowEngine(store, backoff_base_s=0)
    assert eng.execute(dict(store.runs["run-1"]))["status"] == "retrying"
    tasks_before = len(store.tasks)
    allocs_before = len(store.allocations)
    store.runs["run-1"]["attempts"] = 2
    assert eng.execute(dict(store.runs["run-1"]))["status"] == "succeeded"
    assert len(store.tasks) == tasks_before and len(store.allocations) == allocs_before
    assert store.resources["pump"]["available"] == 1          # reserved exactly once
    assert store.steps[("run-1", "notify_teams")]["attempts"] == 2


def test_permanent_failure_is_atomic_no_partial_reservation(store):
    store.resources["crew"]["available"] = 1                  # second crew reservation will fail
    res = WorkflowEngine(store).execute(dict(store.runs["run-1"]))
    assert res["status"] == "compensated"
    assert "INSUFFICIENT_STOCK" in res["reason"]
    # the pump reservation from the same step was rolled back with it
    assert store.resources["pump"]["available"] == 3 and store.resources["crew"]["available"] == 1
    assert store.allocations == {}


def test_plan_state_changed_meanwhile_is_rejected(store):
    store.incidents["inc-2"]["status"] = "resolved"
    res = WorkflowEngine(store).execute(dict(store.runs["run-1"]))
    assert res["status"] == "compensated" and "changed state" in res["reason"]


def test_rerunning_a_succeeded_run_is_a_noop(store):
    eng = WorkflowEngine(store)
    eng.execute(dict(store.runs["run-1"]))
    snapshot = (len(store.tasks), len(store.allocations), store.resources["pump"]["available"])
    store.runs["run-1"]["status"] = "running"
    eng.execute(dict(store.runs["run-1"]))
    assert (len(store.tasks), len(store.allocations), store.resources["pump"]["available"]) == snapshot


def test_crash_during_compensation_resumes(store):
    store.runs["run-1"]["status"] = "compensating"
    store.runs["run-1"]["last_error"] = "worker crashed"
    res = WorkflowEngine(store).execute(dict(store.runs["run-1"]))
    assert res["status"] == "compensated"
