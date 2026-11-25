from __future__ import annotations

import copy
import itertools
import uuid
from contextlib import contextmanager

from .engine import PermanentError, TransientError


class InsufficientStock(Exception):
    pass


class MemoryStore:
    def __init__(self):
        self.runs: dict[str, dict] = {}
        self.steps: dict[tuple, dict] = {}
        self.plans: dict[str, dict] = {}
        self.incidents: dict[str, dict] = {}
        self.resources: dict[str, dict] = {}
        self.allocations: dict[str, dict] = {}
        self.tasks: dict[str, dict] = {}
        self.workers: list[str] = ["worker-a", "worker-b"]
        self.worker_tasks: dict[str, list[str]] = {}
        self.off_duty: set[str] = set()
        self.notifications: list = []
        self.fail_notify_times = 0
        self._seq = itertools.count(1)

    @contextmanager
    def transaction(self):
        data_keys = ("runs", "steps", "plans", "incidents", "resources", "allocations", "tasks", "notifications")
        snap = copy.deepcopy({k: getattr(self, k) for k in data_keys})
        try:
            yield self
        except Exception:
            for k, v in snap.items():
                setattr(self, k, v)
            raise

    @staticmethod
    def classify(exc):
        if isinstance(exc, (TransientError, ConnectionError, TimeoutError)):
            return "transient"
        return "permanent"

    def get_steps(self, run_id):
        return {name: s["status"] for (rid, name), s in self.steps.items() if rid == run_id}

    def mark_step(self, run_id, name, order, status, output=None, error=None):
        s = self.steps.setdefault((run_id, name), {"order": order, "attempts": 0})
        if status == "running":
            s["attempts"] += 1
        s.update(status=status, error=error)
        if output is not None:
            s["output"] = output

    def update_run(self, run_id, **fields):
        self.runs[run_id].update(fields)

    def load_plan(self, plan_id):
        return copy.deepcopy(self.plans.get(plan_id))

    def incident_statuses(self, ids):
        return {i: self.incidents[i]["status"] for i in ids}

    def set_plan_status(self, plan_id, status):
        self.plans[plan_id]["status"] = status

    def set_incident_status(self, ids, from_statuses, to_status, note):
        for i in ids:
            if self.incidents[i]["status"] in from_statuses:
                self.incidents[i]["status"] = to_status

    def reserve(self, resource_id, qty, key, incident_id, plan_id, actor):
        for a in self.allocations.values():
            if a["idempotency_key"] == key:
                return a
        r = self.resources[resource_id]
        if r["available"] < qty:
            raise InsufficientStock(f"INSUFFICIENT_STOCK: {qty} requested, {r['available']} available")
        r["available"] -= qty
        a = {"id": str(uuid.uuid4()), "resource_id": resource_id, "quantity": qty, "status": "reserved",
             "idempotency_key": key, "plan_id": plan_id, "incident_id": incident_id}
        self.allocations[a["id"]] = a
        return a

    def release_allocations_for_plan(self, plan_id, reason):
        n = 0
        for a in self.allocations.values():
            if a["plan_id"] == plan_id and a["status"] in ("reserved", "dispatched"):
                self.resources[a["resource_id"]]["available"] += a["quantity"]
                a["status"] = "released"
                n += 1
        return n

    def mark_allocations(self, plan_id, from_status, to_status):
        for a in self.allocations.values():
            if a["plan_id"] == plan_id and a["status"] == from_status:
                a["status"] = to_status

    def pick_field_crew(self, incident_id, task_type, resource_ids, size):
        load = {w: 0 for w in self.workers}
        for t in self.tasks.values():
            if t["status"] in ("assigned", "accepted", "in_progress"):
                for w in t["crew"]:
                    if w in load:
                        load[w] += 1
        fits = [w for w in self.workers if w not in self.off_duty
                and task_type in self.worker_tasks.get(w, [task_type])]
        return sorted(fits, key=lambda w: (load[w], self.workers.index(w)))[:size]

    def create_task(self, *, crew=(), crew_size=1, **t):
        for existing in self.tasks.values():
            if existing["idempotency_key"] == t["idempotency_key"]:
                return existing
        task = {**t, "crew": list(crew), "crew_size": crew_size, "id": str(uuid.uuid4()),
                "status": "assigned" if t["assigned_to"] else "pending"}
        self.tasks[task["id"]] = task
        return task

    def cancel_tasks_for_run(self, run_id):
        n = 0
        for t in self.tasks.values():
            if t["run_id"] == run_id and t["status"] not in ("completed", "cancelled"):
                t["status"] = "cancelled"
                n += 1
        return n

    def workers_for_run(self, run_id):
        return sorted({w for t in self.tasks.values() if t["run_id"] == run_id for w in t["crew"]})

    def notify(self, run_id, workers):
        if self.fail_notify_times > 0:
            self.fail_notify_times -= 1
            raise TransientError("notification gateway timeout")
        self.notifications.append((run_id, workers))
