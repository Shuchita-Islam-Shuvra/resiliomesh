# ResilioMesh — 2-day execution plan

> Code already lekha shesh. Ei 2 din-er kaj: **setup → bujhe neya → nijer moto customise → deploy → test → video**. Judges live questioning korbe, tai prottek ta part nije bujhte hobe (rubric: "Technical Understanding").

---

## DAY 1: Setup, run, understand (≈ 12 h)

### Block 1 · 09:00–10:30 · Supabase
- [ ] Supabase project banao (Singapore region). DB password save koro.
- [ ] SQL Editor-e `001` → `005` → `seed.sql` serially run koro ([SUPABASE_SETUP.md](SUPABASE_SETUP.md)).
- [ ] Auth → Email confirm **OFF**.
- [ ] Project URL, anon key, service key, Session-pooler connection string copy koro.

### Block 2 · 10:30–12:00 · Local backend
- [ ] `backend/.env` fill koro (`.env.example` theke).
- [ ] `pip install -r requirements.txt` → `python -m app.ml.train` → `uvicorn app.main:app --reload`
- [ ] `http://localhost:8000/docs` open hocche kina dekho.
- [ ] `$env:DEMO_PASSWORD="..."` → `python ..\scripts\seed_demo.py`

### Block 3 · 12:00–13:00 · Local frontend
- [ ] `frontend/.env` → `npm install` → `npm run dev`
- [ ] Prottek role diye login koro (admin, officer, ngo, field1, citizen).

### 13:00–14:00 · Lunch

### Block 4 · 14:00–17:00 · Full flow nije haate koro (sobcheye important)
1. **citizen**: New report → map-e Shantinagar-er kache click → depth 55 → submit.
2. Same spot-e **citizen2** diye arekta report → "Duplicate detected" dekho.
3. **officer**: report open → Verify → Run AI assessment → SHAP chart + rules poro.
4. Plan resources → Run optimiser → Approve.
5. Workflows page → 5 step green hocche dekho.
6. **field1** (onno browser / incognito): task Accept → Start → Complete → incident auto-resolved, pump stock ferot.
7. **AI Risk Analysis** → "Re-score all wards" → map refresh.
8. **NGO**: Register need → Allocate.
9. **Analytics** → `data/bulk_import_sample.csv` import.

### Block 5 · 17:00–19:00 · Code reading (questioning-er prostuti)
Ei files porbe ar nijer bhashay notes likhbe:
- [ ] `supabase/migrations/004_rpc.sql` → `rm_reserve_resource` (**A05**: FOR UPDATE, idempotency, keno re-check)
- [ ] `backend/app/services/optimizer.py` (**A02**: variable, constraint, objective, infeasible → relaxed)
- [ ] `backend/app/ml/rules.py` + `model.py` (SHAP keno, rules keno)
- [ ] `backend/app/workflow/engine.py` (saga, compensation)
- [ ] `003_rls.sql` (RLS ki, keno DB-te)

### Block 6 · 19:00–21:00 · Customise and tests
- [ ] Login page-er demo password note, README-te nijer nam / link.
- [ ] `pytest` (57 pass) + `npm test` (22 pass) cholao.
- [ ] Optional: Docker thakle real-DB tests ([TESTING.md](TESTING.md)).
- [ ] GitHub-e **public** repo → push. (`.env` jeno push na hoy: `git status` dekho.)

---

## DAY 2: Deploy, edge cases, video, submit (≈ 12 h)

### Block 1 · 09:00–11:00 · Deploy
- [ ] Render → Blueprint → env vars → `/health` OK.
- [ ] Vercel → root `frontend` → 3 ta `VITE_*` env → deploy.
- [ ] Supabase Auth URL config + Render `CORS_ORIGINS`-e Vercel URL boshao.
- [ ] Live site-e sob role diye login test.

### Block 2 · 11:00–13:00 · Edge-case rehearsal (video-te dekhabe)
| Demo | Kivabe |
|---|---|
| **A05 last resource** | Age ngo diye "Family Dry-Food Kit" stock edit kore available = 5 koro. Tarpor 2 ta browser: **ngo** ar **admin** (admin je kono org-er stock allocate korte pare). Duita alada need-e ek shathe 5 ta kore allocate → ekjon success, arekjon "insufficient stock". Allocations ledger dekhao. |
| **A02 infeasible** | Critical incident select, reserve 0.9 → shortage + relaxed plan. Reserve 1.0 → "Conflicting constraints". |
| A07 failure | Admin → fault injection "fail at create_tasks" → Approve → Workflows: retrying → compensated, stock ferot → Retry → succeeded. |
| A06 API down | Admin → chaos "Simulate timeout" → Re-score → source = climatology/stale. Normal-e ferot. |
| A01 conflict | 2 officer ek asset edit → conflict dialog. |
| A04 offline | Field portal → DevTools → Offline → task update → Online → synced. |
| A03 security | Citizen → /admin → restricted. |

### 13:00–14:00 · Lunch

### Block 3 · 14:00–17:00 · YouTube video (8–10 min)
1. **0:00–1:00** Problem: Dhaka waterlogging, 3 ta problem, users.
2. **1:00–4:00** Main workflow (Day-1 Block-4 flow, fast).
3. **4:00–6:30** **A02** optimiser + infeasible, **A05** race demo + `rm_reserve_resource` code 20 sec.
4. **6:30–8:00** Edge cases: A07 failure → compensation, A06 chaos.
5. **8:00–9:00** Architecture diagram (README) + limitations (synthetic training data, free hosting).
6. Upload as **Unlisted**.

### Block 4 · 17:00–19:00 · Final checks
- [ ] README top table-e live URL, API URL, video link, track, **A02 + A05**.
- [ ] Private window-e 3 ta link khule check.
- [ ] Judges-der jonno demo password **privately** submission form-e dao (repo-te na).
- [ ] Render free sleep kore: submit-er age `/health` hit kore warm koro.

### Block 5 · 19:00–20:00 · Submit
| Field | Value |
|---|---|
| Project title | ResilioMesh |
| Track | World Problem Solver |
| Problem statement | Dhaka-r urban waterlogging: limited prediction, fragmented coordination, misallocated pumps/crews/relief. Users: citizens, city drainage officers, NGO coordinators, field workers. |
| Advanced challenges | **A02, A05** |
| Links | YouTube · GitHub · Live |

---

## Judges-er common questions: ready answer
- *"Last pump-e 2 jon request korle?"* → `FOR UPDATE` row lock. Second transaction wait kore, tarpor updated stock (0) dekhe `INSUFFICIENT_STOCK`. CHECK constraint backup hisebe ache. 25-thread test proof.
- *"Same request 2 bar asle?"* → idempotency key unique. Lock-er pore abar check kori, tai duplicate hoy na.
- *"Infeasible hole?"* → CP-SAT INFEASIBLE → kon incident-e kon resource koto kom seta report kori → relaxed plan dei, kintu human approval chara execute hoy na.
- *"AI keno trust korbo?"* → SHAP per-feature contribution + hard safety rules. Training data synthetic (limitation), pipeline real data-te retrain-ready.
- *"Redis keno na?"* → Postgres SKIP LOCKED queue: same ACID transaction, free tier-e ek service kom. Limitation: khub high throughput-e Redis lagbe.

