"""Put real field work on the demo crews' phones, through the real pipeline.

The seed creates reports but no field tasks, so a fresh demo shows an empty Field Portal.
This script does what an officer does in the UI, with the same server checks:

    sign in (demo officer)  ->  staff-ID step (rm_verify_staff_login)
    AI assessment for verified reports that have none yet       POST /api/risk/incidents/{id}/assess
    optimise a plan for up to N assessed reports in the area    POST /api/plans/optimize
    approve it  (two-officer areas: south and north)            rpc approve_plan
    run the dispatch workflow now                               POST /api/workflows/process-now

The workflow then sizes each crew, picks the right team on duty, and the tasks
appear live in the field portal of field1..field7.

Usage (backend must be running; same backend/.env as the seed):
    python scripts/demo_dispatch.py                       # both areas, up to 2 reports each
    python scripts/demo_dispatch.py --area south --max 3
    python scripts/demo_dispatch.py --api https://resiliomesh-api.onrender.com
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from app.core.config import get_settings

OFFICERS = {
    "south": ("officer@resiliomesh.demo", "DSCC-OFF-01"),
    "north": ("officer2@resiliomesh.demo", "DNCC-OFF-02"),
}


def fail(msg: str) -> None:
    sys.exit(f"error: {msg}")


class Session:
    def __init__(self, api: str, email: str, staff_id: str, password: str):
        s = get_settings()
        self.rest = s.supabase_url.rstrip("/") + "/rest/v1"
        key = s.supabase_anon_key or s.supabase_service_role_key
        r = httpx.post(s.supabase_url.rstrip("/") + "/auth/v1/token", params={"grant_type": "password"},
                       headers={"apikey": key}, json={"email": email, "password": password}, timeout=20)
        if r.status_code != 200:
            fail(f"sign-in for {email} failed ({r.status_code}). Run scripts/seed_demo.py first.")
        self.h = {"apikey": key, "Authorization": f"Bearer {r.json()['access_token']}"}
        self.api = api.rstrip("/")
        v = self.rpc("rm_verify_staff_login", p_role="city_officer", p_staff_id=staff_id)
        if not v.get("ok"):
            fail(f"staff-ID step failed for {email}: {v}")

    def rpc(self, fn: str, **args):
        r = httpx.post(f"{self.rest}/rpc/{fn}", json=args, headers=self.h, timeout=30)
        if r.status_code >= 400:
            fail(f"{fn}: {r.text[:300]}")
        return r.json() if r.content else None

    def get(self, table: str, **params):
        r = httpx.get(f"{self.rest}/{table}", params=params, headers=self.h, timeout=30)
        if r.status_code >= 400:
            fail(f"read {table}: {r.text[:300]}")
        return r.json()

    def post_api(self, path: str, body: dict | None = None, timeout: float = 90):
        r = httpx.post(f"{self.api}{path}", json=body, headers=self.h, timeout=timeout)
        if r.status_code >= 400:
            fail(f"{path}: {r.status_code} {r.text[:300]}")
        return r.json()

    def close(self):
        httpx.post(f"{self.rest}/rpc/rm_end_staff_session", json={}, headers=self.h, timeout=10)


def dispatch_area(area: str, api: str, password: str, max_reports: int) -> None:
    email, staff_id = OFFICERS[area]
    print(f"\n== {area.upper()}: signed in as {email}")
    s = Session(api, email, staff_id, password)
    try:
        assessed = s.get("incidents", select="id,reference_code,title", status="eq.assessed", order="risk_score.desc.nullslast",
                         limit=str(max_reports))
        if len(assessed) < max_reports:
            for inc in s.get("incidents", select="id,reference_code", status="eq.verified", order="created_at",
                             limit=str(max_reports - len(assessed))):
                s.post_api(f"/api/risk/incidents/{inc['id']}/assess")
                print(f"   assessed {inc['reference_code']}")
            assessed = s.get("incidents", select="id,reference_code,title", status="eq.assessed",
                             order="risk_score.desc.nullslast", limit=str(max_reports))
        if not assessed:
            print("   no assessed or verified reports in this area: nothing to dispatch")
            return
        for i in assessed:
            print(f"   report {i['reference_code']}: {i['title']}")

        out = s.post_api("/api/plans/optimize", {"incident_ids": [i["id"] for i in assessed]})
        plan, result = out["plan"], out.get("result", {})
        n = len(result.get("assignments") or [])
        print(f"   plan {str(plan['id'])[:8]}: {n} assignment(s), solver {result.get('status')}"
              f"{' (constraints relaxed)' if result.get('relaxed') else ''}")
        if n == 0 or plan.get("status") != "pending_approval":
            print(f"   nothing to approve. Shortages: {result.get('shortages')} Notes: {result.get('notes')}")
            return

        ok = s.rpc("approve_plan", p_plan_id=plan["id"], p_expected_version=plan["version"])
        if not ok.get("ok"):
            fail(f"approve_plan: {ok}")
        print(f"   approved -> workflow run {str(ok['run_id'])[:8]}")

        s.post_api("/api/workflows/process-now", timeout=180)
        run = {}
        for _ in range(45):
            run = (s.get("workflow_runs", select="status,last_error", id=f"eq.{ok['run_id']}") or [{}])[0]
            if run.get("status") in ("succeeded", "compensated", "failed"):
                break
            time.sleep(2)
        print(f"   workflow: {run.get('status', 'unknown')}{' - ' + run['last_error'] if run.get('last_error') else ''}")

        ids = ",".join(i["id"] for i in assessed)
        tasks = s.get("tasks", select="title,status,crew_size,incidents(reference_code),"
                      "crew:task_assignees(is_lead,worker:profiles!task_assignees_worker_id_fkey(full_name,email,field_team))",
                      incident_id=f"in.({ids})", status="not.in.(completed,cancelled)")
        for t in tasks:
            crew = sorted(t["crew"], key=lambda c: not c["is_lead"])
            names = ", ".join(f"{c['worker']['full_name']}{' (lead)' if c['is_lead'] else ''} <{c['worker']['email']}>" for c in crew) or "NOBODY: officer must assign"
            print(f"   task  {t['incidents']['reference_code']}  {t['title']:<42} crew {len(crew)}/{t['crew_size']}  {names}")
    finally:
        s.close()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--api", default=os.getenv("DEMO_API_URL", "http://localhost:8000"))
    ap.add_argument("--area", choices=["south", "north", "both"], default="both")
    ap.add_argument("--max", type=int, default=2, help="reports per area (1-5)")
    a = ap.parse_args()
    password = os.getenv("DEMO_PASSWORD") or get_settings().demo_password
    if not password:
        fail("set DEMO_PASSWORD (or backend/.env)")
    for area in (["south", "north"] if a.area == "both" else [a.area]):
        dispatch_area(area, a.api, password, max(1, min(a.max, 5)))
    print("\nDone. Sign in as the field workers listed above: the tasks are in their Field Portal.")


if __name__ == "__main__":
    main()
