"""Event-driven multi-step workflow engine with retries + saga compensation (A07).

dispatch_plan workflow
  1. validate_plan       plan approved & incidents still approved
  2. reserve_resources   atomic, idempotent stock reservations (A05)
  3. create_tasks        one task per incident x task type, auto-assigned to least-loaded worker
  4. notify_teams        push notification to assigned workers (external-style step)
  5. activate_incidents  incidents -> in_progress, allocations -> dispatched, plan -> executed

Guarantees
  * Each step runs in ONE DB transaction together with its own "succeeded" marker,
    so a crash can never leave a half-applied step; on resume succeeded steps are skipped.
  * Every side effect is keyed by an idempotency key derived from run id.
  * Transient failures -> exponential backoff retry (run.status = retrying).
  * Permanent failure / retries exhausted -> compensation in reverse:
      cancel tasks, release reservations, incidents back to 'assessed', plan 'failed'.
  * If compensation itself crashes the run stays 'compensating' and the worker
    re-claims it after the lock timeout and finishes compensation.
"""
from __future__ import annotations

import logging
from collections import defaultdict
from datetime import datetime, timedelta, timezone

log = logging.getLogger("resiliomesh.workflow")

STEPS = ["validate_plan", "reserve_resources", "create_tasks", "notify_teams", "activate_incidents"]

TASK_TYPE_FOR = {
    "pump": "pump_deployment", "crew": "drain_clearing", "sandbag": "drain_clearing",
    "relief_kit": "relief_distribution", "medical_kit": "relief_distribution",
    "water_tank": "relief_distribution", "boat": "evacuation_support",
}
TASK_TITLE = {
    "pump_deployment": "Deploy dewatering pumps",
    "drain_clearing": "Clear blocked drainage / place sandbags",
    "relief_distribution": "Distribute relief supplies",
    "evacuation_support": "Boat evacuation support",
}


class TransientError(Exception):
    """Retryable (network blip, lock timeout, notification gateway down)."""


class PermanentError(Exception):
    """Not retryable (business rule violated, e.g. stock no longer available)."""


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class WorkflowEngine:
    def __init__(self, store, backoff_base_s: float = 5.0):
        self.store = store
        self.backoff_base_s = backoff_base_s

    # ------------------------------------------------------------------
    def execute(self, run: dict) -> dict:
        run_id = run["id"]
        if run["status"] == "compensating":
            return self._compensate(run, run.get("last_error") or "resumed compensation")

        step_state = self.store.get_steps(run_id)
        for order, name in enumerate(STEPS, start=1):
            if step_state.get(name) == "succeeded":
                continue
            self.store.update_run(run_id, status="running", current_step=name)
            self.store.mark_step(run_id, name, order, "running")
            try:
                with self.store.transaction() as tx:
                    if run.get("inject_failure") == name:
                        raise TransientError(f"Injected failure at step '{name}' (fault-injection test)")
                    output = getattr(self, f"_step_{name}")(tx, run)
                    tx.mark_step(run_id, name, order, "succeeded", output=output)
            except Exception as exc:  # noqa: BLE001 — classify everything
                kind = self.store.classify(exc)
                err = f"{name}: {exc}"
                self.store.mark_step(run_id, name, order, "failed", error=str(exc))
                log.warning("run %s step %s failed (%s): %s", run_id, name, kind, exc)
                if kind == "transient" and run["attempts"] < run["max_attempts"]:
                    delay = self.backoff_base_s * (2 ** (run["attempts"] - 1))
                    self.store.update_run(run_id, status="retrying", last_error=err,
                                          next_run_at=utcnow() + timedelta(seconds=delay), locked_by=None)
                    return {"status": "retrying", "step": name, "retry_in_s": delay, "error": err}
                reason = err if kind == "permanent" else f"{err} (retries exhausted after {run['attempts']} attempts)"
                return self._compensate(run, reason)

        self.store.update_run(run_id, status="succeeded", current_step=None, finished_at=utcnow(),
                              last_error=None, locked_by=None)
        return {"status": "succeeded"}

    # ------------------------------------------------------------------ steps
    def _step_validate_plan(self, tx, run):
        plan = tx.load_plan(run["plan_id"])
        if plan is None:
            raise PermanentError("plan not found")
        if plan["status"] not in ("approved", "executing"):
            raise PermanentError(f"plan status is {plan['status']}, expected approved")
        statuses = tx.incident_statuses(plan["incident_ids"])
        bad = {k: v for k, v in statuses.items() if v not in ("approved", "in_progress")}
        if bad:
            raise PermanentError(f"incidents changed state meanwhile: {bad}")
        if not plan["assignments"]:
            raise PermanentError("plan has no assignments")
        tx.set_plan_status(plan["id"], "executing")
        return {"incidents": len(plan["incident_ids"]), "assignments": len(plan["assignments"])}

    def _step_reserve_resources(self, tx, run):
        plan = tx.load_plan(run["plan_id"])
        reserved = []
        for a in plan["assignments"]:
            key = f"run:{run['id']}:g{run.get('generation', 1)}:{a['incident_id']}:{a['resource_id']}"
            alloc = tx.reserve(a["resource_id"], int(a["quantity"]), key, a["incident_id"], plan["id"],
                               run.get("created_by"))
            reserved.append({"allocation_id": str(alloc["id"]), "resource_id": a["resource_id"],
                             "quantity": a["quantity"]})
        return {"reserved": reserved}

    def _step_create_tasks(self, tx, run):
        plan = tx.load_plan(run["plan_id"])
        by_incident: dict[str, set] = defaultdict(set)
        for a in plan["assignments"]:
            by_incident[a["incident_id"]].add(TASK_TYPE_FOR.get(a["resource_type"], "inspection"))
        created = []
        for incident_id, types in by_incident.items():
            for ttype in sorted(types):
                worker = tx.pick_field_worker(incident_id)
                task = tx.create_task(
                    incident_id=incident_id, plan_id=plan["id"], run_id=run["id"], task_type=ttype,
                    title=TASK_TITLE[ttype], assigned_to=worker,
                    idempotency_key=f"run:{run['id']}:g{run.get('generation', 1)}:task:{incident_id}:{ttype}",
                    due_at=utcnow() + timedelta(hours=4),
                )
                created.append({"task_id": str(task["id"]), "type": ttype, "assigned_to": worker})
        return {"tasks": created}

    def _step_notify_teams(self, tx, run):
        workers = tx.workers_for_run(run["id"])
        tx.notify(run["id"], workers)
        return {"notified": workers, "channel": "in-app realtime"}

    def _step_activate_incidents(self, tx, run):
        plan = tx.load_plan(run["plan_id"])
        tx.set_incident_status(plan["incident_ids"], ("approved",), "in_progress", "Dispatch workflow completed")
        tx.mark_allocations(plan["id"], "reserved", "dispatched")
        tx.set_plan_status(plan["id"], "executed")
        return {"activated": len(plan["incident_ids"])}

    # ------------------------------------------------------------------ saga
    def _compensate(self, run: dict, reason: str) -> dict:
        run_id = run["id"]
        self.store.update_run(run_id, status="compensating", last_error=reason)
        try:
            with self.store.transaction() as tx:
                plan = tx.load_plan(run["plan_id"])
                cancelled = tx.cancel_tasks_for_run(run_id)
                released = tx.release_allocations_for_plan(plan["id"], f"compensation: {reason}"[:200])
                tx.set_incident_status(plan["incident_ids"], ("approved", "in_progress"), "assessed",
                                       f"Workflow failed, rolled back: {reason}"[:200])
                tx.set_plan_status(plan["id"], "failed")
                for name, state in tx.get_steps(run_id).items():
                    if state == "succeeded":
                        tx.mark_step(run_id, name, STEPS.index(name) + 1, "compensated")
                tx.update_run(run_id, status="compensated", finished_at=utcnow(), locked_by=None,
                              current_step=None, last_error=reason)
            log.info("run %s compensated: %s tasks cancelled, %s allocations released", run_id, cancelled, released)
            return {"status": "compensated", "reason": reason, "tasks_cancelled": cancelled,
                    "allocations_released": released}
        except Exception as exc:  # leave in 'compensating' -> worker resumes after lock timeout
            log.exception("compensation failed for run %s", run_id)
            self.store.update_run(run_id, status="compensating", last_error=f"compensation error: {exc}")
            return {"status": "compensating", "error": str(exc)}
