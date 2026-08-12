# Project Tracker — MediCore HMS

**The live list of what is done and what is left.** Read from the source tree and the quality
gates on 2026-08-12, then reconciled against the written docs. Where a doc and the code disagreed,
the code won and the difference is recorded in §8.

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

|                         |                                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Branch**              | `feature/0.1`                                                                                                              |
| **Phases complete**     | 2 of 10 (P0, P1) · P2 in progress ~35%                                                                                     |
| **API modules in code** | 43 · 216 OpenAPI paths · 265 contract operations                                                                           |
| **Web screens**         | 40                                                                                                                         |
| **Mobile**              | M0 architecture approved · **M1 delivered 2026-08-12**, verified on a physical Android handset                             |
| **Tests passing**       | 1,722 — 1,462 API integration · 181 mobile · 69 API unit · 10 web                                                          |
| **Gates**               | `format` · `lint` 18/18 · `typecheck` 18/18 · `openapi` · `contract` · `client` · `build` 11/11 · `boundaries` — all green |
| **Next action**         | Close the three patient-safety gaps in §6 before widening scope. Mobile M2 awaits review approval.                         |

---

## 2. Status legend

| Mark | Meaning                                           |
| ---- | ------------------------------------------------- |
| `✅` | Done — built, tested, and exercised end to end    |
| `🟨` | Partial — real code exists; named gap in the note |
| `⬜` | Not started — no module in `apps/api/src/modules` |

Route counts are registered HTTP handlers, a proxy for **depth, not quality**. A low count on a
`🟨` module usually means the write side is thin.

---

## 3. Phases

| Phase | Scope                                                                                     | Status     |
| ----- | ----------------------------------------------------------------------------------------- | ---------- |
| P0    | Monorepo, CI, Docker Compose, design tokens, OpenAPI baseline                             | ✅ 100%    |
| P1    | Foundation — master DB, tenant provisioning, connection manager, auth / JWT / MFA         | ✅ 100%    |
| P2    | Core operations — masters, patients & MPI, doctors & schedules, appointments, queue, beds | 🟨 ~35%    |
| P3    | Clinical — EMR, consultation, nursing, LIS, RIS, theatre, blood bank                      | ⬜ 0%      |
| P4    | Financial — billing engine, pharmacy, inventory, insurance & claims, finance GL           | ⬜ 0%      |
| P5    | Applications — mobile (staff / doctor / patient), communication, home healthcare          | 🟨 M1 only |
| P6    | Analytics — reporting engine, read models, dashboards                                     | ⬜ 0%      |
| P7    | Integrations — payments, comms, analysers, HL7 / FHIR / DICOM, ABDM / NHCX, SSO           | ⬜ 0%      |
| P8    | AI suite — advisory, human-in-the-loop                                                    | ⬜ 0%      |
| P9    | Hardening, compliance, disaster recovery, GA                                              | ⬜ 0%      |

P5 is not zero: the staff app's foundation shipped. The phase stays open — six staff milestones
and the patient app remain.

---

## 4. Completed

### A · Platform & tenancy

- [x] **A1 Tenant management** — registry, provisioning CLI, connection manager, custom domains
- [x] **A3 Identity & auth** — argon2id, JWT, MFA, rotating refresh with reuse detection (13 routes)
- [x] **A4 RBAC & permissions** — 144-permission catalogue, matrix suite as a release gate (8)
- [x] **A5 Audit & activity logging** — append-only, hash-chained (3)
- [x] **A5b Transactional outbox + relay** — ADR-0007
- [x] **A6 Notification system** — outbox-driven (3)

### B · Organisation & facilities

- [x] **B4 Wards, rooms, beds, bed board** (9) — _see the bed-inventory gap in §6_
- [x] **B6 Ambulance** (6)
- [x] **B7 Assets & maintenance** (5)
- [x] **B10 Feedback & complaints** (5)

### C · Patient

- [x] **C1 Patient registration & master patient index** (7)

### E–F · Front office & financial

- [x] **E1 Appointments, queue, token** (19) — with UI and clinic hours
- [x] **F1 Billing** (27) — estimates, invoices, receipts, refunds; one code path, two hospital types

### G · Applications

- [x] **Mobile M0** — architecture approved: tenancy, session, branch, navigation, security model
- [x] **Mobile M1** — sign in, stay signed in, know your site, fail comprehensibly. Platform-free
      core, 181 tests, no simulator required. Verified on hardware.

### Cross-cutting engineering

- [x] Multi-branch isolation — Phase 1 and 1.5, branch survives events and background work
- [x] API contract pipeline — `openapi:check`, `contract:check`, `client:check`, all falsified
- [x] `Idempotency-Key` — documented contract made real, 5 controls falsified
- [x] API v1 compatibility policy — including the three breakages a schema diff cannot show
- [x] Deprecation / Sunset machinery — 12-month window enforced at startup
- [x] Local dev on a physical device — `dev:device-domains`, browser and handset work at once

---

## 5. Pending

### 5.1 Finish P2 — core operations

- [ ] **B1–B3** Organisation structure — departments and profile beyond branches
- [ ] **B5** ICU / ER registries (theatre registry exists)
- [ ] **B8** Partner masters — vendors, referrers
- [ ] **B9** Facility ops — housekeeping, visitor management
- [ ] **C2** Patient clinical profile — beyond vitals, allergies, drug safety
- [ ] **C3** Records, consent, discharge, death — _blocked by the terminal-states gap, §6_
- [ ] **C4** Referral (transfer exists)
- [ ] **C6** Online registration & digital forms
- [ ] **D2** Doctor management — beyond core schedules

### 5.2 P3 — clinical

- [ ] **D1** EMR — full clinical record (encounters exist, 14 routes)
- [ ] **D3** Consultation workspace — currently structured notes only (2 routes)
- [ ] **D5** Nursing — observations and care plans (MAR only, 2 routes)
- [ ] **D6** Laboratory (LIS) — order-to-result (catalogue + orders exist, 13 routes)
- [ ] **D7** Radiology (RIS)
- [ ] **D8** Operation theatre — scheduling and notes (registry only, 6 routes)
- [ ] **D9** Blood bank
- [ ] **D10** Emergency & triage
- [ ] **D11** Critical care — ICU / NICU / PICU
- [ ] **D12** Dialysis
- [ ] **D13** Physiotherapy & rehabilitation
- [ ] **D14** Clinical dietetics
- [ ] **D4** Teleconsultation

### 5.3 P4 — financial

- [ ] **F5** Inventory & store — stock, batches, expiry. **The missing module under F4.**
- [ ] **F4** Pharmacy — dispensing is thin (2 routes) and unsafe without F5
- [ ] **F2** Insurance / TPA / claims — beyond MVP (7 routes)
- [ ] **F3** Corporate & packages
- [ ] **F6** Finance & accounting — general ledger
- [ ] **F7** HR & payroll

### 5.4 P5–P9 — applications and platform services

- [ ] **G2–G3** Doctor and patient portals
- [ ] **H1** Communication suite — staff chat, broadcast
- [ ] **I1–I2** Reporting & dashboards — beyond current partial (6 routes)
- [ ] **J1** AI suite
- [ ] **K1** Security & compliance centre
- [ ] **Integrations** — HL7 / FHIR, ABDM, NHCX, payments, analysers, SSO
- [ ] Home healthcare · occupational health
- [ ] **A7 / A8 / A9** past MVP — documents, branding, API keys
- [ ] **A2** Subscription & plans — beyond core edition enforcement

---

## 6. Gaps to close before widening scope

Three are patient-safety defects sitting _underneath_ modules marked done. They are not new work —
they are the cost of the demo slices that got the clinical loop clickable.

| #   | Gap                                                                                        | Why it matters                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **IPD terminal states** — LAMA, absconded and deceased all record as an ordinary discharge | A false statement in a medical record                                                                                                                                    |
| 2   | **Pharmacy stock, batches, expiry** (F5)                                                   | The counter dispenses a drug the shelf may not hold                                                                                                                      |
| 3   | **Bed inventory**                                                                          | Two patients can be recorded in the same bed                                                                                                                             |
| 4   | **`Branch.timezone` is unvalidated** and unset on seeded branches                          | Must land **before** any time-dependent appointment work, or times render against a guess. Use the shape + `Intl` rule — `Intl.supportedValuesOf` rejects `Asia/Kolkata` |
| 5   | **`resolveActiveBranch` accepts an INACTIVE branch**                                       | Validates membership but not status, so a retired site passes for a hospital-wide caller                                                                                 |
| 6   | **RBAC matrix test isolation**                                                             | One token per role reused across ~1,181 requests; intermittently 401 where 403 is expected in the full run, passes standalone                                            |

Also open, lower severity: allergy screening covers 15 demo drugs and is **not a formulary** — do
not widen the drug list without widening the safety data.

---

## 7. Mobile — staff app

| Stage | Scope                                                                     | Status                     |
| ----- | ------------------------------------------------------------------------- | -------------------------- |
| M0    | Architecture — tenancy, session, branch, navigation, security             | ✅ Approved                |
| M1    | Foundation — sign in, stay signed in, know your site, fail comprehensibly | ✅ Delivered 2026-08-12    |
| M2    | Doctor — my patients, timeline, vitals & results, biometric gate          | ⬜ Next, awaiting approval |
| M3    | Nurse — ward worklist, vitals capture, medication administration          | ⬜                         |
| M4    | Alerts — device registration, push delivery, inbox                        | ⬜                         |
| M5    | Reception & pharmacy — register, check in, take payment, dispense         | ⬜                         |
| M6    | Lab & admin — worklist, result entry, approvals                           | ⬜                         |
| M7    | Hardening — accessibility, offline reads, store release                   | ⬜                         |
| M8    | **Patient app — deferred to the final major phase, lowest priority**      | ⬜ Deferred                |

**M2 forces a development build.** `expo-local-authentication` does not run in Expo Go. That is
also the point at which the Expo SDK 54 pin can be lifted — see `apps/mobile/README.md` for why it
must not be raised on its own.

---

## 8. Where the code disagreed with the docs

Recorded so the correction is not lost, and so the next audit knows what was already checked.

| Doc claim                                                      | Reality on 2026-08-12                         |
| -------------------------------------------------------------- | --------------------------------------------- |
| `00-PROGRESS-TRACKER.md`: F1 Billing `⬜`                      | 27 routes, working receipt flow               |
| `00-PROGRESS-TRACKER.md`: E1 Appointments `⬜`                 | 19 routes, UI, clinic hours                   |
| `00-PROGRESS-TRACKER.md`: C7 MRD, C5 Wallet, B13 Mortuary `⬜` | All three have modules and screens            |
| `00-PROGRESS-TRACKER.md`: G1–G3 apps `⬜`                      | Mobile M1 shipped and runs on hardware        |
| Activity log ends 2026-07-16                                   | `PROJECT-STATUS.md` audits through 2026-08-12 |

The ledger in that file drifted because it was updated separately from the work. This file exists
to be updated _with_ the work — see the update rule at the top.

---

## 9. Change log for this file

| Date       | Change                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------- |
| 2026-08-12 | Created. Baseline reconciled against the source tree, the gates and `PROJECT-STATUS.md`. |
