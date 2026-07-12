# 05 — Delivery Playbook

Roadmap, sprint plan, priority matrix, testing strategy, production checklist and scaling strategy for building and operating the platform.

---

## 1. Development Roadmap (indicative, team of 8–12)

> Assumes a squad model: **Platform**, **Clinical**, **Financial**, **Mobile**, **Data/AI**, plus shared **QA** and **DevOps**. Timeline is indicative; adjust to team size. Sprints = 2 weeks.

| Phase | Focus | Indicative duration | Milestone / Sellable increment | Edition unlocked (Doc 07) |
|-------|-------|---------------------|-------------------------------|---------------------------|
| P0 | Setup & scaffolding | 2–3 weeks | CI green, skeleton deploys | — |
| P1 | Foundation (tenancy, auth, RBAC, audit, notifications, files, shell) | 6–8 weeks | **MVP platform** — can onboard a tenant & users | — (internal alpha) |
| P2 | Core ops (patients, doctors, appointments, beds, masters) | 8–10 weeks | **Clinic-ready** — OP flow sellable to small clinics | **Clinic Edition** (beta with 3 design-partner clinics) |
| P3 | Clinical (EMR, nursing, lab, radiology, OT, blood bank + triage/ICU/dialysis/physio/dietetics flags) | 14–18 weeks | **Hospital-ready HIS** | **Clinic Plus, Diagnostic, Day Care** (lab/radiology subset ships mid-phase) |
| P4 | Financial (billing, pharmacy, inventory, finance, HR) | 10–14 weeks | **Full revenue cycle** — sellable to hospitals | **Nursing Home, Hospital Edition** (1 NABH design partner) |
| P5 | Mobile & communication (+ home healthcare, occupational health flags) | 8–10 weeks | **Patient/Doctor/Staff apps** live | Patient-engagement add-on across editions |
| P6 | Analytics & reporting | 6–8 weeks | **Management dashboards & reports** | **Multi-Specialty Edition** |
| P7 | Integrations | 8–12 weeks | **Deployable in regulated institutions** | **Government, Medical College Editions** |
| P8 | AI features | 8–12 weeks | **Premium AI tier** | AI add-on tier |
| P9 | Production hardening & GA | ongoing, 6–8 weeks concentrated | **Enterprise GA** | **Enterprise Edition** |

Phases 5–7 partially parallelize once P4 stabilizes. Total ~14–20 months to full enterprise GA; **first revenue at end of P2**, credible hospital sales at end of P4.

**Design-partner program:** each edition launches with named design partners (Clinic: 3 clinics; Diagnostic: 1 lab chain; Hospital: 1 NABH-accredited hospital) who get discounted pricing in exchange for weekly feedback and go-live case studies. No edition is declared GA without at least one design partner in production for 60 days.

---

## 2. Sprint Planning (illustrative backlog slices)

**Sprint 1–2 (P0/P1):** Monorepo, CI, Docker Compose, tenant model, auth (login/refresh/MFA), tenant middleware + ALS context, audit plugin.
**Sprint 3–4 (P1):** RBAC/permission catalog + seed, users/invitations, org setup (hospital/branch/dept), file service, notification abstraction (in-app+email).
**Sprint 5–6 (P1):** Feature flags, subscription/plans, admin console, app shell + branding + i18n. → **P1 demo & internal alpha.**
**Sprint 7–9 (P2):** Masters (services/tariffs/insurers/vendors), patient registration + MPI, doctor + schedules.
**Sprint 10–12 (P2):** Appointments + queue/token + reminders, ward/bed board, facilities/assets/ambulance, reception/visitor/feedback. → **Clinic pilot.**
**Sprint 13–18 (P3):** EMR core, consultation + prescription + order entry, nursing (vitals/MAR/notes/handover).
**Sprint 19–24 (P3):** Lab, radiology, OT, blood bank, consent/discharge/referral, teleconsult. → **Hospital pilot.**
**Sprint 25–26 (P3, flag-gated specialty wave):** Emergency & triage, critical-care flowsheets, dialysis, physiotherapy, clinical dietetics, CSSD/mortuary/MRD, specialty charting templates — scheduled by edition demand; does not block the P4 start (financial squad proceeds in parallel).
**Sprint 25–30 (P4):** Charge engine, OP/IP billing + payments, pharmacy + inventory, insurance/corporate/wallet, finance, HR/payroll. → **Full HIS beta.**
**Sprint 31–36 (P5):** Realtime/push infra, patient app, doctor app, staff app, chat/announcements/video.
**Sprint 37–40 (P6):** Reporting engine + ETL/read models, dashboards, report catalog.
**Sprint 41–46 (P7):** Payments + SMS/WhatsApp, lab/radiology machines, HL7/FHIR/DICOM, ABDM, SSO, accounting connectors, public API.
**Sprint 47–52 (P8):** AI infra + guardrails, OCR + voice notes, chat assistant, forecasting, appointment/no-show, symptom checker, prescription/ICD assist.
**Continuous (P9):** observability, backups/DR, security hardening, compliance, load testing, blue-green deploy, migration tooling → **GA.**

Ceremonies: sprint planning, daily standup, backlog refinement, review/demo, retro. Definition of Done includes tests, docs, security review, accessibility, and feature-flag wrapping.

---

## 3. Priority Matrix (MoSCoW × Value/Effort)

| Priority | Modules | Rationale |
|----------|---------|-----------|
| **Must (P1–P2)** | Tenancy, Auth, RBAC, Audit, Patients, Appointments, Billing (OP), Doctor mgmt | No product without these; fastest path to revenue |
| **Should (P3–P4)** | EMR, Nursing, Lab, Pharmacy, IP billing, Inventory, Insurance | Required to sell to hospitals |
| **Could (P5–P6)** | Mobile apps, Radiology, OT, Blood bank, Analytics, HR/Finance depth | Strong differentiators & stickiness |
| **Won't-yet / Later (P7–P8)** | Deep integrations, AI suite | Premium tiers; sequence after core is stable |

**Value/Effort quadrants**
- *Quick wins (high value/low effort):* appointment reminders, patient portal records view, daily collection report, bed board.
- *Big bets (high value/high effort):* EMR, LIS, revenue cycle, AI scribe, HL7/FHIR.
- *Fill-ins (low/low):* feedback, cafeteria, parking, visitor logs.
- *Avoid over-investing early (low value/high effort):* full PACS, full double-entry accounting — integrate/partner first, build later.

---

## 4. Testing Strategy

### 4.1 Test pyramid
| Layer | Tooling | Coverage target | What |
|-------|---------|-----------------|------|
| Unit | Vitest/Jest | 80%+ services/utils | Business logic, validators, calculators (billing, payroll, ranges) |
| Integration | Jest + Testcontainers (Mongo/Redis) | Critical paths | Repositories, transactions, tenant isolation, RBAC enforcement |
| Contract | Zod/OpenAPI + Pact | All public APIs | Request/response schemas, backward compat |
| E2E (web) | Playwright | Core journeys | Register→appoint→consult→bill; multi-role, multi-tenant isolation |
| E2E (mobile) | Detox / Maestro | Smoke + key flows | Login, book, records, pay, offline sync |
| Load/perf | k6 / Artillery | NFR gates | p95 latency, throughput, soak, spike |
| Security | OWASP ZAP, Semgrep, Trivy, gitleaks | Every pipeline | SAST/DAST/deps/secrets |
| Accessibility | axe-core, Playwright a11y | WCAG 2.1 AA | Web + patient app |

### 4.2 Special HMS test concerns (must-have suites)
- **Tenant isolation tests:** attempt cross-tenant reads/writes for every endpoint → must 403/empty. Automated for all routes.
- **RBAC matrix tests:** each permission × role × scope combination.
- **Clinical safety:** allergy/interaction warnings fire; MAR schedule correctness; result reference-range flagging; unit conversions.
- **Financial correctness:** billing math, tax, discounts, refunds, package consumption, wallet balance, payment allocation, idempotency (double-charge prevention).
- **Concurrency:** simultaneous bed allocation, stock dispense, token issue → no double-booking/negative stock.
- **Data integrity:** transaction rollback, outbox reliability, soft-delete visibility.
- **Migration tests:** up/down reversibility on seeded data.

### 4.3 Environments & data
Synthetic/anonymized datasets; **no real PHI in non-prod**. Golden datasets per specialty. Chaos testing (kill pods, drop Redis) before GA.

---

## 5. Production Readiness Checklist

**Security**
- [ ] TLS 1.3 everywhere; HSTS; secure cookies; CSP
- [ ] Field-level encryption for PHI; KMS-managed keys; encryption at rest
- [ ] JWT short-lived + rotating refresh with reuse detection; MFA for privileged roles
- [ ] RBAC + permission + tenant/branch scope enforced server-side on every route
- [ ] Rate limiting, WAF, bot protection, input validation (Zod) on all inputs
- [ ] Secrets in vault; no secrets in repo/images; dependency & image scanning clean
- [ ] Pen-test completed & criticals remediated
- [ ] Audit logging on all PHI/financial mutations; immutable

**Reliability**
- [ ] Health/readiness/liveness probes; graceful shutdown
- [ ] Automated backups + tested PITR restore; documented RPO/RTO met
- [ ] DR runbook + at least one successful DR drill
- [ ] Circuit breakers/retries/timeouts on all integrations; DLQs monitored
- [ ] Autoscaling configured & load-tested to target concurrency
- [ ] Zero-downtime deploy (blue-green/canary) + rollback tested

**Observability**
- [ ] Metrics, tracing, logs with `traceId`/`tenantId` correlation
- [ ] Dashboards + SLOs + alerting + on-call rotation + runbooks
- [ ] Error tracking (Sentry) wired FE/BE/mobile
- [ ] Synthetic monitors + public status page

**Compliance**
- [ ] HIPAA/GDPR/DPDP controls mapped; DPAs & BAAs templated
- [ ] Consent management + data-subject-request (export/erasure) workflow
- [ ] Retention policies configured per jurisdiction; legal hold supported
- [ ] Data residency honored per tenant
- [ ] ABDM/NABH/JCI operational alignment where applicable

**Product/Ops**
- [ ] Feature flags gate every incomplete feature
- [ ] Tenant onboarding + data import/migration tooling
- [ ] Billing/dunning + usage metering working
- [ ] Admin/user/API documentation + training material
- [ ] Support playbooks, incident process, escalation
- [ ] Accessibility (WCAG 2.1 AA) verified
- [ ] i18n/l10n, multi-currency, multi-timezone verified

---

## 6. Scaling Strategy

### 6.1 Application
- **Stateless API** → horizontal autoscale (HPA) behind LB; sessions/state in Redis, not memory.
- **Workers** scale independently per queue depth.
- **Socket.IO** with Redis adapter; sticky sessions or use WebSocket-aware LB.
- **CDN** for web static + cached patient-facing content; edge for assets.

### 6.2 Data
- **Database-per-tenant placement tiers:** small hospitals co-located on a shared cluster → heavy hospital's DB moved to a dedicated server/cluster by flipping `dbUri` in the master registry (no code change). A single huge hospital shards *within* its own DB (`{branchId, _id}` keys). Master DB stays small and cache-fronted.
- **Read replicas** for reporting/analytics; route heavy aggregations to read models.
- **Change streams → materialized read models** (dashboards/analytics) to keep OLTP fast.
- **Redis cluster** for cache/queues; **TTL + eviction** policies tuned.
- **Object storage + CDN** for files/DICOM; lifecycle to cold tiers.
- **Archival tier** for cold audit/clinical/financial history (query-on-demand).

### 6.3 Tenant scaling patterns
- **Noisy-neighbor control:** per-tenant rate limits, queue quotas, connection-manager caps; DB-level isolation already prevents query-level contention across tenants on dedicated tiers.
- **Tiered isolation:** shared cluster (own DB) → dedicated server → dedicated cluster as the hospital grows — a registry change, not a migration project.
- **Per-tenant backup/restore:** each `hms_<slug>` DB is backed up and restorable independently — a tenant-level incident never requires a platform-wide restore.
- **Regional sharding:** deploy per region for residency & latency; global control plane, regional data planes.

### 6.4 Performance guardrails
- Enforce indexes (leading `tenantId`); ban unindexed queries in review.
- Pagination mandatory on lists; cap page size.
- Cache hot reference data (tariffs, flags, ICD).
- Async everything non-critical (notifications, reports, integrations) via queues.
- Load test each release against NFR gates; profile slow queries via APM.

### 6.5 Cost & capacity
Capacity model per tenant tier (beds/OP volume → API RPS, storage, DB IOPS). Autoscale floors/ceilings per environment; budget alerts; right-size on usage telemetry.

---

## 7. Team, Governance & Risk

- **Squads:** Platform, Clinical, Financial, Mobile, Data/AI + QA/DevOps guilds.
- **Governance:** ADRs for architecture decisions, API design review, security review gate, change advisory for prod.
- **Top risks & mitigations:**
  - *Tenant data leakage* → enforced at DB plugin + automated isolation tests.
  - *Clinical safety defects* → dedicated safety test suites, human-in-loop AI, clinical SME review.
  - *Scope creep* → phase gates, MoSCoW, feature flags.
  - *Integration fragility* → resilient integration layer, sandboxes, contract tests.
  - *Compliance gaps* → compliance mapped from P1, DSR tooling, audits.
  - *Performance regressions* → load-test gates, query review, read models.
