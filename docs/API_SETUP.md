# APIs, environment variables & deployment

## External APIs used

| API | Purpose | Key needed? | Notes |
|---|---|---|---|
| **Open-Meteo Forecast** `api.open-meteo.com/v1/forecast` | Past 24 h + next 24 h hourly rainfall per ward | **No** | Free for non-commercial use (~10k calls/day). The 30-min cache means about 20 wards × 48 calls a day at most. |
| **OpenStreetMap tiles** | Map background (Leaflet) | No | Attribution is shown on the map. |
| **Supabase** (Auth, Postgres, Realtime) | Database, login, live updates | Project keys (see SUPABASE_SETUP.md) | |

No paid API keys are required. The only secrets are the Supabase service key and the database URL.

### How the weather integration survives failures (A06)
`backend/app/services/weather.py`
1. **Fresh cache** (under 30 min): Postgres `weather_cache` plus memory.
2. **Live call**: 4 s timeout, up to 3 attempts with exponential backoff and jitter (only on timeouts, 5xx and 429), and a **pydantic schema validation** of the payload. Malformed data is not retried.
3. **Circuit breaker**: opens after 3 consecutive failures and skips upstream for 60 s, then lets one half-open trial call through.
4. **Stale cache** (under 24 h): flagged `degraded`.
5. **Climatology fallback** from `data/dhaka_monthly_climatology.csv`: a conservative estimate, flagged `degraded`.

Admins can simulate `timeout`, `error500` and `malformed` from **Admin → System health & chaos**.

## Our own REST API (FastAPI): `/docs` gives interactive Swagger

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/health` | public | liveness |
| GET | `/api/me` | any | current user + role |
| GET | `/api/weather/wards/{id}` | any | ward rainfall (with source/degraded flags) |
| GET | `/api/weather/status` | staff | breaker state, stats |
| POST | `/api/admin/chaos` | admin | fault-inject the weather API |
| POST | `/api/risk/incidents/{id}/assess` | officer, admin | AI assessment → `assessed` |
| POST | `/api/risk/wards/refresh` | officer, admin | re-score all 20 wards with live weather |
| POST | `/api/risk/simulate` | staff | what-if scoring |
| GET | `/api/risk/model` | staff | metrics + feature importance |
| POST | `/api/plans/optimize` | coordinators | OR-Tools plan (`Idempotency-Key` header supported) |
| GET | `/api/workflows/worker` | coordinators | worker heartbeat |
| POST | `/api/workflows/process-now` | coordinators | drain queue synchronously |
| POST | `/api/analytics/import` | admin, officer | CSV bulk import |
| GET | `/api/admin/health` | admin | DB latency, queue, model, breaker |

All calls need `Authorization: Bearer <supabase access token>`. Every user is rate-limited to 120 requests/min (sliding window, HTTP 429 with `Retry-After`).

Supabase RPCs that the browser calls directly (all check roles and versions server-side): `transition_incident`, `approve_plan`, `reject_plan`, `retry_workflow_run`, `update_task_status`, `allocate_to_need`, `nearby_incidents`, `ward_risk_summary`, `analytics_dashboard`.

## Environment variables

**backend/.env** (see `.env.example`)
```
SUPABASE_URL=https://<ref>.supabase.co
DATABASE_URL=postgresql://postgres.<ref>:<pw>@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres
SUPABASE_SERVICE_ROLE_KEY=...        # seed script only
CORS_ORIGINS=http://localhost:5173,https://<your-app>.vercel.app
WORKER_IN_PROCESS=true
```
**frontend/.env**
```
VITE_SUPABASE_URL=https://<ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon/publishable key>
VITE_API_URL=http://localhost:8000          # prod: https://<your-api>.onrender.com
```

## Deployment

### Backend → Render (free)
1. Push the repository to GitHub (public).
2. In Render, choose **New → Blueprint**, pick the repo, and Render reads `render.yaml`.
3. Set the env vars `SUPABASE_URL`, `DATABASE_URL` and `CORS_ORIGINS` (include your Vercel URL).
4. Deploy, then open `https://<service>.onrender.com/health`.
Alternatives: Railway or Fly.io using `backend/Dockerfile` (build context = repo root).

### Frontend → Vercel
1. **Add New Project**, import the repo, and set **Root Directory = `frontend`** (framework: Vite).
2. Add the three `VITE_*` variables and deploy.
3. Copy the Vercel URL into Supabase Auth URL settings and into Render `CORS_ORIGINS`.

### Judge demo sign-in (one click per profile)
Under the normal sign-in form, a **Demo accounts for judges** box lists seven demo people (citizen, two Drainage Officers for
Dhaka South / North, NGO coordinator, field worker, two admins). A judge clicks one and is signed in, no password (a
**judge access code** is asked once only if `DEMO_ACCESS_CODE` is set). This follows the rulebook (S03 "provide test access privately", checklist 05
"no credentials in public files"):

* The demo password stays on the server. The browser never sees it.
* The optional access code is checked on the server (constant time, 10 tries per minute per IP).
* The session then goes through the normal server-side staff-ID check, role rules, area rules and audit log.

Set these on **Render** (Environment) and redeploy:

| Variable | Value |
|---|---|
| `DEMO_MODE` | `true` (set `false` after judging; the picker then disappears) |
| `DEMO_PASSWORD` | the password you used with `scripts/seed_demo.py` |
| `DEMO_ACCESS_CODE` | *optional.* Empty = profiles open with one click, no code. Set a long random code to require it (send it privately, or use the private link below) |

The backend also needs the public anon key. It reads `VITE_SUPABASE_ANON_KEY` (already set for the build)
or `SUPABASE_ANON_KEY`. Open `/api/demo` to check: it returns `{"enabled": true}` when everything is set.
If the website is on Vercel, set `VITE_API_URL` there to the Render URL so the picker can reach the API.

**Private judge link:** put the code in the link you send privately, e.g.
`https://resiliomesh.onrender.com/login#code=<DEMO_ACCESS_CODE>`. Judges open it and just click an account:
the code is filled in, remembered, and removed from the address bar. The `#` part is never sent to any server.
Never put this link in the README, the repo or the video.


### Before submission
* Open the live URL in a private window and log in with every demo role.
* Call `/api/risk/wards/refresh` once so the map shows live risk.
* Make sure there is no `.env` in git: `git ls-files | grep .env` should show only `.env.example`.
