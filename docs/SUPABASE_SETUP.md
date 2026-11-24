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
| 7 | `supabase/migrations/006_role_requests.sql` | staff access requests (sign-up as Drainage Officer / NGO / Field Worker) |
| 8 | `supabase/migrations/007_staff_login_ids.sql` | Employee / Staff / Admin sign-in IDs |
| 9 | `supabase/migrations/008_identity_verification.sql` | server-side staff-ID check bound to the session, MFA, official e-mail domains, staff roster, NGOAB registry, ID-card upload bucket, two-admin approval, Bangladesh-only phones, report area / rate limits / trust flags. See [IDENTITY_VERIFICATION.md](IDENTITY_VERIFICATION.md) |
| 10 | `supabase/migrations/009_officer_areas.sql` | Drainage Officer areas: each drainage authority serves Dhaka North (DNCC) or Dhaka South (DSCC). Officers can view all of Dhaka but can only verify, assess, plan, resolve and edit assets in their own area. Admins stay city-wide. |

Shortcut: run `001_schema.sql`, then `supabase/run_after_001.sql` (files 2–10 in one script).

All files can be re-run safely (they are idempotent). If you ever re-run `003_rls.sql`, run 006–009 again afterwards (003 resets every policy). If you re-run `004_rpc.sql`, run 009 again.

Check that it worked:
```sql
select (select count(*) from wards) wards, (select count(*) from historical_flood_events) history;
-- expect 20 | ~23000
```

## 3. Authentication settings
**Authentication → Sign In / Providers → Email**
* Email provider: **enabled**
* **Confirm email: ON.** Without it anyone can register with someone else's address, and the official e-mail domain rule (`@dncc.gov.bd`, `@dscc.gov.bd`, …) proves nothing. Staff requests cannot be approved until the address is confirmed. The demo accounts are created already confirmed, so judges are not affected.
* Minimum password length: 8

**Authentication → Sign In / Providers → Phone** (SMS one-time codes)
* Enable the Phone provider and connect an SMS provider (Twilio, MessageBird, Vonage or Textlocal).
* Then switch on the server rule, so citizens need an SMS-verified **+880** number to report:
  ```sql
  update security_settings set require_phone_verification = true;
  ```
  Leave it off until SMS works, otherwise citizens cannot submit reports. Numbers are always restricted to Bangladeshi mobiles, whether this rule is on or off.

**Authentication → Multi-Factor**
* TOTP (authenticator app): **enabled** (the default). Anyone can turn it on under *Account & security*. Once an account has it, its staff role only works after the 6-digit code is entered.
* To make it mandatory for sensitive roles:
  ```sql
  update security_settings set mfa_required_roles = '{admin,city_officer}';
  ```
  Each person then sets up their app at their next sign-in. Do not do this on the shared demo admin: the first judge to enrol would lock the others out.

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
| admin@resiliomesh.demo · ADM-001 | System Admin |
| admin2@resiliomesh.demo · ADM-002 | System Admin: the second approver for the two-admin rule |
| officer@resiliomesh.demo / officer2@… | Drainage Officer (Dhaka South / Dhaka North) |
| ngo@resiliomesh.demo / ngo2@… | NGO Coordinator |
| field1@ / field2@ / field3@resiliomesh.demo | Field Worker |
| citizen@ / citizen2@resiliomesh.demo | Citizen |

It also inserts 18 realistic incidents in different states and 6 community needs. One need is a deliberate duplicate, and the database flags it automatically.

> Self-registration always creates a **Citizen**. Staff roles are granted only through **Admin → Access requests**. Drainage Officer and Admin grants, and any request that fails a check (not on the roster, wrong e-mail domain, unknown NGOAB number), need **two different admins**. The database enforces all of this.

## 6b. Verification data (Admin → Verification data)
* **Official e-mail domains** per city authority / NGO. Seeded: North → `dncc.gov.bd`, South → `dscc.gov.bd`.
* **Staff roster**: upload the CSV each HR office provides (`employee_id,official_email,full_name,role`). Requests show *On staff roster* in green or a red flag.
* **NGOAB registry**: upload the NGO Affairs Bureau list (`registration_no,name,district,status,valid_until`).
* **Storage bucket `staff-documents`** (private) is created by migration 008 for ID cards and appointment letters. Check that it exists under *Storage*. If the migration could not create it, create it as private and re-run 008 for its policies.

## 6c. Security settings
One row in `security_settings`. It can only be edited from the SQL editor, never from the app:
```sql
select * from security_settings;
-- e.g. shorter staff sessions and stricter report limits
update security_settings set staff_session_hours = 8, citizen_reports_per_hour = 3;
```

## 7. Sanity checks in the SQL editor
```sql
-- RLS is on for every table
select tablename, rowsecurity from pg_tables where schemaname='public' order by 1;
-- Race test: the last unit can be reserved only once
select * from resources where quantity_available <= 1;
```
