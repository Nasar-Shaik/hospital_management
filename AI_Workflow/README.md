# MediCore HMS — Enterprise Multi-Tenant Hospital Management SaaS

**Implementation Blueprint — Planning to Production**

> **⚖️ Read first, in this order:** [PROJECT_MEMORY.md](./PROJECT_MEMORY.md) → [PROJECT_CONSTITUTION.md](./PROJECT_CONSTITUTION.md) (highest authority) → [00-PROGRESS-TRACKER.md](./PlanofActionforHMS/00-PROGRESS-TRACKER.md). AI agents must also follow [AI_DEVELOPMENT_GUIDELINES.md](./AI_DEVELOPMENT_GUIDELINES.md) and use only [DOMAIN_GLOSSARY.md](./DOMAIN_GLOSSARY.md) vocabulary.

A commercial-grade, multi-tenant Hospital Information System (HIS) comparable to Epic, Oracle Cerner, Athenahealth, Practo and MediBuddy — sellable to clinics, hospitals, multi-branch chains, diagnostic centers, medical colleges and specialty hospitals.

---

## Document Index

| #   | Document                                                                  | What it covers                                                                                                  |
| --- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| —   | [README](./README.md)                                                     | This index, product vision, personas, non-functional requirements                                               |
| 00  | [Progress Tracker](./PlanofActionforHMS/00-PROGRESS-TRACKER.md)           | **Start here to resume work** — build status by phase/module, decisions log, handoff notes                      |
| 01  | [Phase-Wise Development Plan](./PlanofActionforHMS/01-PHASE-WISE-PLAN.md) | 9 phases — objectives, modules, pages, collections, APIs, permissions, dependencies, build order                |
| 02  | [Complete Module Catalog](./PlanofActionforHMS/02-MODULE-CATALOG.md)      | Every module with Purpose / Pages / Collections / APIs / Permissions / Dependencies / Reports / Mobile / Future |
| 03  | [MongoDB Database Design](./PlanofActionforHMS/03-DATABASE-DESIGN.md)     | Master DB + database-per-tenant strategy, all collections, relationships, indexes, integrity, CQRS              |
| 04  | [System Architecture](./PlanofActionforHMS/04-ARCHITECTURE.md)            | Folder structures, Connection Manager, backend/frontend/RN architecture, API design, Docker, CI/CD              |
| 05  | [Delivery Playbook](./PlanofActionforHMS/05-DELIVERY-PLAYBOOK.md)         | Roadmap (edition-mapped), sprint plan, priority matrix, testing strategy, production checklist, scaling         |
| 06  | [Master Feature Checklist](./PlanofActionforHMS/06-FEATURE-CHECKLIST.md)  | Exhaustive tick-list proving no hospital feature is missed                                                      |
| 07  | [Product Editions](./PlanofActionforHMS/07-PRODUCT-EDITIONS.md)           | 10 sellable editions covering all 25 org types — flags, limits, pricing placeholders, upgrade paths             |
| 08  | [Design System](./PlanofActionforHMS/08-DESIGN-SYSTEM.md)                 | Tokens, typography, components, states, dark mode, accessibility, animation                                     |
| 09  | [Engineering Standards](./PlanofActionforHMS/09-ENGINEERING-STANDARDS.md) | Naming, coding/API/DTO standards, patterns, testing, git, review & security checklists                          |
| 10  | [Architecture Review](./PlanofActionforHMS/10-ARCHITECTURE-REVIEW.md)     | Enterprise review findings + normative rulings (N1–N8) binding across all docs                                  |

### Governance Layer (AI-first development)

| Document                                                                                                                                                                                                                                                                                 | What it covers                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [PROJECT_CONSTITUTION.md](./PROJECT_CONSTITUTION.md)                                                                                                                                                                                                                                     | **Highest authority** — principles, non-negotiables, DoR/DoD, AI never/always           |
| [AI_DEVELOPMENT_GUIDELINES.md](./AI_DEVELOPMENT_GUIDELINES.md)                                                                                                                                                                                                                           | Session protocol, never/always rules, search-before-create, doc-update matrix           |
| [PROJECT_MEMORY.md](./PROJECT_MEMORY.md)                                                                                                                                                                                                                                                 | Long-term memory: why decisions were made, assumptions, postponed items, debt, lessons  |
| [DOMAIN_GLOSSARY.md](./DOMAIN_GLOSSARY.md)                                                                                                                                                                                                                                               | Single vocabulary — forbidden synonyms, code identifiers                                |
| [docs/adr/](./docs/adr/README.md)                                                                                                                                                                                                                                                        | Architecture Decision Records (0001–0011)                                               |
| [docs/EVENT_CATALOG.md](./docs/EVENT_CATALOG.md) · [STATE_MACHINE_CATALOG](./docs/STATE_MACHINE_CATALOG.md) · [BUSINESS_WORKFLOWS](./docs/BUSINESS_WORKFLOWS.md) · [USER_JOURNEYS](./docs/USER_JOURNEYS.md) · [ERROR_CODES](./docs/ERROR_CODES.md)                                       | Behavior contracts: events, lifecycles, workflows, journeys, errors                     |
| [docs/CACHE_STRATEGY.md](./docs/CACHE_STRATEGY.md) · [SEARCH_STRATEGY](./docs/SEARCH_STRATEGY.md) · [PERFORMANCE_BUDGET](./docs/PERFORMANCE_BUDGET.md) · [SCHEDULER_CATALOG](./docs/SCHEDULER_CATALOG.md) · [OBSERVABILITY_GUIDE](./docs/OBSERVABILITY_GUIDE.md)                         | Infrastructure contracts                                                                |
| [docs/DATA_RETENTION_POLICY.md](./docs/DATA_RETENTION_POLICY.md) · [DISASTER_RECOVERY_RUNBOOK](./docs/DISASTER_RECOVERY_RUNBOOK.md) · [RELEASE_MANAGEMENT](./docs/RELEASE_MANAGEMENT.md) · [FEATURE_ROLLOUT](./docs/FEATURE_ROLLOUT.md) · [MAINTENANCE_MODE](./docs/MAINTENANCE_MODE.md) | Operations                                                                              |
| [docs/RISK_REGISTER.md](./docs/RISK_REGISTER.md) · [COST_OPTIMIZATION](./docs/COST_OPTIMIZATION.md) · [MODULE_OWNERSHIP](./docs/MODULE_OWNERSHIP.md)                                                                                                                                     | Governance                                                                              |
| [docs/MANUAL_VALIDATION_RUNBOOK.md](./docs/MANUAL_VALIDATION_RUNBOOK.md) · [MOBILE_M2_DEVICE_CHECKLIST](./docs/MOBILE_M2_DEVICE_CHECKLIST.md) · [MOBILE_M3_DEVICE_CHECKLIST](./docs/MOBILE_M3_DEVICE_CHECKLIST.md)                                                                       | **Manual validation** — the runbook is authoritative; the checklists are its companions |
| [docs/PLATFORM_STRATEGY.md](./docs/PLATFORM_STRATEGY.md)                                                                                                                                                                                                                                 | PaperlessTech platform reuse (future ERPs) + extensibility ruling                       |

---

## 1. Product Vision

**MediCore HMS** is a modular, API-first, multi-tenant SaaS platform that runs the complete operational, clinical, financial and administrative lifecycle of a healthcare organization. Every tenant (a hospital group) is logically isolated, can span multiple branches, subscribes to a plan, enables only the modules it needs (feature flags), and can be white-labeled with custom branding and domains.

### Design Pillars

1. **Multi-tenancy first** — master database + **dedicated database per hospital**; cross-tenant leakage is physically impossible, and every document is still tenant-stamped and branch-aware as defense in depth.
2. **Modular monetization** — modules are independently toggleable and metered; plans gate features, storage, seats and API usage.
3. **Clinical safety** — allergy/interaction checks, immutable audit trails, digital signatures, versioned clinical records.
4. **Standards-based** — HL7 v2, FHIR R4, ICD-10 & ICD-11, SNOMED CT, LOINC, DICOM, ABDM/NDHM & NHCX (India), NABH/NABL/JCI-aligned workflows.
5. **Offline-tolerant mobile** — nurses, doctors and field staff operate on unstable networks.
6. **Observability & compliance** — HIPAA / GDPR / India DPDP aligned; full auditability; disaster recovery with RPO/RTO targets.

---

## 2. Target Segments & Fit — 25 Organization Types, One Codebase

**Configuration-over-code principle:** every organization type below runs the same codebase, differentiated only by **feature flags + subscription plan (edition) + tenant/branch configuration + permissions** — never by forks. Full edition specs (limits, flags, pricing, upgrade paths) in [07-PRODUCT-EDITIONS.md](./PlanofActionforHMS/07-PRODUCT-EDITIONS.md).

| Edition         | Organization types served                                                                                                  | Key needs                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Clinic          | Small clinic, single-doctor clinic                                                                                         | OP registration, appointments, billing, prescriptions                     |
| Clinic Plus     | Dental / eye / ENT / physiotherapy clinics, telemedicine providers, home healthcare, corporate occupational health centers | Specialty charting templates, teleconsult, field visits, corporate exams  |
| Diagnostic      | Diagnostic centers, pathology labs, radiology centers                                                                      | LIS/RIS, sample tracking, analyzer integration, referrer network          |
| Day Care        | Day care surgery centers, dialysis centers                                                                                 | Same-day pathways, OT/dialysis scheduling, package billing                |
| Nursing Home    | Nursing homes                                                                                                              | Small IPD, nursing/MAR, pharmacy, IP billing                              |
| Hospital        | General hospitals                                                                                                          | Full HIS: ED, ICU, OT, blood bank, revenue cycle, HR                      |
| Multi Specialty | Multi/super-specialty hospitals, multi-branch hospitals                                                                    | Specialty template packs, up to 10 branches, group reporting              |
| Enterprise      | Hospital groups, corporate & international hospitals, enterprise healthcare networks                                       | Multi-entity, dedicated infrastructure, white-label, regional deployments |
| Medical College | Medical college / teaching hospitals                                                                                       | Academics, rotations, countersign workflows, research extracts            |
| Government      | Government hospitals                                                                                                       | Scheme billing (PM-JAY), ABDM/NHCX, statutory reporting, on-prem option   |

---

## 3. Core Personas & Primary App Surface

| Persona                   | Surface              | Representative actions                                             |
| ------------------------- | -------------------- | ------------------------------------------------------------------ |
| Super Admin (SaaS owner)  | Admin Console (web)  | Tenant provisioning, plans, feature flags, global monitoring       |
| Tenant Admin              | Web app              | Branch/dept setup, RBAC, subscription, branding                    |
| Doctor                    | Web + Doctor App     | Consult, EMR, e-prescription, orders, teleconsult                  |
| Nurse                     | Web + Staff App      | Vitals, MAR, nursing notes, handover, monitoring                   |
| Front Desk / Registration | Web                  | Registration, appointments, queue, billing                         |
| Lab Technician            | Web                  | Sample collection, result entry, machine interface                 |
| Radiologist / Technician  | Web + PACS viewer    | Imaging orders, reporting, DICOM                                   |
| Pharmacist                | Web                  | Dispensing, inventory, batch/expiry, purchase                      |
| Billing / Cashier         | Web                  | OP/IP billing, payments, refunds, insurance                        |
| Finance / Accounts        | Web                  | Ledgers, day book, tax, P&L                                        |
| HR / Payroll              | Web                  | Attendance, leave, payroll, recruitment                            |
| Store / Inventory         | Web                  | Indent, GRN, issue, stock audit                                    |
| Patient                   | Patient App + Portal | Book appointments, records, reports, bills, pay, teleconsult, chat |
| Management / CXO          | Web dashboards       | KPIs, financials, occupancy, forecasting                           |

---

## 4. Non-Functional Requirements (NFRs)

| Area           | Target                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Availability   | 99.9% (Business), 99.95% (Enterprise)                                                                                                 |
| API latency    | p95 < 300 ms for reads, < 800 ms for writes                                                                                           |
| Scalability    | Horizontal stateless API; database-per-tenant placement tiers (shared cluster → dedicated server/cluster per hospital); Redis cluster |
| RPO / RTO      | RPO ≤ 5 min (oplog/PITR), RTO ≤ 30 min                                                                                                |
| Security       | Encryption at rest (AES-256) + in transit (TLS 1.3), field-level encryption for PHI                                                   |
| Compliance     | HIPAA, GDPR, India DPDP, ABDM; NABH/JCI operational alignment                                                                         |
| Auditability   | Immutable append-only audit log for every PHI/financial mutation                                                                      |
| Data residency | Per-tenant region pinning (configurable)                                                                                              |
| Localization   | i18n (multi-language), multi-currency, multi-timezone, configurable tax regimes                                                       |
| Accessibility  | WCAG 2.1 AA on web and patient app                                                                                                    |

---

## 5. Global Technology Stack

- **Frontend:** **Next.js (App Router) + React 19** + TypeScript + Tailwind CSS + Shadcn UI + TanStack Query + Zustand + React Hook Form + Zod (ADR-0012 — presentation tier only; SSR/ISR for public/white-label surfaces, client components for dashboards)
- **Backend:** Node.js + Express.js + TypeScript, layered (routes → controllers → services → repositories), Zod validation — **the only API; Next.js never replaces Express**
- **Database:** MongoDB (Mongoose ODM) + Redis (cache, sessions, queues, rate-limit, pub/sub)
- **Mobile:** React Native (Expo) + TypeScript + expo-router + TanStack Query + MMKV (offline)
- **Realtime:** Socket.IO (namespaced/tenant-scoped rooms) + Redis adapter
- **Queues:** BullMQ (Redis) for notifications, reports, OCR, imports, billing jobs
- **Files:** S3-compatible object storage + signed URLs; DICOM to dedicated store
- **Auth:** JWT access + rotating refresh tokens, RBAC + fine-grained permissions, optional SSO/OIDC, MFA
- **Infra:** Docker, Docker Compose (dev), Kubernetes (prod optional), PM2 (single/VM deploys), Nginx/Traefik gateway
- **CI/CD:** GitHub Actions → build/test/scan → registry → staged deploy
- **Observability:** OpenTelemetry, Prometheus + Grafana, Loki logs, Sentry errors, health/readiness probes

---

## 6. High-Level Architecture

```
                    ┌───────────────────────────────────────────────┐
                    │              CDN / WAF / DNS                    │
                    └───────────────────────┬───────────────────────┘
                                            │
                        ┌───────────────────┴───────────────────┐
                        │        API Gateway (Nginx/Traefik)     │
                        │  TLS, rate-limit, tenant routing       │
                        └───────────────────┬───────────────────┘
             ┌──────────────┬───────────────┼───────────────┬──────────────┐
             │              │               │               │              │
       Web (Next.js)  Patient App     Doctor App       Staff App     Admin (Next.js)
             │              │               │               │              │
             └──────────────┴───────────────┼───────────────┴──────────────┘
                                            │  (REST + WebSocket)
                        ┌───────────────────┴───────────────────┐
                        │      Express API (stateless, N pods)   │
                        │  authN/Z · tenant ctx · validation     │
                        │  services · repositories · events      │
                        └───┬─────────┬─────────┬─────────┬──────┘
                            │         │         │         │
                      ┌─────┴──────────┐ ┌────┴───┐ ┌───┴────┐ ┌──┴──────┐
                      │ MongoDB        │ │ Redis  │ │ BullMQ │ │ Object  │
                      │ master + 1 DB  │ │ cache/ │ │workers │ │ Storage │
                      │ per hospital   │ │ pubsub │ │        │ │(S3/PACS)│
                      └────────────────┘ └────────┘ └────────┘ └─────────┘
                            │
                   ┌────────┴─────────┐
                   │ Integrations bus │  HL7/FHIR · Payment · SMS/Email/WhatsApp
                   │                  │  Lab/Radiology machines · ABDM · Insurance TPA
                   └──────────────────┘
```

---

## 7. Multi-Tenancy Model (summary)

- **Isolation strategy: Master DB + database-per-tenant.** One master database **`paperlesstech_master`** holds platform-level data only (tenant registry, plans, feature flags, SaaS billing, usage counters, licenses, support tickets, global settings). **Each hospital gets its own MongoDB database** (`hms_apollo`, `hms_sunshine`, …) holding all clinical/financial/operational data with an identical schema. Physical isolation by default; `tenantId` is still stamped on every document as defense in depth.
- **Tenant resolution:** subdomain (`apollo.paperlesstech.in`) or verified custom domain (`hms.apollohospital.com`) → master registry lookup (Redis-cached) → **Connection Manager** returns the cached per-tenant DB connection; JWT `tenantId` claim must match the resolved tenant. Context carried in `AsyncLocalStorage`; repositories bind only to the tenant connection.
- **Scaling without code change:** tenant DBs start co-located on a shared cluster; a heavy hospital's database moves to a dedicated server/cluster by changing its `dbUri` in the master registry.
- **Branch scope:** `branchId` on operational documents; RBAC scopes users to one/many branches.
- **Feature flags:** per-tenant + per-plan module entitlements (stored in master) resolved at login and cached in Redis.
- **Data lifecycle:** provisioning (create DB → migrate → seed), suspension, export, per-tenant backup/restore, and erasure are first-class tenant operations.

See [03-DATABASE-DESIGN.md](./03-DATABASE-DESIGN.md) and [04-ARCHITECTURE.md](./04-ARCHITECTURE.md) for full detail.

---

## 8. How to Read This Blueprint

Check **00 (Progress Tracker)** first for current build status and next action. Then: **01 (Phases)** for the delivery sequence, **02 (Modules)** as the functional spec, **03 (Database)** and **04 (Architecture)** as the technical contracts, **07 (Editions)** for packaging, **08 (Design System)** and **09 (Engineering Standards)** before writing any UI/code, **05 (Delivery)** to run the program, **06 (Checklist)** for release gating, and **10 (Review)** for the binding architecture rulings.
