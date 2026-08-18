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

|                        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Branch**             | `feature/0.1` — **28 commits unpushed**, HEAD `0356f89`, tree clean                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Phases complete**    | 2 of 10 (P0, P1) · P2 ~55% · P3 ~30% · P5 ~35%                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **API**                | 43 modules · 228 OpenAPI paths · 277 contract operations · 52 tenant migrations · **13 default roles**                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Web**                | 47 screens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Mobile**             | 27 screens · **M0–M3 delivered** (foundation, doctor, nurse)                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Tests passing**      | **3,661** — 1,690 API integration · 1,613 mobile · 207 web · 133 API unit · 18 packages                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Gates**              | `format` · `lint` 18/18 · `typecheck` 18/18 · `unit` · `openapi` · `contract` · `client` · `build` 11/11 · `boundaries` — green. **`integration` is green on re-run and in isolation, not on every full run** — 6 runs on 2026-08-17: one passed 1838/1838, five failed 1–4 disjoint tests each. Every failure a timeout, 404 or 401; **none an assertion about behaviour**. Cause NOT established (a contention theory was claimed and retracted the same day). Raised as **T3**; see `TESTING.md` §9. |
| **Test environment**   | ✅ **Ready** — `pnpm seed:validation` builds a 45-bed, 42-patient ward across two sites and two timezones; `--verify` checks the **schema** (3) then the **data** (19), and refuses a database that cannot enforce the clinical invariants. See `SEED.md`.                                                                                                                                                                                                                                              |
| **API pre-validation** | ✅ 2026-08-14 — **43 server-side safety checks**, two real nurses racing one dose. Duplicate prevention, 409-as-answer, idempotent replay and lost-response reconciliation all hold.                                                                                                                                                                                                                                                                                                                    |
| **Manual validation**  | 🔴 **0 executed.** Procedure now written: [`docs/MANUAL_VALIDATION_RUNBOOK.md`](docs/MANUAL_VALIDATION_RUNBOOK.md). Mobile M2 0/61 · M3 0/45 · Web 0/24 · **Journey 0/25 (§13A, new 2026-08-17)** · safety, permission and negative suites 0. **Nothing has been seen on a screen by a person.**                                                                                                                                                                                                        |
| **Open defects**       | **4 fixed 2026-08-16** (D1 · D2 · D3 · D6) · **3 fixed 2026-08-17** (D9 cross-branch appointment write · D10 cross-branch report file · D13 mobile discarded the paper instruction) · **2 closed 2026-08-17** (D11, D12). **2 reclassified** as deliberate design (D4, D5). **1 open** — D7, a product decision. **P0 = 0, P1 = 0.** T2 partially controlled. See `docs/RISK_REGISTER.md` §0 and its 2026-08-17 P2 review.                                                                              |
| **CI**                 | 🔴 Billing-locked off-repo. No workflow has ever executed. `pnpm gate` on one machine is the only gate.                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Next action**        | **HUMAN MANUAL VALIDATION.** Execute [`docs/MANUAL_VALIDATION_RUNBOOK.md`](docs/MANUAL_VALIDATION_RUNBOOK.md) in its §5 order — §5.0's security regression set (BR-10, BR-11, BR-07, DRIFT-01…12, BR-12) first, then the environment gate, permissions by API, **Web**, the new **§13A journey** (JR-01…22 + DUP-01/02 + TEN-01), then mobile. **No engineering work is pending before this.**                                                                                                          |

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

### 5.1 Finish P2 — core operations

- [ ] **B8** Partner masters — vendors, referrers. _Blocks goods-receipt in Stage B._
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
- [ ] **D9** Blood bank · **D10** Emergency & triage _(D7 Radiology v1 landed 2026-08-18)_
- [ ] **D11** Critical care · **D12** Dialysis · **D13** Physiotherapy · **D14** Dietetics
- [ ] **D4** Teleconsultation
- [ ] **D8** Theatre depth — anaesthetist/team, pre-op checklist, utilisation

### 5.3 P4 — financial

- [ ] **F5** Inventory depth — goods-receipt, vendors, procurement. _Batch/expiry landed
      2026-08-19 (see D-group). No purchasing, deliberately._
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

| Risk                                                                                          | Severity                                                                                                                          |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Nothing has been validated on a device or in a browser by a human** — 106 checks unticked   | 🔴 Highest. The API layer beneath them was pre-validated 2026-08-14; the UI was not.                                              |
| **Tenant databases do not converge on their own** — risk register T2, materialised 2026-08-14 | 🔴 A stale tenant silently loses its safety indexes. `seed:migrate --all` is a workaround for a missing control, not a fix.       |
| **CI is billing-locked**; 8 commits unpushed                                                  | 🔴 The work exists on one machine and has never been built anywhere else.                                                         |
| **F5 expiry is captured and never read**                                                      | 🟠 An expired batch can be dispensed with no signal.                                                                              |
| **Web has no nursing-note surface** — the ward page gates notes on `emr:write`                | 🟠 Mobile gained `POST /nursing-notes` (`nursing:manage`) at M3-S2; web did not. The boundary is correct; the surface is missing. |
| **Allergy screening covers 15 demo drugs and is not a formulary**                             | 🟠 Do not widen the drug list without widening the safety data.                                                                   |
| **Vitals render in the reader's timezone, not the ward's**                                    | 🟡 Display only; the stored instant is correct.                                                                                   |
| Integration suite is **environment-sensitive**, not flaky — the host swaps under load         | 🟡 Re-run before investigating; check Docker memory first.                                                                        |

---

## 7. Mobile — staff app

| Stage | Scope                                                                     | Status                                 |
| ----- | ------------------------------------------------------------------------- | -------------------------------------- |
| M0    | Architecture — tenancy, session, branch, navigation, security             | ✅ Approved                            |
| M1    | Foundation — sign in, stay signed in, know your site, fail comprehensibly | ✅ 2026-08-12 · hardware-verified      |
| M2    | Doctor — my patients, timeline, vitals & results, writes, biometric gate  | ✅ 2026-08-13 · **0/61 device checks** |
| M3    | Nurse — ward worklist, vitals capture, medication administration, round   | ✅ 2026-08-13 · **0/45 device checks** |
| M4    | Alerts — **inbox ✅ 2026-08-18**; device registration + push delivery     | 🟨 Partial · **0 device checks**       |
| M5    | Reception & pharmacy — register, check in, take payment, dispense         | ⬜ _needs Stage B_                     |
| M6    | Lab & admin — worklist, result entry, approvals                           | ⬜                                     |
| M7    | Hardening — accessibility, offline reads, store release                   | ⬜                                     |
| M8    | **Patient app — deferred to the final major phase, lowest priority**      | ⬜ Deferred                            |

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

### Stage A · Prove what exists — **no new features** · S · 🟨 IN PROGRESS

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

**Left — the runbook is prepared but NOT executed. No manual result exists yet.**

> **Updated 2026-08-17 after a security audit and a pre-validation preparation pass.** Three items
> below moved. **Item 4 (licence states) is DONE** — `pnpm seed:licence` prepares LIC-01…05 and was
> verified end to end; only LIC-06 remains, and it needs an edition without the nursing module.
> **Item 5 (branch-confined nurse) is now the highest-value account in the campaign**, not a
> nice-to-have: the audit found three cross-branch defects (D9 P1, D10 P2, plus a branch-isolation
> test that asserted against a route that does not exist), all on paths no test walked with two
> branches configured. A new **runbook §5.0** puts the five regression rows first.
> Backup/restore (DR §0) and VPS readiness are now documented and are pilot-deployment blockers,
> separate from manual validation.

1. **Web first, not mobile** — it needs no build, no device, no pairing, and D-1/D-2 have _never_
   been opened in a browser, whereas the mobile MAR has 1,613 tests around it. Highest defect
   probability per minute. → runbook §13, `WEB-01`…`WEB-24`.
2. Run `MOBILE_M2_DEVICE_CHECKLIST.md` on hardware → 61/61. Gate is §1 + §2 + §7[1–3], 17 rows.
3. Run `MOBILE_M3_DEVICE_CHECKLIST.md` on hardware → 45/45.
4. ~~Prepare the licence grace/expired states~~ — **DONE 2026-08-17.** `pnpm seed:licence -- --slug
licence-lab --state <active|expiring|grace|expired>`, verified against a real tenant; §18.1 has
   the commands. The old instruction (`extendDays: -1`) could not have worked — the schema declares
   `min(1)`, so it was a 400 and had never been run. **LIC-06 alone remains blocked**, and needs an
   edition without the nursing module rather than a licence change.
5. **🔴 Create a branch-confined nurse so `BR-07` can run — now the highest-value account in the
   campaign.** D1 is fixed, but the 2026-08-17 audit found three MORE branch-scope defects behind
   the same blind spot, so this is no longer about one risk-register entry. It was the only way to prove
   empirically that risk-register D1 reaches a bound user, which was inferred from the
   code path. Roles UI, no code change.
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

### Stage E · Widen the clinical floor — P3 breadth · L

**D7 radiology** and **D10 emergency & triage** before D9/D11–D14: radiology is the second-largest
order source after the lab and reuses the order pipeline wholesale, and triage is the front door of
every hospital that buys the Hospital edition. Then **C2** problem list and **D1** ICD master —
both are the same missing thing, a coded clinical vocabulary.

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

| Doc claim                                                                                                  | Reality                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `00-PROGRESS-TRACKER.md`: F1 Billing `⬜`                                                                  | 28 routes, working receipt flow (2026-08-12)                                                                                                                                                                                                                                                                     |
| `00-PROGRESS-TRACKER.md`: E1 Appointments `⬜`                                                             | 22 routes, UI, clinic hours (2026-08-12)                                                                                                                                                                                                                                                                         |
| `00-PROGRESS-TRACKER.md`: C7 MRD, C5 Wallet, B13 Mortuary `⬜`                                             | All three have modules and screens (2026-08-12)                                                                                                                                                                                                                                                                  |
| `00-PROGRESS-TRACKER.md`: G1–G3 apps `⬜`                                                                  | Mobile M1 shipped and runs on hardware (2026-08-12)                                                                                                                                                                                                                                                              |
| **This file §3: P3 and P4 at `0%`**                                                                        | **Both ~30%. The clinical loop and the billing loop both run.**                                                                                                                                                                                                                                                  |
| **This file §6.1: terminal states record as a discharge**                                                  | **False — `DISCHARGE_DISPOSITIONS` + outcome notes exist.**                                                                                                                                                                                                                                                      |
| **This file §6.3: two patients can share a bed**                                                           | **False — `one_open_stay_per_bed_per_branch` prevents it.**                                                                                                                                                                                                                                                      |
| **This file §5.1: C3 blocked by the terminal-states gap**                                                  | **Not blocked; medicolegal, consent and death records exist.**                                                                                                                                                                                                                                                   |
| **This file §6.2: "the counter dispenses a drug the shelf may not hold"**                                  | **A deliberate decision, not a defect. The real gap is that expiry is never read.**                                                                                                                                                                                                                              |
| M3 audit §11 B2: dose identity keyed on `drugCode`                                                         | Wrong — one prescription may carry the same drug twice. Shipped key is `lineIndex`.                                                                                                                                                                                                                              |
| M0 phase table: "M3 backend needed: none"                                                                  | Four backend gaps, one a live clinical-safety defect                                                                                                                                                                                                                                                             |
| `pharmacy.service.ts` header: stock "does not decrement… nothing writes it"                                | **False since the medicines module landed.** `medicine.consumers.ts` decrements on `medication.dispensed`, idempotent on `(dispenseId, medicineCode)`; `pharmacy:stock` gates 8 routes. The real F5 gap is that the balance is a SCALAR, so batch and expiry are captured on receipt and can never be read back. |
| `channels/inapp.ts`: "the inbox is polled today (GET /notifications/me)"                                   | The route did not exist until 2026-08-18. Now true.                                                                                                                                                                                                                                                              |
| `notificationTemplates.ts`: pointing a template at another channel is "a template edit, not a code change" | `updateTemplate` accepts subject, body and enabled — **not** `channel`. Moving one is a seed value plus a migration, which is how 0051 did it. Corrected in place.                                                                                                                                               |
| This file §1: 224 paths · 3,661 tests · 144 permissions · 41 migrations                                    | **228 · 4,155 · 161 · 51.** Counted 2026-08-18.                                                                                                                                                                                                                                                                  |
| This file §5.2: D7 Radiology listed as not started                                                         | It ran end to end on the order spine before this milestone; what was missing was a role that could FINISH a study. Closed 2026-08-18.                                                                                                                                                                            |
| `wallet.model.ts`: the account and the ledger "move together, in one transaction"                          | **They did not.** `walletEntries.balanceAfter` carried `min: 0` while the account was allowed to go negative, so the admitted-patient settle path threw a ValidationError from inside the transaction and escaped as an unhandled 500. Fixed 2026-08-18; the route had no behavioural test at all.               |
| Editions sell eight flags that gate no code                                                                | `portal.patient` (every edition), ~~`module.clinical.ris`~~ (closed 2026-08-18), `module.clinical.emergency`, `module.finance.{opBilling,ipBilling,packages,preAuth}`, `module.analytics.groupDashboards`. Same class as a permission granted to nobody, one layer up. **Open.**                                 |

Three of this file's own six "gaps" were false when it was written on 2026-08-12 — they were
inherited from `00-PROGRESS-TRACKER.md`'s prose rather than read from the code. A tracker that
copies another tracker inherits its drift. **Read the code.**

---

## 11. Change log for this file

| Date       | Change                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-12 | Created. Baseline reconciled against the source tree, the gates and `PROJECT-STATUS.md`.                                                                                                                                                                                                                                                                                                                                  |
| 2026-08-14 | Reconciled against 24 commits (mobile M2 + M3, web W1–W4 + closure, API nurse-safety work). Tests 1,722 → 3,661. Five of six §6 gaps closed, three of them found false. Added §8 web slices and §9 stage-wise strategy.                                                                                                                                                                                                   |
| 2026-08-14 | Post-Phase-1 sync. Confirmed defects moved to `RISK_REGISTER.md` §0 (D1–D7); **T2 recorded as materialised**. Stage A marked in progress with the environment and API pre-validation done. Corrected two claims this file made: the nurse **can** write a nursing note (mobile gained the route at M3-S2 — the gap is web-only), and "M2 forces a development build" is contradicted by SDK 54's own bundled-module list. |
