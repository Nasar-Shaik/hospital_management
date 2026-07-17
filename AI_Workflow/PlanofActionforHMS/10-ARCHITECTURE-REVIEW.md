# 10 — Enterprise Architecture Review

**Reviewer:** Principal Architect review pass · **Date:** 2026-07-12 · **Scope:** README + Docs 01–06
**Verdict:** Blueprint is strong and commercially viable. Gaps found were **clinical-service coverage** (ED triage, critical care charting, dialysis, physio, dietetics, CSSD, mortuary, MRD), **org-type coverage** (only 7 of 25 target org types were mapped), **product packaging** (no editions), and **engineering governance** (no standards doc). All fixed in this pass — see §Resolution Log at the end. No existing functionality was removed; all changes are additive or corrective. Backward compatibility preserved.

---

## Review 1 — README.md

### Strengths

- Clear product vision with correct SaaS design pillars (tenancy-first, modular monetization, clinical safety, standards-based).
- NFR table is quantified (p95 latency, RPO/RTO, WCAG) — rare and valuable at blueprint stage.
- Technology stack is coherent and modern; no conflicting choices.
- High-level diagram correctly shows stateless API, queue workers, and an integration bus.

### Weaknesses

1. **Target segment table covered only 7 organization types** while the product must serve 25 (single-doctor clinic → enterprise healthcare network). Sales and configuration strategy for the other 18 was implicit, not documented.
2. Plan tiers ("Starter/Growth/Business/Enterprise") were named but never specified — no editions document existed.
3. Standards list omitted **ICD-11** and **NHCX** (India's National Health Claims Exchange), both required for the Indian market roadmap.
4. Document index did not include design system, engineering standards, or progress tracking.

### Missing Enterprise Features

- Organization-type → edition mapping (fixed via 07-PRODUCT-EDITIONS.md).
- A statement of the **configuration-over-code** principle: one codebase, all org types via feature flags + plans + tenant/branch config + permissions.

### Recommended Improvements (applied)

- Expanded §2 to map all 25 organization types to editions.
- Added ICD-11, NHCX to the standards pillar.
- Extended document index with 00, 07, 08, 09, 10.

### Reasoning

A commercial HIS lives or dies on packaging. Epic and Cerner both sell one platform configured per facility type; the blueprint claimed this but only demonstrated it for hospitals and clinics. Making the 25-type mapping explicit forces every module to declare its flag and prevents "fork-per-customer" drift over the 10-year horizon.

---

## Review 2 — 01-PHASE-WISE-PLAN.md

### Strengths

- Nine phases with crisp objectives, sellable increments, and a correct dependency graph (P1→P2→P3→P4 sequential; P5–P7 parallelizable).
- Permission naming convention (`resource:action[:scope]`) and API conventions declared up front and used consistently.
- Development order inside each phase is realistic (e.g., masters before registration, charge engine before billing).
- Phase 8 AI correctly gated as advisory, human-in-the-loop, last-built for clinical suggestions.

### Weaknesses

1. **Emergency care was under-modeled.** Phase 2 registers ER rooms and Phase 2 has "Emergency Registration," but there was **no triage module** (ESI/CTAS/manchester levels, NEWS/MEWS scoring, ED tracking board, code-blue workflow). A general/multi-specialty hospital cannot pass NABH without it.
2. **Critical care (ICU/NICU/PICU) had registries but no clinical workflow** — no ICU flowsheets, ventilator settings, hourly charting, APACHE/SOFA scores, NICU-specific growth/feeding charts.
3. **Dialysis, Physiotherapy, Dental, Ophthalmology, ENT** — five of the 25 target org types had no dedicated workflow. Dialysis needs sessions/machine slots/adequacy tracking; physio needs treatment sessions/exercise plans; dental needs tooth charting; ophthalmology needs visual-acuity/refraction; ENT needs audiometry. These are now specialty modules gated by feature flags (dental/eye/ENT via **specialty charting templates** on the EMR, dialysis/physio as first-class modules).
4. **Dietetics was misplaced** — `dietOrders` sat under facility ops (cafeteria) but clinical diet prescription (therapeutic diets, nutrition assessment) is a clinical module tied to admissions.
5. **CSSD (sterilization), Mortuary, and MRD (Medical Records Department)** were absent — all three are NABH-audited hospital departments.
6. Phase 7 omitted **NHCX** for claims exchange; ICD-11 not mentioned.
7. **Home Healthcare and Occupational Health** org types had no supporting modules (visit scheduling for field staff; pre-employment/periodic exams for corporate OHC).

### Missing Enterprise Features

All items in Weaknesses 1–7, plus **Day Care Surgery pathway** (admission-to-discharge same-day workflow — mostly composition of existing modules, now called out explicitly).

### Recommended Improvements (applied)

- Phase 3 module list extended with: Emergency & Triage, Critical Care (ICU/NICU/PICU flowsheets), Dialysis, Physiotherapy & Rehabilitation, Clinical Dietetics, CSSD, Mortuary, MRD, Specialty Charting (dental/eye/ENT templates).
- Phase 5 extended with Home Healthcare field-visit workflow; Phase 2 masters extended with Occupational Health packages.
- Phase 7 updated with NHCX and ICD-11.

### Reasoning

These modules were the difference between "sellable to clinics" and "sellable to all 25 org types from one codebase." Each is flag-gated so a small clinic never sees them; the marginal cost is schema + module scaffolding, not roadmap risk. They slot into Phase 3 (clinical) without changing phase order.

---

## Review 3 — 02-MODULE-CATALOG.md

### Strengths

- Uniform module template (Purpose/Pages/Collections/APIs/Permissions/Dependencies/Reports/Mobile/Future) — excellent for handing to squads.
- Dependency declarations are mostly correct and acyclic.
- "Future" sections show a real upgrade path per module (BCMA, NEWS/MEWS, auto-verification, etc.).

### Weaknesses

1. **Typo/broken reference in C6:** "Dependencies: C1, Appointments (D... E1)" → corrected to E1.
2. **Duplicate master data:** `vendors` and `suppliers` are the same business entity (a party you procure from). Two collections invite drift. **Resolution:** single `vendors` collection with `categories[]` (pharma-supplier, equipment, services…); `suppliers` retained as a deprecated alias in docs for backward compatibility, not a separate collection. Same for `pharmacySuppliers` (F4) → references `vendors`.
3. **Equipment vs Assets overlap:** `equipment` is a subtype of `assets`. **Resolution:** one `assets` collection with `assetType: medical-equipment | it | furniture | vehicle`; biomedical-specific fields in a sub-document. `equipment` kept as a documented view/alias.
4. **`dietOrders` placement** (facility ops) — clinical diet prescription moved to new module D14 Clinical Dietetics; kitchen fulfillment stays in B9.
5. Missing modules for full org-type coverage (see Review 2) — added as D10–D14, B12–B13, C7.

### Missing Enterprise Features

- Emergency & Triage (D10), Critical Care (D11), Dialysis (D12), Physiotherapy & Rehab (D13), Clinical Dietetics (D14).
- CSSD (B12), Mortuary (B13).
- MRD / Health Information Management (C7) — chart tracking, coding worklist, deficiency management, statutory registers.
- Home Healthcare (G4 mobile-first module) and Occupational Health (F8) — referenced in catalog additions.

### Recommended Improvements (applied)

All of the above added to the catalog with the standard template; duplicates resolved with explicit normalization notes.

### Reasoning

Duplicate masters are the #1 cause of ERP data-quality decay — a vendor invoiced under two IDs breaks spend analytics and payables reconciliation permanently. Fix costs nothing now, is near-impossible after go-live.

---

## Review 4 — 03-DATABASE-DESIGN.md

### Strengths

- Tenancy enforcement is defense-in-depth (ALS context → Mongoose plugin → repository merge → index design) — this is the correct pattern.
- Transactional outbox + idempotency keys + optimistic `version` field: the three integrity mechanisms most designs forget.
- Index strategy is disciplined (tenantId-leading, partial filters on soft delete, TTL for ephemera).
- Reference/global data split (ICD/SNOMED/LOINC in a shared read-only DB) is right.

### Weaknesses

1. **No sequence/counter strategy.** UHIDs, invoice numbers, token numbers, and GRN numbers all need gap-controlled, per-tenant (often per-branch, per-fiscal-year) sequences. MongoDB has no `AUTO_INCREMENT`; without a designed `counters` collection with atomic `findOneAndUpdate` increments, teams improvise and produce duplicate invoice numbers. **Added §5.1.**
2. **`vitals` at hospital scale is a time-series workload** (ICU monitors can emit readings every minute). Modeled as one-doc-per-reading it will dominate storage. **Added:** MongoDB **time-series collections** for `vitals`, `iotReadings`; bucketing guidance.
3. **No schema-version field** — 10-year systems need `schemaVersion` per document for lazy migrations. Added to common fields.
4. Missing collections for the new modules (triage, ICU flowsheets, dialysis, physio, diet, CSSD, mortuary, MRD). Added.
5. **CQRS / event sourcing not addressed** though the review checklist demands it. **Added §9:** pragmatic guidance — event-source the financial ledger and audit trail (append-only journal already implied), CQRS-lite via change-stream-fed read models for dashboards; do **not** event-source clinical documents (versioned snapshots are the medico-legal norm).
6. Sharding note offered `{tenantId: "hashed"}` as an alternative without warning that hashed sharding **breaks tenant data co-location** and range queries. Clarified.
7. `suppliers` duplication (see Review 3) — normalized.

### Missing Enterprise Features

- Counters/sequences (§5.1), time-series collections, schema versioning, archival job specifics, read-model catalog, event-sourcing candidates.

### Recommended Improvements (applied)

All of the above; new collections listed in §2 additions.

### Reasoning

The three additions (counters, time-series, schemaVersion) are the ones that cannot be retrofitted cheaply: duplicate invoice numbers are a statutory violation, vitals re-modeling requires a data migration of the largest collection, and missing schemaVersion forces big-bang migrations forever after.

---

## Review 5 — 04-ARCHITECTURE.md

### Strengths

- Monorepo layout with shared `types/validation/api-client/permissions` packages — maximizes contract safety across 6 apps.
- Middleware chain order is correct (authn → tenant resolution → authz → validation → idempotency).
- Worker/queue separation, Socket.IO with Redis adapter, graceful shutdown — production-grade.
- Both deployment targets (single-VM PM2 and K8s) — matches the market from nursing homes to enterprise.

### Weaknesses

1. **No module-boundary rule.** A modular monolith without an import discipline becomes a big ball of mud by year 3. **Added:** modules may only depend on other modules via (a) their exported service interface or (b) domain events — never direct repository/model imports; enforced by ESLint `import/no-restricted-paths` / dependency-cruiser in CI.
2. **No service-extraction path.** Enterprise scale will eventually demand extracting hot modules (notifications, reports, integrations) into services. Added a note: the module = future service boundary; outbox events are already the seam.
3. **API versioning/deprecation policy absent** beyond `/api/v1`. Added: additive-only changes within v1, deprecation headers + 12-month sunset for breaking changes, version pinning per API key.
4. **Custom-domain tenant routing** was mentioned in README but not specified in the gateway section. Added: gateway resolves `Host` → tenant via cached domain map; falls back to JWT claim; mismatch = 403.
5. Coding/DTO/testing standards embedded here belonged in a dedicated standards doc → now 09-ENGINEERING-STANDARDS.md (this doc keeps architecture, 09 keeps rules).

### Recommended Improvements (applied)

§2.6 Module Boundary Rules, §5.3 API Versioning & Deprecation, gateway tenant-resolution note.

### Reasoning

"Maintainable for 10 years" is decided by boundary discipline, not folder structure. The single highest-leverage addition to this document is the import rule + CI enforcement.

---

## Review 6 — 05-DELIVERY-PLAYBOOK.md

### Strengths

- Realistic timeline (14–20 months to GA) with first revenue at P2 — honest, not sales-deck fiction.
- Testing strategy includes the HMS-specific suites that generic pyramids miss (tenant isolation, RBAC matrix, clinical safety, financial correctness, concurrency).
- Production readiness checklist is genuinely gating quality.
- Risk register names the real killers (tenant leakage, clinical safety, integration fragility).

### Weaknesses

1. Milestones were phase-named, not **edition-named** — sales needs "Clinic Edition GA at end of P2," not "P2 done." Mapped milestones to editions (07).
2. New Phase-3 clinical modules (triage, critical care, dialysis, physio, dietetics) need sprint-slice coverage — added to sprint 19–24 band with +2 sprints contingency.
3. No **beta/design-partner program** structure — added one line per milestone (clinic pilot = 3 design partners, hospital pilot = 1 NABH-accredited partner).

### Recommended Improvements (applied)

Roadmap table now carries an "Edition unlocked" column; sprint plan extended.

### Reasoning

Tying delivery milestones to sellable editions converts the roadmap into a revenue plan and gives engineering an unambiguous scope cut-line per release.

---

## Review 7 — 06-FEATURE-CHECKLIST.md

### Strengths

- Traceability discipline: every item maps to a module (02) and phase (01).
- Serves double duty as release gate and sales completeness proof.

### Weaknesses

1. Missing sections for the added modules (Emergency/Triage, Critical Care, Dialysis, Physiotherapy, Dietetics, CSSD, Mortuary, MRD, Home Healthcare, Occupational Health).
2. Compliance section was thin: no explicit NABH/NABL/ICD-11/NHCX/consent-management/retention line items.
3. "Completeness Verification" claimed ✅ before development — reframed as _blueprint_-completeness (the progress tracker 00 now owns build status).

### Recommended Improvements (applied)

Added the missing checklist sections and a dedicated Compliance checklist; clarified the verification claim.

---

## Cross-Document Consistency Rulings (normative)

These rulings resolve inconsistencies found across documents; all docs now conform:

| #   | Ruling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1  | Party you procure from = **`vendors`** (with `categories[]`). `suppliers`/`pharmacySuppliers` are deprecated aliases, not collections.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| N2  | Physical items = **`assets`** with `assetType`; `equipment` is the biomedical subtype, not a separate collection.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| N3  | Clinical diet prescription lives in **D14 Clinical Dietetics** (`dietPrescriptions`, `nutritionAssessments`); kitchen fulfillment (`dietOrders`, `cafeteriaOrders`) stays in B9.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| N4  | Collection naming: **camelCase plural** (`labOrders`), fields camelCase, permission codes `resource:action[:scope]` kebab-free, API paths kebab-case plural (`/lab-orders`). Already mostly true; now stated once, here and in 09.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| N5  | Specialty clinics (dental/eye/ENT/physio) are served by **specialty charting templates + feature flags on the shared EMR**, plus first-class Dialysis and Physiotherapy modules — never by forked code.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| N6  | Every module MUST declare its feature-flag key (`module.<domain>.<name>`) — editions (07) compose these flags.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| N7  | ICD-10 **and ICD-11** both supported; coding system is a per-tenant configuration (jurisdictions migrate at different speeds).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| N8  | **Tenancy architecture (owner decision, 2026-07-12): Master DB + database-per-tenant.** `paperlesstech_master` holds platform data only (tenant registry, plans, flags, SaaS billing, usage, licenses, support tickets, global settings); each hospital gets a dedicated `hms_<slug>` database with identical schema. Tenant resolved per request by subdomain/custom domain → master registry (Redis-cached) → Connection Manager (cached per-tenant connections). Heavy tenants relocate to dedicated servers/clusters via a `dbUri` registry change — no application code change. `tenantId` stays stamped on every document as defense in depth. Supersedes the earlier shared-collection/row-level-isolation default throughout Docs README/01/02/03/04/05/07. Business modules and features are unchanged. |
| N9  | **Frontend framework (owner decision, 2026-07-12): Next.js (App Router) + React 19 for all web frontends; Express remains the only API.** Driven by expanded platform scope (public hospital websites, marketing pages, SEO booking, white-label custom domains, future ERPs). Next.js is **presentation-tier only** — no business logic, no DB/Redis access, no business `app/api/*` routes; all data via the typed client → Express. SSR/ISR for public/white-label surfaces; client components for operator dashboards. Vite survives only as tooling (Vitest, `packages/ui` playground). Supersedes ADR-0003 via ADR-0012; backend/tenancy/modular-monolith architecture unchanged.                                                                                                                          |

---

## Resolution Log

| Item                                                                          | Where fixed                          |
| ----------------------------------------------------------------------------- | ------------------------------------ |
| 25 org-type mapping                                                           | README §2, 07-PRODUCT-EDITIONS.md    |
| Missing clinical modules (triage, ICU/NICU/PICU, dialysis, physio, dietetics) | 01 Phase 3, 02 D10–D14, 03 §2, 06    |
| Missing support depts (CSSD, mortuary, MRD)                                   | 01 Phase 3, 02 B12/B13/C7, 03 §2, 06 |
| Home healthcare + occupational health                                         | 01 P5/P2, 02 notes, 06               |
| Vendor/supplier + equipment/asset duplication                                 | 02 B8/B7, 03 §2, ruling N1/N2        |
| Counters/sequences, time-series vitals, schemaVersion                         | 03 §1.3, §5.1                        |
| CQRS / event-sourcing guidance                                                | 03 §9                                |
| Module boundary rules, API deprecation policy, custom-domain routing          | 04 §2.6, §5.3                        |
| NHCX, ICD-11                                                                  | README §1, 01 Phase 7, 06            |
| Editions                                                                      | 07-PRODUCT-EDITIONS.md               |
| Design system                                                                 | 08-DESIGN-SYSTEM.md                  |
| Engineering standards                                                         | 09-ENGINEERING-STANDARDS.md          |
| Progress tracking for future contributors/models                              | 00-PROGRESS-TRACKER.md               |
| C6 dependency typo                                                            | 02                                   |
