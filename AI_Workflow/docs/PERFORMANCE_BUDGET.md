# PERFORMANCE BUDGET

Release-gating latency/size budgets (Constitution §12). Measured at p95 under nominal load (load-test profiles in Doc 05 §4) unless stated; verified by k6 gates in CI (P9 onward) and APM in production.

## API (server-side, per endpoint class)

| Class                                                     | p95    | p99     | Notes                                            |
| --------------------------------------------------------- | ------ | ------- | ------------------------------------------------ |
| Auth (login incl. hash verify)                            | 500 ms | 800 ms  | includes MFA verify                              |
| Token refresh                                             | 150 ms | 300 ms  | hot path                                         |
| Read (single doc)                                         | 200 ms | 400 ms  |                                                  |
| Read (list, paginated)                                    | 300 ms | 600 ms  | max page 100                                     |
| Patient search / MPI                                      | 300 ms | 600 ms  | the flagship budget                              |
| Write (create/update)                                     | 500 ms | 900 ms  | incl. audit + outbox in txn                      |
| Billing finalize / payment capture                        | 800 ms | 1500 ms | excl. external gateway time (tracked separately) |
| Dashboard endpoints                                       | 400 ms | 800 ms  | read models only                                 |
| Report generation                                         | async  | —       | enqueue < 200 ms; user notified on completion    |
| Tenant resolution overhead (middleware chain pre-handler) | 15 ms  | 40 ms   | registry cached; cache miss ≤ 80 ms              |

## Web (Core Web Vitals, mid-range hardware, staging data ~50k patients)

| Surface                               | Budget                                     |
| ------------------------------------- | ------------------------------------------ |
| First load (login → dashboard, cold)  | LCP < 2.5 s, TTI < 3.5 s                   |
| Route change (warm, code-split chunk) | < 500 ms to interactive                    |
| Patient 360° chart open               | < 1.5 s to usable timeline                 |
| Queue/bed board realtime update       | < 2 s from event to pixel                  |
| Initial JS (per app, gzipped)         | < 350 KB shell + lazy chunks < 200 KB each |

## Mobile (mid-range Android, 4G)

| Flow                        | Budget                                               |
| --------------------------- | ---------------------------------------------------- |
| Cold start → home           | < 3 s                                                |
| Book appointment end-to-end | < 6 taps, each screen < 1 s                          |
| Offline vitals/MAR entry    | 0 ms network dependency; sync < 30 s after reconnect |
| Report/PDF open             | < 2 s (cached thereafter)                            |

## Background & Data

| Item                                    | Budget                                                |
| --------------------------------------- | ----------------------------------------------------- |
| Notification enqueue → provider handoff | < 30 s (reminder class), < 5 s (panic/critical class) |
| Outbox event → consumer start           | < 10 s p95                                            |
| Read-model lag (dashboards)             | < 60 s                                                |
| Fleet migration (per tenant DB)         | < 5 min typical; > 15 min requires maintenance window |
| Per-tenant backup restore (RTO drill)   | < 30 min (NFR)                                        |

## Enforcement

- New endpoint ⇒ assign a class above (or add a row with justification).
- CI perf gates fail the release on >10% regression against baseline.
- Production burn-rate alerts on these as SLOs (OBSERVABILITY_GUIDE).
- Budgets may only be relaxed via PR to this file + owner approval — never by silently accepting a slower number.
