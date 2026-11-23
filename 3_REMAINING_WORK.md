# 3. What is missing and what to do next

Use this file to decide the next steps. Ordered by how much it affects the score.

## A. Must do (submission fails or loses marks without these)

| # | Task | Why | Rulebook |
|---|---|---|---|
| 1 | **Deploy the app**: Supabase (migrations 001 to 005 + seed), Render backend, Vercel frontend. Set CORS, Auth redirect URLs | README only has placeholder links. No live link means judges cannot verify anything | S03, M08 |
| 2 | **Make the GitHub repo public** and push everything. Check no `.env`, keys or passwords are in history | Repo must be public and contain no secrets | S02 |
| 3 | **Record the YouTube video** (public or unlisted). Show: problem, main workflow, A02 demo, A05 demo, one edge case | Required submission item | S01 |
| 4 | **Fill in README**: real live URL, API URL, video link | Placeholders are still there | S01 to S03 |
| 5 | **Prepare private test logins** for judges (one per role) and send them privately, never in the repo or video | Login is required to test | S03 |
| 6 | **Run the full test suites** and note the results: backend unit, backend real-DB, Playwright. Only the frontend unit tests (22) were re-run so far | Docs claim 57 + 21 + 22 + 10 passing, but the backend and e2e are not re-verified | M-all, A02, A05 |
| 7 | **Commit the uncommitted changes** (see file 2) after checking the app still works | Published build must match the repo | S03 |

## B. Should do (protects the 40 advanced marks)

| # | Task | Why |
|---|---|---|
| 8 | Rehearse the **A05 demo**: two browsers, two NGO coordinators allocate the last stock at the same time | The hidden test is "multiple users request the final available resource" |
| 9 | Rehearse the **A02 demo**: reserve 0.95 plus a critical incident (shortage + relaxed plan), then reserve 1 (conflict error) | The hidden test is conflicting constraints and an infeasible request |
| 10 | Be able to **explain** `rm_reserve_resource`, the CP-SAT model, the rule floor, and the saga without reading the code | 2 marks per challenge for technical understanding, and judges ask live questions |
| 11 | Do a **cold-start check** of the live site. Render free tier sleeps about 50 s | First request may time out in front of judges. Open the site a minute before the demo |
| 12 | Test every role on the **live** site, not just locally | Some bugs only show with deployed CORS or auth settings |

## C. Known gaps and honest limitations

| Gap | Impact | Possible fix |
|---|---|---|
| Training data is **synthetic** (no open labelled ward-level data for Dhaka) | Judges may ask how the model was validated. R-squared about 0.90 is against the simulator, not against real events | Say so openly (already in README). If time allows, calibrate with any real rainfall / flood records |
| Ward attributes (capacity, imperviousness, elevation) are **estimates** | Risk numbers are demo-grade | Same as above, state it clearly |
| "Notify teams" step is **in-app realtime only** | No SMS, email or push outside the app | Fine for the competition. Mention it as a limitation |
| Weather is **grid-level** (1 to 11 km) | Not street-level | Mention as a limitation |
| Free-tier hosting **sleeps** | Slow first request | "Process queue now" fallback exists. Warm the service before demo |
| UI is English only | Local users may prefer Bangla | Optional |
| Page load can feel slow | Backend / Supabase RPCs and big chunks (charts 457 kB, map 155 kB) | A first fix (preload + inner Suspense) is done. Measure on the live site before doing more |

## D. Nice to have (only after A and B)

* Short architecture diagram image in the README.
* Screenshots / GIFs of the main flow in the README.
* Seed script instructions for judges who want to run it themselves.
* UI polish (sidebar look was discussed, original teal/navy style kept).

## Suggested order for the next session

1. Install backend deps and run backend tests (A6).
2. Deploy (A1), then test all roles on the live site (B12).
3. Update README links (A4), commit and push (A2, A7).
4. Rehearse A02 and A05 demos (B8, B9, B10), then record the video (A3).
5. Final check of all 3 links and the checklist in file 2.
