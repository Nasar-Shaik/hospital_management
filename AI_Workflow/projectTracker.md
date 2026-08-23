# Project Tracker — MediCore HMS

**The live list of what is done and what is left.** Read from the source tree and the quality
gates on 2026-08-14, then reconciled against the written docs. Where a doc and the code disagreed,
the code won and the difference is recorded in §10.

> **Update rule.** Change a module's state in the same commit that changes the module. A tracker
> updated afterwards is a tracker nobody trusts — which is exactly what happened to
> [00-PROGRESS-TRACKER.md](PlanofActionforHMS/00-PROGRESS-TRACKER.md), whose ledger still marks
> shipped modules as not started.

**How this file relates to the others**

| File                                                                  | Role                                                                                           |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **`projectTracker.md`** (this file)                                   | What is done, what is pending, what to do next. The working list.                              |
| [`PROJECT-STATUS.md`](../PROJECT-STATUS.md)                           | Point-in-time engineering audit — how sound the built parts are, with evidence.                |
| [`PROJECT_MEMORY.md`](PROJECT_MEMORY.md)                              | Why decisions were made. Not a status file.                                                    |
| [`00-PROGRESS-TRACKER.md`](PlanofActionforHMS/00-PROGRESS-TRACKER.md) | Historical decision log + activity history. **Its module ledger is superseded by §4–§5 here.** |

---

## 1. Snapshot

|                        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Branch**             | `feature/0.1` — **12 commits unpushed**, HEAD `f64f34f`, tree clean (2026-08-19)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Phases complete**    | 2 of 10 (P0, P1) · P2 ~55% · P3 ~30% · P5 ~35%                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **API**                | **45 modules · 243 OpenAPI paths · 294 contract operations · 54 tenant migrations · 14 default roles · 160 permissions (92 active, 68 declared)** — counted 2026-08-20                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Web**                | 48 screens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Mobile**             | 27 screens · **M0–M3 delivered** (foundation, doctor, nurse)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Tests passing**      | **4,338** — 2,057 API integration · 1,668 mobile · 356 web · 239 API unit · 18 packages · **45 Playwright** on top                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Gates**              | **`pnpm gate:full` green end to end, 2026-08-19** — format · lint 18/18 · typecheck 18/18 · unit · openapi (234 paths) · contract (283 ops, additive only) · client · integration **2,057/2,057** · build · boundaries (0 violations, 1,151 modules) · **e2e 45**. T3 (the wandering integration flake) was root-caused and **closed 2026-08-17**; its guard is still armed. **The one unexplained 2026-08-19 failure was reproduced, named and fixed** — it was a real 500 under a concurrent triage, plus a second harness race in `dropDatabases`. See `TESTING.md` §9.                                                                                                                                                                                                                                                                                                                    |
| **Test environment**   | ✅ **Ready** — `pnpm seed:validation` builds a 45-bed, 42-patient ward across two sites and two timezones; `--verify` checks the **schema** (3) then the **data** (19), and refuses a database that cannot enforce the clinical invariants. See `SEED.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **API pre-validation** | ✅ 2026-08-14 — **43 server-side safety checks**, two real nurses racing one dose. Duplicate prevention, 409-as-answer, idempotent replay and lost-response reconciliation all hold.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Manual validation**  | 🔴 **0 executed.** Procedure now written: [`docs/MANUAL_VALIDATION_RUNBOOK.md`](docs/MANUAL_VALIDATION_RUNBOOK.md). Mobile M2 0/61 · M3 0/45 · Web 0/24 · **Journey 0/25 (§13A, new 2026-08-17)** · safety, permission and negative suites 0. **Nothing has been seen on a screen by a person.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Open defects**       | **4 fixed 2026-08-16** (D1 · D2 · D3 · D6) · **3 fixed 2026-08-17** (D9 cross-branch appointment write · D10 cross-branch report file · D13 mobile discarded the paper instruction) · **2 closed 2026-08-17** (D11, D12). **2 reclassified** as deliberate design (D4, D5). **1 open** — D7, a product decision. **P0 = 0, P1 = 0.** T2 partially controlled. See `docs/RISK_REGISTER.md` §0 and its 2026-08-17 P2 review.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **CI**                 | 🔴 Billing-locked off-repo. No workflow has ever executed. `pnpm gate` on one machine is the only gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Next action**        | **AWAITING REVIEW.** C2 (Theatre + Emergency v1 finalisation) executed 2026-08-19 as an AUDIT, not a build: both modules were measured against the practical hospital workflow and found sufficient. **One genuine gap in each.** Theatre — the operative note was reachable only from `/my-patients`, the doctor's LIVE QUEUE, so it left the product's reach when the visit closed; the durable chart now carries a Procedures tab (`/patients/:id`), gated on `module.clinical.ot`. Emergency — the board carried `doctorId` and dropped it, so a row read "With doctor" without saying which; it now names the doctor and the arrival time. No new subsystems: no anaesthesia, PACU, ESI, ED analytics, or module-specific billing (`THEATRE.md` and `EMERGENCY.md` list them as FUTURE). Stage A defects D14–D21 all fixed. Mobile (`M2` 0/61, `M3` 0/45) still needs hardware and eyes. |

---

## 2. Status legend

| Mark | Meaning                                           |
| ---- | ------------------------------------------------- |
| `✅` | Done — built, tested, and exercised end to end    |
| `🟨` | Partial — real code exists; named gap in the note |
| `⬜` | Not started — no module in `apps/api/src/modules` |

Route counts are registered HTTP handlers per module directory, a proxy for **depth, not quality**.
A low count on a `🟨` module usually means the write side is thin.

---

## 3. Phases

| Phase | Scope                                                                                     | Status               |
| ----- | ----------------------------------------------------------------------------------------- | -------------------- |
| P0    | Monorepo, CI, Docker Compose, design tokens, OpenAPI baseline                             | ✅ 100%              |
| P1    | Foundation — master DB, tenant provisioning, connection manager, auth / JWT / MFA         | ✅ 100%              |
| P2    | Core operations — masters, patients & MPI, doctors & schedules, appointments, queue, beds | 🟨 ~55%              |
| P3    | Clinical — EMR, consultation, nursing, LIS, RIS, theatre, blood bank                      | 🟨 ~30%              |
| P4    | Financial — billing engine, pharmacy, inventory, insurance & claims, finance GL           | 🟨 ~30%              |
| P5    | Applications — mobile (staff / doctor / patient), communication, home healthcare          | 🟨 ~35%              |
| P6    | Analytics — reporting engine, read models, dashboards                                     | 🟨 ~10%              |
| P7    | Integrations — payments, comms, analysers, HL7 / FHIR / DICOM, ABDM / NHCX, SSO           | ⬜ 0%                |
| P8    | AI suite — advisory, human-in-the-loop                                                    | ⬜ 0%                |
| P9    | Hardening, compliance, disaster recovery, GA                                              | 🟨 runs continuously |

**P3 and P4 were both recorded as 0% and both were wrong.** Billing has 28 routes and a working
receipt flow; the pharmacy has a medicine master and an append-only stock ledger; the clinical loop
runs encounter → consultation note → prescription → dispense → order → result → MAR. They are thin,
not absent, and calling them zero hid real gaps behind an easy number. See §10.

---

## 4. Completed

### A · Platform & tenancy

- [x] **A1 Tenant management** (17) — registry, provisioning CLI, connection manager, operator console
- [x] **A3 Identity & auth** (13) — argon2id, JWT, MFA, rotating refresh with reuse detection
- [x] **A4 RBAC & permissions** (8) — 144-permission catalogue, matrix suite as a release gate
- [x] **A5 Audit & activity logging** (3) — append-only, hash-chained, tamper detection proven
- [x] **A5b Transactional outbox + relay** — ADR-0007, leader-locked, DLQ
- [x] **A6 Notification system — Communication v1 complete (2026-08-18).** Outbox-driven, one
      message per cause enforced by lease, and now **readable**: `GET /notifications/me` +
      `POST /:id/read` (5 routes), authenticated and deliberately unpermissioned, with a bell and
      `/alerts` on web and the M4 Alerts tab on mobile. The two STAFF templates moved from `email`
      to `inapp` (migration 0051) — `email.isEnabled()` requires an SMTP host, so on a default
      deployment `order.critical` was recorded `suppressed` and reached nobody. Patient templates
      and `password.reset` stay on email, for reasons in
      [`docs/COMMUNICATION_POLICY.md`](docs/COMMUNICATION_POLICY.md).
      **NOT built, deliberately:** push (FCM/APNs), SMS/WhatsApp, staff chat, broadcast, a patient
      inbox, sockets, per-user preferences. The inbox is **not branch-scoped** — a message is
      addressed to a person — and `scopedReads.test.ts` guards that it stays that way.
- [x] **A7 documents** (4) · **A8 branding** (site, 6) · **A9 API keys** (3) — MVP depth

### B · Organisation & facilities

- [x] **B1 Hospital profile** (2) · **B2–B3 Departments** (3) — hierarchy, cycle-guarded
- [x] **B4 Wards, rooms, beds, bed board** (9) — ward → room → bed, tariff resolution most-specific-wins
- [x] **B5 Operating theatre** (6) — registry + overlap-guarded bookings
- [x] **B6 Ambulance** (6) · **B7 Assets & maintenance** (5) · **B10 Feedback & complaints** (5)
- [x] **B13 Mortuary** (4)

### C · Patient

- [x] **C1 Patient registration & MPI** (7) — UHID from an atomic counter, duplicate refusal, merge without delete
- [x] **C3 Records, consent, discharge, death** (medicolegal 5, consents, death records) — **the terminal-states gap is closed**, see §6
- [x] **C5 Wallet & packages** (4)
- [x] **C7 MRD / HIM** (6)

### D · Clinical

- [x] **D2 Doctor management** — session roster, leave, and a doctor managing their **own** availability
- [x] **D5 Nursing — the safe core.** Vitals (3), ward notes, and the **Medication Administration
      Record** (3) hardened to a clinical-safety envelope: administration identity is
      `prescriptionId + lineIndex + scheduledFor` (migration 0049 unique index), `HMS-MAR-001`
      returns the existing row as an **answer** rather than a failure, and PRN is deliberately
      unconstrained. The ±4h slot tolerance that was a duplicate-administration escape path is gone.
- [x] **D6 Laboratory — LIS v1 complete (2026-08-18).** Doctor orders → charge raised → cashier
      collects → lab worklist → accept/start → result or uploaded report → pathologist verifies →
      releases → doctor reads it. Catalogue (4 routes) **now seeded** — CBC, LFT, RFT, Glucose,
      Lipid Profile with analytes and reference ranges, on the same codes the tariff prices — and
      read tenant-wide, so both sites see one definition (it was branch-filtered against a
      per-tenant unique index, which made a seeded catalogue invisible the moment a site was
      selected). Order-to-result pipeline (9 routes) with the two-person rule and category
      authority. Payment is **advisory at the API and held at the web worklist** — written up in
      [`docs/PAYMENT_POLICY.md`](docs/PAYMENT_POLICY.md). Browser coverage on the worklist;
      branch isolation pinned both directions.
      **NOT built, deliberately:** specimen tracking, barcodes, analyser interfacing, QC/EQAS.
      `lab:collect` and `lab:result` remain correctly `future()` — there is no specimen entity.

- [x] **D7 Radiology — RIS v1 complete (2026-08-18).** Doctor orders a study → charge raised →
      imaging worklist → accept/start → **narrative report** (findings and impression) with the
      film attached through the existing reports module → verify → release → doctor reads it on the
      chart. It rides the Order spine wholesale; no new pipeline and no second catalogue — the
      tariff is the study list, because imaging has no analytes to hold.
      **A radiologist is NOT required**, which is the milestone: `radiology:sign` gated verification
      and only RADIOLOGIST held it, so a hospital without a consultant could take the film, type the
      report and deliver neither. `RADIOLOGY_TECHNICIAN` now carries a study the whole way, without
      `emr:read`. A hospital that DOES employ radiologists gets the two-person model by editing
      roles — no code. `module.clinical.ris` now gates ordering (it gated nothing).
      Written up in [`docs/RADIOLOGY.md`](docs/RADIOLOGY.md).
      **NOT built, deliberately:** PACS, DICOM, modality integration, RIS scheduling, mandatory
      sign-off, second reader, structured imaging templates. `radiology:report` stays `future()`.

- [x] **B5/D8 Operation theatre — Theatre v1 complete (2026-08-19).** Surgeon books a theatre
      window → the OT list shows it → the room is started → the **operation record** is written →
      it reaches the patient's chart. The registry, the bookings, the overlap rule, the four-state
      machine and the screen already existed and were **not** rebuilt.
      What was missing was the record — `ot:record` was declared `future()` — and **a surgeon who
      could book**: `ot:schedule` was granted to no clinical role, so the only person in the
      building who could put a patient on a surgical list was the hospital administrator. Fourth
      instance of "a permission nobody holds is a feature nobody has".
      The record is **write-once**, enforced by a conditional update rather than a read-then-write,
      and may only be written on a procedure that has started — a note on a scheduled or cancelled
      booking would record an operation that did not happen. The overlap rule is tested at its
      BOUNDARIES (a back-to-back list is legal) and under concurrency.
      Written up in [`docs/THEATRE.md`](docs/THEATRE.md).
      **NOT built, deliberately:** pre-op checklists, anaesthesia, team roster, instrument/implant
      tracking, CSSD, OT inventory, PACU, blood, consumables, utilisation analytics, and amending a
      record. **Billing is a documented dependency, not a second system** — a `procedure` ORDER is
      what bills; a booking is scheduling.

- [x] **D10 Emergency & triage — Emergency v1 complete (2026-08-19).** Patient arrives → registered
      as an emergency → triaged → ranked on the board → sent to a doctor → worked up on the
      **ordinary** clinical screens → discharged, admitted, or sent to another hospital.
      **The ED is not a second hospital, it is a way in.** `origin: "emergency"` and `class: "ER"`
      already existed, and the encounter's own state machine already _is_ arrived → triaged → with
      a doctor → treatment → disposition. So this module owns exactly two things: the triage
      judgement (a person, a priority, a time) and the board. An integration test drives an ED lab
      order and asserts it lands on the ordinary bench, so a second clinical pipeline cannot be
      added quietly.
      `module.clinical.emergency` **gated nothing** and now gates the department; `triage:perform`
      went live and is held by NURSE and DOCTOR, not by the registration desk. **An unassessed
      patient sorts above every assessed one** — unknown severity is not low severity.
      Written up in [`docs/EMERGENCY.md`](docs/EMERGENCY.md).
      **NOT built, deliberately:** five-level triage scales, bay assignment, manual board
      re-ordering, MLC registration, ambulance/referral integration, ED analytics. Notifications
      were **evaluated and declined** — "a critical patient arrived" is addressed to a room, not a
      person, and the board is the alert.

### G · Support & supply

- [x] **G1/G3 General store — v1 complete (2026-08-20).** Store keeper adds a supplier → adds an
      item → receives a delivery → the shelf rises → issues to a department → the shelf falls →
      the list says what to reorder. Three verbs, one shelf **per site**, one append-only ledger.
      Chosen by the 2026-08-20 product audit as the only core operational department with no
      software at all: every hospital consumes gloves, syringes, IV sets and linen daily, and the
      product could not say what was on the shelf, who supplied it, or what to reorder.
      It reuses the pharmacy's PATTERN and none of its tables — a glove has no form, no strength
      and no batch, and must never reach a prescribing pad. **The balance is per branch**, unlike
      the pharmacy's hospital-wide total: a store is a room, and the objection that stopped the
      pharmacy splitting (how do you divide an existing balance?) does not reach a new collection.
      **The shelf cannot go below zero** — the one rule the pharmacy deliberately does not have,
      arbitrated by a conditional update rather than a read-then-write, so two keepers reaching for
      the last boxes cannot both win.
      Five permissions went live (`inventory:manage|purchase|issue|audit`, `vendor:manage`), all
      five previously held by TENANT_ADMIN alone — the **fifth** instance of "a permission nobody
      holds is a feature nobody has". `STORE_KEEPER` is the new role, and it holds **nothing
      clinical**, which is why `GET /inventory-destinations` exists: `/departments` is gated on
      `patient:read`, and handing a store keeper every patient record to fill in a picker would
      have been the exact broad-grant mistake the catalogue exists to prevent.
      Written up in [`docs/INVENTORY.md`](docs/INVENTORY.md).
      **NOT built, deliberately:** purchase orders, approval chains, rate contracts, GRN matching,
      accounts payable, sub-stores, inter-branch transfer, ABC/VED, EOQ, barcodes, batch/expiry,
      patient-level consumable billing. `pharmacy:purchase` stays `future()` — the supplier master
      now exists, but wiring the drug shelf to it is a pharmacy change and the pharmacy is frozen.

### E–F · Front office & financial

- [x] **F4/F5 Pharmacy — v1 complete (2026-08-19).** Doctor prescribes (seeing availability, and
      restricted by none of it) → signs → the counter's queue → partial or full handover → stock
      falls **by batch, earliest expiry first** → billing is told what actually crossed the counter
      → the doctor sees `12/20 given`. Prescription, dispensing and billing are three different
      questions and the code keeps them apart.
      `medicineBatches` (migration 0052) makes expiry mean something: it was captured on receipt
      and read by nothing. Expired lots are excluded by the QUERY, never by an `if`; a lot cannot be
      over-drawn; a shortfall is recorded as `reconcile` rather than refused, because a bookkeeping
      problem must not hold a patient's medicine.
      Written up in [`docs/PHARMACY.md`](docs/PHARMACY.md).
      **NOT built, deliberately:** procurement, vendors, GRN, warehouses, POS, substitution,
      barcode hardware, expiry/low-stock notifications (both evaluated — see the doc).
      **Open:** per-branch stock is a product decision, not an oversight.

- [x] **E1 Appointments, queue, token** (22) — clinic hours now resolve in the **branch** timezone
- [x] **F1 Billing** (28) — estimates, invoices, receipts, refunds; packages visible, payee named

### G · Applications

- [x] **Mobile M0** — architecture approved: tenancy, session, branch, navigation, security model
- [x] **Mobile M1** — sign in, stay signed in, know your site, fail comprehensibly. Verified on hardware.
- [x] **Mobile M2 — doctor.** My patients, timeline, vitals & results, clinical writes, inpatient
      workflow, biometric screen lock. Forces a development build (`expo-local-authentication`).
- [x] **Mobile M3 — nurse.** Ward worklist, patient chart, vitals capture, single-dose MAR
      administration, medication round, hardening pass.
- [x] **Web M3 parity** — see §8

### Cross-cutting engineering

- [x] Multi-branch isolation — Phase 1 and 1.5; branch survives events and background work
- [x] API contract pipeline — `openapi:check`, `contract:check`, `client:check`, all falsified
- [x] `Idempotency-Key` — documented contract made real, 5 controls falsified, now consumed by web and mobile
- [x] API v1 compatibility policy — including the three breakages a schema diff cannot show
- [x] Deprecation / Sunset machinery — 12-month window enforced at startup
- [x] **Branch timezone is validated, not trusted** — and clinical dates are reckoned in it, on both clients
- [x] **Shared clinical primitives live in `@medicore/api-client`** — `marSlotTaken`, `attemptAdministration`,
      `reconcileSlot`, `attemptVitals`, `reconcileVitals`. One engine, two apps, no fork.
- [x] Local dev on a physical device — `dev:device-domains`, browser and handset work at once

---

## 5. Pending

### 5.0 Patient-merge re-pointing — **CLOSED 2026-08-23**

The invariant in `repointPatient.ts` ("every module that stores a `patientId` re-points its own
references") was a comment, and comments do not fail. An audit of the real schemas found **29
patient-bearing collections; 15 had a consumer and 14 did not** — the MAR, the consultation note,
the coded diagnosis, ED triage, theatre bookings, insurance cover and claims, consent, death
records, the mortuary register, ambulance trips, feedback tickets, the portal identity, and
`packageEnrollments`, which sat inside a module that already had a consumer and was missed by it.

All 14 now re-point through the existing `onPatientsMerged` architecture — no second mechanism.
`REPOINTED_PATIENT_REFERENCES` / `EXEMPT_PATIENT_REFERENCES` in `repointPatient.ts` are the
register, and `patientMergeCoverage.int.test.ts` reads the REAL schemas off a provisioned tenant
and fails on anything in neither list. Two exemptions, both because moving them would be the bug:
`auditLogs` (hash-chained history) and `outboxEvents` (a record of what was published).

**Still open, and recorded in the risk table:** the two-open-encounter collision.

### 5.1 Finish P2 — core operations

- [x] **B8** Partner masters — **suppliers landed 2026-08-20** (`vendor:manage`, §4 G1/G3), which
      is what unblocked goods-receipt. _Referrer masters are still not built._
- [ ] **B9** Facility ops — housekeeping states beyond `blocked`, visitor management
- [ ] **C2** Patient clinical profile — problem list across visits, immunisations, family history
- [ ] **C4** Referral out (bed-to-bed transfer exists)
- [ ] **C6** Online registration & digital forms

### 5.2 P3 — clinical

- [ ] **D1** EMR depth — ICD code master + search, order sets, problem list (encounters: 14 routes)
- [ ] **D3** Consultation workspace — structured note only (2 routes); templates, order sets
- [ ] **D5** Nursing depth — **intake/output, wound care, care plan, handover, and the nurse's own
      note permission.** The M3 audit named all five out of scope; they are the rest of a shift.
- [ ] **D6** LIS depth — specimen collection/accession state, panels, delta checks
- [ ] **D7** RIS depth — PACS/DICOM, modality worklists, structured templates, and radiologist
      sign-off as a hospital-configurable policy rather than a role edit
- [ ] **D9** Blood bank _(D7 Radiology v1 2026-08-18 · **D10 Emergency v1 2026-08-19** — see §4)_
- [ ] **D10** Emergency depth — five-level triage, bay assignment, MLC registration, ED analytics.
      _v1 landed 2026-08-19; `ed:board:manage` stays `future()` and now names what it is reserved
      for._
- [ ] **D11** Critical care · **D12** Dialysis · **D13** Physiotherapy · **D14** Dietetics
- [ ] **D4** Teleconsultation
- [ ] **D8** Theatre depth — anaesthetist/team, pre-op checklist, utilisation, instrument/implant
      tracking, and **amending an operation record**. _v1 landed 2026-08-19; see §4._

### 5.3 P4 — financial

- [ ] **F5** Inventory depth — PROCUREMENT only: purchase orders, GRN matching, payables.
      _The general store, the supplier master and goods-receipt landed 2026-08-20 (§4 G1/G3);
      pharmacy batch/expiry landed 2026-08-19. What is left is purchasing, deliberately._
- [ ] **F4** Pharmacy depth — OTC/walk-in sale (`pharmacy:sell`), purchasing (`pharmacy:purchase`), substitution. _Dispensing and stock completed 2026-08-19._
- [ ] **F2** Insurance / TPA / claims — beyond MVP (7 routes)
- [ ] **F3** Corporate & packages — enrolment exists, corporate billing does not
- [ ] **F6** Finance & accounting — general ledger · **F7** HR & payroll

### 5.4 P5–P9 — applications and platform services

- [ ] **Mobile M4–M7** — see §7 · **M8 patient app** deferred to the final phase
- [ ] **G2–G3** Doctor and patient portals (web)
- [ ] **H1** Communication suite — staff chat and broadcast. _The in-app inbox landed 2026-08-18._
- [ ] **I1–I2** Reporting & dashboards — beyond current partial (6 routes)
- [ ] **J1** AI suite · **K1** Security & compliance centre
- [ ] **Integrations** — ABDM/NHCX first (India), then HL7/FHIR, payments, analysers, SSO
- [ ] Home healthcare · occupational health
- [ ] **A2** Subscription — SaaS invoicing/dunning (needs a payment gateway)
- [ ] **A8** Custom-domain TLS routing — parked with the VPS/edge work

---

## 6. Gaps to close before widening scope

**Five of the six gaps this file opened on 2026-08-12 are closed.** They are kept here with their
resolution so the next audit does not re-investigate them.

| #   | Gap                                                  | State                                                                                                                                                                                                                                                                                                     |
| --- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **IPD terminal states** — LAMA/absconded/deceased    | ✅ **Closed.** `DISCHARGE_DISPOSITIONS`, `endStayWithOutcome`, and an `outcome_note` in the ward record. The tracker's claim that they record as an ordinary discharge was already false when written.                                                                                                    |
| 2   | **Pharmacy stock, batches, expiry** (F5)             | ✅ **Closed 2026-08-19.** `medicineBatches` gives each lot its own balance and expiry; dispensing takes FEFO and can never take an expired lot. Receipt demands a batch number and an expiry together, or neither. What is still absent is PURCHASING (vendors, GRN) — a different feature, not this gap. |
| 3   | **Bed inventory** — two patients in one bed          | ✅ **Closed.** `one_open_stay_per_bed_per_branch` partial-unique index arbitrates occupancy; proven by the branch-isolation suite.                                                                                                                                                                        |
| 4   | **`Branch.timezone` unvalidated**                    | ✅ **Closed** (`c262612`) — shape + `Intl` rule, and both clients now reckon clinical dates in it.                                                                                                                                                                                                        |
| 5   | **`resolveActiveBranch` accepts an INACTIVE branch** | ✅ **Closed** (`dadbf66`).                                                                                                                                                                                                                                                                                |
| 6   | **RBAC matrix test isolation**                       | ✅ **Not a code defect** (`b2253bd`) — Docker OOM on the dev host, ~7.75 GB across ~30 containers. Check for `Exited (137)` before blaming the suite.                                                                                                                                                     |

### Open risks, current

**Confirmed defects now live in [`docs/RISK_REGISTER.md` §0](docs/RISK_REGISTER.md)** — D1–D7, each
with its evidence. A found defect and a predicted risk are different things and no longer share a
list. What remains here is the standing risk picture.

| Risk                                                                                                                                          | Severity                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Nothing has been validated on a device or in a browser by a human** — 106 checks unticked                                                   | 🔴 Highest. The API layer beneath them was pre-validated 2026-08-14; the UI was not.                                                                                                                                                                                                                                                                                     |
| **Tenant databases do not converge on their own** — risk register T2, materialised 2026-08-14                                                 | 🔴 A stale tenant silently loses its safety indexes. `seed:migrate --all` is a workaround for a missing control, not a fix.                                                                                                                                                                                                                                              |
| **CI is billing-locked**; 8 commits unpushed                                                                                                  | 🔴 The work exists on one machine and has never been built anywhere else.                                                                                                                                                                                                                                                                                                |
| ~~**A merge collides on two open encounters**~~                                                                                               | ✅ **CLOSED 2026-08-23.** `mergePatients` now refuses with `409 HMS-PAT-003` naming both visits, before any state changes. The rule lives in `encounters` and is reached through `core/policy/mergeGuards.ts` — an inverted port, because `encounters` already imports `patients` for identity. Neither encounter is closed: which visit is real is a clinical decision. |
| **F5 expiry is captured and never read**                                                                                                      | 🟠 An expired batch can be dispensed with no signal.                                                                                                                                                                                                                                                                                                                     |
| ~~**Web has no nursing-note surface**~~ — **CLOSED.** F-2 shipped `AddChartNote` + `chartNoteCapability`; both clients write the nurse's note | 🟠 Mobile gained `POST /nursing-notes` (`nursing:manage`) at M3-S2; web did not. The boundary is correct; the surface is missing.                                                                                                                                                                                                                                        |
| **Allergy screening covers 15 demo drugs and is not a formulary**                                                                             | 🟠 Do not widen the drug list without widening the safety data.                                                                                                                                                                                                                                                                                                          |
| **Vitals render in the reader's timezone, not the ward's**                                                                                    | 🟡 Display only; the stored instant is correct.                                                                                                                                                                                                                                                                                                                          |
| Integration suite is **environment-sensitive**, not flaky — the host swaps under load                                                         | 🟡 Re-run before investigating; check Docker memory first.                                                                                                                                                                                                                                                                                                               |

---

## 7. Mobile — staff app

| Stage | Scope                                                                     | Status                                                                     |
| ----- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| M0    | Architecture — tenancy, session, branch, navigation, security             | ✅ Approved                                                                |
| M1    | Foundation — sign in, stay signed in, know your site, fail comprehensibly | ✅ 2026-08-12 · hardware-verified                                          |
| M2    | Doctor — my patients, timeline, vitals & results, writes, biometric gate  | ✅ 2026-08-13 · **0/61 device checks**                                     |
| M3    | Nurse — ward worklist, vitals capture, medication administration, round   | ✅ 2026-08-13 · **0/45 device checks**                                     |
| M4    | Alerts — inbox ✅ 2026-08-18 · **push ✅ 2026-08-20**                     | ✅ code · 🔴 **0/18 device checks** — repo side clear, awaiting `eas init` |
| M5    | Department worklists — lab/imaging queue, pharmacy dispense queue         | ⬜ _re-scoped 2026-08-20_                                                  |
| M6    | The departments that move — ED board + triage, theatre board              | ⬜ _re-scoped 2026-08-20_                                                  |
| M7    | Store at the shelf + hardening — accessibility, offline reads, release    | ⬜ _re-scoped 2026-08-20_                                                  |
| M8    | **Patient app — deferred to the final major phase, lowest priority**      | ⬜ Deferred                                                                |

### M4 delivered, 2026-08-20 — and it cannot be called done until a phone rings

Device-token registration, push delivery through the existing notification architecture,
notification → deep-link navigation, the token lifecycle, and the entitlement gap the audit found.

**Push is not a `Channel`, on purpose.** `dedupeKey` is unique per tenant, so a template delivered
on two channels collides on `one_message_per_cause` and the second is dropped as a duplicate —
the problem `COMMUNICATION_POLICY.md` already records for email-plus-inapp. The fan-out hangs off
the in-app delivery instead, which is what `channels/inapp.ts` said it would be from the day it was
written: _"a phone notification is a push wrapper around one of these rows, not a separate
system."_ The ledger row stays the message and stays authoritative; an Expo outage costs a buzz,
never an alert.

**The lock screen carries no identifiers.** The in-app subject reads "CRITICAL RESULT — Kamala Devi
— Serum Potassium"; pushing it would put a name, a test and a diagnosis-shaped fact on a handset
lying face-up on a desk. The push carries a fixed line per template — what happened, never who —
and the ids ride in the undisplayed `data`. An unclassified template falls back to "You have a new
alert", so forgetting one costs silence rather than disclosure.

**Two defects found by M4's own tests, one of them four months old:**

1. **No appointment reminder has ever been scheduled.** BullMQ builds its keys as
   `bull:<queue>:<jobId>` and rejects a custom id containing a colon;
   `reminder:{tenantId}:{appointmentId}` therefore made `add()` reject on every booking since A6.
   It failed inside an awaited call in a consumer, which surfaces as an ordinary job retry, so
   nothing said so. `scheduleTask` now refuses a colon up front (`taskQueue.test.ts`).
2. **The same bug in M4's own job id**, caught the same way — by a test that asserted on the
   QUEUED JOB rather than on `scheduleTask` having been called.

**The entitlement gap is closed.** `/auth/me` has carried `features` since D20 and the mobile
runtime dropped them; the session store now holds them and `tabsFor` gates on both halves, so a
nurse at a clinic with no nursing module is no longer offered a Ward tab that can only answer
`HMS-PLAN-002`.

**Validation, in three classes:** automated ✅ (27 API integration + 9 unit + 15 mobile, plus 11
falsifications) · emulator 🔴 none · **physical device 🔴 0 of 18**. See
[`docs/MOBILE_M4_DEVICE_CHECKLIST.md`](docs/MOBILE_M4_DEVICE_CHECKLIST.md).

### M4 follow-up, 2026-08-20 — the repository side of device validation is now clear

Everything that could be prepared in code has been. What remains is an Expo account, a build and a
phone; [`docs/MOBILE_PUSH_ENABLEMENT.md`](docs/MOBILE_PUSH_ENABLEMENT.md) is the runbook.

**A third silent-nothing defect, found while closing the first blocker.** `app.config.ts` rebuilt
its `extra` object from scratch, with no `...config.extra`. `eas init` writes the project id to
`app.json` — it cannot write into a dynamic config — so the id would have been **discarded on its
way through the config function**: a linked project in the repository, no project in
`expo config`, and `getExpoPushTokenAsync` going on returning `undefined` with nothing logged
anywhere. The first device session would have been spent chasing it. Same shape as the colon in
the BullMQ job id and the fifth instance of that class this month.

Also: the id is now accepted from `EAS_PROJECT_ID` as well as `app.json`; the
`expo-notifications` config plugin is registered, with `mode` derived from the build profile
(it writes the iOS `aps-environment` entitlement, and a sandbox/production mismatch is invisible —
Expo returns an `ok` ticket and the phone stays silent) and `defaultChannel` matching the one
channel the app creates; `android.googleServicesFile` is referenced only when present, so a
checkout without Firebase credentials still builds. All three verified by running `expo prebuild`
and reading the generated manifest and entitlements, not by reading documentation. `app.json` is
now `{}` — it held a stale `plugins` array that `app.config.ts` had been silently overriding.

**The adapter now says why it minted nothing.** Four different situations produced an identical
silence, which is right in the app and useless on a bench. It logs a reason —
`no-eas-project-id`, `permission-denied`, `unsupported-platform`, `no-token-issued`,
`registrar-threw` — and never the token.

**The reminder fix is now proven, not just guarded.** Every existing reminder test dispatched the
task BY HAND, which is exactly why a booking that scheduled nothing passed for four months. Two
tests in `notifications.int.test.ts` now assert on the Redis key BullMQ actually wrote. Falsified
by restoring the original defect in full — colon back, guard removed: the two new tests fail and
all 31 pre-existing ones, including all three reminder tests, still pass.

**K4-01 fixed, 2026-08-20.** The server sent `priority: high|default` and the app created a single
Android channel at HIGH importance — and on Android 8+ the channel, not the priority, decides
whether something interrupts a human, so every routine result buzzed like a critical potassium. Two
channels now (`critical` HIGH, `default` DEFAULT), derived from the same `urgent` flag that decides
the lock-screen wording, with the ids defined once in `@medicore/types`: a server and an app that
disagree on a channel id do not degrade, they lose the notification, because Android discards it
while Expo still returns an `ok` ticket. M4-10 changes from "expected to fail" to the row that
verifies it. **K4-02 biometrics is still wired to nothing**, below.

**Adjacent finding, STILL NOT FIXED — re-confirmed 2026-08-20.** `RuntimeProvider` passes
`secureStore`, `preferences`, `push` and `logger` to `createRuntime`, and not `biometrics`. So
`platform/biometrics.ts` is imported by no shipping code, all three call sites read `undefined`,
and the M2 screen lock can only ever ask for a passcode. One line. Left alone again deliberately —
it is unrelated to push and its fix needs the same hardware session to verify, so it belongs in
the same booking, not in this commit. Tracked as K4-02.

---

### Coverage audit, 2026-08-20 — **the next milestone is M4, and it is a finishing job**

Measured against the CODE, not the milestone names. Estimated coverage of practical staff
workflows: **≈50%** — but the useful figure is by AUDIENCE, because the two that are complete are
the two that matter most on a phone.

| Audience       | On mobile                                                                       | Status                          |
| -------------- | ------------------------------------------------------------------------------- | ------------------------------- |
| Doctor         | queue, chart, consultation, orders, results, prescribing, inpatients, discharge | ✅ 8 of 9 — no appointment book |
| Nurse          | ward worklist, chart, vitals, MAR, nursing notes, medication round, alerts      | ✅ 7 of 7                       |
| Everyone       | alerts inbox — **pull only; nothing is delivered to the phone**                 | 🟨 half                         |
| Pharmacist     | —                                                                               | 🔴 `ComingLater` placeholder    |
| Cashier        | —                                                                               | 🔴 `ComingLater` placeholder    |
| Lab technician | —                                                                               | 🔴 nothing                      |
| Radiology      | —                                                                               | 🔴 nothing                      |
| Emergency      | —                                                                               | 🔴 nothing                      |
| Theatre        | —                                                                               | 🔴 nothing                      |
| Store keeper   | —                                                                               | 🔴 nothing                      |

**Nothing is blocked by the backend or by the client.** `@medicore/api-client` exposes 299 methods
and mobile calls 37. `dispense`, `acceptOrder`/`startOrder`/`completeOrder`, `edBoard`,
`triagePatient`, `listOtBookings`, `transitionOtBooking`, `issueStoreStock` and `recordPayment` are
all already there, typed and contract-checked. Every remaining mobile milestone is UI, navigation
and permission wiring on a client that already speaks the whole product.

**Two gaps that are not screens:**

1. **Push delivery does not exist.** No device-token collection, no endpoint, no worker job —
   `grep expoPushToken` across `apps/` returns nothing. The inbox shipped 2026-08-18; the half that
   reaches a phone did not, so every screen already built is pull-only.
2. **Mobile does not know what the hospital bought.** `/auth/me` carries `features`;
   `src/lib/runtime.ts` reads `me.permissions` and drops them, so `tabsFor` gates on permission
   alone — the web shell has gated on both since D20. A nurse holding `nursing:manage` at a clinic
   with no IPD is offered the Ward tab and meets `HMS-PLAN-002`. The refusal renders honestly
   (`lib/net/errors.ts` has the predicate), so this is a wrong offer rather than a leak: one field
   in the session store and one condition in `tabsFor`.

**Validation, in three separate classes so none of them borrows another's credit:**

| Class                    | Status                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| A · Automated            | ✅ **1,669 tests**, 19 files, plain Node — no simulator, no Xcode, no Android SDK           |
| B · Emulator / simulator | 🔴 **none recorded.** `bundle:check` bundles both platforms headlessly; nothing is ever run |
| C · Physical device      | 🔴 **0 of 106** — M2 0/61, M3 0/45, M4 0. Never once run.                                   |

Class A cannot see a first render, a gesture, biometrics, a notch or a push token. That is the gap,
and it is the argument for M4: **push is the one milestone that cannot be faked without hardware**,
so choosing it converts the 106-check backlog from something perpetually deferred into a
prerequisite of the next release.

**"M2 forces a development build" is probably wrong, and this file said it.** `expo-local-authentication@~17.0.8`
is listed in SDK 54's own `bundledNativeModules.json` and matches the installed version exactly, so
Expo Go should run the biometric gate. [`apps/mobile/README.md`](../apps/mobile/README.md) and the
M2 checklist say opposite things; the checklist has the evidence. **Settle it in the first five
minutes of the next device session** — the whole setup cost turns on it. The SDK 54 pin must still
not be raised on its own, for the reason the README gives.

**The API beneath M2 and M3 was pre-validated on 2026-08-14** — 43 server-side checks including two
real nurses racing one dose. That ticks no device row, but it means a failure on the handset is a
client failure. See the M3 checklist's closing section.

---

## 8. Web — clinical parity slices

Web is the **primary** clinical surface, not a mobile companion. These slices brought it up to the
same safety envelope M3 established on mobile, reusing the same primitives.

| Slice | Scope                                                                                                               | Status |
| ----- | ------------------------------------------------------------------------------------------------------------------- | ------ |
| W1    | Branch-scoped screens are discarded on a branch switch                                                              | ✅     |
| W2    | Clinical dates reckoned in the branch timezone, not the browser's                                                   | ✅     |
| W3    | **MAR safety** — slot identity, `HMS-MAR-001` read as an answer, idempotency, reconciliation instead of "try again" | ✅     |
| W4    | **Medication round** — a navigator, not a second administration engine. One write path.                             | ✅     |
| D1+D2 | Ward identity resolved server-side; vitals writes idempotent and reconciled                                         | ✅     |

**No W5 is justified.** The closure audit compared 28 areas of M3 behaviour against web and found
the safety envelope complete. The next web work is validation, not code.

---

## 9. Next development strategy — stage by stage

Ordered by what makes the next stage cheaper or safer, not by what is most interesting.

### Stage A · Prove what exists — **no new features** · S · 🟩 WEB EXECUTED · 🟥 MOBILE BLOCKED

Everything built since M1 is proven by tests only. A defect found now costs one fix; the same defect
found after M4 and M5 are built on top costs a redesign.

**Done (2026-08-14):**

- [x] **Test environment built and verified** — `seed:validation`, 19/19 (`70e5a6e`).
- [x] **Schema verification gate** — `--verify` now refuses a database that cannot enforce the
      clinical invariants, checking `pendingCount()` **and** the actual indexes (`39e2dff`). Gates
      **one tenant**; risk register T2 stays open.
- [x] **API layer pre-validated** — 43 server-side checks, two nurses racing one dose. **This is
      where the day's real finding came from:** the first run reported seven catastrophic safety
      failures that were entirely the missing migrations 0048/0049 (risk register T2). Had a human
      met that on a handset, duplicate administration would have been raised as a P0 and been wrong.
- [x] **Manual validation runbook** — [`docs/MANUAL_VALIDATION_RUNBOOK.md`](docs/MANUAL_VALIDATION_RUNBOOK.md),
      the authoritative procedure for M2, M3 and Web: environment gate, accounts, **192 identified
      tests**, evidence standard, failure classification, escalation.

> **Correction (2026-08-16).** This list previously claimed **"Web checklist written — 30 scenarios,
> in the Phase 1 plan"** as done. **It was not in the repository** — no file defined `WEB-nn` IDs and
> the scratchpads were empty; it had been written in a conversation and never persisted. §13 of the
> runbook now supplies it, written from the implementation rather than recovered from memory. Worth
> noting for its own sake: _a plan that lives only in a conversation is not a deliverable_, and it
> was marked `[x]` for two days.

> ## EXECUTED 2026-08-19 — the web half, and it was worth the wait
>
> **Seven defects, found in one sitting, in a product whose automated gate was green** (2,060
> integration tests, 45 Playwright specs, 0 boundary violations). Three fixed the same day, four
> open. Evidence and reproduction: `docs/RISK_REGISTER.md` §0 **D14–D20**; how it was run and what
> it could not cover: `TESTING.md` **§11b**.
>
> | Defect                                                                                                          | Sev | Status              |
> | --------------------------------------------------------------------------------------------------------------- | --- | ------------------- |
> | D14 ED triage/transfer accepted on a visit that had ENDED — and a refused transfer overwrote a real destination | P1  | ✅ fixed `9d4715b`  |
> | D15 the operating surgeon is required, stored, and never shown                                                  | P3  | ✅ fixed `ffd481c`  |
> | D16 stock lookup 400s past a 2,000-char formulary, silently                                                     | P2  | ✅ fixed `ac4bae9`  |
> | D17 a document created by an UPSERT is never audited                                                            | P2  | ✅ fixed 2026-08-19 |
> | D18 the doctor's queue renders "—" instead of a patient's name                                                  | P2  | ✅ fixed 2026-08-19 |
> | D19 a write is offered under "All branches", refused on submit                                                  | P3  | ✅ fixed 2026-08-19 |
> | D20 the nav advertises modules the edition does not include                                                     | P3  | ✅ fixed 2026-08-19 |
> | D21 an audit entry with an empty diff side could never recompute its hash                                       | P2  | ✅ fixed 2026-08-19 |
>
> **Item 1 (web) is done** — Theatre and Emergency end to end, plus reception, consultation,
> ordering, admission, and the money path from bill to payment. **Item 5 is done: `BR-07` ran and
> passed** — a branch-confined user sees only their branch whether they send the other branch's id
> in `x-active-branch` or no header at all. The header filters within what you may see; it does not
> grant. That is the row this campaign was most about, and it is now a measurement rather than an
> inference from the code path.
>
> **Two things this pass does NOT settle.** It was executed by an agent driving a real browser, not
> by a person: nobody has judged legibility, density or whether a screen works under time pressure.
> And **items 2 and 3 are untouched** — the mobile checklists need hardware and eyes, and remain
> 0/61 and 0/45.

**Left — items 2 and 3 need a device. Item 6 needs a credential.**

> **Updated 2026-08-17 after a security audit and a pre-validation preparation pass.** Three items
> below moved. **Item 4 (licence states) is DONE** — `pnpm seed:licence` prepares LIC-01…05 and was
> verified end to end; only LIC-06 remains, and it needs an edition without the nursing module.
> **Item 5 (branch-confined nurse) is now the highest-value account in the campaign**, not a
> nice-to-have: the audit found three cross-branch defects (D9 P1, D10 P2, plus a branch-isolation
> test that asserted against a route that does not exist), all on paths no test walked with two
> branches configured. A new **runbook §5.0** puts the five regression rows first.
> Backup/restore (DR §0) and VPS readiness are now documented and are pilot-deployment blockers,
> separate from manual validation.

1. ~~**Web first, not mobile**~~ — **DONE 2026-08-19.** The reasoning held exactly: highest defect
   probability per minute, and it produced D14–D20 in a single session. `TESTING.md` §11b lists
   what passed.
2. Run `MOBILE_M2_DEVICE_CHECKLIST.md` on hardware → 61/61. Gate is §1 + §2 + §7[1–3], 17 rows.
3. Run `MOBILE_M3_DEVICE_CHECKLIST.md` on hardware → 45/45.
4. ~~Prepare the licence grace/expired states~~ — **DONE 2026-08-17.** `pnpm seed:licence -- --slug
licence-lab --state <active|expiring|grace|expired>`, verified against a real tenant; §18.1 has
   the commands. The old instruction (`extendDays: -1`) could not have worked — the schema declares
   `min(1)`, so it was a 400 and had never been run. **LIC-06 alone remains blocked**, and needs an
   edition without the nursing module rather than a licence change.
5. ~~Create a branch-confined user so `BR-07` can run~~ — **DONE 2026-08-19, and it PASSED.** The
   demo hospital already had one (`person1@sunrise.com`, FRONT_OFFICE, bound to GC01), which is why
   this sat open for two days behind an account nobody had looked for. Measured: 4 GC01 patients
   under `x-active-branch: GC01`, the same 4 under `x-active-branch: MAIN`, the same 4 with no
   header; an unbound admin sees 192 in MAIN and 4 in GC01. The blind spot that produced D1, D9 and
   D10 does not reach a bound user.
6. Resolve the push blocker (SSH unlock or `workflow` scope) and push the outstanding commits.
7. ~~Unblock CI billing, or record the decision~~ — **DECISION RECORDED 2026-08-17: `pnpm gate` on
   one machine is the accepted V1 gate.** Reviewed rather than assumed:

   - **A CI change is not justified.** The account is billing-locked, so every job is rejected
     _before its first step_ — no workflow edit can change that, and none has ever executed.
   - **Adding the schema gate to CI would be theatre.** `seed:migrate --check` needs a fleet, and
     CI has no tenants. It would answer READY vacuously, which is worse than not running.
   - **`pnpm gate` is not a weaker substitute.** It runs format, lint, typecheck, openapi,
     contract, client-contract, unit, **integration** and build plus boundaries — the same set,
     against a real Mongo, which a free CI runner would struggle to provide.

   **The residual risk is real and is NOT mitigated:** the work has only ever been built on one
   machine, so a missing dependency or an environment assumption would not surface until someone
   else clones it. The cheap mitigation is to run `pnpm gate` once on a second machine before the
   pilot — not to build CI infrastructure. Tracked as a pilot-deployment item, not a code task.

**Every session starts with `pnpm seed:migrate --all`.** Not hygiene — T2 will silently reproduce on
any database that predates M3, and it invalidates results without saying so.

**Exit:** every checklist green, history pushed. **Do not start Stage B until this is done.**

> **Where that exit actually stands, 2026-08-19.** The web half is executed and its defects are
> filed; the mobile half cannot be executed without hardware. Stages B–E were built past this gate
> anyway, five milestones deep — so the honest reading is not "the gate held" but "the gate was
> bypassed, and the first time anyone opened it, seven defects fell out". Whether the remaining
> mobile rows block the pilot is a product decision, not an engineering one. Nothing has been
> pushed.

### Stage B · Make the shelf honest — F5 + F4 · M

The last open item from the original safety list, and the narrowest it has ever been.

1. Read expiry: flag expired and near-expiry stock on the master and in a report.
2. Choose a batch at dispense; refuse an expired batch with an override that is recorded.
3. Low-stock and expiry alerts through the existing outbox — no new delivery mechanism.
4. **B8 partner masters** (vendors) as the minimum to make a goods-receipt real.

**Why here:** it is a patient-safety gap, it is the shelf mobile M5 will sell from, and it is the
one place where "marked done" and "safe" still differ.

### Stage C · Finish the nurse's shift — D5 depth · M

M3 gave a nurse a worklist, vitals and a medication record. A shift also has fluids and a handover.

1. **A nursing note the nurse can actually write** — not `emr:write`.
2. Intake / output charting.
3. Nursing assessment + care plan.
4. Handover — **derive it from what is already recorded**, do not build a parallel document.

**Why here:** it converts M3 from "usable" to "a nurse could work a whole shift on it", and it needs
no new client — both surfaces already exist.

### Stage D · Mobile M4 alerts, then M5 · M

M4 first: push is what makes the app worth opening unprompted, and the outbox that feeds it is
already built and proven. M5 follows Stage B, because a dispensing screen with no batch is the
same defect on a smaller screen.

### Stage E · Widen the clinical floor — P3 breadth · L · 🟨 **two of three delivered**

**D7 radiology** and **D10 emergency & triage** before D9/D11–D14: radiology is the second-largest
order source after the lab and reuses the order pipeline wholesale, and triage is the front door of
every hospital that buys the Hospital edition. Then **C2** problem list and **D1** ICD master —
both are the same missing thing, a coded clinical vocabulary.

- [x] **D7 Radiology v1** — 2026-08-18.
- [x] **D10 Emergency v1** — 2026-08-19. (**B5/D8 Theatre v1** landed the same day; it was not on
      this list, because the tracker had recorded theatres as complete since B5 shipped the
      registry. It was complete as a _bookable resource_ and had no operation record — see §10.)
- [ ] **C2 problem list + D1 ICD master** — the remaining Stage E item, and the one this ordering
      was actually pointing at. The ICD **master exists** (108 seeded codes, `mrd:code`, the `/mrd`
      screen); what does not is a **problem list that persists across visits**. Diagnoses today
      live on one consultation note, so a patient's diabetes is re-typed every visit and no report
      can count it.

### Stage F · Financial depth — P4 · L

F2 claims, F3 corporate billing, F6 general ledger, F7 payroll. Deliberately after the clinical
floor: billing already works for the cash and package cases, and every module added above generates
charges that the GL must eventually reconcile — building the ledger before the charges exist means
building it twice.

### Stage G · Platform services — P6 → P7 → P8 · L

Analytics (P6) once there is enough clinical data to be worth reading; then integrations (P7) with
**ABDM/NHCX first** — it is a regulatory requirement in the target market, not a feature; then AI
(P8) as advisory only, human-in-the-loop, on top of a record that is already trustworthy.

### Standing · P9 hardening, continuously

Rate limiting, the authorization probes for routes that lack one, DR drills, retention/archival.
These do not wait for a phase — each stage adds its own.

### The rule this ordering encodes

> **Depth before breadth, and validation before both.** Every stage above closes something already
> half-built before opening something new. The three worst defects this project has found —
> duplicate administration, permissions granted to nobody, and identity resolved from a paginated
> list — were all inside modules marked done.

---

## 10. Where the code disagreed with the docs

Recorded so the correction is not lost, and so the next audit knows what was already checked.

| Doc claim                                                                                                  | Reality                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `00-PROGRESS-TRACKER.md`: F1 Billing `⬜`                                                                  | 28 routes, working receipt flow (2026-08-12)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `00-PROGRESS-TRACKER.md`: E1 Appointments `⬜`                                                             | 22 routes, UI, clinic hours (2026-08-12)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `00-PROGRESS-TRACKER.md`: C7 MRD, C5 Wallet, B13 Mortuary `⬜`                                             | All three have modules and screens (2026-08-12)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `00-PROGRESS-TRACKER.md`: G1–G3 apps `⬜`                                                                  | Mobile M1 shipped and runs on hardware (2026-08-12)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **This file §3: P3 and P4 at `0%`**                                                                        | **Both ~30%. The clinical loop and the billing loop both run.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **This file §6.1: terminal states record as a discharge**                                                  | **False — `DISCHARGE_DISPOSITIONS` + outcome notes exist.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **This file §6.3: two patients can share a bed**                                                           | **False — `one_open_stay_per_bed_per_branch` prevents it.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **This file §5.1: C3 blocked by the terminal-states gap**                                                  | **Not blocked; medicolegal, consent and death records exist.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **This file §6.2: "the counter dispenses a drug the shelf may not hold"**                                  | **A deliberate decision, not a defect. The real gap is that expiry is never read.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| M3 audit §11 B2: dose identity keyed on `drugCode`                                                         | Wrong — one prescription may carry the same drug twice. Shipped key is `lineIndex`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| M0 phase table: "M3 backend needed: none"                                                                  | Four backend gaps, one a live clinical-safety defect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `pharmacy.service.ts` header: stock "does not decrement… nothing writes it"                                | **False since the medicines module landed.** `medicine.consumers.ts` decrements on `medication.dispensed`, idempotent on `(dispenseId, medicineCode)`; `pharmacy:stock` gates 8 routes. The real F5 gap is that the balance is a SCALAR, so batch and expiry are captured on receipt and can never be read back.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `channels/inapp.ts`: "the inbox is polled today (GET /notifications/me)"                                   | The route did not exist until 2026-08-18. Now true.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `notificationTemplates.ts`: pointing a template at another channel is "a template edit, not a code change" | `updateTemplate` accepts subject, body and enabled — **not** `channel`. Moving one is a seed value plus a migration, which is how 0051 did it. Corrected in place.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| This file §1: 224 paths · 3,661 tests · 144 permissions · 41 migrations                                    | **228 · 4,155 · 161 · 51.** Counted 2026-08-18.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| This file §5.2: D7 Radiology listed as not started                                                         | It ran end to end on the order spine before this milestone; what was missing was a role that could FINISH a study. Closed 2026-08-18.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `wallet.model.ts`: the account and the ledger "move together, in one transaction"                          | **They did not.** `walletEntries.balanceAfter` carried `min: 0` while the account was allowed to go negative, so the admitted-patient settle path threw a ValidationError from inside the transaction and escaped as an unhandled 500. Fixed 2026-08-18; the route had no behavioural test at all.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Editions sell flags that gate no code                                                                      | **CLOSED as a class 2026-08-20 — it is now a gate, not an audit.** `apps/api/src/featureLifecycle.test.ts` is `permissionLifecycle.test.ts`'s rule one layer up: a flag with no entry in `FEATURE_LIFECYCLE` must be read by shipped code, and a declared one must be read by none. Two defects fixed with it. **`portal.patient`** was in `CLINIC_FLAGS` — every edition — with no portal in the product, and every hospital saw "Patient portal" under "Included in this plan" on `/subscription`; removed from the editions (the flag stays, declared `unbuilt`). **`module.finance.packages`** gated nothing because the six package routes carried `module.ops.opd` like the rest of billing, so PLAN_HOSPITAL and PLAN_CLINIC had a Day Care / Hospital Plus differentiator for free; the routes now name the flag the price list already names. Previously closed: ~~`module.clinical.ris`~~ (2026-08-18), ~~`module.clinical.emergency`~~ (2026-08-19). **Eleven flags remain listed in an edition with no module behind them** — bloodbank, critical care, dialysis, physio, teleconsult, CSSD, pre-auth, inter-branch, multi-entity, dedicated DB, group dashboards — all in Clinic Plus and above, each a department on the roadmap. That number is now PINNED by the ledger test, so it can only change on purpose, and it should FALL as modules ship. |
| `pharmacy:purchase` lifecycle: "the pharmacy has no inventory"                                             | **False since migration 0052.** The pharmacy has batches, a stock ledger, FEFO and expiry. What it has no is PURCHASING — a receipt names no supplier, cost or invoice. Reason corrected in place 2026-08-20; the supplier master now exists under `vendor:manage`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `06-FEATURE-CHECKLIST.md`: every box `☐`                                                                   | **Roughly half of it has shipped.** The file calls itself "sales-completeness proof and release gate" and currently proves nothing. Identified by the 2026-08-20 audit; not corrected, because a tick-list rewritten from memory is how `00-PROGRESS-TRACKER.md` rotted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `PROJECT-STATUS.md`: audited 2026-08-10 at 135 commits                                                     | Ten days and **seven module V1s** stale (LIS, RIS, Theatre, Emergency, Pharmacy, Communication, General Store). It is a point-in-time audit and is not being retro-edited; read `projectTracker.md` §4–§5 for current state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Three of this file's own six "gaps" were false when it was written on 2026-08-12 — they were
inherited from `00-PROGRESS-TRACKER.md`'s prose rather than read from the code. A tracker that
copies another tracker inherits its drift. **Read the code.**

---

## 11. Change log for this file

| Date       | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-12 | Created. Baseline reconciled against the source tree, the gates and `PROJECT-STATUS.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2026-08-14 | Reconciled against 24 commits (mobile M2 + M3, web W1–W4 + closure, API nurse-safety work). Tests 1,722 → 3,661. Five of six §6 gaps closed, three of them found false. Added §8 web slices and §9 stage-wise strategy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-08-19 | **Theatre v1 and Emergency v1 closed** (§4), Stage E marked two-of-three (§9), pending D8/D10 rewritten as depth items (§5.2), snapshot refreshed to 44 modules / 234 paths / 4,338 tests. The 2026-08-19 gate anomaly was **reproduced, named and fixed** — a 500 on a concurrent ED triage and a race in `dropDatabases`; see `TESTING.md` §9 and the T3 postscript in `RISK_REGISTER.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2026-08-19 | **Stage A executed — the web half** (§9). Seven defects in one sitting against a green gate: D14 (P1, an ED write on an ENDED visit, and a refused transfer that overwrote a real destination), D15, D16 fixed; D17–D20 open. `BR-07` ran and **passed** — a branch-confined user cannot reach another branch by changing the header. Stage A items 1 and 5 closed; items 2/3 still need hardware. `TESTING.md` gained §11b; `RISK_REGISTER.md` §0 gained D14–D20.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2026-08-19 | **D17 audit-integrity hardening.** An audited first write performed by an upsert is now recorded as a CREATE, and later mutations as UPDATEs — the query path used to discard any write it had found no pre-image for. Fixing it surfaced **D21**: an entry whose diff had an empty side could never recompute its own hash. `auditPlugin.int.test.ts` (11 tests) is the audit subsystem's first test of any kind; `auditedUpsertsReturnTheNewDocument.test.ts` keeps the caller-side rule true.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 2026-08-19 | **Stage A cleanup — D18, D19, D20.** The doctor's queue and the reception register stopped joining patient names against a capped page of recent registrations: `GET /encounters` returns `EncounterRow` with `patientName` and `uhid`, resolved server-side in one `$in`, which also let the phone delete its per-row `getPatient`. A write that stamps a branch is no longer offered under "All branches" — the UI restates `writeBranchId()`'s own rule and lists the sites where the refusal used to appear. The navigation gates on entitlement as well as permission (`/auth/me` carries `features`), and `/emergency` and `/theatres` answer `HMS-PLAN-002` with a refusal instead of a refusal beside "Nobody in the emergency department." No server rule changed; all three falsified in both directions.                                                                                                                                                                                                                                                                                                                                                           |
| 2026-08-19 | **C2 — Theatre + Emergency v1 finalised by AUDIT.** Both modules were measured against the practical workflow rather than extended: the OT lifecycle, the collision rule, the write-once record, triage, the board, every disposition, RBAC, tenant/branch isolation and entitlement were all already correct and were left alone. Two gaps closed, both small and both on the workflow's own path: the operative note now reaches the DURABLE patient chart (it was reachable only from the doctor's live queue, so it vanished when the visit closed — D15's shape, one screen on), and the ED board now names the doctor a patient was handed to (the id was always on the wire and the screen dropped it). Ten falsifications run across overlap, the OT state machine, triage priority, encounter ownership, transfer persistence, disposition, both authorization layers and both new surfaces.                                                                                                                                                                                                                                                                         |
| 2026-08-20 | **Product audit, then General Stores v1.** A repository-wide audit re-measured every major HMS area against the code (not the trackers) and found the general store to be the only core operational department with nothing built; `packages/permissions/src/index.ts`'s lifecycle ledger — gate-enforced by `permissionLifecycle.test.ts` — was used as the authoritative module inventory. The module then shipped: 11 routes, 4 collections (migration 0054), a per-site shelf that cannot go negative, five permissions off `future()`, a `STORE_KEEPER` role holding nothing clinical, and `module.support.inventory` in the Hospital editions. Its own suite immediately caught a real defect — three of the permissions were declared `tenant`-scoped, so a branch-confined keeper was answered with both sites' shelves. See §4 G1/G3 and `docs/INVENTORY.md`.                                                                                                                                                                                                                                                                                                        |
| 2026-08-20 | **Entitlement cleanup — the flag ledger.** The layer-1 sibling of the permission ledger now exists: `apps/api/src/featureLifecycle.test.ts` reads the shipped app and fails when a flag with no `FEATURE_LIFECYCLE` entry gates nothing, or when a declared one acquires a gate. Two defects fixed with it — `portal.patient` was sold by every edition with no portal in the product (removed from the editions; the flag stays, declared `unbuilt`), and `module.finance.packages` gated nothing because the six care-package routes carried `module.ops.opd` like the rest of billing, so PLAN_HOSPITAL and PLAN_CLINIC had a Day Care / Hospital Plus differentiator for free. Writing the ledger caught a third thing on the way past: `module.finance.ipBilling` is not `bundled` — it is `gated` by `module.ops.ipd`, which the test now verifies. Eleven unbuilt flags remain listed in premium editions and the count is pinned. Eight falsifications; see §10.                                                                                                                                                                                                      |
| 2026-08-20 | **Mobile coverage audit** (§7). Measured against the code: the doctor (8 of 9) and the nurse (7 of 7) are complete; seven other staff audiences have nothing, two of them behind `ComingLater` placeholders that promise M5. Coverage ≈50% of practical staff workflows — an estimate. Nothing is blocked by the API or the client (299 client methods, 37 called by mobile; `dispense`, the order lifecycle, `edBoard`, `triagePatient`, the OT board and `issueStoreStock` are all already typed and contract-checked). Two non-screen gaps found: push delivery does not exist at all, and mobile drops `me.features`, so its tab bar gates on permission without entitlement — the D20 rule the web shell already follows. M5–M7 re-scoped by audience. **Next milestone: M4 — finish alerts.** Validation reported in three classes: automated 1,669 ✅ · emulator none · physical device **0/106**.                                                                                                                                                                                                                                                                     |
| 2026-08-20 | **M4 — staff mobile push.** Device registration (`POST/GET/DELETE /me/devices`, self-service, one row per TOKEN so a shared ward phone has one owner), delivery via a `push.deliver` task off the existing notification architecture, notification → deep-link navigation on a generic `resourceType`/`resourceId` pair, and the entitlement gap the audit found (mobile now reads `me.features` and gates tabs on both halves). Push is NOT a `Channel` — that would collide with the in-app row on `one_message_per_cause` — and carries no identifiers on a lock screen. Two defects found by its own tests: **no appointment reminder has ever been scheduled** (a colon in the BullMQ job id, rejected silently since A6) and the same bug in M4's own id; `scheduleTask` now refuses a colon. Validation: automated ✅ · emulator none · **physical device 0/18, two rows BLOCKED** (no EAS project linked; Expo Go cannot receive push since SDK 53).                                                                                                                                                                                                                  |
| 2026-08-14 | Post-Phase-1 sync. Confirmed defects moved to `RISK_REGISTER.md` §0 (D1–D7); **T2 recorded as materialised**. Stage A marked in progress with the environment and API pre-validation done. Corrected two claims this file made: the nurse **can** write a nursing note (mobile gained the route at M3-S2 — the gap is web-only), and "M2 forces a development build" is contradicted by SDK 54's own bundled-module list.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2026-08-20 | **M4 follow-up — unblocking real-device validation.** Everything preparable in code is done: `extra.eas.projectId` is plumbed from `app.json` or `EAS_PROJECT_ID`, the `expo-notifications` plugin is registered with `mode` derived from the build profile and `defaultChannel` matching the app's own channel, `android.googleServicesFile` is conditional, and the push adapter now logs WHY it minted no token. All verified by running `expo prebuild` and reading the generated manifest and entitlements. **A third silent-nothing defect found:** `app.config.ts` rebuilt `extra` without `...config.extra`, so an id written by `eas init` would have been discarded in transit — a linked project the app could not see. The reminder fix is now proven by two tests asserting on the Redis key BullMQ wrote, falsified by restoring the original defect in full. Remaining blockers are external and named in `docs/MOBILE_PUSH_ENABLEMENT.md`: an Expo account, a development build, Firebase, and (for the 4 iOS rows only) a paid Apple account. Two rows known to fail in advance — K4-01 Android channel importance, K4-02 biometrics still wired to nothing. |
| 2026-08-20 | **K4-01 — notification channel separation.** M4 shipped one Android channel at HIGH importance, so a routine released result interrupted a ward round exactly like a critical potassium: `priority` governs delivery, the CHANNEL governs interruption, and only the first was set. Two channels now, derived from the same `urgent` flag as the lock-screen copy so the words and the noise cannot disagree; unclassified templates go to the quiet one. Ids live in `@medicore/types` — a mismatch between server and app is not a downgrade, it is a discarded notification with an `ok` ticket. 8 unit + 5 mobile + 2 integration tests, falsified five ways (ids collapsed, everything urgent, mapping inverted, app stops creating a channel, builder ignores the mapping). Gate green.                                                                                                                                                                                                                                                                                                                                                                                 |
| 2026-08-20 | **M4 Firebase/FCM configuration.** EAS project linked (`@nasarj/medicore-staff`), Firebase project and Android app registered for `in.paperlesstech.medicore.development` — verified against `google-services.json` and against the `applicationId` prebuild generates. **A second silent-nothing defect found and fixed:** EAS Build uploads a git archive, so the gitignored `google-services.json` was NOT in it — proven with `eas build:inspect --stage archive` — and the build would have succeeded while producing an app that can never mint an FCM token. Now an EAS secret file variable, which `app.config.ts` already read. Also: `expo-dev-client` was missing though `developmentClient: true` was set; build profiles are bound to EAS environments (without which no server-side variable is injected); `eas init`'s snapshot of the machine's LAN IP trimmed out of `app.json`; and the root `.gitignore` now catches service-account key filenames anywhere in the tree — a real FCM key matched no existing rule. Remaining external step: upload the service-account key via `eas credentials`, then build.                                              |
