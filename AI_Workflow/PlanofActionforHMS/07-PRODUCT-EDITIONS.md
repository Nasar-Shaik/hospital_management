# 07 — Product Editions

One codebase, ten editions. An **edition** is a named, sellable composition of **feature flags + subscription limits + default tenant configuration**. Editions are data (rows in `plans` with `entitlements[]` and `limits{}`), never code branches. Any tenant can be upgraded by changing its plan — no migration, no redeploy.

> **Enforcement points:** limits are metered in `usageCounters` and enforced at (1) creation APIs (e.g., adding user #26 on a 25-user plan → `402 LIMIT_EXCEEDED` with upgrade hint), (2) login/entitlement resolution (flags cached in Redis), (3) storage/API middleware. Soft-warning at 80%, hard block at 100% (grace configurable per edition).

---

## 1. Organization Type → Edition Map (all 25 supported org types)

| # | Organization type | Edition | Notes |
|---|-------------------|---------|-------|
| 1 | Small Clinic | Clinic | |
| 2 | Single Doctor Clinic | Clinic | 1-doctor price floor |
| 3 | Dental Clinic | Clinic Plus | + `specialty.dental` |
| 4 | Eye Clinic | Clinic Plus | + `specialty.eye` |
| 5 | ENT Clinic | Clinic Plus | + `specialty.ent` |
| 6 | Physiotherapy Clinic | Clinic Plus | + `module.clinical.physiotherapy` |
| 7 | Diagnostic Center | Diagnostic | lab + radiology centric |
| 8 | Pathology Lab | Diagnostic | lab-only flag profile |
| 9 | Radiology Center | Diagnostic | radiology-only flag profile |
| 10 | Dialysis Center | Day Care | + `module.clinical.dialysis` |
| 11 | Day Care Surgery Center | Day Care | |
| 12 | Nursing Home | Nursing Home | |
| 13 | General Hospital | Hospital | |
| 14 | Multi Specialty Hospital | Multi Specialty | |
| 15 | Super Specialty Hospital | Multi Specialty | + specialty template packs |
| 16 | Hospital Group | Enterprise | multi-entity |
| 17 | Multi Branch Hospital | Multi Specialty / Enterprise | by branch count |
| 18 | Medical College Hospital | Medical College | |
| 19 | Government Hospital | Government | |
| 20 | Corporate Hospital | Enterprise | |
| 21 | International Hospital | Enterprise | + regional deployment, i18n, JCI pack |
| 22 | Telemedicine Provider | Clinic Plus | teleconsult-centric flag profile |
| 23 | Home Healthcare | Clinic Plus | + `module.clinical.homeHealthcare` |
| 24 | Corporate Occupational Health Center | Clinic Plus | + `module.clinical.occupationalHealth` |
| 25 | Enterprise Healthcare Network | Enterprise | dedicated cluster |

Within an edition, **flag profiles** (e.g., "lab-only" Diagnostic) tune defaults without creating a new edition.

---

## 2. Limits Matrix (summary)

"∞" = no platform-imposed cap (fair-use policy applies). Storage excludes DICOM add-on packs.

| Limit | Clinic | Clinic Plus | Diagnostic | Day Care | Nursing Home | Hospital | Multi Specialty | Enterprise | Medical College | Government |
|---|---|---|---|---|---|---|---|---|---|---|
| Max users | 10 | 25 | 30 | 40 | 60 | 150 | 400 | ∞ | 600 | per contract |
| Max doctors | 3 | 10 | 10 (referrers ∞) | 15 | 20 | 60 | 200 | ∞ | 300 | per contract |
| Max branches | 1 | 2 | 3 | 2 | 2 | 3 | 10 | ∞ | 3 | per contract |
| Max beds | — | — | — | 20 | 50 | 150 | 500 | ∞ | 1000 | per contract |
| Max active patients | 5k | 20k | 50k | 30k | 40k | 200k | 1M | ∞ | 1M | per contract |
| Storage | 10 GB | 50 GB | 200 GB | 100 GB | 100 GB | 500 GB | 2 TB | custom | 2 TB | custom |
| API rate (req/min/tenant) | 300 | 600 | 1,200 | 900 | 900 | 3,000 | 6,000 | custom | 6,000 | custom |
| Public API keys | — | 1 | 3 | 2 | 2 | 5 | 10 | ∞ | 10 | per contract |
| Webhooks | — | 2 | 5 | 3 | 3 | 10 | 25 | ∞ | 25 | per contract |
| SLA | 99.5% | 99.5% | 99.9% | 99.9% | 99.9% | 99.9% | 99.9% | 99.95% | 99.9% | per contract |
| DB placement (every tenant has its own DB) | shared cluster | shared cluster | shared cluster | shared cluster | shared cluster | shared cluster | shared or dedicated server | dedicated server/cluster | dedicated server | dedicated server/cluster (on-prem option) |
| White-label | — | logo/theme | logo/theme | logo/theme | logo/theme | + custom domain | + custom domain | full (incl. mobile builds) | + custom domain | full |

---

## 3. Editions

### 3.1 Clinic Edition
- **Purpose:** Run a small OP practice — register, book, consult, prescribe, bill — in under a day of setup.
- **Target customers:** Small clinics, single-doctor clinics (org types 1–2).
- **Enabled modules:** A3–A7 (platform basics), B1, C1 (OP registration only), C2 (basic), D1 (SOAP/prescription subset), D2, D3, E1, F1 (OP billing), patient portal (view/book/pay), basic reports.
- **Disabled modules:** IPD/beds, ED/ICU, OT, lab*, radiology*, pharmacy*, blood bank, inventory, finance GL, HR/payroll, insurance/TPA, AI. (*orderable as add-ons)
- **Feature flags:** `module.clinical.emr(basic)`, `module.ops.appointments`, `module.finance.opBilling`, `portal.patient` — all IPD/clinical-depth flags off.
- **Limits:** see matrix.
- **Pricing tier placeholder:** `PLAN_CLINIC` (₹/$ per doctor/month).
- **Upgrade path:** → Clinic Plus (specialty/tele/lab add-ons) → Hospital.

### 3.2 Clinic Plus
- **Purpose:** Specialty and multi-doctor clinics with teleconsult, specialty charting, and diagnostics-lite.
- **Target customers:** Dental/eye/ENT/physio clinics, telemedicine providers, home healthcare, occupational health centers (org types 3–6, 22–24).
- **Enabled modules:** Clinic + D4 teleconsult, specialty charting templates, D13 physio (flagged), lab-lite (order + external results), pharmacy-lite (dispensing), packages/wallet, WhatsApp/SMS reminders, home-healthcare & occupational-health modules (flagged).
- **Disabled modules:** IPD/beds, ED/ICU, OT, blood bank, full inventory, finance GL, HR/payroll, insurance claims, AI (add-on).
- **Feature flags:** Clinic set + `specialty.*` (per clinic type), `module.clinical.teleconsult`, `module.clinical.physiotherapy|homeHealthcare|occupationalHealth` (per profile), `module.pharmacy.dispensing`.
- **Pricing tier placeholder:** `PLAN_CLINIC_PLUS`.
- **Upgrade path:** → Diagnostic (if imaging/lab grows) or Hospital.

### 3.3 Diagnostic Edition
- **Purpose:** LIS/RIS-first operation — orders, samples, analyzers, reporting, referrer network. Patients are visitors, not admissions.
- **Target customers:** Diagnostic centers, pathology labs, radiology centers (org types 7–9).
- **Enabled modules:** D6 LIS (full incl. analyzer integration), D7 RIS/PACS-lite, C1 (visit registration), E1 (slot booking), F1 (diagnostic billing), referrer/doctor network + payout tracking, patient portal (reports), home-collection app, B2E corporate packages.
- **Disabled modules:** IPD/beds, ED/ICU, OT, nursing, MAR, blood bank, pharmacy retail, HR-lite only, AI (add-on).
- **Feature flags:** `module.clinical.lis`, `module.clinical.ris`, `module.integrations.analyzers`, `module.finance.referrerPayouts`; flag profiles: lab-only / radiology-only / both.
- **Pricing tier placeholder:** `PLAN_DIAGNOSTIC` (+ per-DICOM-GB add-on).
- **Upgrade path:** → Multi Specialty (if the center becomes a hospital) or Enterprise (lab chains).

### 3.4 Day Care Edition
- **Purpose:** Same-day admission→procedure→discharge pathways with a small bed complement and OT/dialysis scheduling.
- **Target customers:** Day care surgery centers, dialysis centers (org types 10–11).
- **Enabled modules:** Diagnostic-lite + B4 beds (small), D8 OT (day-care pathway), D12 dialysis (flagged), anesthesia records, consent, discharge summary, F1 (package billing), insurance pre-auth (single-payer flow).
- **Disabled modules:** Full IPD nursing stations, ICU flowsheets, blood bank, mortuary, HR/payroll (lite), AI (add-on).
- **Feature flags:** `module.clinical.ot(dayCare)`, `module.clinical.dialysis` (per profile), `module.finance.packages`, `module.finance.preAuth`.
- **Pricing tier placeholder:** `PLAN_DAYCARE`.
- **Upgrade path:** → Nursing Home / Hospital.

### 3.5 Nursing Home Edition
- **Purpose:** Small inpatient facility — IPD, nursing, MAR, basic OT/labour room, pharmacy, without the full hospital stack.
- **Target customers:** Nursing homes, small maternity/surgical facilities (org type 12).
- **Enabled modules:** Day Care + full B4 bed management, D5 nursing (MAR, handover, care plans), D14 dietetics-lite, F4 pharmacy (full), F1 IP billing, basic F7 HR (attendance/leave).
- **Disabled modules:** ED tracking board, ICU flowsheets (add-on), blood bank, CSSD (add-on), finance GL (add-on), payroll (add-on), AI (add-on).
- **Feature flags:** `module.ops.ipd`, `module.clinical.nursing`, `module.pharmacy.full`, `module.finance.ipBilling`.
- **Pricing tier placeholder:** `PLAN_NURSING_HOME` (per bed/month component).
- **Upgrade path:** → Hospital Edition.

### 3.6 Hospital Edition
- **Purpose:** The complete single-hospital HIS — every clinical, financial and operational department of a general hospital.
- **Target customers:** General hospitals, corporate single-site hospitals (org type 13).
- **Enabled modules:** Everything in Nursing Home + D10 ED/triage, D11 critical care, D6/D7 full, D9 blood bank, B12 CSSD, B13 mortuary, C7 MRD, F2 insurance/TPA/claims, F5 inventory, F6 finance GL, F7 full HR/payroll, I1/I2 reports & dashboards, biomedical waste, ambulance, diet/laundry/housekeeping.
- **Disabled modules:** Multi-entity consolidation, regional deployment, academic modules; AI as paid add-on.
- **Feature flags:** all `module.*` on except `module.platform.multiEntity`, `module.academic.*`.
- **Pricing tier placeholder:** `PLAN_HOSPITAL` (per bed/month + modules).
- **Upgrade path:** → Multi Specialty (more branches/specialties) → Enterprise.

### 3.7 Multi Specialty Edition
- **Purpose:** Large multi/super-specialty hospitals and small chains — specialty template packs, up to 10 branches, consolidated reporting.
- **Target customers:** Multi-specialty and super-specialty hospitals, multi-branch hospitals (org types 14, 15, 17).
- **Enabled modules:** Hospital + all specialty charting packs (cardiac/ortho/onco/IVF/neuro…), inter-branch transfers, consolidated group dashboards, custom report builder, public API + webhooks (10/25), optional dedicated DB.
- **Disabled modules:** Multi-entity legal consolidation, white-label mobile builds, regional data planes.
- **Feature flags:** Hospital set + `specialty.pack.*`, `module.ops.interBranch`, `module.analytics.groupDashboards`, `platform.dedicatedDb(optional)`.
- **Pricing tier placeholder:** `PLAN_MULTI_SPECIALTY`.
- **Upgrade path:** → Enterprise.

### 3.8 Enterprise Edition
- **Purpose:** Hospital groups and healthcare networks — unlimited scale, dedicated infrastructure, white-label, contractual SLA.
- **Target customers:** Hospital groups, corporate chains, international hospitals, enterprise healthcare networks (org types 16, 20, 21, 25).
- **Enabled modules:** All. Plus multi-entity (group holding → hospitals → branches), regional deployments/data residency pinning, SSO/SAML, white-label web + mobile builds, dedicated DB or dedicated cluster, custom integrations, priority support, AI suite included.
- **Disabled modules:** None (academic modules optional).
- **Feature flags:** all on; `platform.multiEntity`, `platform.regionPinning`, `platform.dedicatedCluster`, `whitelabel.mobileBuilds`, `ai.*`.
- **Limits:** contractual; usage-metered billing.
- **Pricing tier placeholder:** `PLAN_ENTERPRISE` (annual contract + usage).
- **Upgrade path:** terminal tier; growth via add-ons, regions, entities.

### 3.9 Medical College Edition
- **Purpose:** Teaching hospital + academics — the full Hospital stack plus students, residents, rotations, and research data needs.
- **Target customers:** Medical college hospitals, teaching hospitals (org type 18).
- **Enabled modules:** Hospital/Multi Specialty + academic module set: student/resident registry, rotation & duty rosters, supervised-signature workflows (resident writes → consultant countersigns), case-log books, anonymized research data extracts (IRB-gated), exam/assessment hooks.
- **Disabled modules:** White-label mobile builds; multi-entity optional.
- **Feature flags:** Hospital set + `module.academic.students|rotations|counterSign|caseLogs|researchExtracts`.
- **Pricing tier placeholder:** `PLAN_MEDICAL_COLLEGE`.
- **Upgrade path:** → Enterprise (university health systems).

### 3.10 Government Edition
- **Purpose:** Public hospitals — scheme-based (free/subsidized) billing, statutory reporting, Hindi/regional language depth, on-prem/air-gap option.
- **Target customers:** Government hospitals, district hospitals, public health facilities (org type 19).
- **Enabled modules:** Hospital stack + government scheme billing (Ayushman Bharat/PM-JAY, state schemes; zero-price tariffs with scheme claim tracking), ABDM/ABHA-first registration, statutory registers & health-program reporting (HMIS/IDSP uploads), Aadhaar eKYC, queue/token at scale, NHCX claims.
- **Disabled modules:** SaaS billing/dunning (procurement contracts instead), white-label.
- **Feature flags:** Hospital set + `module.finance.schemeBilling`, `module.integrations.abdm|nhcx|hmis`, `platform.onPrem(optional)`.
- **Limits:** per contract; deployments sized per facility census.
- **Pricing tier placeholder:** `PLAN_GOVERNMENT` (tender/contract).
- **Upgrade path:** state/district-wide network rollout (Enterprise-style dedicated infrastructure under government contract).

---

## 4. Add-on Packs (attachable to any edition)

| Add-on | Contents | Flag namespace |
|--------|----------|----------------|
| AI Suite | Scribe, OCR, chatbot, forecasting, coding assist | `ai.*` |
| DICOM/PACS Storage | Per-100GB DICOM packs + viewer | `module.integrations.pacs` |
| Insurance Desk | TPA workflows, NHCX, denial management | `module.finance.claims` |
| Patient Engagement+ | WhatsApp journeys, surveys/NPS, campaigns | `module.comms.campaigns` |
| Advanced Analytics | Custom report builder, data export API | `module.analytics.builder` |
| Compliance Pack | NABH/NABL evidence dashboards, audit exports | `module.compliance.evidence` |

---

## 5. Upgrade & Downgrade Rules

1. **Upgrades are instant** — plan change flips flags/limits at next entitlement refresh (≤5 min Redis TTL) or forced refresh on demand. No data migration: disabled-module data was simply never created.
2. **Downgrades are guarded** — blocked while usage exceeds target limits (e.g., 40 users → 25-user plan requires deactivating 15). Data from modules being disabled is **retained read-only** (export always available), never deleted — re-upgrading restores full access. This is the backward-compatibility guarantee.
3. **Placement promotion** — every tenant already has its own database; moving it from the shared cluster to a dedicated server/cluster is an infrastructure operation (`dbUri` change in the master registry, Doc 03 §1.5), orthogonal to edition, standard from Multi Specialty upward.
4. **Trials:** any edition can run a 30-day trial flag-profile; trial tenants carry `status: trial` and reduced limits.
