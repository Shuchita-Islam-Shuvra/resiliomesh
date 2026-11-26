# Requirement coverage matrix (Hack the Vibe 2026 rubric)

## Mandatory M01–M08 (60 marks)

| ID | Rubric item | Implementation | Where |
|---|---|---|---|
| **M01** | 3 interconnected modules | Drainage Intelligence → Resource Intelligence → Autonomous Ops, sharing incidents, plans and tasks | all pages |
| | End-to-end workflow | report → verify → AI assess → optimise → approve → workflow → field tasks → auto-resolve and return equipment | `004_rpc.sql`, `workflow/engine.py` |
| | Meaningful features | live map, explainable AI, optimiser, offline field app, analytics, audit | 11 pages |
| **M02** | CRUD | assets (C/R/U/D), resources (C/R/U), incidents, needs, users | IncidentsPage, ResourcesPage, NgoCenter, Admin |
| | Persistent storage | Supabase Postgres + PostGIS; IndexedDB offline | `001_schema.sql` |
| | Relationships and consistency | 17 tables with FKs, CHECKs (`available ≤ total`, depth ranges), unique idempotency keys, trigger-maintained versions | `001`, `002` |
| **M03** | Secure authentication | Supabase Auth (bcrypt, JWT); backend verifies JWT via JWKS/HS256 | `core/auth.py` |
| | Role/resource authorisation | 5 roles; RLS per role **and organisation**; RPC role checks; route guards | `003_rls.sql`, `ProtectedRoute.jsx` |
| | Session protection | auto token refresh, deactivated accounts force-logout (realtime), self-role-change blocked | `AuthContext.jsx`, `rm_guard_profile` |
| **M04** | Rule-based decisions | 7 risk rules, priority formula, demand derivation, reusable vs consumable equipment | `ml/rules.py`, `optimizer.derive_demand` |
| | Multi-condition transitions | incident state machine (8 states) + task state machine + plan states, each with role conditions; four-eyes rule (a reporter can never verify their own report) | `rm_incident_transition_allowed`, `transition_incident`, `update_task_status`, `022_reporter_cannot_verify.sql` |
| | Correct outcomes | boundary tests (34.9/35/75), auto-resolve only when every task is done | `test_risk_engine.py`, `test_db_flow.py` |
| **M05** | Search, filter, sort | server-side `ilike` search, 4 filters, sortable headers, pagination | `IncidentsPage.jsx` |
| | Calculations/aggregation | analytics RPC: percentiles, utilisation %, per-ward/month/year aggregates; risk scoring | `analytics_dashboard` |
| | Output accuracy | aggregate correctness verified in real-DB tests | `test_analytics_is_staff_only` |
| **M06** | Input validation | client validators mirror DB CHECKs; pydantic 422 with field details | `validation.js`, `main.py` |
| | Duplicate actions | idempotent approve, `client_id` on reports, idempotency keys on reservations and optimiser, PostGIS duplicate reports, duplicate aid needs | `002`, `004` |
| | Failure handling and recovery | weather fallbacks, workflow retry/compensation, offline queue, friendly error mapping | `weather.py`, `engine.py`, `errors.js` |
| **M07** | Responsive | mobile drawer nav, responsive grids/tables, bottom-sheet modals | `AppShell.jsx`, `ui.jsx` |
| | Keyboard and semantics | skip link, labelled inputs, `aria-sort`, `aria-invalid`, focus rings, Esc closes modals, `role=alert` | `ui.jsx` |
| | Validation feedback | inline field errors, toasts, conflict dialog | |
| **M08** | Live deployment | Vercel + Render + Supabase | `render.yaml`, `vercel.json` |
| | Repo and docs | README, setup, API, testing, this matrix, CI | `docs/` |

## Advanced A01–A08 (declare **A02 + A05**)

| ID | Build | Hidden-test scenario → behaviour |
|---|---|---|
| **A02 ★ declared** | XGBoost + SHAP explanations + rule engine; OR-Tools CP-SAT with stock, reserve, distance, pump→crew coupling, org isolation and critical full-coverage constraints; pre-solve contradiction check; infeasibility diagnosis (per incident/type shortage + aggregate); relaxed fallback flagged for human review; what-if simulator | Conflicting constraints → `INVALID_CONSTRAINTS` listing each contradiction. Infeasible → `INFEASIBLE` + shortages, or a `relaxed` partial plan that **cannot be silently executed** (coordinator must approve, empty plans are refused by `approve_plan`) |
| **A05 ★ declared** | `rm_reserve_resource`: `SELECT … FOR UPDATE` row lock, re-check of the idempotency key after the lock, unique-violation race handling, CHECK `available ≥ 0` as a last line of defence; idempotent release; `allocate_to_need` fully atomic (need + stock + allocation in one transaction); idempotent `approve_plan`; SKIP LOCKED job claiming; workflow step and marker committed atomically | 25 concurrent requests for the last unit → exactly 1 succeeds, 24 get `INSUFFICIENT_STOCK`, stock = 0, 1 allocation row. 10 concurrent identical requests → one allocation returned to all. Two coordinators → one need fulfilled, the other untouched |
| A01 | Supabase Realtime on 11 tables; presence ("also viewing"); `version` optimistic locking on every mutable table; conflict dialog with field diff | Two officers → second write returns `conflict` + current server row |
| A03 | RLS by role and organisation; SECURITY DEFINER RPCs with explicit checks; client cannot forge reporter/status/risk; role escalation blocked by trigger; append-only audit with actor + diff | Citizen updating another's report affects 0 rows; NGO editing another org's stock affects 0 rows |
| A04 | IndexedDB task cache + outbox, service-worker app shell, ordered replay with version chaining, documented conflict policy (server-terminal-wins / progress-wins / merge) | Offline completion vs coordinator cancel → server wins, logged |
| A06 | Timeout, retry with jitter, 429/5xx-only retries, schema validation, circuit breaker, DB + memory cache, climatology fallback, API rate limiting, chaos switch | Timeout → 3 attempts → stale cache / climatology, `degraded=true` |
| A07 | 5-step saga, Postgres queue, exponential backoff, compensation (release, cancel, roll back), resumable after crash, admin retry with generation-scoped idempotency | Fail at `create_tasks` → retried 3× → compensated → retry → succeeded with no double reservation |
| A08 | Indexed aggregate RPC; COPY-based import; in-file + in-DB dedup (hash); missing-value imputation (ward×month median); invalid row rejection | 125k dirty rows → 212 invalid rejected, 42k duplicates removed, 36k gaps imputed, 4.5 s |
