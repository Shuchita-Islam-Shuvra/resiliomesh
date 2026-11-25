# 1. Features built so far

ResilioMesh: flood resilience and humanitarian resource intelligence for Dhaka.
Track: **World Problem Solver**. Declared advanced challenges: **A02** and **A05**.

> Status of this list: taken from the code in this repo (pages, migrations, backend routes).
> Test counts come from the project docs; see file 2 for what was actually re-run.

## Who uses it (5 roles)

| Role | What they do |
|---|---|
| Citizen | Report waterlogging, track their own reports, see risk for their ward |
| Water Resilience Officer (Dhaka North or Dhaka South) | The water: verify reports, run AI assessment, plan and approve pump & crew dispatch (the only role besides admin that can) in their own area; read-only elsewhere |
| NGO coordinator (home area Dhaka North or South, one NGO per person) | Responsible for community needs in their own area: log, allocate own NGO's stock, track dispatch / delivery, cancel. Can ask the other area for backup (one need or the whole area) and help the other area when asked; an area with no coordinator is open to all. One person holds one coordinator post; a move to another NGO is a two-admin transfer, a move to the other area is admin-only. Reads reports (can log a relief need from one) but never changes them or approves pump / crew plans |
| Field worker (city crews: own area; NGO crews: city-wide) | Work in crews: each task gets a crew sized to the job (1 per pump, 2 per boat, about 1 per 50 kits, at most 4) with one lead. The crew is picked by team/skill, the stock owner's own people first, on-duty only, then least busy. Any crew member can update status, offline too, and device GPS is recorded at start and finish. A worker can go on or off duty, can decline a task before accepting it (with a reason; a replacement is picked automatically, otherwise the officer is told), and can report a problem after accepting without a fake start (migration 020). Officers see every task with no crew, a failure, a decline, short staffing or a missed due time in a live "Field crews need attention" list and assign or adjust crews from there. Field workers can never cancel a task |
| Admin (two admins, two jobs) | **System owner**: platform set-up (official domains, NGOAB numbers, staff roster, NGOAB registry) and fault injection. **Security & audit officer**: reviews access, audit log, revokes at once. Both approve access under the two-person rule; neither can change their own duty (migration 021) |

## Frontend pages (React 19 + Vite + Tailwind, PWA)

| Page | Route | Main features |
|---|---|---|
| Login / Register / Setup | `/login`, `/register` | Supabase Auth, validation, setup screen when env vars are missing |
| Dashboard | `/dashboard` | Different dashboard per role (staff, citizen, field, NGO). Live counters, high-risk wards, work queues, resource utilisation. Officers: live "Field crews need attention" list ranked by urgency. Field workers: duty status, team, next tasks by due time |
| Live Risk Map | `/map` | Leaflet map of wards, risk colour per ward, drainage assets, live updates |
| Reports & Assets | `/incidents` | Server-side search, 4 filters, sortable columns, pagination. Drainage asset CRUD |
| Report incident | `/incidents/new` | Pick location on map, depth, photos, offline-safe submit, duplicate detection |
| Incident detail | `/incidents/:id` | Status timeline, verify / assess / transition, AI explanation, presence ("also viewing"), conflict dialog |
| AI Risk Analysis | `/risk` | Ward risk scores, SHAP explanation, model info, what-if simulator, re-score all wards |
| Resources & Allocation | `/resources` | Inventory CRUD, run the optimiser, see shortages, approve plans |
| NGO Coordination | `/ngo` | Register community needs, duplicate-aid detection, allocate stock |
| Workflows & Tasks | `/workflows` | Dispatch workflow runs, step status, retries, compensation, manual retry |
| Field Portal | `/field` | Crew tasks cached on the device (with crew phone numbers), accept / start / complete / report a problem, decline before accepting, on/off duty switch, overdue badge, GPS proof with feedback, works offline. Filter chips with counts (new, working, overdue, problem), search by ward / report code / title, sort by due time. Double taps never queue the same change twice. A toast announces each new assignment as it arrives |
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
