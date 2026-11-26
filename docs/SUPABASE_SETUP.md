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
| 7 | `supabase/migrations/006_role_requests.sql` | staff access requests (sign-up as Water Resilience Officer / NGO / Field Worker) |
| 8 | `supabase/migrations/007_staff_login_ids.sql` | Employee / Staff / Admin sign-in IDs |
| 9 | `supabase/migrations/008_identity_verification.sql` | server-side staff-ID check bound to the session, MFA, official e-mail domains, staff roster, NGOAB registry, ID-card upload bucket, two-admin approval, Bangladesh-only phones, report area / rate limits / trust flags. See [IDENTITY_VERIFICATION.md](IDENTITY_VERIFICATION.md) |
| 10 | `supabase/migrations/009_officer_areas.sql` | Water Resilience Officer areas: each drainage authority serves Dhaka North (DNCC) or Dhaka South (DSCC). Officers can only verify, assess, plan, resolve and edit assets in their own area. Admins stay city-wide. |
| 11 | `supabase/migrations/010_one_ngo_per_coordinator.sql` | One person, one NGO Coordinator post. NGO Coordinators work city-wide (no North/South split). A mobile number that holds an active NGO Coordinator post cannot be used by any other active staff account, and moving a coordinator to another NGO is a two-admin transfer. |
| 12 | `supabase/migrations/011_officer_area_view.sql` | Officers SEE only their own area too: a Dhaka South officer's wards, reports, assets, risk, plans, tasks, workflows, analytics and map are all Dhaka South (their own reports and their authority's own stock stay visible). Admins, NGOs and field workers unchanged. |
| 13 | `supabase/migrations/012_area_bound_staff.sql` | North / South everywhere: field workers of a city corporation are bound to its area like officers (NGO crews stay city-wide). Area-bound staff see only their area (incl. ward weather) and can file reports / log needs only there; a place belongs to the area of its nearest ward centre. Field tasks go only to crews of the incident's area or NGO crews. Adds public `ward_areas()` for map shading. |
| 14 | `supabase/migrations/013_ngo_allocation_lifecycle.sql` | NGO coordinator aid lifecycle: `ngo_update_allocation()` (dispatch, mark delivered, cancel and return stock) and `cancel_need()`; coordinators can edit only their own or unclaimed needs. |
| 15 | `supabase/migrations/014_ngo_coordinator_areas.sql` | NGO coordinators get a home area (Dhaka North / South) from their main operating ward and are responsible for needs there. The other area's coordinators can help when backup is asked for one need (`request_ngo_backup`) or the whole area (`set_ngo_area_backup`), or when an area has no coordinator. `ngo_area_status()` for the NGO screen. Changing a coordinator's area is admin-only. |
| 16 | `supabase/migrations/015_split_officer_ngo_duties.sql` | Separates the two jobs: only Water Resilience Officers (own area) and admins approve, reject or retry pump & crew plans. NGO coordinators keep read access to reports and handle relief on the NGO page. |
| 17 | `supabase/migrations/016_split_stock_by_role.sql` | Splits the STOCK by role: NGO coordinators see and edit only their own NGO's stock and cannot register pumps or crews; officers see city-authority equipment (own authority + authority stock in their area), not NGO relief stock. The officers' optimiser also plans with authority equipment only; relief kits / medical kits for people go to NGO coordinators. |
| 18 | `supabase/migrations/017_incident_is_closed.sql` | `incidents.is_closed`, so lists rank open reports ahead of resolved / rejected / duplicate ones |
| 19 | `supabase/migrations/018_allocate_only_verified.sql` | Relief stock can only be reserved for a need whose linked report an officer has verified |
| 20 | `supabase/migrations/019_field_crews.sql` | Field crews: a task gets a crew sized to the job with one lead, picked by team, area, duty and workload; on/off duty; decline with automatic replacement; officers set crews; GPS at start and finish |
| 21 | `supabase/migrations/020_field_failure_after_accept.sql` | A field worker can report a problem after accepting, without a fake "start work" |
| 22 | `supabase/migrations/021_admin_duties.sql` | Two admins, two jobs: the **system owner** sets the platform up (roster, NGOAB registry, official domains, fault injection); the **access reviewer** reviews access, audits and revokes. Both approve access (two-person rule). New admins start as reviewer; only the platform team (SQL) changes a duty |
| 23 | `supabase/migrations/022_reporter_cannot_verify.sql` | Four-eyes rule: whoever filed a report (an officer from the field, an admin logging a call-in) cannot verify it; another officer of that area or an admin must. The reporter can still mark it duplicate or withdraw it with a reason |

Shortcut: run `001_schema.sql`, then `supabase/run_after_001.sql` (files 2–17 in one script), then 017–022 one by one.

All files can be re-run safely (they are idempotent). If you ever re-run `003_rls.sql`, run 006–016 again afterwards (003 resets every policy). If you re-run `004_rpc.sql`, run 009, 011, 012 and 015 again. If you re-run `008`, run 010 again.

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
| admin@resiliomesh.demo · ADM-001 | System Admin · **System owner**: platform set-up (roster, NGOAB registry, official domains, fault injection) |
| admin2@resiliomesh.demo · ADM-002 | System Admin · **Security & audit officer**: reviews access and the audit log, the second approver for the two-admin rule; cannot change platform set-up |
| officer@resiliomesh.demo / officer2@… | Water Resilience Officer (Dhaka South / Dhaka North) |
| ngo@resiliomesh.demo / ngo2@… | NGO Coordinator (Dhaka South / Dhaka North) |
| field1@ … field7@resiliomesh.demo · FW-001 … FW-007 | Field Worker (drainage, pump, relief and medical teams, both areas) |
| citizen@ / citizen2@resiliomesh.demo | Citizen |

It also inserts 18 realistic incidents in different states and 6 community needs. One need is a deliberate duplicate, and the database flags it automatically. Re-running the seed is safe: it resets the demo passwords, puts every demo field worker back on duty and skips the sample data that already exists.

### Put real work on the field crews (optional, before a demo)
The seed creates reports but no field tasks, so the Field Portal starts empty. With the backend running:
```powershell
python ..\scripts\demo_dispatch.py            # add --api https://<your-api>.onrender.com for the live backend
```
It signs in as the two demo officers and runs the real pipeline for up to 2 assessed reports per area: AI assessment if missing → optimiser plan → approval → dispatch workflow. The script prints every task with its crew (lead marked). Crews are sized to the job, so some tasks start short-staffed and show up in the officer's **Field crews need attention** list.

> Self-registration always creates a **Citizen**. Staff roles are granted only through **Admin → Access requests**. Water Resilience Officer and Admin grants, and any request that fails a check (not on the roster, wrong e-mail domain, unknown NGOAB number), need **two different admins**. The database enforces all of this.

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
