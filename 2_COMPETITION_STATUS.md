# 2. Competition status: what is fulfilled

Rulebook: Hack the Vibe 2026 (Code-ArenaX). Total 100 marks = **60 mandatory (M01 to M08)** + **40 advanced (2 challenges x 20)**.
Track: World Problem Solver. Declared challenges: **A02** and **A05**.

**How to read the Status column**
* **Built** = the code exists in the repo (checked by reading it).
* **Verified here** = I re-ran it on 2026-11-23 and it passed.
* **Needs check** = claimed in the docs, not re-run by me yet.
* **Not done** = missing.

## Verification done on 2026-11-23

| Check | Result |
|---|---|
| Frontend unit tests (`npm test`) | 22 passed |
| Frontend production build (`vite build`) | passes |
| Backend unit tests | **could not run here**: Python deps not installed (`psycopg_pool` missing). Run `pip install -r requirements.txt` first |
| Backend real-DB tests (21) | not run (needs Docker PostGIS or a staging Supabase) |
| Playwright e2e (10) | not run (needs seeded Supabase + backend running) |
| Live deployment | **no real URLs in the README** (placeholders only) |

## Mandatory requirements (60 marks)

| ID | Requirement | Marks | Status | Evidence |
|---|---|---|---|---|
| M01 | Complete functional system (3 modules, end-to-end workflow, meaningful features) | 12 | Built | Drainage intelligence, resource intelligence, autonomous ops. Workflow: report, verify, AI assess, optimise, approve, saga, field tasks, auto-resolve |
| M02 | Database, CRUD, persistence, relationships | 8 | Built | 17 tables, FKs, CHECKs, assets / resources / incidents / needs / users CRUD |
| M03 | Authentication and authorization | 8 | Built | Supabase Auth + JWT, 5 roles, RLS by role and organisation, route guards, forced logout when deactivated |
| M04 | Complex business logic | 10 | Built | 7 risk rules, state machines for incidents / tasks / plans, optimiser, duplicate-aid rules |
| M05 | Search, filter, sort, aggregation | 6 | Built | Incidents page (search, 4 filters, sort, pagination), analytics RPC |
| M06 | Validation, duplicates, failure recovery | 8 | Built | Client and DB validation, idempotency keys, duplicate-report detection, weather fallback, saga compensation, offline queue |
| M07 | Responsive UI and accessibility | 4 | Built | Mobile drawer, responsive grids, skip link, ARIA, focus rings, Esc closes modals |
| M08 | Live deployment and documentation | 4 | **Partly** | Docs and config are there. **Live URL is not confirmed**, README links are placeholders |

Risk to watch: M08 is only 4 marks, but a dead or missing live link also stops judges from verifying everything else (see "Incomplete, inaccessible or nonfunctional submission links" in the rulebook).

## Advanced challenges (40 marks): the 2 declared ones

Scoring per challenge: implementation 8, complex scenarios 6, reliability 4, technical explanation 2.

### A02: Intelligent Decisions and Optimization (20)

| Rubric part | Status | What exists |
|---|---|---|
| Implementation (8) | Built | XGBoost + SHAP + 7-rule engine; OR-Tools CP-SAT optimiser; what-if simulator |
| Tricky scenarios (6) | Built | Conflicting constraints are caught before solving (`INVALID_CONSTRAINTS` lists each one). Infeasible request returns `INFEASIBLE` with shortages, or a "relaxed" plan that needs human approval and cannot be run silently. Empty plans are refused |
| Reliability (4) | Needs check | `test_optimizer.py`, `test_risk_engine.py` (boundary tests 34.9 / 35 / 75) |
| Explanation (2) | You must prepare | Be ready to explain: why rules floor the ML score, how CP-SAT variables and objective work, what "relaxed" means |

### A05: Concurrency and Transaction Management (20)

| Rubric part | Status | What exists |
|---|---|---|
| Implementation (8) | Built | `rm_reserve_resource` with `SELECT ... FOR UPDATE`, idempotency key re-check after lock, unique-violation handling, `available >= 0` CHECK, idempotent release and approve, `allocate_to_need` atomic |
| Tricky scenarios (6) | Needs check | Test: 25 concurrent requests for the last unit means exactly 1 success and 24 `INSUFFICIENT_STOCK`. 10 identical requests give one allocation. Two coordinators race for the last kits |
| Reliability (4) | Built | SKIP LOCKED job claiming; workflow step and marker committed atomically |
| Explanation (2) | You must prepare | Explain row lock vs optimistic lock, why idempotency key is re-checked after the lock |

Evidence: `test_db_integration.py::test_many_users_race_for_the_final_unit`, `test_db_flow.py::test_two_coordinators_race_for_last_relief_kits`.

## Extra challenges built (do not add marks)

Only the two declared challenges are scored. These exist as bonus and as a safety net:

| ID | Built | Notes |
|---|---|---|
| A01 Real-time sync | Yes | Realtime on 11 tables, presence, optimistic locking, conflict dialog |
| A03 Security | Yes | RLS, escalation trigger, append-only audit |
| A04 Offline-first | Yes | IndexedDB outbox, conflict policy |
| A06 External API fault tolerance | Yes | Timeout, retry, circuit breaker, fallback |
| A07 Multi-step workflow | Yes | 5-step saga with compensation |
| A08 Data analytics | Yes | 125k-row dirty CSV import in about 4.5 s |

Rule 05 in the rulebook: one piece of evidence must not be counted twice. Keep A02 and A05 demos separate (for example, do not use the saga as proof for both).

## Submission items (S01 to S03)

| Item | Status |
|---|---|
| S01 YouTube video | **Not done** |
| S02 Public GitHub repo | Repo exists (`origin` set). Check that it is **public** and pushed |
| S03 Live URL | **Not confirmed** |
| Track named in README | Done |
| Two challenges named in README | Done |
| No secrets in repo | `.env` is git-ignored. Re-check before the final push |

## Uncommitted work (as of now)

Local changes not yet committed: teal/brand colour touch-ups (icon, manifest, map, charts), page-chunk preloading in `App.jsx`, and a `Suspense` boundary inside `AppShell.jsx`. Also these 3 new `.md` files.
