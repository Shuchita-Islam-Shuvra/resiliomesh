# Testing guide

## Automated suites

```bash
# Backend unit tests (no database needed), 57 tests
cd backend && .venv\Scripts\python -m pytest -v

# Backend real-database tests, 21 tests
#  a) against a throwaway local PostGIS (Docker):
docker run -d --name rm-pg -e POSTGRES_PASSWORD=testpw -p 54329:5432 postgis/postgis:16-3.4
for f in scripts/test_db/supabase_stub.sql supabase/migrations/00*.sql supabase/seed.sql; do
  docker exec -i rm-pg psql -U postgres -v ON_ERROR_STOP=1 -q < $f; done
TEST_DATABASE_URL=postgresql://postgres:testpw@localhost:54329/postgres pytest tests/test_db_*.py -v
#  b) or against a Supabase *staging* project (tests create and clean their own rows)

# Frontend unit tests, 22 tests
cd frontend && npm test

# End-to-end (Playwright). Needs the seeded Supabase project and a running backend
npx playwright install chromium
$env:E2E_PASSWORD="<DEMO_PASSWORD>"; npx playwright test
```
CI (`.github/workflows/ci.yml`) runs backend unit and real-DB tests against PostGIS, plus frontend unit tests and the build, on every push.

## What each official test scenario maps to

| PDF scenario | Automated test | Manual demo |
|---|---|---|
| **A01** Two users update the same record simultaneously | `test_db_flow::test_officer_transition_with_optimistic_lock`, `e2e/workflow.spec::A01` | Two browsers → edit the same drainage asset → second save shows "Someone else changed this record" |
| **A02** Conflicting constraints / infeasible request | `test_optimizer::test_conflicting_constraints_detected_before_solving`, `test_infeasible_*` | Resources → Optimise: reserve 0.95 + a critical incident → shortage diagnosis + relaxed plan; reserve 1 → "constraints conflict" |
| **A03** User modifies another user's restricted record | `test_db_flow::test_citizen_cannot_modify_another_users_record`, `test_citizen_cannot_escalate_own_role`, `test_ngo_cannot_touch_other_orgs_stock` | Citizen → `/admin` shows Access restricted. Raw REST PATCH with the anon key returns 0 rows |
| **A04** Conflicting edits while one client is offline | `sync.test.js` (server-wins / client-wins / merge), `e2e/offline.spec` | Field portal → DevTools Offline → update task → coordinator changes it → go online → conflict log |
| **A05** Multiple users request the final available resource | `test_db_integration::test_many_users_race_for_the_final_unit` (25 threads), `test_db_flow::test_two_coordinators_race_for_last_relief_kits` | Two NGO coordinators allocate the last kits at the same moment → one succeeds, the other gets "insufficient stock" |
| **A06** API times out or returns malformed data | `test_weather.py` (9 tests) | Admin → chaos "Simulate timeout" → Re-score wards → source `climatology`/`stale_cache`, breaker opens |
| **A07** Intermediate step fails after earlier steps succeeded | `test_workflow::test_intermediate_failure_after_reservations_compensates`, `test_db_flow::test_intermediate_step_failure_compensates_everything` | Admin → Plans → fault injection "fail at create_tasks" → approve → Workflows page shows retries → compensated (stock restored) → Retry → succeeded |
| **A08** Duplicates, missing values, large input | `test_importer.py` (120k rows), real import of `data/bulk_import_sample.csv` (125k rows, ~4.5 s) | Analytics → Bulk import → report card |

## Mandatory requirement checks

| Req | Evidence |
|---|---|
| M02 CRUD/consistency | Asset CRUD with version checks; CHECK constraints (`available <= total`); FK cascades; `test_check_constraint_prevents_negative_stock` |
| M03 Auth | `test_api.py` (401/403), `e2e/auth.spec` |
| M04 Business logic | `test_risk_engine.py` (rule floors, boundaries), state-machine tests, task-completion auto-resolve |
| M05 Search/filter/sort/aggregate | Incidents page (server-side search + 4 filters + sort + pagination); `analytics_dashboard` aggregates |
| M06 Validation / duplicates / recovery | `validation.test.js`, 422 tests, idempotent approve (`again["replayed"]`), geo-duplicate test |
| M07 Responsive/a11y | `e2e/responsive.spec`, keyboard login test, labelled fields, `aria-invalid`, skip link |
