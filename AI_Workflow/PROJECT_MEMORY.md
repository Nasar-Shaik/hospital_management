# PROJECT_MEMORY — Long-Term Memory for AI Agents

**Read this first in every session.** This file preserves institutional knowledge that conversation history loses: why decisions were made, what was deliberately postponed, known debt, and lessons learned. **Append-only in spirit** — never delete entries; strike through with a dated note if superseded.

**Update rule:** every session that makes a decision, discovers a surprise, postpones something, or takes on debt appends an entry before ending. (Constitution §19, Guidelines §1.)

---

## 1. Current Status & Next Priorities

- **Status (2026-07-12, later session):** **Sprint 0 / Phase 0 complete.** Code lives in `medicore-hms/` (sibling of `AI_Workflow/`), 9 conventional commits, all gates green (typecheck 14/14, lint, tests, build incl. Next standalone, dependency-cruiser boundaries). No business modules, no auth — by design.
- **Next priorities:** ① Phase 1 starting with master DB + tenant provisioning + Connection Manager **with the tenant-isolation test suite built alongside it** — everything inherits its correctness. ② Auth/RBAC. ③ OpenAPI generation baseline (deferred from P0; wire zod-to-openapi with the first business routes).
- Detailed status: `PlanofActionforHMS/00-PROGRESS-TRACKER.md` (single source of truth for build state).

## 2. Why Major Decisions Were Made

| Decision | Why (short) | Record |
|----------|-------------|--------|
| Master DB + database-per-tenant (not shared collections) | Owner decision: physical isolation, per-tenant backup/restore/residency, clean scale-out by moving a DB; simpler compliance story for hospitals | ADR-0005, ruling N8 |
| One codebase / 25 org types via flags+editions | Fork-per-customer is how HIS vendors die; packaging is data (plans), not code | Doc 07, ruling N6 |
| Modular monolith first, not microservices | Team size and speed; boundaries + outbox give an extraction path without upfront distributed-systems tax | ADR-0002, Doc 04 §2.4 |
| MongoDB (not PostgreSQL) | Document shapes fit clinical records; per-tenant DB model trivial; Atlas ops maturity; team stack | ADR-0001 |
| ~~React 19 + Vite SPA (not Next.js)~~ **Superseded 2026-07-12** | Original premise ("all surfaces behind login") invalidated by expanded platform scope | ~~ADR-0003~~ |
| **Next.js (App Router) + React 19 for all web frontends; Express stays the only API** | Platform scope now includes public hospital websites, marketing pages, SEO booking, white-label custom domains, and future ERPs — one framework covers public SSR/ISR + dashboards; middleware gives per-host white-label; Next.js is presentation-tier only (no business logic/DB) | ADR-0012, ruling N9 |
| Event sourcing only for ledger/audit; snapshots for clinical docs | Medico-legal norm is "signed document as seen"; accounting is inherently an event log; full ES elsewhere is unjustified complexity | Doc 03 §9 |
| Editions enforce limits at creation-time APIs (402) with 80% soft warning | Hard cutoffs mid-workflow would endanger care; warnings + blocks at creation are safe and sellable | Doc 07 |
| Specialty clinics via EMR templates + flags (not per-specialty modules) | Dental/eye/ENT are charting variations, not different systems; dialysis/physio are true modules because they have distinct workflows/resources | Ruling N5 |

## 3. Architectural Assumptions (validate before relying on)

- Tenant count ~50–500 in first years; master registry fits in Redis cache comfortably.
- Largest single hospital ≈ 1,000 beds → one replica set per tenant DB suffices for years; within-DB sharding is a documented escape hatch, not a plan.
- Connection Manager LRU cap ~200 open tenant connections per API pod is safe (validate under load in P9).
- India-first go-to-market (GST, ABDM, NHCX, NABH weighting); architecture must not hardcode India (tax/ID/compliance are per-tenant config).
- AI features are advisory-only in all jurisdictions we enter; no autonomous clinical action is on any roadmap.

## 4. Deliberately Postponed (do NOT resurrect without checking here)

| Item | Why postponed | Revisit when |
|------|---------------|--------------|
| Full PACS (beyond DICOM store + viewer) | Build-vs-buy favors integrating Orthanc/cloud PACS | Enterprise imaging deals demand it |
| Full double-entry accounting depth (budgeting, cost centers) | Tally/Zoho connectors cover the gap; GL core only | Multiple customers reject connectors |
| GraphQL gateway | REST + typed client sufficient; GraphQL adds authz complexity across tenants | Public-API partners demand it |
| Microservice extraction | No scale trigger yet | A module's queue depth/team contention proves it |
| Multi-region active-active | Region-pinned single-primary per tenant is enough | First multi-region enterprise contract |
| Offline-first web (PWA) | Mobile apps carry offline duty; web assumes connectivity | Field feedback contradicts |
| Plugin runtime (executable third-party code) | Config-first extensibility chosen instead — see `docs/PLATFORM_STRATEGY.md` §3 | Marketplace strategy matures |

## 5. Known Technical Debt

*(Format: what · where · why accepted · interest being paid · suggested payoff trigger)*

- **Dev compose uses non-default host ports (mongo 27018, redis 6380)** · `infra/docker/docker-compose.yml` + `.env.example` files · another local project already binds 27017/6379 on the dev machine · contributors must not "fix" ports back to defaults · payoff: none needed — container-internal ports are standard; only host mappings differ.
- **`pnpm deploy --legacy` flag in api/workers Dockerfiles** · pnpm 10 deploy behavior · simplest working monorepo prod-bundle today · revisit when pnpm stabilizes non-legacy deploy for workspaces.
- **Sprint 0 skipped OpenAPI baseline and RN app scaffolds** · deliberate: OpenAPI is meaningless with zero business routes (P1), Expo apps are P5 · add both at their phases.

## 6. Future Ideas (parking lot, unranked)

Kiosk self-check-in · bedside patient tablet app · RTLS asset tracking · WhatsApp-first booking flows · denial-prediction model · FHIR bulk-export for research · marketplace add-on packs (Doc 07 §4 extensions) · voice-first nursing documentation.

## 7. Lessons Learned

- (2026-07-12) Writing editions *after* modules exposed missing modules (dialysis, physio, ED triage…). Lesson: **map packaging → capabilities early**; the sales lens finds architecture gaps that the engineering lens misses.
- (2026-07-12) A mid-review architecture pivot (shared-collections → DB-per-tenant) touched 7 documents. Lesson: keep tenancy assumptions centralized (Doc 03 §1 + ADR) and referenced, not restated, elsewhere — restatements are what go stale.
- (2026-07-12) ADR-0003 (Vite SPA) was correct for its stated scope and superseded within a day when the scope statement changed (public/SEO/white-label surfaces became first-class). Lesson: **an ADR is only as durable as its Context section** — write the scope assumptions explicitly so it's obvious when they break; the supersession process worked exactly as designed.

## 8. Common Mistakes to Avoid (grows with experience)

- Using `suppliers`/`equipment` as collection names (rulings N1/N2 — they're aliases/views of `vendors`/`assets`).
- Putting business logic, DB access, or business API routes inside Next.js (`app/api/*`) — Next.js is presentation-only; Express is the only API (ADR-0012, ruling N9).
- Scaffolding new frontend features with Vite — Vite survives only as Vitest + `packages/ui` playground tooling.
- Putting per-hospital data in the master DB or vice versa — check Doc 03 §2 placement table every time.
- Aggregating dashboards from OLTP collections "temporarily."
- Confusing the hospital's own helpdesk (`helpdeskTickets`, tenant DB) with SaaS support (`supportTickets`, master DB).
- Treating `00-PROGRESS-TRACKER.md`/this file as optional paperwork — they are the only memory the next agent has.

## 9. Links

- Authority chain: `PROJECT_CONSTITUTION.md` → rulings (Doc 10) → ADRs (`docs/adr/`) → standards (Doc 09) → guidelines (`AI_DEVELOPMENT_GUIDELINES.md`)
- Build state: `PlanofActionforHMS/00-PROGRESS-TRACKER.md`
- Vocabulary: `DOMAIN_GLOSSARY.md` · Behavior: `docs/STATE_MACHINE_CATALOG.md`, `docs/BUSINESS_WORKFLOWS.md`, `docs/EVENT_CATALOG.md` · Ops: `docs/DISASTER_RECOVERY_RUNBOOK.md`, `docs/OBSERVABILITY_GUIDE.md`

## 9b. Session Handoff (2026-07-12, Sprint 0 session end)

- `medicore-hms/` has **9 commits + 11 modified/added files uncommitted** (verification fixes: utils sleep typing, Express traceId augmentation, BullMQ connection options, compose port remap 27018/6380, pnpm onlyBuiltDependencies). All gates verified green AFTER these fixes. **First action next session:** `git add -A && git commit` with message "fix(bootstrap): type fixes, bullmq connection options, dev port remap" — couldn't commit due to a temporary harness outage for state-changing shell commands at session end.
- **Runtime verification pending:** `docker compose -f infra/docker/docker-compose.yml up -d` (same outage). Static verification (typecheck/lint/test/build/boundaries) all passed; the compose file's earlier failure mode (host ports 27017/6379 occupied by an unrelated `school_*` stack on this machine) is already fixed via the 27018/6380 remap.

## 10. Open Questions (owner answers pending)

- Pricing values for Doc 07 placeholders (`PLAN_*`).
- Primary cloud + regions for launch (affects Terraform in P0/P9).
- Payment gateway priority order (Razorpay first?).
- Company legal entity name for DPA/BAA templates.
