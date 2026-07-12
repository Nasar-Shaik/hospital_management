# PROJECT_MEMORY — Long-Term Memory for AI Agents

**Read this first in every session.** This file preserves institutional knowledge that conversation history loses: why decisions were made, what was deliberately postponed, known debt, and lessons learned. **Append-only in spirit** — never delete entries; strike through with a dated note if superseded.

**Update rule:** every session that makes a decision, discovers a surprise, postpones something, or takes on debt appends an entry before ending. (Constitution §19, Guidelines §1.)

---

## 1. Current Status & Next Priorities

- **Status (2026-07-12, baseline reset):** **Sprint 0 / Phase 0 complete and runtime-verified.** History was intentionally reset to a **single foundation commit** (`chore(repo): initialize Medicore HMS platform foundation`); `AI_Workflow/` now lives **inside** the `medicore-hms/` repo — **one repository is the sole source of truth**. Earlier Sprint-0 commit history is discarded and must never be recreated. All gates green on the baseline (typecheck 14/14, lint 14/14, 9 tests, boundaries 0 violations) and all 8 containers healthy (`/ready` → mongo up, redis up; workers heartbeat processing). No business modules, no auth — by design.
- **Phase 1A (Tenancy Core) — DONE (2026-07-12).** Master DB + tenant registry, Connection Manager (LRU pool, `useDb` co-location, `dbUri` dedicated-cluster override), ALS request context, host→tenant resolution middleware (subdomain + custom domain, status gate), `tenantScopePlugin` (defense in depth), per-tenant migration runner + first 4 migrations, provisioning service + CLI. **17-test tenant-isolation suite passes and is release-gating in CI** (real MongoDB, fails-never-skips).
- **Next priorities:** ① **Phase 1B — Authentication** (ADR-0009: JWT access + rotating refresh with reuse detection, MFA; `users`/`credentials`/`sessions` in the tenant DB; JWT `tenantId` claim must match the host-resolved tenant → HMS-TEN-003). ② Phase 1C — RBAC engine + permission catalog seeding (ADR-0010) + the RBAC matrix test suite. ③ OpenAPI baseline (wire zod-to-openapi with the first business routes).
- Detailed status: `PlanofActionforHMS/00-PROGRESS-TRACKER.md` (single source of truth for build state).

## 2. Why Major Decisions Were Made

| Decision                                                                              | Why (short)                                                                                                                                                                                                                                                                         | Record                |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Master DB + database-per-tenant (not shared collections)                              | Owner decision: physical isolation, per-tenant backup/restore/residency, clean scale-out by moving a DB; simpler compliance story for hospitals                                                                                                                                     | ADR-0005, ruling N8   |
| One codebase / 25 org types via flags+editions                                        | Fork-per-customer is how HIS vendors die; packaging is data (plans), not code                                                                                                                                                                                                       | Doc 07, ruling N6     |
| Modular monolith first, not microservices                                             | Team size and speed; boundaries + outbox give an extraction path without upfront distributed-systems tax                                                                                                                                                                            | ADR-0002, Doc 04 §2.4 |
| MongoDB (not PostgreSQL)                                                              | Document shapes fit clinical records; per-tenant DB model trivial; Atlas ops maturity; team stack                                                                                                                                                                                   | ADR-0001              |
| ~~React 19 + Vite SPA (not Next.js)~~ **Superseded 2026-07-12**                       | Original premise ("all surfaces behind login") invalidated by expanded platform scope                                                                                                                                                                                               | ~~ADR-0003~~          |
| **Next.js (App Router) + React 19 for all web frontends; Express stays the only API** | Platform scope now includes public hospital websites, marketing pages, SEO booking, white-label custom domains, and future ERPs — one framework covers public SSR/ISR + dashboards; middleware gives per-host white-label; Next.js is presentation-tier only (no business logic/DB) | ADR-0012, ruling N9   |
| Event sourcing only for ledger/audit; snapshots for clinical docs                     | Medico-legal norm is "signed document as seen"; accounting is inherently an event log; full ES elsewhere is unjustified complexity                                                                                                                                                  | Doc 03 §9             |
| Editions enforce limits at creation-time APIs (402) with 80% soft warning             | Hard cutoffs mid-workflow would endanger care; warnings + blocks at creation are safe and sellable                                                                                                                                                                                  | Doc 07                |
| Specialty clinics via EMR templates + flags (not per-specialty modules)               | Dental/eye/ENT are charting variations, not different systems; dialysis/physio are true modules because they have distinct workflows/resources                                                                                                                                      | Ruling N5             |

## 3. Architectural Assumptions (validate before relying on)

- Tenant count ~50–500 in first years; master registry fits in Redis cache comfortably.
- Largest single hospital ≈ 1,000 beds → one replica set per tenant DB suffices for years; within-DB sharding is a documented escape hatch, not a plan.
- Connection Manager LRU cap ~200 open tenant connections per API pod is safe (validate under load in P9).
- India-first go-to-market (GST, ABDM, NHCX, NABH weighting); architecture must not hardcode India (tax/ID/compliance are per-tenant config).
- AI features are advisory-only in all jurisdictions we enter; no autonomous clinical action is on any roadmap.

## 4. Deliberately Postponed (do NOT resurrect without checking here)

| Item                                                         | Why postponed                                                                  | Revisit when                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------ |
| Full PACS (beyond DICOM store + viewer)                      | Build-vs-buy favors integrating Orthanc/cloud PACS                             | Enterprise imaging deals demand it               |
| Full double-entry accounting depth (budgeting, cost centers) | Tally/Zoho connectors cover the gap; GL core only                              | Multiple customers reject connectors             |
| GraphQL gateway                                              | REST + typed client sufficient; GraphQL adds authz complexity across tenants   | Public-API partners demand it                    |
| Microservice extraction                                      | No scale trigger yet                                                           | A module's queue depth/team contention proves it |
| Multi-region active-active                                   | Region-pinned single-primary per tenant is enough                              | First multi-region enterprise contract           |
| Offline-first web (PWA)                                      | Mobile apps carry offline duty; web assumes connectivity                       | Field feedback contradicts                       |
| Plugin runtime (executable third-party code)                 | Config-first extensibility chosen instead — see `docs/PLATFORM_STRATEGY.md` §3 | Marketplace strategy matures                     |

## 5. Known Technical Debt

_(Format: what · where · why accepted · interest being paid · suggested payoff trigger)_

- **Dev compose uses non-default host ports (mongo 27018, redis 6380)** · `infra/docker/docker-compose.yml` + `.env.example` files · another local project already binds 27017/6379 on the dev machine · contributors must not "fix" ports back to defaults · payoff: none needed — container-internal ports are standard; only host mappings differ.
- **`pnpm deploy --legacy` flag in api/workers Dockerfiles** · pnpm 10 deploy behavior · simplest working monorepo prod-bundle today · revisit when pnpm stabilizes non-legacy deploy for workspaces.
- **Sprint 0 skipped OpenAPI baseline and RN app scaffolds** · deliberate: OpenAPI is meaningless with zero business routes (P1), Expo apps are P5 · add both at their phases.

## 6. Future Ideas (parking lot, unranked)

Kiosk self-check-in · bedside patient tablet app · RTLS asset tracking · WhatsApp-first booking flows · denial-prediction model · FHIR bulk-export for research · marketplace add-on packs (Doc 07 §4 extensions) · voice-first nursing documentation.

## 7. Lessons Learned

- (2026-07-12) Writing editions _after_ modules exposed missing modules (dialysis, physio, ED triage…). Lesson: **map packaging → capabilities early**; the sales lens finds architecture gaps that the engineering lens misses.
- (2026-07-12) A mid-review architecture pivot (shared-collections → DB-per-tenant) touched 7 documents. Lesson: keep tenancy assumptions centralized (Doc 03 §1 + ADR) and referenced, not restated, elsewhere — restatements are what go stale.
- (2026-07-12) ADR-0003 (Vite SPA) was correct for its stated scope and superseded within a day when the scope statement changed (public/SEO/white-label surfaces became first-class). Lesson: **an ADR is only as durable as its Context section** — write the scope assumptions explicitly so it's obvious when they break; the supersession process worked exactly as designed.

## 8. Common Mistakes to Avoid (grows with experience)

- Using `suppliers`/`equipment` as collection names (rulings N1/N2 — they're aliases/views of `vendors`/`assets`).
- Putting business logic, DB access, or business API routes inside Next.js (`app/api/*`) — Next.js is presentation-only; Express is the only API (ADR-0012, ruling N9).
- Scaffolding new frontend features with Vite — Vite survives only as Vitest + `packages/ui` playground tooling.
- Putting per-hospital data in the master DB or vice versa — check Doc 03 §2 placement table every time.
- **Omitting `directConnection=true` from a Mongo URI in dev.** The dev replica set advertises its member as `localhost:27017`, so the driver's topology discovery redirects a host-side connection to whatever else listens on port 27017 (on this machine: an unrelated `school_mongodb`). Symptom: `getaddrinfo ENOTFOUND mongodb`. Transactions still work with a direct connection to the RS primary.
- **Stamping fields in Mongoose `pre("save")`.** Schema validation runs _before_ save hooks, so a `required` field stamped there fails validation. Stamp in `pre("validate")` (this is why `tenantScopePlugin` does).
- Aggregating dashboards from OLTP collections "temporarily."
- Confusing the hospital's own helpdesk (`helpdeskTickets`, tenant DB) with SaaS support (`supportTickets`, master DB).
- Treating `00-PROGRESS-TRACKER.md`/this file as optional paperwork — they are the only memory the next agent has.

## 9. Links

- Authority chain: `PROJECT_CONSTITUTION.md` → rulings (Doc 10) → ADRs (`docs/adr/`) → standards (Doc 09) → guidelines (`AI_DEVELOPMENT_GUIDELINES.md`)
- Build state: `PlanofActionforHMS/00-PROGRESS-TRACKER.md`
- Vocabulary: `DOMAIN_GLOSSARY.md` · Behavior: `docs/STATE_MACHINE_CATALOG.md`, `docs/BUSINESS_WORKFLOWS.md`, `docs/EVENT_CATALOG.md` · Ops: `docs/DISASTER_RECOVERY_RUNBOOK.md`, `docs/OBSERVABILITY_GUIDE.md`

## 9b. Baseline Reset (2026-07-12) — RESOLVED, do not re-litigate

- Git history was **intentionally reset**. The nine Sprint-0 commits (`chore(repo)`, `chore(config)`, `chore(quality)`, `feat(packages)`, `feat(api)`, `feat(workers)`, `feat(web,admin)`, `chore(docker)`, `ci(github)`) **no longer exist and must never be recreated** — their functionality is fully present in the single foundation commit. The prior session's pending fixes (utils sleep typing, Express `traceId` augmentation, BullMQ connection options, compose port remap, pnpm `onlyBuiltDependencies`) are all **already in the baseline** — verified.
- Repo layout changed: **`AI_Workflow/` moved inside `medicore-hms/`**. One repository, one source of truth. Any doc that references a sibling `../AI_Workflow` path is stale — fix it in place.
- Runtime verification (blocked previously by a tooling outage) is now **complete**: all 8 containers healthy; API `/ready` reports mongo `up` + redis `up`; workers report `queueActive: true` with a live heartbeat timestamp.

## 10. Open Questions (owner answers pending)

- Pricing values for Doc 07 placeholders (`PLAN_*`).
- Primary cloud + regions for launch (affects Terraform in P0/P9).
- Payment gateway priority order (Razorpay first?).
- Company legal entity name for DPA/BAA templates.
