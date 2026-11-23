# Supabase setup (about 15 minutes)

## 1. Create the project
1. Go to <https://supabase.com/dashboard>, choose **New project**, and name it `resiliomesh`.
2. Region: **Southeast Asia (Singapore)**, the closest region to Dhaka.
3. Save the **database password** somewhere safe. You will need it for `DATABASE_URL`.

## 2. Run the SQL (SQL Editor → New query)
Run these files **one at a time, in this order**. Paste the content and click **Run**.

| # | File | What it creates |
|---|---|---|
| 1 | `supabase/migrations/001_schema.sql` | PostGIS, enums, 17 tables, indexes |
| 2 | `supabase/migrations/002_functions_triggers.sql` | role helpers, profile auto-creation, privilege-escalation guard, incident state machine, geo-duplicate detection, audit triggers |
| 3 | `supabase/migrations/003_rls.sql` | Row Level Security policies (role + organisation isolation) |
| 4 | `supabase/migrations/004_rpc.sql` | atomic reservation, plan approval, task updates, workflow queue, analytics |
| 5 | `supabase/migrations/005_realtime.sql` | adds tables to the `supabase_realtime` publication |
| 6 | `supabase/seed.sql` | 20 Dhaka wards, 25 drainage assets, 5 organisations, inventory, ~23k historical events |

All files can be re-run safely (they are idempotent).

Check that it worked:
```sql
select (select count(*) from wards) wards, (select count(*) from historical_flood_events) history;
-- expect 20 | ~23000
```

## 3. Authentication settings
**Authentication → Sign In / Providers → Email**
* Email provider: **enabled**
* **Confirm email: OFF** for the hackathon demo, so judges can register and sign in immediately. Turn it ON for production.
* Minimum password length: 8

**Authentication → URL Configuration**
* Site URL: `https://<your-app>.vercel.app`
* Redirect URLs: `http://localhost:5173/**`, `https://<your-app>.vercel.app/**`

## 4. Realtime
**Database → Publications → supabase_realtime** should list incidents, tasks, resources, allocation_plans, workflow_runs, workflow_steps, community_needs, wards, drainage_assets, profiles and allocations. Migration 005 adds them. Toggle any that are missing.

## 5. Keys you need (Project Settings → API / Connect)

| Value | Where it goes | Secret? |
|---|---|---|
| Project URL | `VITE_SUPABASE_URL` (frontend), `SUPABASE_URL` (backend) | no |
| anon / publishable key | `VITE_SUPABASE_ANON_KEY` (frontend) | no (protected by RLS) |
| service_role / secret key | `SUPABASE_SERVICE_ROLE_KEY`, only in `backend/.env` for the seed script | **YES. Never in the frontend, never in git** |
| Connection string → **Session pooler** | `DATABASE_URL` (backend) | **YES** |

`DATABASE_URL` looks like:
```
postgresql://postgres.<ref>:<db-password>@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres
```
Use the **Session pooler** (port 5432). Render's free tier has no IPv6, and the direct `db.<ref>.supabase.co` host is IPv6-only. If the password contains `@ # / ?`, URL-encode it.

JWT verification needs no setup: the backend reads the project's JWKS from `SUPABASE_URL`. Only if your project still uses the **legacy HS256 secret** do you also set `SUPABASE_JWT_SECRET` (Project Settings → API → JWT Settings).

## 6. Create the demo accounts and sample data
```powershell
cd backend
.venv\Scripts\activate
$env:DEMO_PASSWORD = "Choose-A-Strong-Pass-2026"
python ..\scripts\seed_demo.py
```
This creates 10 accounts and assigns their roles and organisations:

| Email | Role |
|---|---|
| admin@resiliomesh.demo | System Admin |
| officer@resiliomesh.demo / officer2@… | City Officer (South / North Drainage Authority) |
| ngo@resiliomesh.demo / ngo2@… | NGO Coordinator |
| field1@ / field2@ / field3@resiliomesh.demo | Field Worker |
| citizen@ / citizen2@resiliomesh.demo | Citizen |

It also inserts 18 realistic incidents in different states and 6 community needs. One need is a deliberate duplicate, and the database flags it automatically.

> Self-registration always creates a **Citizen**. Only an admin can grant staff roles (Admin → Users & roles). The database enforces this.

## 7. Sanity checks in the SQL editor
```sql
-- RLS is on for every table
select tablename, rowsecurity from pg_tables where schemaname='public' order by 1;
-- Race test: the last unit can be reserved only once
select * from resources where quantity_available <= 1;
```
