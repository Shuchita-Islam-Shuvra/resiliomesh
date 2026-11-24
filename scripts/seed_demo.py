"""Create demo accounts + realistic sample operations data.

Prereqs: migrations 001-008 and supabase/seed.sql already applied.

    cd backend
    # backend/.env must contain SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL
    set DEMO_PASSWORD=<choose-a-strong-password>        (PowerShell: $env:DEMO_PASSWORD="...")
    .venv\\Scripts\\python ..\\scripts\\seed_demo.py

Idempotent: re-running updates existing users and skips existing sample data.
The password is never written to the repository.
"""
from __future__ import annotations

import os
import random
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import psycopg
from psycopg.types.json import Jsonb
from psycopg.rows import dict_row

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from app.core.config import get_settings  # noqa: E402
from app.ml.features import monsoon_factor  # noqa: E402
from app.ml.model import get_model  # noqa: E402
from app.ml.rules import apply_rules, priority  # noqa: E402

ORG = {
    "north": "11111111-1111-1111-1111-111111111101",
    "south": "11111111-1111-1111-1111-111111111102",
    "shobar": "11111111-1111-1111-1111-111111111103",
    "nodi": "11111111-1111-1111-1111-111111111104",
    "ops": "11111111-1111-1111-1111-111111111105",
}
# sign-in IDs shown on the login page's demo box (City Officer / Field Worker / Admin)
STAFF_IDS = {
    "admin@resiliomesh.demo": "ADM-001", "admin2@resiliomesh.demo": "ADM-002", "officer@resiliomesh.demo": "DSCC-OFF-01", "officer2@resiliomesh.demo": "DNCC-OFF-02",
    "field1@resiliomesh.demo": "FW-001", "field2@resiliomesh.demo": "FW-002", "field3@resiliomesh.demo": "FW-003",
}
USERS = [
    ("admin@resiliomesh.demo", "Farhana Rahman", "admin", "ops", None),
    ("admin2@resiliomesh.demo", "Kamal Hossain", "admin", "ops", None),       # second approver (two-person rule)
    ("officer@resiliomesh.demo", "Tanvir Hasan", "city_officer", "south", "DSCC-04"),
    ("officer2@resiliomesh.demo", "Nusrat Jahan", "city_officer", "north", "DNCC-05"),
    ("ngo@resiliomesh.demo", "Sabrina Akter", "ngo_coordinator", "shobar", "DSCC-01"),
    ("ngo2@resiliomesh.demo", "Mahmud Karim", "ngo_coordinator", "nodi", "DSCC-05"),
    ("field1@resiliomesh.demo", "Rafiqul Islam", "field_worker", "south", "DSCC-02"),
    ("field2@resiliomesh.demo", "Shahidul Alam", "field_worker", "north", "DNCC-02"),
    ("field3@resiliomesh.demo", "Mitu Begum", "field_worker", "shobar", "DSCC-06"),
    ("citizen@resiliomesh.demo", "Arif Chowdhury", "citizen", None, "DSCC-02"),
    ("citizen2@resiliomesh.demo", "Lamia Sultana", "citizen", None, "DNCC-02"),
]

DEMO_PHONE = {email: f"+88017000002{i:02d}" for i, (email, *_rest) in enumerate(USERS)}

# realistic report templates: (ward, category, title, description, depth, people, severity)
REPORTS = [
    ("DSCC-02", "waterlogging", "Knee-deep water at Shantinagar crossing", "Water up to knees after 2 hours of rain. Rickshaws stuck, shops along Bazar Road taking water.", 48, 450, 5),
    ("DSCC-03", "blocked_drain", "Malibagh railgate drain choked with plastic", "Drain mouth completely blocked by polythene and market waste. Water not flowing.", 22, 120, 3),
    ("DNCC-09", "waterlogging", "Kawran Bazar kitchen market flooded", "Ankle-to-knee water inside kitchen market lanes; vendors moving goods.", 38, 600, 4),
    ("DSCC-05", "overflow", "Manda canal overflowing into Mugda lanes", "Canal water overflowing onto residential lanes near the pump station.", 62, 900, 5),
    ("DSCC-06", "road_flooded", "Jatrabari flyover approach under water", "Southbound approach road under water, buses stalled, long tailback.", 55, 300, 4),
    ("DNCC-02", "waterlogging", "Mirpur 10 roundabout waterlogged", "Water around metro pillars, pedestrians wading. Culvert looks blocked.", 41, 700, 4),
    ("DSCC-10", "relief_need", "Families stranded in Kamrangirchar low-lying block", "Around 70 families have water inside homes, need dry food and drinking water.", 85, 320, 5),
    ("DSCC-07", "blocked_drain", "Nayabazar drain blocked", "Storm drain grates covered with construction debris.", 15, 80, 2),
    ("DNCC-07", "waterlogging", "Badda link road waterlogged", "Water accumulating near Begunbari canal crossing after heavy shower.", 30, 250, 3),
    ("DNCC-08", "road_flooded", "DIT Road Rampura flooded", "Both lanes flooded near TV station, traffic diverted.", 35, 200, 3),
    ("DSCC-04", "waterlogging", "Motijheel C/A side street flooded", "Office workers wading, water ~30 cm.", 28, 400, 3),
    ("DSCC-01", "blocked_drain", "Satmasjid road drain clogged", "Drain slow, water pooling near the mosque.", 12, 60, 2),
    ("DSCC-08", "waterlogging", "Lalbagh fort road waterlogged", "Water up to ankle across the road, heritage area access blocked.", 18, 150, 2),
    ("DNCC-04", "overflow", "Ramchandrapur canal spilling", "Canal bank overflow near Mohammadpur bus stand.", 44, 350, 4),
    ("DSCC-09", "relief_need", "Hazaribagh tannery-area families need medicines", "Skin infections reported after prolonged flooding; need ORS and medical kits.", 25, 180, 3),
    ("DNCC-03", "waterlogging", "Pallabi sector 12 lane waterlogged", "Water collected in lane after rainfall.", 20, 90, 2),
    ("DNCC-01", "blocked_drain", "Uttara sector 7 drain cover broken", "Broken cover and silt build-up; risk of injury.", 8, 40, 2),
    ("DNCC-10", "waterlogging", "Mohakhali bus terminal flooded", "Bus terminal yard under water; passengers stranded.", 33, 500, 3),
]
STATES = ["resolved"] * 6 + ["in_progress"] * 0 + ["assessed"] * 5 + ["verified"] * 3 + ["reported"] * 4


def admin_upsert_user(client: httpx.Client, base: str, email: str, name: str, password: str) -> str:
    r = client.get(f"{base}/auth/v1/admin/users", params={"page": 1, "per_page": 1000})
    r.raise_for_status()
    existing = next((u for u in r.json().get("users", []) if u["email"] == email), None)
    if existing:
        client.put(f"{base}/auth/v1/admin/users/{existing['id']}", json={"password": password}).raise_for_status()
        return existing["id"]
    r = client.post(f"{base}/auth/v1/admin/users",
                    json={"email": email, "password": password, "email_confirm": True, "user_metadata": {"full_name": name}})
    r.raise_for_status()
    return r.json()["id"]


def main() -> None:
    s = get_settings()
    password = os.getenv("DEMO_PASSWORD") or s.demo_password
    if not (s.supabase_url and s.supabase_service_role_key and s.database_url):
        sys.exit("backend/.env needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and DATABASE_URL")
    if not password or len(password) < 8:
        sys.exit("Set DEMO_PASSWORD (>= 8 chars) in the environment")

    base = s.supabase_url.rstrip("/")
    headers = {"apikey": s.supabase_service_role_key}
    if not s.supabase_service_role_key.startswith("sb_"):      # legacy JWT-style service_role key
        headers["Authorization"] = f"Bearer {s.supabase_service_role_key}"
    ids = {}
    with httpx.Client(headers=headers, timeout=30) as client:
        for email, name, role, org, ward in USERS:
            ids[email] = admin_upsert_user(client, base, email, name, password)
            print(f"user  {email:<28} {role}")

    model = get_model(s.model_path, s.historical_csv)
    rng = random.Random(2026)
    now = datetime.now(timezone.utc)
    with psycopg.connect(s.database_url, row_factory=dict_row, autocommit=False, prepare_threshold=None) as conn:
        for email, name, role, org, ward in USERS:
            conn.execute("""update profiles set full_name=%s, role=%s, organization_id=%s, ward_id=%s, is_active=true, email=%s
                            where id=%s""", (name, role, ORG[org] if org else None, ward, email, ids[email]))
            if email in STAFF_IDS:   # role-specific sign-in ID (migration 007)
                conn.execute("savepoint sid")
                try:
                    conn.execute("update profiles set employee_id=%s where id=%s", (STAFF_IDS[email], ids[email]))
                except psycopg.errors.UndefinedColumn:
                    conn.execute("rollback to savepoint sid")
            # demo-only: a +880 number marked as SMS-verified so the demo still works when
            # security_settings.require_phone_verification is switched on (migration 008)
            conn.execute("savepoint phone")
            try:
                conn.execute("update profiles set phone=%s, phone_verified_at=coalesce(phone_verified_at, now()) where id=%s",
                             (DEMO_PHONE[email], ids[email]))
            except psycopg.errors.UndefinedColumn:
                conn.execute("rollback to savepoint phone")
        conn.commit()

        if conn.execute("select count(*) n from incidents where title like 'DEMO:%%' or reporter_id = any(%s::uuid[])",
                        ([ids["citizen@resiliomesh.demo"], ids["citizen2@resiliomesh.demo"]],)).fetchone()["n"] > 0:
            print("sample incidents already present — skipping")
            return

        wards = {w["id"]: w for w in conn.execute("select * from wards").fetchall()}
        officer = ids["officer@resiliomesh.demo"]
        reporters = [ids["citizen@resiliomesh.demo"], ids["citizen2@resiliomesh.demo"], ids["field1@resiliomesh.demo"]]
        states = STATES[:]
        rng.shuffle(states)
        for idx, (ward_id, cat, title, desc, depth, people, sev) in enumerate(REPORTS):
            w = wards[ward_id]
            status = states[idx % len(states)]
            created = now - timedelta(days=rng.uniform(0, 12) if status == "resolved" else rng.uniform(0, 0.4), minutes=rng.randint(0, 600))
            lat = w["lat"] + rng.uniform(-0.004, 0.004)
            lng = w["lng"] + rng.uniform(-0.004, 0.004)
            score = level = prio = None
            if status in ("assessed", "resolved"):
                feats = {"rain_past_24h_mm": rng.uniform(30, 120), "rain_next_24h_mm": rng.uniform(20, 140),
                         "max_hourly_mm": rng.uniform(10, 55), "drainage_capacity_mm_hr": w["drainage_capacity_mm_hr"],
                         "impervious_pct": w["impervious_pct"], "elevation_m": w["elevation_m"], "asset_condition": rng.uniform(25, 70),
                         "blocked_assets": rng.randint(0, 2), "historical_events_10y": w["historical_events_10y"],
                         "recent_reports_6h": rng.randint(0, 3), "monsoon": monsoon_factor(now.month)}
                ml = model.predict(feats)
                r = apply_rules(ml["score"], {**ml["features"], "water_depth_cm": depth, "people_affected": people, "category": cat})
                score, level = r["score"], r["level"]
                prio = priority(score, people, sev, 2)
            row = conn.execute("""
                insert into incidents(reporter_id, ward_id, category, title, description, severity_reported, water_depth_cm,
                                      people_affected, lat, lng, status, risk_score, risk_level, priority, created_at,
                                      verified_by, resolved_at)
                values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) returning id""",
                (reporters[idx % 3], ward_id, cat, title, desc, sev, depth, people, lat, lng, status, score, level, prio,
                 created, officer if status != "reported" else None,
                 created + timedelta(hours=rng.uniform(3, 30)) if status == "resolved" else None)).fetchone()
            if score is not None:
                conn.execute("""insert into risk_assessments(incident_id, ward_id, score, level, model_version, features,
                                contributions, rules_fired, weather_source, created_by)
                                values (%s,%s,%s,%s,%s,%s,%s,%s,'seed',%s)""",
                             (row["id"], ward_id, score, level, model.version, Jsonb({**ml["features"], "ml_score": ml["score"]}),
                              Jsonb(ml["contributions"]), Jsonb(r["rules_fired"]), officer))
            print(f"incident {status:<11} {title}")

        # community needs incl. one deliberate duplicate
        needs = [("DSCC-10", "relief_kit", 70, 70, "Rokeya Begum", "+8801711000001"),
                 ("DSCC-10", "water_tank", 1, 70, "Rokeya Begum", "+8801711000001"),
                 ("DSCC-09", "medical_kit", 40, 36, "Hazaribagh Youth Club", "+8801711000002"),
                 ("DSCC-05", "relief_kit", 55, 55, "Mugda Ward Committee", "+8801711000003"),
                 ("DSCC-06", "relief_kit", 30, 30, "Jatrabari Imam", "+8801711000004"),
                 ("DSCC-05", "relief_kit", 55, 55, "Mugda Ward Committee", "+880-1711-000003")]  # duplicate (phone normalised)
        for wid, t, q, h, cn, cp in needs:
            conn.execute("""insert into community_needs(ward_id, need_type, quantity, households, contact_name, contact_phone, dedup_key, submitted_by)
                            values (%s,%s,%s,%s,%s,%s,'x',%s)""", (wid, t, q, h, cn, cp.replace("-", ""), ids["ngo@resiliomesh.demo"]))
        conn.commit()
    print("\nDone. Sign in with any demo account using DEMO_PASSWORD.")


if __name__ == "__main__":
    main()
