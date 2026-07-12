# PLATFORM STRATEGY — PaperlessTech Beyond HMS

HMS is product #1 of the **PaperlessTech Platform**. Future products (School ERP, College ERP, HRMS, CRM, Finance ERP, Inventory ERP) must reuse platform services **without rewriting code**. This document is the architectural review of that goal plus the extensibility (plugin) ruling.

---

## 1. Review Verdict

The current architecture is ~80% platform-ready by accident of good design (modular monolith, flags, editions, DB-per-tenant) — but only if we enforce **one structural rule from day one**:

> **Rule P1: platform-candidate modules must contain zero healthcare vocabulary.** The notification module notifies "recipients about events," not "patients about appointments." HMS-specific wording, types, and logic live in HMS modules that *use* platform modules. This costs nothing now and is unbuildable retroactively.

Concretely: monorepo packages/modules are tagged `platform` or `hms`. CI (dependency-cruiser) forbids `platform → hms` imports — the same mechanism that already enforces module boundaries (Doc 04 §2.4). Platform modules refer to `refType/refId` (polymorphic references), never `patientId`.

## 2. Reusable Platform Modules (the future `@paperlesstech/*` platform kernel)

| Platform module | Today (HMS) | Reuse readiness | Required discipline |
|-----------------|-------------|-----------------|---------------------|
| **Tenancy & Connection Manager** (master registry, DB-per-tenant, provisioning) | A1 | ✅ Fully generic already | DB prefix configurable (`hms_` → `sch_`, `crm_`) |
| **Authentication** (JWT/refresh/MFA/SSO) | A3 | ✅ Generic | Keep patient-identity binding in HMS layer |
| **RBAC & Permissions** | A4 | ✅ Generic engine | Permission *catalog* is per-product data |
| **Subscription, Plans & Editions, Licensing, Usage metering, SaaS billing** | A2 | ✅ Generic | Editions are rows; each product ships its own plan set |
| **Audit & Activity Logging** | A5 | ✅ Generic | PHI tagging generalizes to "sensitive-field" tagging |
| **Notifications** (channels, templates, preferences) | A6 | ✅ Generic | Template catalogs per product |
| **File & Document Service** | A7 | ✅ Generic | Retention classes per product |
| **White-label & Custom Domains** | A8 | ✅ Generic | — |
| **API Keys, Webhooks, Public API scaffolding** | A9 | ✅ Generic | — |
| **Search abstraction** (`SearchProvider` port) | SEARCH_STRATEGY | ✅ Generic | Index definitions per product |
| **Reports & Dashboards engine** (definitions, schedules, exports, widgets) | I1–I2 | ✅ Generic engine | Report catalogs per product |
| **Workflow/Approvals** (approval chains: discounts, leave, PO) | scattered in F/HR | ⚠️ **Extract deliberately** — build as one generic approval engine (entity + chain config + actions) the first time two modules need it, not three copies | The classic missed extraction |
| **Scheduler/job framework** (BullMQ conventions, catalogs) | ADR-0007 | ✅ Generic | — |
| **AI service layer** (provider abstraction, redaction, guardrails, audit, RAG) | J1 | ✅ Generic core | Clinical guardrails are HMS policy plugged into generic hooks |
| **Comms suite** (chat, announcements, video) | H1 | ✅ Mostly generic | — |
| **HR/Payroll** | F7 | ⚠️ Semi — HR is also a *product* (HRMS) | Build clean enough to seed the HRMS product later |
| **Finance GL** | F6 | ⚠️ Semi — same (Finance ERP seed) | Journal engine generic; hospital charge-posting is HMS |
| **Inventory core** (items, stock, PO/GRN movements) | F5 | ⚠️ Semi (Inventory ERP seed) | Movement-ledger engine generic; pharmacy batch rules are HMS |

**Not reusable (correctly product-specific):** EMR, clinical modules, billing charge-posting rules, appointments/queue (though its slot engine could generalize later), editions content.

## 3. Extensibility / Plugin Ruling (summary of ADR-0011)

**No executable third-party plugins in v1.** With PHI in scope, third-party code in-process is an unacceptable security/upgrade/support liability. Extensibility is delivered configuration-first: clinical/digital form template engines, country compliance config packs, public API + signed webhooks + first-party connectors, report/dashboard builders, declarative rule configs. The internal module system already provides first-party pluggability (modules register behind flags — a "hospital-specific module" is a first-party module flagged to one tenant when truly justified). Revisit with a sandboxed marketplace design (separate ADR) only when partner strategy demands it.

## 4. Execution Rules (start now, cost ≈ zero)

1. Tag every module `platform | hms` in its `index.ts` metadata; CI forbids `platform → hms` dependencies. **(P0 task)**
2. Platform modules use `refType/refId` polymorphism and neutral vocabulary (Rule P1).
3. The approval-engine extraction (Workflow row above) is a named backlog item — the second approval chain implemented must trigger it (note in PROJECT_MEMORY when it happens).
4. Do **not** split platform modules into a separate repo/services now — same monorepo, discipline only. Extraction into `@paperlesstech/platform` packages happens when product #2 is funded, and will be mechanical if rules 1–2 held.
5. Product #2 architecture = this stack verbatim: master registry gains a `product` field; a School ERP tenant is `sch_<slug>` resolved by the same Connection Manager.

## 5. What This Buys

When School ERP starts, day-one inheritance: tenancy/provisioning, auth/SSO/MFA, RBAC engine, plans/billing/licensing/metering, notifications, files, audit, search, reports engine, jobs, AI layer, white-label, webhooks, observability conventions, and this entire governance layer (constitution/guidelines/catalog templates) — leaving only the school domain modules to build. That is the platform bet, and it's enforced by two CI rules, not by hope.
