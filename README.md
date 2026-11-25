# ResilioMesh

**Autonomous urban flood resilience & humanitarian resource intelligence for Dhaka.**

**🌐 Live demo: [https://resiliomesh.vercel.app](https://resiliomesh.vercel.app)**

*Predict risk · Optimise resources · Coordinate response.*

| Field | Value |
|---|---|
| Competition | Hack the Vibe 2026 (Code-ArenaX) |
| Track | **World Problem Solver** |
| Declared advanced challenges | **A02 — Intelligent Decisions & Optimization** and **A05 — Concurrency & Transaction Management** |
| Also implemented (not declared) | A01, A03, A04, A06, A07, A08 |
| SDGs | 6, 11, 13, 17 |
| Live app | **[resiliomesh.vercel.app](https://resiliomesh.vercel.app)** |
| API | `https://<your-api>.onrender.com/docs` |
| Video | `https://youtu.be/<id>` |

## 1. Problem

Every monsoon, Dhaka's low-lying wards (Shantinagar, Malibagh, Mugda, Jatrabari, Kawran Bazar, Mirpur…) waterlog within hours of heavy rain. Three things go wrong:

1. **Limited prediction.** Nobody can tell which drainage zone will fail next, so crews react late.
2. **Fragmented coordination.** City drainage teams, NGOs and citizens report through phone calls and social media. Reports get duplicated, and some get lost.
3. **Resource misallocation.** A few dewatering pumps, crews and relief kits go to whoever calls loudest instead of to the highest-risk places, and two NGOs sometimes serve the same family twice.

**Users:** citizens, city water resilience officers, NGO coordinators, field workers and system administrators.

## 2. Solution: three connected modules

| Module | What it does |
|---|---|
| **1. Predictive drainage intelligence** | Live Open-Meteo rainfall, drainage asset condition, 10-year history and nearby report clusters feed an **XGBoost** model, overlaid with a deterministic **rule engine**. Every score is explained with **SHAP** contributions. Ward-level risk map. |
| **2. Humanitarian resource intelligence** | Organisation-scoped inventories, community needs with **duplicate-aid detection**, and an **OR-Tools CP-SAT** optimiser that allocates pumps, crews and relief under hard constraints. It reports infeasibility and shortages. |
| **3. Autonomous operations** | Coordinator approval starts a 5-step **dispatch saga**: reserve stock atomically, create and auto-assign tasks, notify, activate. It retries with backoff and compensates on failure. Includes an offline-first field portal, live updates and analytics. |

### End-to-end workflow
```
Citizen report ─► Officer verifies ─► AI risk assessment (weather + XGBoost + rules)
      │ (geo-duplicate auto-merge)                     │
      ▼                                                ▼
 Live map / dashboards ◄── realtime ── OR-Tools plan ─► Coordinator approves (RPC, idempotent)
                                                       │
                     Workflow worker: validate → reserve (row-locked) → tasks → notify → activate
                                                       │                     ▲ retry / compensate
                                                       ▼
                         Field worker (offline-capable) completes tasks ─► incident resolved,
                                                       reusable equipment auto-returned to stock
```

## 3. Architecture

```
React 19 + Vite + Tailwind (Vercel, PWA, IndexedDB)
   │  supabase-js (RLS-protected CRUD, RPCs, Realtime, Auth)          │ fetch + JWT
   ▼                                                                   ▼
Supabase: Postgres + PostGIS + RLS + Realtime + Auth      FastAPI (Render) ── Open-Meteo API
   • state machines & business rules in triggers            • XGBoost risk model + rule engine
   • atomic RPCs (FOR UPDATE, idempotency keys)              • OR-Tools CP-SAT optimiser
   • append-only audit log (triggers)                        • workflow worker (SKIP LOCKED queue)
   • analytics aggregates over indexed tables                • CSV bulk import (COPY, dedup)
```

**Design decisions** (and why)
* **Rules live in the database.** Business invariants such as the state machine, stock limits, role checks, duplicate detection and audit sit in Postgres triggers and RPCs. Every client path (browser, backend, raw REST) gets the same enforcement, which a UI check alone cannot guarantee.
* **Postgres is the job queue** (`FOR UPDATE SKIP LOCKED`) instead of Redis/Celery. The queue gets the same ACID guarantees as the data, there is one less service to host on free tiers, and running several workers is still safe. Redis would add value only at much higher throughput.
* **The backend uses a trusted DB connection.** It records the acting user with `set_config('rm.actor')`, so audit attribution survives.
* **ML score plus rule floors.** The ML model is calibrated but statistical. Rules encode policy that must never be violated (for example, 45 cm of standing water is always HIGH).

## 4. Requirement coverage

See **[docs/REQUIREMENTS_MATRIX.md](docs/REQUIREMENTS_MATRIX.md)** for a line-by-line map of M01–M08 and A01–A08 to code and tests.

## 5. Running locally

```bash
# 1. Database: follow docs/SUPABASE_SETUP.md (run 5 migrations + seed.sql, create demo users)
# 2. Backend
cd backend
python -m venv .venv && .venv\Scripts\activate      # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
copy .env.example .env                             # fill in SUPABASE_URL, DATABASE_URL
python -m app.ml.train                             # trains model (~5 s)
uvicorn app.main:app --reload --port 8000          # http://localhost:8000/docs
# 3. Frontend
cd ../frontend
npm install
copy .env.example .env                             # VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_API_URL
npm run dev                                        # http://localhost:5173
```
For more detail see [docs/API_SETUP.md](docs/API_SETUP.md) (environment variables, deployment) and [docs/TESTING.md](docs/TESTING.md).

## 6. Tests

| Suite | Count | Command |
|---|---|---|
| Backend unit (AI, optimiser, weather fault tolerance, workflow saga, import, API auth) | 57 | `cd backend && pytest` |
| Backend real-DB (25-way race for the last unit, RLS attacks, full dispatch, failure compensation) | 21 | `TEST_DATABASE_URL=… pytest tests/test_db_*.py` |
| Frontend unit (offline sync, conflict policy, validation) | 22 | `cd frontend && npm test` |
| E2E Playwright (auth, roles, lifecycle, concurrent edit, offline, mobile) | 10 | `cd frontend && npx playwright test` |

## 7. Data & limitations (honest notes)

* **Training data is synthetic.** No open, labelled, ward-level waterlogging dataset exists for Dhaka, so `app/ml/synth.py` simulates one from Dhaka monthly climatology and a runoff-excess formulation (hold-out R² ≈ 0.90 against that simulator). The pipeline is real: replace the CSV with observed incidents and run `python -m app.ml.train`.
* **Ward attributes are estimates.** Ward centroids are approximate, and hydrological attributes (capacity, imperviousness, elevation) are modelled for the demo. Organisation names are fictional.
* **Free-tier hosting sleeps.** The Render free tier sleeps after inactivity, so the first request can take about 50 s. The UI has a "Process queue now" fallback for the worker.
* **Weather resolution.** Open-Meteo is grid-level (about 1–11 km), not street-level.

## 8. Repository layout
```
supabase/migrations/   001 schema · 002 triggers/guards · 003 RLS · 004 RPCs · 005 realtime
supabase/seed.sql      wards, assets, organisations, inventory, ~23k historical events
backend/app/           FastAPI: ml/ services/ workflow/ api/ core/
backend/tests/         pytest (unit + real-DB)
frontend/src/          React pages, offline/, hooks/, lib/
frontend/tests/        vitest unit + Playwright e2e
scripts/               generate_data.py · seed_demo.py · demo_dispatch.py (real tasks for the field crews) · test_db/ (Supabase stub for CI)
data/                  training CSV, climatology, 125k-row dirty bulk-import sample
docs/                  setup, testing, requirement matrix, 2-day plan
```
