# Identity verification and anti-impersonation

This document covers how ResilioMesh checks that staff are who they say they are, and how it keeps fake or foreign citizen reports out. The rules are enforced in the database (`supabase/migrations/008_identity_verification.sql`) and in the API backend. The browser repeats them only to give instant feedback. A user who skips the UI and calls the Supabase API directly runs into the same rules.

## Gaps and fixes

| Gap | Fix | Where |
|---|---|---|
| The Employee ID was checked only in the browser. Signing in through the API with email and password skipped it. | Staff privileges are bound to a **server-verified session**. After the password step, `rm_verify_staff_login()` checks the Employee / Staff / Admin ID (or the NGO) in the database and records that session id in `staff_sessions`. Until then `rm_role()` returns `citizen` for that session, and every RLS policy and RPC uses `rm_role()`. Five wrong IDs lock the account for 15 minutes. The lock is counted on the server. The FastAPI backend resolves the role the same way, through `rm_effective_role()`. | 008 §3, `backend/app/core/auth.py` |
| No real second factor | **TOTP (authenticator app)** through Supabase MFA. Once an account has an authenticator, its staff role only works in sessions at AAL2. `mfa_required_roles` makes it mandatory per role. | 008 §3, *Account & security* page |
| Email confirmation was off | Email confirmation is **on** (see the setup guide). Staff requests cannot be approved until the address is confirmed. | `SUPABASE_SETUP.md` §3, 008 §6 |
| No official email domain | `organizations.email_domains` (DNCC → `dncc.gov.bd`, DSCC → `dscc.gov.bd`). Sign-up as **Drainage Officer** is refused without the authority's domain. **NGO Coordinators** need their NGO's domain and can never use public mail (Gmail, Yahoo, …). Admins cannot add public mail domains. | 008 §4, §7 |
| The Employee ID was not checked against an official list | **Staff roster** uploaded from each HR office as a CSV. Each request shows *On staff roster* or a red flag (*Not on roster*, *Roster e-mail differs*, *ID belongs to another organisation*, *Inactive*). If the reviewing admin uploaded the matching roster row, it does not count as independent proof. | 008 §5, §6 |
| The NGOAB number was not checked | **NGOAB registry** (CSV import). The registration number must be in it and active. | 008 §5 |
| No proof documents | ID card or appointment letter, uploaded to a **private** storage bucket (`staff-documents`). Only the applicant and admins can open them. Self-service requests cannot be approved without one. | 008 §6, *Account & security* |
| A single admin could approve anyone | **Two different admins** for Drainage Officer and Admin grants, and for any request with a red flag. A flagged request also needs a written reason. Any one admin can still reject or revoke access (fail-safe). Admins can no longer promote someone, change a staff member's organisation or ID, or re-activate staff directly. That goes through *Propose access change* and needs a second admin. Every step is in the audit log. | 008 §2, §8 |
| No phone OTP, and the DB accepted any 10–14 digits | The DB accepts **Bangladeshi mobiles only** (`+8801[3-9]XXXXXXXX`) and normalises `01…` input. Verification uses an **SMS one-time code** (Supabase phone auth). The verified flag can only be set by Supabase Auth, never by the user. With `require_phone_verification` on, citizens need a verified number to report. | 008 §2, §9 |
| Citizen country was not checked, and GPS could be faked | Reports must be inside the **Dhaka service area**, and the pin must belong to the chosen ward. There are **rate limits** (5 per hour and 20 per day by default). The server attaches **trust flags** that staff see on the report: *foreign network* / *Tor* (from Cloudflare's `cf-ipcountry`, best effort), *phone not verified*, *new account*, *far from home area*. Officer verification remains the final gate. | 008 §9 |

## How a staff sign-in works

1. Email and password go to Supabase Auth, which issues a session. At this point the database treats the session as a **citizen**.
2. The browser calls `rm_verify_staff_login(role, id, org)`. The database checks the ID or NGO and stores `session_id → role` with a lifetime (12 hours by default).
3. If the account has an authenticator, or its role requires one, the 6-digit code raises the session to AAL2.
4. From now on `rm_role()` returns the real role for this session only. Signing out, an expired staff session, a revoked Supabase session or a role change by an admin all drop the session back to citizen.

If someone opens the app with a session that has not been verified (a stolen password, an expired shift), they see the **Confirm your sign-in** screen instead of the console.

## Settings

The `security_settings` table has a single row and can only be changed from the SQL editor:

| Setting | Default | Meaning |
|---|---|---|
| `staff_session_hours` | 12 | How long a verified staff session lasts |
| `staff_id_max_failures` / `staff_id_lock_minutes` | 5 / 15 | Lock-out after wrong IDs |
| `mfa_required_roles` | `{}` | Roles that must use an authenticator app |
| `require_phone_verification` | `false` | Citizens need an SMS-verified +880 number to report. Switch it on after connecting an SMS provider. |
| `require_official_email` | `true` | Domain rule for Drainage Officers and NGO Coordinators |
| `require_email_confirmed` | `true` | Approval needs a confirmed e-mail address |
| `require_documents` | `true` | Approval needs an uploaded ID card or appointment letter |
| `two_person_roles` | `{city_officer,admin}` | Roles that always need two admins |
| `citizen_reports_per_hour` / `_per_day` | 5 / 20 | Report rate limits |
| `report_ward_max_km` | 4 | How far the pin may be from the chosen ward's centre |

## Known limits

* **Geo-IP is a signal, not a block.** VPNs bypass it, and it depends on Supabase passing Cloudflare's `cf-ipcountry` header. When the header is missing, no flag is set.
* **Phone OTP needs an SMS provider** configured in Supabase. Until then, phone numbers are format-checked only and `require_phone_verification` must stay off.
* **The roster and NGOAB data are only as good as the uploaded files.** Keep them current: use *Replace* when re-uploading a roster so that people who left are deactivated.
* **Two admins need two admin accounts.** The demo seeds `admin2@resiliomesh.demo` (ADM-002). In production, create the second admin from the SQL editor or seed script, then grant further admins through the two-person flow.
* Ward boundaries are approximated by ward centroids, so a pin far from every listed ward is accepted for its nearest ward and flagged.

## Tests

* `backend/tests/test_db_identity.py`: 27 tests against a real Postgres, run with end-user privileges. They cover the API bypass, lock-out, session theft, sign-out and expiry, MFA, BD-only phones, OTP-only verification, the Dhaka area and ward check, rate limits, trust flags, official domains, roster and NGOAB checks, documents, two-person approval, the proposal flow and registry permissions.
* `frontend/tests/unit/identity.test.js`: client-side mirrors of the rules.
