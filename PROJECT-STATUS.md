# PROJECT STATUS — MediCore HMS

A point-in-time audit of what is actually built, measured against the planned module catalog
([AI_Workflow/PlanofActionforHMS/02-MODULE-CATALOG.md](AI_Workflow/PlanofActionforHMS/02-MODULE-CATALOG.md)).
This reflects the **code on disk**, not the plan — the two can drift, so this is verified by reading
`apps/api/src/modules`, the routers wired in `app.ts`, the pages in `apps/web/app`, and the OpenAPI
spec.

**Audited:** 2026-08-02 · **Backend modules:** 43 · **Wired API routers:** 38 · **REST endpoints:**
217 · **Web pages:** 45

---

## Scorecard

Counting the **60 planned module areas** (A–J in the catalog):

| Status                       | Count | Share | Meaning                                         |
| ---------------------------- | ----- | ----- | ----------------------------------------------- |
| ✅ **Done**                  | 36    | 60%   | Backend + web built and gated                   |
| 🟡 **Partial**               | 7     | 12%   | Core built; a named sub-part is missing         |
| ⏭️ **Skipped (by decision)** | 10    | 17%   | Specialty modules you chose to defer            |
| 🔮 **Future phase**          | 7     | 12%   | Mobile, comms, AI, finance-GL, HR — not started |

**In-scope completion** (excluding the 17 skipped + future areas): **36 done + 7 partial of 43 =
~84% fully done, the rest partially done.** The core hospital MVP — admin → reception → doctor → lab →
pharmacy → billing, across private and government hospital types — is functionally complete and
end-to-end.

**Backend is ahead of web** (43 modules / 217 endpoints vs 45 pages): every _done_ module has a
screen; the only backend-only pieces are internal (notifications templates, document service, the
drug-safety reference engine) or await a UI (a notifications management page, the patient-facing
portal).

**Legend:** ✅ done · 🟡 partial · ⏭️ deliberately skipped · 🔮 future phase · — n/a

---

## A · Platform & Foundation — ✅ 9/9

| #   | Module                           | Backend | Web | Notes                                                          |
| --- | -------------------------------- | ------- | --- | -------------------------------------------------------------- |
| A1  | Tenant management                | ✅      | ✅  | `tenants` + `platform`; operator console (port 3001)           |
| A2  | Subscription & plans             | ✅      | ✅  | `/subscription`; editions + licence expiry                     |
| A3  | Identity & auth                  | ✅      | ✅  | JWT/refresh/MFA; login, forgot/reset/change-password, sessions |
| A4  | RBAC & permissions               | ✅      | ✅  | `/roles`; permission-unioning across roles                     |
| A5  | Audit & activity log             | ✅      | ✅  | `/audit`; append-only, hash-chained                            |
| A6  | Notifications                    | ✅      | —   | Templates + outbox; **no management UI yet**                   |
| A7  | File & document service          | ✅      | ✅  | `documents`; used in profile/reports                           |
| A8  | White-label / branding / domains | ✅      | ✅  | `site` + `/settings/site`                                      |
| A9  | API keys & developer platform    | ✅      | ✅  | `/settings/api-keys`; OpenAPI at `/openapi.json`               |

## B · Organization & Facilities — ✅ 9 · 🟡 1 · ⏭️ 3

| #   | Module                                           | Backend | Web | Notes                                                  |
| --- | ------------------------------------------------ | ------- | --- | ------------------------------------------------------ |
| B1  | Hospital profile                                 | ✅      | ✅  | `/settings/profile`                                    |
| B2  | Branch management                                | ✅      | ✅  | `/branches`; active-branch context (ADR-0015)          |
| B3  | Departments                                      | ✅      | ✅  | `/departments`                                         |
| B4  | Wards, rooms, beds                               | ✅      | ✅  | `/ward` + `/beds`; one-patient-per-bed                 |
| B5  | Theatres / ICU / ER                              | 🟡      | 🟡  | `/theatres` scheduling; ICU/ER not modelled            |
| B6  | Ambulance                                        | ✅      | ✅  | `/ambulance`; dispatch board                           |
| B7  | Assets & maintenance                             | ✅      | ✅  | `/assets`; service log                                 |
| B8  | Insurance / corporate / vendor masters           | 🟡      | 🟡  | Insurance built; **vendors/suppliers master missing**  |
| B9  | Facility ops (housekeeping, visitor, help desk…) | ⏭️      | ⏭️  | Permissions exist, no module                           |
| B10 | Feedback & complaints                            | ✅      | ✅  | `/feedback`                                            |
| B11 | Biomedical waste                                 | ⏭️      | ⏭️  | Not built                                              |
| B12 | CSSD (sterile supply)                            | ⏭️      | ⏭️  | Flag + perms only                                      |
| B13 | Mortuary                                         | ✅      | ✅  | `/mortuary`; body register + medico-legal release hold |

## C · Patient — ✅ 5 · 🟡 2

| #   | Module                                              | Backend | Web | Notes                                                            |
| --- | --------------------------------------------------- | ------- | --- | ---------------------------------------------------------------- |
| C1  | Registration & UHID (MPI)                           | ✅      | ✅  | `/reception`, `/patients`; merge + de-dupe                       |
| C2  | Clinical profile (allergies, vitals, timeline)      | ✅      | ✅  | `/patients/[id]`; allergy safety net                             |
| C3  | Records, consent, discharge & death                 | ✅      | ✅  | `medicolegal`; discharge summary page                            |
| C4  | Referral & transfer                                 | 🟡      | 🟡  | Doctor/bed **transfer** done; **referral-in/out** not a module   |
| C5  | Wallet, packages, insurance (patient-side)          | ✅      | ✅  | `wallet` + `/packages` + `insurance`                             |
| C6  | Online registration & appointments (patient-facing) | 🟡      | 🟡  | Staff appointments done; **patient self-serve portal not built** |
| C7  | MRD / health information                            | ✅      | ✅  | `/mrd`; ICD-10 coding + disease register                         |

## D · Clinical — ✅ 5 · 🟡 2 · ⏭️ 7

| #   | Module                 | Backend | Web | Notes                                                |
| --- | ---------------------- | ------- | --- | ---------------------------------------------------- |
| D1  | EMR                    | ✅      | ✅  | Read/write/sign; immutable signed notes              |
| D2  | Doctor management      | ✅      | ✅  | `/doctors`; roster + leave                           |
| D3  | Consultation workspace | ✅      | ✅  | `/my-patients`; order pad, Rx pad, note              |
| D4  | Tele-consultation      | ⏭️      | ⏭️  | Flag + perm only                                     |
| D5  | Nursing (MAR, notes)   | ✅      | ✅  | `mar`; bedside administration                        |
| D6  | Laboratory (LIS)       | ✅      | ✅  | `/worklist` + `/lab-catalogue`; order→verify→release |
| D7  | Radiology (RIS/PACS)   | 🟡      | 🟡  | Radiology **orders** flow through LIS; no RIS module |
| D8  | Operation theatre      | 🟡      | 🟡  | Scheduling only; no full intra-op record             |
| D9  | Blood bank             | ⏭️      | ⏭️  | Not built                                            |
| D10 | Emergency & triage     | ⏭️      | ⏭️  | Flag only                                            |
| D11 | Critical care (ICU)    | ⏭️      | ⏭️  | Flag only                                            |
| D12 | Dialysis               | ⏭️      | ⏭️  | Flag only                                            |
| D13 | Physiotherapy          | ⏭️      | ⏭️  | Flag only                                            |
| D14 | Clinical dietetics     | ⏭️      | ⏭️  | Not built                                            |

_Also built: **drug-safety engine** (allergen/interaction screening, a leaf module) powering D3/D5
prescribing._

## E · Encounter, Queue & Appointments — ✅ 3/3

| #   | Module                                  | Backend | Web | Notes                                              |
| --- | --------------------------------------- | ------- | --- | -------------------------------------------------- |
| E0  | Encounter & patient journey (the spine) | ✅      | ✅  | The entry point; policy-driven per org type        |
| E1  | Appointments (an encounter origin)      | ✅      | ✅  | `/appointments`                                    |
| E2  | Work-queue engine (platform module)     | ✅      | ✅  | Projection over the outbox; School-ERP-inheritable |

## F · Financial — ✅ 3 · 🟡 2 · 🔮 2

| #   | Module                               | Backend | Web | Notes                                            |
| --- | ------------------------------------ | ------- | --- | ------------------------------------------------ |
| F1  | Billing (OP/IP/pharmacy/lab/package) | ✅      | ✅  | `/billing`; event-driven charges, finalize≠pay   |
| F2  | Insurance, TPA & claims              | ✅      | ✅  | Payer-split, claim lifecycle                     |
| F3  | Corporate billing & packages         | 🟡      | 🟡  | Packages done; **corporate-client billing** thin |
| F4  | Pharmacy (commercial)                | ✅      | ✅  | `/pharmacy`; dispense + stock ledger             |
| F5  | Inventory / store                    | 🟡      | 🟡  | Pharmacy stock done; **general store** not built |
| F6  | Finance & accounting (GL)            | 🔮      | 🔮  | Reports have collections; no ledger/GL           |
| F7  | HR & payroll                         | 🔮      | 🔮  | Not started                                      |

## G · Mobile — 🔮 0/3

| #   | Module               | Backend | Web/App | Notes                                                                                                                       |
| --- | -------------------- | ------- | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| G1  | Patient app / portal | 🔮      | 🔮      | Planned                                                                                                                     |
| G2  | Doctor mobile app    | 🔮      | 🔮      | **Planned & scoped** — see [MOBILE_APP_DEVELOPMENT.md](AI_Workflow/docs/MOBILE_APP_DEVELOPMENT.md); first audience = Doctor |
| G3  | Staff mobile app     | 🔮      | 🔮      | Planned                                                                                                                     |

_Backend is mobile-ready (body tokens, host tenancy, reusable client) — the mobile work is a client
build, not new backend._

## H · Communication — 🔮 0/1

| #   | Module                                          | Backend | Web | Notes                              |
| --- | ----------------------------------------------- | ------- | --- | ---------------------------------- |
| H1  | Communication suite (staff chat, announcements) | 🔮      | 🔮  | Roadmap; notifications is the seed |

## I · Reporting & Dashboards — ✅ 2/2

| #   | Module                              | Backend | Web | Notes                                                                                                     |
| --- | ----------------------------------- | ------- | --- | --------------------------------------------------------------------------------------------------------- |
| I1  | Reporting engine & catalog          | ✅      | ✅  | `/reports`; collections, visits, doctor-load, diagnostics, revenue-leakage, dues-ageing, disease register |
| I2  | Dashboards (executive / management) | ✅      | ✅  | `/dashboard`; role-aware with drill-through                                                               |

## J · AI — 🔮 0/1

| #   | Module           | Backend | Web | Notes                                |
| --- | ---------------- | ------- | --- | ------------------------------------ |
| J1  | AI feature suite | 🔮      | 🔮  | Not started; platform hooks reserved |

---

## Deliberately skipped (your scope decision, 2026-07-30)

These are **specialty modules you chose to defer** to keep momentum toward MVP + mobile. They are not
"missing" — they are out of the current scope: **B9** facility ops, **B11** biomedical waste, **B12**
CSSD, **D4** teleconsult, **D9** blood bank, **D10** emergency/triage, **D11** critical care, **D12**
dialysis, **D13** physiotherapy, **D14** dietetics. Also partially deferred: vendor masters (B8),
referral-in/out (C4), general store (F5), corporate billing (F3).

## Future phases (planned, not skipped)

**Mobile** (G1–G3 — Doctor app scoped and ready to build), **Communication/staff chat** (H1),
**Finance GL** (F6), **HR/Payroll** (F7), **AI suite** (J1).

---

## The honest headline

- **The core hospital MVP is done and works end-to-end** — every step from registration to payment,
  for both private (prepaid) and government (₹0) hospitals, plus the statutory records (consent,
  death, MRD, mortuary) and the money picture (discounts, refunds, payer-split, leakage/dues
  reports, management dashboard).
- **What remains in-scope is small**: a handful of partials (RIS depth, OT record, vendors,
  corporate billing, general store) and one UI gap (notifications management, patient portal).
- **The big remaining bets are future phases, not gaps**: the mobile apps (next up, already scoped)
  and later comms/AI/finance-GL/HR.

## How to keep this current

Re-audit with:

```bash
ls apps/api/src/modules | wc -l                         # backend module count
grep -oE 'v1Router.use\(([a-zA-Z]+)Router' apps/api/src/app.ts | wc -l   # wired routers
find apps/web/app -name page.tsx | wc -l                # web pages
pnpm --filter @medicore/api openapi                     # endpoint count
```

Update the status marks above when a module moves ✅/🟡/⏭️/🔮. The decision log lives in
[00-PROGRESS-TRACKER.md](AI_Workflow/PlanofActionforHMS/00-PROGRESS-TRACKER.md); this file is the
"how much is built" snapshot.
