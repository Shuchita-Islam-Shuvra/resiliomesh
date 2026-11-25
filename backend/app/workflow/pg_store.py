from __future__ import annotations

from contextlib import contextmanager

import psycopg
from psycopg import errors as pg

from ..core import db
from .engine import PermanentError, TransientError

RUN_FIELDS = {"status", "current_step", "last_error", "next_run_at", "locked_by", "finished_at"}


class _Ops:
    def __init__(self, conn: psycopg.Connection):
        self.c = conn

    def get_steps(self, run_id):
        rows = self.c.execute("select step_name, status from workflow_steps where run_id = %s", (run_id,)).fetchall()
        return {r["step_name"]: r["status"] for r in rows}

    def mark_step(self, run_id, name, order, status, output=None, error=None):
        self.c.execute(
            """insert into workflow_steps(run_id, step_name, step_order, status, attempts, output, error, started_at, finished_at)
               values (%(r)s, %(n)s, %(o)s, %(s)s, case when %(s)s = 'running' then 1 else 0 end, %(out)s, %(e)s,
                       now(), case when %(s)s in ('succeeded','failed','compensated') then now() end)
               on conflict (run_id, step_name) do update set
                 status = excluded.status,
                 attempts = workflow_steps.attempts + case when excluded.status = 'running' then 1 else 0 end,
                 output = coalesce(excluded.output, workflow_steps.output),
                 error = excluded.error,
                 started_at = case when excluded.status = 'running' then now() else workflow_steps.started_at end,
                 finished_at = excluded.finished_at""",
            {"r": run_id, "n": name, "o": order, "s": status,
             "out": db.as_json(output) if output is not None else None, "e": error},
        )

    def update_run(self, run_id, **fields):
        bad = set(fields) - RUN_FIELDS
        if bad:
            raise ValueError(f"unknown run fields {bad}")
        sets = ", ".join(f"{k} = %({k})s" for k in fields)
        self.c.execute(f"update workflow_runs set {sets} where id = %(id)s", {**fields, "id": run_id})

    def load_plan(self, plan_id):
        row = self.c.execute(
            "select id::text, status::text, incident_ids::text[] as incident_ids, assignments from allocation_plans where id = %s",
            (plan_id,)).fetchone()
        return row

    def incident_statuses(self, ids):
        rows = self.c.execute("select id::text, status::text from incidents where id = any(%s::uuid[])", (ids,)).fetchall()
        return {r["id"]: r["status"] for r in rows}

    def set_plan_status(self, plan_id, status):
        self.c.execute("update allocation_plans set status = %s where id = %s", (status, plan_id))

    def set_incident_status(self, ids, from_statuses, to_status, note):
        self.c.execute("select set_config('rm.note', %s, true)", (note,))
        self.c.execute(
            "update incidents set status = %s where id = any(%s::uuid[]) and status::text = any(%s)",
            (to_status, ids, list(from_statuses)))

    def reserve(self, resource_id, qty, key, incident_id, plan_id, actor):
        return self.c.execute(
            "select * from rm_reserve_resource(%s, %s, %s, %s, null, %s, %s)",
            (resource_id, qty, key, incident_id, plan_id, actor)).fetchone()

    def release_allocations_for_plan(self, plan_id, reason):
        rows = self.c.execute(
            """select rm_release_allocation(id, %s) from allocations
               where plan_id = %s and status in ('reserved','dispatched')""", (reason, plan_id)).fetchall()
        return len(rows)

    def mark_allocations(self, plan_id, from_status, to_status):
        self.c.execute("update allocations set status = %s where plan_id = %s and status = %s",
                       (to_status, plan_id, from_status))

    def pick_field_crew(self, incident_id, task_type, resource_ids, size):
        rows = self.c.execute(
            """select worker_id::text w from rm_pick_field_crew(
                   %s, %s, (select array_agg(distinct organization_id) from resources where id = any(%s::uuid[])),
                   %s, null)
               order by pick_rank""", (incident_id, task_type, list(resource_ids), size)).fetchall()
        return [r["w"] for r in rows]

    def create_task(self, *, crew=(), crew_size=1, **t):
        status = "assigned" if t["assigned_to"] else "pending"
        row = self.c.execute(
            """insert into tasks(incident_id, plan_id, run_id, title, task_type, assigned_to, status, due_at,
                                 idempotency_key, crew_size)
               values (%(incident_id)s, %(plan_id)s, %(run_id)s, %(title)s, %(task_type)s, %(assigned_to)s, %(status)s,
                       %(due_at)s, %(idempotency_key)s, %(crew_size)s)
               on conflict (idempotency_key) do update set updated_at = tasks.updated_at
               returning id, (xmax = 0) as inserted""", {**t, "status": status, "crew_size": crew_size}).fetchone()
        if row["inserted"]:
            for i, w in enumerate(crew):
                self.c.execute("""insert into task_assignees(task_id, worker_id, is_lead) values (%s, %s, %s)
                                  on conflict do nothing""", (row["id"], w, i == 0))
        return row

    def cancel_tasks_for_run(self, run_id):
        rows = self.c.execute(
            """update tasks set status = 'cancelled', notes = coalesce(notes || E'\n', '') || 'Cancelled by workflow compensation'
               where run_id = %s and status not in ('completed','cancelled') returning id""", (run_id,)).fetchall()
        return len(rows)

    def workers_for_run(self, run_id):
        rows = self.c.execute("""select distinct ta.worker_id::text as w from task_assignees ta
                                 join tasks t on t.id = ta.task_id where t.run_id = %s""", (run_id,)).fetchall()
        return [r["w"] for r in rows]

    def notify(self, run_id, workers):
        for w in workers:
            self.c.execute("select pg_notify('field_tasks', %s)", (f"{w}:{run_id}",))


class PgStore:
    def __getattr__(self, name):
        op = getattr(_Ops, name)

        def call(*a, **kw):
            with db.tx() as conn:
                return op(_Ops(conn), *a, **kw)
        return call

    @contextmanager
    def transaction(self):
        with db.tx() as conn:
            yield _Ops(conn)

    @staticmethod
    def classify(exc: Exception) -> str:
        if isinstance(exc, TransientError):
            return "transient"
        if isinstance(exc, PermanentError):
            return "permanent"
        if isinstance(exc, (psycopg.OperationalError, pg.LockNotAvailable, pg.SerializationFailure,
                            pg.DeadlockDetected, pg.QueryCanceled)):
            return "transient"
        return "permanent"


def claim_run(worker_id: str) -> dict | None:
    with db.tx() as conn:
        row = conn.execute("select * from rm_claim_workflow_run(%s)", (worker_id,)).fetchone()
    if not row or row.get("id") is None:
        return None
    row["id"] = str(row["id"])
    row["plan_id"] = str(row["plan_id"])
    row["status"] = str(row["status"])
    row["created_by"] = str(row["created_by"]) if row.get("created_by") else None
    return row
