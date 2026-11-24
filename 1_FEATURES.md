# 1. Features built so far

ResilioMesh: flood resilience and humanitarian resource intelligence for Dhaka.
Track: **World Problem Solver**. Declared advanced challenges: **A02** and **A05**.

> Status of this list: taken from the code in this repo (pages, migrations, backend routes).
> Test counts come from the project docs; see file 2 for what was actually re-run.

## Who uses it (5 roles)

| Role | What they do |
|---|---|
| Citizen | Report waterlogging, track their own reports, see risk for their ward |
| Drainage officer (Dhaka North or Dhaka South) | Verify reports, run AI assessment, plan and approve resources in their own area; read-only elsewhere |
| NGO coordinator | Manage own organisation's stock and community needs, allocate aid |
| Field worker | Receive tasks, work offline, update task status |
| Admin | Users and roles, audit log, system health, fault injection |

## Frontend pages (React 19 + Vite + Tailwind, PWA)

| Page | Route | Main features |
|---|---|---|
| Login / Register / Setup | `/login`, `/register` | Supabase Auth, validation, setup screen when env vars are missing |
| Dashboard | `/dashboard` | Different dashboard per role (staff, citizen, field, NGO). Live counters, high-risk wards, work queues, resource utilisation |
| Live Risk Map | `/map` | Leaflet map of wards, risk colour per ward, drainage assets, live updates |
| Reports & Assets | `/incidents` | Server-side search, 4 filters, sortable columns, pagination. Drainage asset CRUD |
| Report incident | `/incidents/new` | Pick location on map, depth, photos, offline-safe submit, duplicate detection |
| Incident detail | `/incidents/:id` | Status timeline, verify / assess / transition, AI explanation, presence ("also viewing"), conflict dialog |
| AI Risk Analysis | `/risk` | Ward risk scores, SHAP explanation, model info, what-if simulator, re-score all wards |
| Resources & Allocation | `/resources` | Inventory CRUD, run the optimiser, see shortages, approve plans |
| NGO Coordination | `/ngo` | Register community needs, duplicate-aid detection, allocate stock |
| Workflows & Tasks | `/workflows` | Dispatch workflow runs, step status, retries, compensation, manual retry |
| Field Portal | `/field` | Task list cached on the device, accept / start / complete, works offline |
| Analytics | `/analytics` | Percentiles, utilisation, per-ward / month / year charts, bulk CSV import |
| Audit & Admin | `/admin` | User and role management, audit log, API health, chaos switch |

Shared UI: app shell with sidebar, mobile drawer, toasts, conflict dialog, skeleton / spinner states, skip link, ARIA labels.

## Backend (FastAPI)

| Area | Endpoints / modules |
|---|---|
| Auth | `GET /me`, JWT verification (JWKS / HS256) in `core/auth.py` |
| Weather | `GET /weather/wards/{id}`, `GET /weather/status`: Open-Meteo with timeout, retry with jitter, circuit breaker, cache, climatology fallback |
| Risk AI | `POST /risk/incidents/{id}/assess`, `POST /risk/wards/refresh`, `POST /risk/simulate`, `GET /risk/model` |
| Optimiser | `POST /plans/optimize` (OR-Tools CP-SAT) |
| Workflow | `GET /workflows/worker`, `POST /workflows/process-now` |
| Analytics | `POST /analytics/import` (bulk CSV: COPY, dedup, imputation) |
| Admin | `GET /admin/health`, `POST /admin/chaos` |
| Safety | Rate limiting, pydantic validation (422 with field details), structured errors |

## Database (Supabase Postgres + PostGIS)

* **17 tables** with foreign keys and CHECK constraints (for example `available <= total`, depth ranges).
* **Migrations 001 to 005:** schema, triggers and guards, RLS, RPCs, realtime. Plus `seed.sql` (wards, assets, organisations, inventory, about 23k historical events).
* **Business rules in the database:** incident state machine (8 states), task state machine, plan states, optimistic-lock `version` on mutable tables, duplicate-report detection (PostGIS), append-only audit log.
* **13 RPC functions** in `004_rpc.sql` (atomic reserve / release, approve plan, allocate to need, transitions, analytics).
* **Row Level Security** by role and by organisation.

## AI and optimisation

* **XGBoost** risk model (trained on synthetic data, see file 3) plus **SHAP** explanations.
* **Rule engine:** 7 hard rules that act as a floor under the ML score (for example 45 cm standing water is always HIGH).
* **OR-Tools CP-SAT optimiser:** stock limits, reserve share, distance, pump-to-crew coupling, organisation isolation, full coverage for critical incidents.
* **Infeasible and conflicting inputs:** contradiction check before solving, shortage diagnosis, "relaxed" plan that a human must approve.

## Automation (dispatch saga)

5 steps: `validate_plan`, `reserve_resources`, `create_tasks`, `notify_teams`, `activate_incidents`.
Postgres queue with `FOR UPDATE SKIP LOCKED`, exponential backoff, compensation on failure, resumable after crash, admin retry.
When all tasks finish, the incident is resolved and reusable equipment goes back to stock.

## Offline-first

IndexedDB task cache and outbox, service worker for the app shell, ordered replay on reconnect, conflict policy (server-terminal wins, progress wins, merge) with a log.

## Tests and tooling

| Suite | Count (from docs) |
|---|---|
| Backend unit | 57 |
| Backend real-DB | 21 |
| Frontend unit (vitest) | 22 |
| Playwright e2e | 10 |

CI workflow in `.github/workflows/ci.yml`. Deploy config: `render.yaml` (backend), `frontend/vercel.json`.

## Docs already in the repo

`README.md`, `docs/SUPABASE_SETUP.md`, `docs/API_SETUP.md`, `docs/TESTING.md`, `docs/REQUIREMENTS_MATRIX.md`, `docs/2_DAY_WORKFLOW.md`.
