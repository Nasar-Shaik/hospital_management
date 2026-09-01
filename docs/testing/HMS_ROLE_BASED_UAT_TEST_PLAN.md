# HMS ROLE-BASED UAT TEST PLAN

**The master manual / UAT validation document for MediCore HMS as it is implemented today.**

Built on 2026-08-22 by reading the repository — the route table the live Express app prints, the
permission catalogue, the web and mobile screens, and every test suite named below — and by
re-homing every scenario in
[`AI_Workflow/docs/MANUAL_VALIDATION_RUNBOOK.md`](../../AI_Workflow/docs/MANUAL_VALIDATION_RUNBOOK.md)
into a structure a hospital can actually validate against: **role → module → workflow → scenario**.

> ### The one thing to understand before using this document
>
> **Automated coverage and manual validation are different facts, and neither implies the other.**
> A scenario can be proven at three layers and still be `⬜ Not Tested` here, because nobody has
> looked at it. **No row in this document may be marked PASS from automated evidence.** Every
> manual status starts at `⬜ Not Tested` and only a person who performed the step may change it.
>
> As of this writing, **the manual column is `⬜ Not Tested` for every scenario in the plan.**

---

## 0. What this document is, and what it replaces

| Document                                                                                          | Relationship                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`MANUAL_VALIDATION_RUNBOOK.md`](../../AI_Workflow/docs/MANUAL_VALIDATION_RUNBOOK.md)             | **Source, and still the authority for what each of its 232 IDs MEANS** — its invariants, traps, error codes and fixtures are quoted throughout and were what the automated tests were written from. §21 maps all 232 into this plan. Nothing was dropped. |
| [`TESTING.md`](../../TESTING.md) §11 / §11b                                                       | The audit that decided which layer proves which runbook row, and the record of the 2026-08-19 browser pass that found D14–D21. Its conclusions are consumed here as coverage evidence.                                                                    |
| [`MOBILE_M2_DEVICE_CHECKLIST.md`](../../AI_Workflow/docs/MOBILE_M2_DEVICE_CHECKLIST.md) (61 rows) | Still the long-form text for the doctor-phone rows. This plan carries the M2-nn IDs under **Doctor → Mobile**.                                                                                                                                            |
| [`MOBILE_M3_DEVICE_CHECKLIST.md`](../../AI_Workflow/docs/MOBILE_M3_DEVICE_CHECKLIST.md) (45 rows) | Same, for the nurse phone. IDs carried under **Nurse → Mobile**.                                                                                                                                                                                          |
| [`MOBILE_M4_DEVICE_CHECKLIST.md`](../../AI_Workflow/docs/MOBILE_M4_DEVICE_CHECKLIST.md) (18 rows) | Staff push. Carried under **Cross-cutting → Notifications** (§17.11). Blocked on an external build.                                                                                                                                                       |
| [`RISK_REGISTER.md`](../../AI_Workflow/docs/RISK_REGISTER.md) §0                                  | D1–D21. Where a scenario is a regression check on a closed defect, the entry says so.                                                                                                                                                                     |
| [`HMS_UAT_EXECUTION_WAVES.md`](./HMS_UAT_EXECUTION_WAVES.md)                                      | **The execution companion.** Schedules the 95 P0/C0 scenarios below into six waves with their fixtures, handoffs and clock constraints. It defines no expectation — this plan remains the authority for every one.                                        |

### Four discrepancies found while writing this, recorded rather than silently resolved

1. **The requested path was `AI_Workflow/docs/manualvalidationrunbook.md`; the file is
   `AI_Workflow/docs/MANUAL_VALIDATION_RUNBOOK.md`.** Same file — macOS is case-insensitive — and it
   is the one that was read. Every reference here uses the real name.
2. **This plan lives at `docs/testing/`, and every other document in this repository lives under
   `AI_Workflow/docs/`.** Written where it was asked for. If the split turns out to be a nuisance,
   moving it is one `git mv` and two link edits; that is a decision for whoever owns the docs tree.
3. **The runbook's own §15.1 permission matrix disagrees with the permission catalogue on
   `vitals:record`**, in two cells and in opposite directions. Full detail and the resolution in
   §21.2b — this plan follows the implementation.
4. **[`PRODUCT-TOUR.md`](../../PRODUCT-TOUR.md) §3 still says "No clinical screens yet".** It is
   badly stale — patients, encounters, orders, prescriptions, pharmacy, billing, theatre, emergency
   and the general store all ship. `TESTING.md` §1d and `AI_Workflow/projectTracker.md` §4 are the
   current truth. Not corrected here; flagged so a validator reading the tour does not conclude the
   product is unbuilt.

### What this plan deliberately does not do

- **It does not invent functionality.** Every scenario names a route, a screen or a permission that
  exists. Where a prompt-level expectation had no implementation behind it — procurement, referral
  masters, five-level triage, PACS, specimen accession, patient portal, corporate billing — it is
  recorded as **not built**, in a boxed note at the end of the module's own section and again in
  §20.4, never as a failing test.
- **It does not re-run the automation.** Coverage claims below were verified by reading the test
  files named. Test _counts_ are deliberately absent: they go stale silently and then get quoted
  (`MANUAL_VALIDATION_RUNBOOK.md` §20.3). Run `pnpm gate:full` and quote the run.

---

## 1. Conventions

### 1.1 Scenario format

Every scenario carries: **ID · Role · Module · Criticality · Priority · Preconditions · Steps ·
Expected Result · Negative / Boundary · Downstream Verification · Automation Coverage · Manual
Validation · Evidence**. Where a field would be empty it is omitted rather than padded.

### 1.2 Criticality — what happens if this fails

| Level  | Meaning                                                       | Examples in this product                                                                                         |
| ------ | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **C0** | Patient safety · severe security · severe financial integrity | Double-charted dose · cross-tenant PHI · wrong patient on an administering screen · expired lot dispensed        |
| **C1** | Major clinical, operational or financial failure              | Doctor cannot see the queue · a released result never reaches the ordering doctor · a dispensed drug never bills |
| **C2** | Important business workflow                                   | Appointment booking · date-range filters · reports export · roster management                                    |
| **C3** | Minor, UX, convenience                                        | A disabled control that does not say why · a cosmetic truncation · a display-only identifier                     |

### 1.3 Priority — how urgently it must be tested

**Priority is not derived from criticality.** P0 = must pass before release. P1 = core workflow.
P2 = important, non-blocking. P3 = secondary.

The two diverge in both directions, and the divergences are the interesting rows:

- **C0 / P2** — cross-tenant isolation of the _mortuary register_. Catastrophic if wrong; the
  mechanism is one database per tenant (ADR-0005), already proven on the paths that carry PHI daily,
  so re-proving it on a low-traffic register is not what blocks a release.
- **C2 / P0** — the reception register's day boundary. Nobody is harmed by a wrong day, but a
  register that shows the wrong patients is the first screen the hospital opens every morning, and
  it was a real defect (D2).
- **C1 / P3** — the ambulance dispatch board. A real operational failure if broken, but the module
  has no customer using it and its own docs list it as MVP depth.

Unusual pairings are explained inline.

### 1.4 Coverage vocabulary

| Field                | Values                                                 |
| -------------------- | ------------------------------------------------------ |
| **Unit**             | `✅ — <file>` · `❌` · `N/A`                           |
| **Integration**      | `✅ — <file> §<block>` · `⚠️ partial` · `❌` · `N/A`   |
| **E2E / Playwright** | `✅ — e2e/<spec>` · `❌` · `N/A`                       |
| **Mobile automated** | `✅ — apps/mobile/__tests__/<file>` · `❌` · `N/A`     |
| **Manual**           | `⬜ Not Tested` · `🟢 Pass` · `🔴 Fail` · `🟡 Blocked` |

`⚠️ partial` means the layer exercises the path but does not assert the invariant this scenario is
about — an RBAC probe that confirms who may call a route is _not_ coverage of what the route does.
It is used deliberately and often, because the alternative is a `✅` that means nothing.

`N/A` means the layer cannot meaningfully prove it (a browser cannot prove an FCM token; a unit test
cannot prove a Mongo unique index).

### 1.5 Result classification for manual runs

Inherited unchanged from `MANUAL_VALIDATION_RUNBOOK.md` §2.2 — use exactly these, and do not invent
a ninth: **PASS · FAIL · BLOCKED · ENVIRONMENT ISSUE · DATA ISSUE · KNOWN DEFECT · PRODUCT DECISION
REQUIRED · N/A**.

Three rules, also unchanged and load-bearing:

1. Never convert an automated PASS into a manual PASS.
2. Never convert an untested scenario into PASS. `BLOCKED` is a respectable answer.
3. Never invent an Expected result. If the repository does not define the behaviour, write
   `PRODUCT DECISION REQUIRED`.

### 1.6 ⚠️ Three different things are called "D-2" — read this before citing a defect id

The runbook already warns about two `D` schemes (§19.1). There are now **three**, and two of them
share a spelling:

| Written          | Means                                                                                                           | Where                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| **`D2`**         | Reception register resolved `?date=` in `DEFAULT_TIMEZONE` — ✅ fixed `8330faa`                                 | `RISK_REGISTER.md` §0 table                 |
| **`D-2` (web)**  | **Lost vitals response** — ✅ fixed `375e4cf`, never confirmed in a browser                                     | the runbook's web fix history → NUR-VIT-002 |
| **`D-2` (test)** | A browser spec grew the hospital it asserts against, one patient per run — a **TEST** defect, not a product one | `RISK_REGISTER.md`, its own section         |

**This plan always writes "web defect D-1" / "web defect D-2" in full** when it means the web fix
history, and plain `D1`…`D21` when it means the risk register. Do the same in a report; a bare `D-2`
now sends the reader to one of three places.

### 1.7 Safety rule

**No scenario in this document requires performing an unsafe clinical action.** Every safety control
is validated by _attempting_ the unsafe act and _observing the refusal_. You never chart a wrong
drug, a wrong dose or a wrong patient to see what happens. If a scenario would leave the environment
in a state you cannot explain, stop it, capture what you have, and continue only with independent
tests.

---

## 2. Roles actually implemented

Read from `packages/permissions/src/index.ts` (`DEFAULT_ROLES`) and
`apps/api/src/modules/platform/platform.model.ts`. **Fourteen tenant roles and two operator roles.**
No role below is invented, and no role in the code is omitted.

| #   | Role code                | Name                       | Covered in                    | Seeded login (`pnpm seed:demo`) |
| --- | ------------------------ | -------------------------- | ----------------------------- | ------------------------------- |
| 1   | `RECEPTIONIST`           | Receptionist               | §3 Front Desk                 | `reception@sunrise.test`        |
| 2   | `FRONT_OFFICE`           | Front Office (desk + cash) | §3 Front Desk (union role)    | — not seeded                    |
| 3   | `DOCTOR`                 | Doctor                     | §4 Doctor                     | `drrao@…`, `drkhan@…`           |
| 4   | `NURSE`                  | Nurse                      | §5 Nurse                      | `nurse@…`, `nurse2@…`           |
| 5   | `LAB_TECHNICIAN`         | Lab Technician             | §6 Laboratory                 | `labtech@sunrise.test`          |
| 6   | `PATHOLOGIST`            | Pathologist                | §6 Laboratory                 | `pathologist@sunrise.test`      |
| 7   | `RADIOLOGY_TECHNICIAN`   | Radiology Technician       | §7 Radiology                  | `radiographer@sunrise.test`     |
| 8   | `RADIOLOGIST`            | Radiologist                | §7 Radiology (optional role)  | `radiologist@sunrise.test`      |
| 9   | `PHARMACIST`             | Pharmacist                 | §8 Pharmacy                   | `pharmacy@sunrise.test`         |
| 10  | `STORE_KEEPER`           | Store Keeper               | §9 General Stores             | `store@sunrise.test`            |
| 11  | `CASHIER`                | Cashier / Billing          | §12 Billing                   | `cashier@sunrise.test`          |
| 12  | `TENANT_ADMIN`           | Hospital Administrator     | §13 Admin                     | `admin@sunrise.test`            |
| 13  | `AUDITOR`                | Auditor                    | §15 Auditor                   | — not seeded                    |
| 14  | `PATIENT`                | Patient-portal identity    | §16 — **declared, not built** | — not seeded                    |
| 15  | `SUPER_ADMIN` (platform) | Operator, full             | §14 Operator                  | `ops@paperlesstech.in`          |
| 16  | `SUPPORT` (platform)     | Operator, read-only        | §14 Operator                  | — not seeded                    |

**Emergency and Theatre are not roles.** They are modules worked by the roles above holding
`triage:perform` (NURSE, DOCTOR) and `ot:schedule` / `ot:record` (NURSE runs the list, DOCTOR writes
the record). They get their own sections — §10 and §11 — because the _workflow_ is what needs
validating, not a persona. Inventing an "Emergency Staff" or "OT Staff" role here would misdescribe
the product.

### 2.1 The three-layer authorization model (ADR-0010)

Every scenario that expects a refusal must be read against this, or a correct refusal gets filed as
a bug:

1. **Entitlement** — did the hospital _buy_ the module? Failure: `403 HMS-PLAN-002`, naming the flag.
2. **Permission** — does the role hold the code? Failure: `403 HMS-AUTH-005`.
3. **Row scope** — is the record inside the caller's branch / tenant? Failure: **`404 HMS-GEN-404`**,
   deliberately, because a 403 would confirm the record exists.

A tester who meets `HMS-PLAN-002` and reports "permission bug" has mis-filed layer 1 as layer 2.

### 2.2 The permission surface, as the app actually prints it

`pnpm --filter @medicore/api routes` prints every registered route with the permission and feature
flag it enforces, read from the live Express app rather than from a document. **299 routes, 10
public.** Run it before a campaign — it is the only authorization reference that cannot be stale, and
it is the fastest way to answer "should this role be able to do this?".

---

## 3. Environment and prerequisites

Unchanged from `MANUAL_VALIDATION_RUNBOOK.md` §3, which remains the long-form text. Reproduced here
as a gate because **every clinical result taken before ENV-04 says READY is void.**

| ID         | Step                                                         | Command                                                        | Gate?                                       |
| ---------- | ------------------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------- |
| **ENV-01** | Infrastructure up                                            | `pnpm docker:dev` then `pnpm dev`; `/health` → 200             | Yes                                         |
| **ENV-02** | Operator, hospitals and all thirteen staff accounts          | `pnpm seed:operator && pnpm seed:demo`                         | Yes                                         |
| **ENV-03** | Schema convergence across every tenant                       | `pnpm seed:migrate --all` then `--check`                       | **Yes — hard**                              |
| **ENV-04** | 🔴 Build and verify the validation ward                      | `pnpm seed:validation` then `-- --verify` → must print `READY` | **Yes — hardest. Stop if it says BLOCKED.** |
| **ENV-05** | Know what the ward contains (45 beds, 2 zones, 12 medicated) | read `--verify` output                                         | No                                          |
| **ENV-06** | Reach the API from a handset                                 | prefer `pnpm --filter @medicore/api dev:device-domains`        | Mobile only                                 |
| **ENV-07** | Mobile build — Expo Go or a development build                | see §17 and `MOBILE_PUSH_ENABLEMENT.md`                        | Mobile only                                 |
| **ENV-08** | Devices and browsers actually available                      | §22.3                                                          | Plan the day around it                      |

**Two traps that have each cost a day and are not obvious:**

- **`tenant converged` is weaker evidence than it sounds.** The migration runner skips anything
  already recorded, so an index dropped by hand or lost to an old restore reports "converged" while
  changing nothing. ENV-04 is what actually checks. (Risk register T2, materialised 2026-08-14: four
  local tenants were missing `one_administration_per_dose_slot` and a probe reported seven
  catastrophic safety failures that were _entirely_ the missing index.)
- **Containers showing `Exited (137)` are the local Docker memory ceiling, not flaky software.**
  Free memory and restart before blaming anything in this plan.

### 3.1 Timezone — plan the clock, not just the checklist

Branch A is `Asia/Kolkata`, Branch B is `America/New_York` — 9½–10½ hours apart, chosen so the two
wards sit on different calendar days during ordinary working hours. Several scenarios are only
meaningful near a midnight, and **the MAR integration suite genuinely fails between roughly 05:30
and 09:30 IST** because of a real ward-timezone window. Check `TZ=America/New_York date` before
concluding a red run is a defect.

---

## 3A. FRONT DESK — Reception and Front Office

**Roles:** `RECEPTIONIST` · `FRONT_OFFICE` (the same job plus the cash counter — the union role, for
the small hospital where one person does both).
**Screens:** `/patients`, `/patients/[id]`, `/reception`, `/appointments`, `/receipts`, `/billing`
(read), `/opd-slip/[id]`.
**Modules:** Patient Registration & MPI · Visit / Queue · Appointments · Vitals at the desk ·
Payment (Front Office only).

> **The desk measures the patient.** `RECEPTIONIST` holds `vitals:record` and `vitals:read` and
> deliberately **not** `emr:read` — the scale is next to the counter in an Indian OPD, and the
> alternative was that nothing was measured at all. The desk sees the observations it took today; it
> never sees the consultation note. That is a policy decision, recorded in the role catalogue, and a
> tester should not report it either way round.

### Module: Patient Registration & MPI

#### FD-REG-001 — Existing patient detection before a second record is created

**Role:** Front Desk · **Module:** Patient Registration · **Criticality:** C0 · **Priority:** P0

**Preconditions** — a patient already registered at this branch; their name, phone and UHID known.

**Steps**

1. Open `/patients`.
2. Search by part of the name. Then by full UHID. Then by phone number.
3. Open the matching record.

**Expected Result** — all three searches return the patient. The row and the chart both carry the
**UHID**. The record can be opened and used; no registration form is offered as the primary action.

**Negative / Boundary** — a search with no match returns an explicit empty state, not a blank page.
A search string of 200 characters is refused by validation, not by a 500. The register's list cap is
**100**; a client asking for more is refused `400 HMS-VAL-001` (this is exactly the shape of the two
`limit=200` defects the browser sweep found — see XC-INT-002).

**Downstream Verification** — the patient found here is the same identity the doctor, the ward and
the bill will use. Confirm the UHID is unchanged on `/reception` after starting a visit.

**Automation Coverage**

- Unit: `N/A`
- Integration: `⚠️ partial` — `apps/api/src/patients.int.test.ts` §2 proves the clerk can open the
  chart the MPI refused for, **by id and by UHID**; `apps/api/src/branchIsolation.int.test.ts` §18
  covers what a search may disclose across branches; `apps/api/src/rbac.int.test.ts` covers who may
  call each route. **Still no suite asserting that a search by name, by UHID and by phone all find
  the same person** — the `?q=` path itself is untested.
- E2E: `❌`
- Mobile: `✅ — apps/mobile/__tests__/doctor.test.ts` (identity fetched per patient and cached)
- Manual: **⬜ Not Tested**

**Evidence** — screenshot of each of the three searches with the UHID legible.

---

#### FD-REG-002 — Registration issues a UHID, and the UHID is for life

**Role:** Front Desk · **Module:** Patient Registration · **Criticality:** C0 · **Priority:** P0

**Preconditions** — none. Use a synthetic name that cannot collide with the seeded register.

**Steps** — `/patients` → Register → name, gender, DOB or age, phone → submit.

**Expected Result** — `201`. A **UHID is issued and shown on screen at the moment of creation.**
Re-opening the record shows the same UHID.

**Negative / Boundary** — the UHID counter is atomic: two registrations in quick succession must
produce two different UHIDs, never a collision and never a gap that repeats. Submitting the form
twice (double-click) must produce **one** patient.

**Downstream Verification** — the UHID appears on the OP slip, the reception register, the doctor's
queue, the ward row, the medication-round row and the invoice. It is the identity every other
scenario in this plan hangs from.

**Automation Coverage**

- Unit: `N/A`
- Integration: `✅ — apps/api/src/patients.int.test.ts` §1 ("the desk can register at all") — a
  registration with no UHID fails the suite, and two genuinely different people get two different
  UHIDs. **The remaining gap is narrower and named: nothing proves the counter is atomic under
  CONCURRENT registration.** `nextUhid` uses `findOneAndUpdate` `$inc` inside the transaction, so
  the property is there; no test races it.
- E2E: `⚠️ partial` — `e2e/pharmacyDispensing.spec.ts` and `e2e/emergencyWorkflow.spec.ts` both
  register a patient as a fixture and use the UHID, so a total failure would go red; neither asserts
  the issue rule.
- Mobile: `N/A` — the phone does not register patients.
- Manual: **⬜ Not Tested**

---

#### FD-REG-003 — Required and invalid fields are refused in words, and nothing typed is lost

**Role:** Front Desk · **Module:** Patient Registration · **Criticality:** C2 · **Priority:** P1

**Steps** — submit with (a) no name, (b) a malformed phone, (c) a DOB in the future, (d) an age of
`999`.

**Expected Result** — each refused with `400 HMS-VAL-001` and a **field-level message**. **Every
other value the clerk typed is still on the form.** No refusal is a bare toast.

**Negative / Boundary** — a 2,000-character address must be refused or accepted deliberately, never
silently truncated.

**Automation Coverage**

- Unit: `✅ — apps/api/src/errorContract.test.ts` (the shape of `HMS-VAL-001`, and that it carries no PHI)
- Integration: `⚠️ partial` — validation shape is proven; these specific fields are not enumerated.
- E2E: `❌`
- Manual: **⬜ Not Tested**

---

#### FD-REG-004 — 🔴 MPI duplicate refusal names the candidate it thinks this already is

**Role:** Front Desk · **Module:** Patient Registration · **Criticality:** C0 · **Priority:** P0
**Runbook:** JR-02

**Preconditions** — a patient registered in FD-REG-002, with a known name, DOB and phone.

**Steps** — register a **second** patient with the same name, the same date of birth and the same
phone.

**Expected Result** — **`409 HMS-PAT-002`.** The screen **names the candidate(s)** it matched and
says _what_ matched. It does not merely say "duplicate".

**Negative / Boundary**

- Near-misses **below** the blocking threshold must be _shown_ and _not enforced_ — a warning the
  clerk can read past is the design (`patient.service.ts`: "Near-misses below the block threshold.
  Shown, not enforced").
- The detector matches on **exact DOB** among other fields. Two genuinely different people who share
  a birthday and a common name are expected to be offered as candidates; that is correct, not a
  false positive to file.

**Downstream Verification** — the register still holds **one** patient. A silent second UHID is how
one human becomes two charts, and the ward, the bill and the allergy list all split with it.

**Automation Coverage**

- Unit: `❌` — the scoring functions in `mpi.ts` are still not unit-tested directly; they are
  exercised through the API.
- Integration: **`✅ — apps/api/src/patients.int.test.ts`** §2 ("registering somebody who is already
  here") — the `409`, the `HMS-PAT-002` code, the candidate's **id, UHID, name, phone, score and
  `matchedOn`**, the threshold echoed in the body, **that the register still holds exactly one
  chart**, and that the clerk can still open the record it refused for. §3 pins the threshold
  arithmetic itself: phone alone (40) and name alone (35+5) warn; name+DOB (60) blocks exactly at
  the bar; the same pair with a differing gender falls to 55 and only warns.
  **Falsified** — disabling the refusal turns 8 tests red; moving `DUPLICATE_THRESHOLD` to 30 turns 4 red.
- E2E: `❌`
- Mobile: `N/A`
- Manual: **⬜ Not Tested**

**Evidence** — the `409` body in full, including the candidate list; the register's row count before
and after.

---

#### FD-REG-005 — The override exists, and only a human can use it

**Role:** Front Desk · **Module:** Patient Registration · **Criticality:** C0 · **Priority:** P0
**Runbook:** JR-03

**Steps** — on FD-REG-004's refusal, choose to register anyway (`force: true`).

**Expected Result** — it proceeds, **and only because a person said so**. The override is recorded:
`patient.duplicateOverridden` in the activity trail, with the candidate it overrode.

**Negative / Boundary** — **`force` requires `patient:merge`**, which the plain `RECEPTIONIST` does
**not** hold. A desk clerk attempting it gets `403 HMS-AUTH-005`, and that is correct: the person who
can create a knowing duplicate must be the person who can also merge it. **If `force` is ever applied
automatically anywhere in the UI, that is a P1** — the check would be decorative.

**Automation Coverage**

- Integration: `✅ — apps/api/src/patients.int.test.ts` §4 ("overriding the refusal") — a
  receptionist's `force` is refused **`403 HMS-AUTH-005` naming `patient:merge`** and writes
  nothing; an administrator's succeeds; the override produces a `patient.duplicateOverridden` audit
  entry carrying the candidates it overrode; `possibleDuplicates` comes back empty on an override;
  and `force` on a registration that was never blocked is simply ignored rather than escalating.
  **Falsified** — removing the `patient:merge` check turns 3 red.
- E2E: `❌`
- Manual: **⬜ Not Tested**

---

#### FD-REG-006 — Merge joins two charts and deletes nothing

**Role:** Hospital Admin (holds `patient:merge`) · **Module:** MPI · **Criticality:** C0 · **Priority:** P1

**Steps** — `POST /patients/merge` with a survivor and a duplicate. Then search for the duplicate's
UHID.

**Expected Result** — the duplicate is marked `merged`, **never deleted**. Its UHID still resolves,
and resolves to the survivor. Clinical records repoint to the survivor
(`onPatientsMerged` runs on billing and the other consumers).

**Negative / Boundary** — merging a patient into themselves is refused. Merging an already-merged
record is refused. `PATIENT_STATUSES` is `["active", "merged"]` and merged records are hidden from
the register by default — confirm they are hidden, not gone.

**Downstream Verification** — **a merged patient cannot be booked an appointment.** That is the one
downstream effect with a test behind it.

**Automation Coverage**

- Integration: `✅ — apps/api/src/patients.int.test.ts` §5 ("folding one chart into another") —
  self-merge refused, the merge itself, the merged chart **kept** with its UHID still resolving by
  id and by UHID, hidden from the register by default and findable with `status=merged`, no longer
  offered as an MPI candidate, a second merge refused `HMS-STATE-001`, a **chain refused** with the
  live record named, the audit entry carrying the operator's typed reason, and a receptionist
  refused the route. Plus `apps/api/src/appointments.int.test.ts` §"a merged patient cannot be
  booked". **Falsified** — dropping the `status: "active"` filter and removing the chain guard each
  turn one red.
  **Still untested: the `patient.patients.merged` event actually re-pointing billing and the other
  consumers.**
- E2E: `❌`
- Manual: **⬜ Not Tested**

---

#### FD-REG-007 — The register pages, filters by registration date, and says what it is showing

**Role:** Front Desk · **Module:** Patient Registration · **Criticality:** C2 · **Priority:** P2

**Preconditions** — a register with more than 25 patients (`pnpm seed:clinical -- --patients 300`).

**Steps** — open `/patients`; read the count; page forward; set **Registered on or after** and
**Registered on or before**; clear the filters.

**Expected Result** — 25 per page, newest first, an honest "showing X–Y of Z", and the date range
narrows the list. **The bounds resolve in the ACTIVE BRANCH's timezone**, not the server's — a clerk
at a differently-zoned site asking for the 16th must not get a window that opens at 14:30 on the
15th. The range is **half-open** (`$gte` / `$lt`), so a patient registered at 23:59 on the closing
day is included.

**Negative / Boundary** — `from` later than `to` returns an empty list, not an error page. Changing
a filter resets to page 1 (otherwise page 4 of a 2-page result reads as "no patients").

**Automation Coverage**

- Unit: `✅ — apps/web/__tests__/day.test.ts` (`dayRangeInZone`, half-open, in the branch's calendar)
- Integration: `✅ — apps/api/src/appointments.tz.int.test.ts` §"the register's DATE RANGE is the branch's days too"
- E2E: `❌`
- Web component: `✅ — apps/web/__tests__/patientRegisterFilters.test.tsx`
- Manual: **⬜ Not Tested**

---

#### FD-REG-008 — Patient identity crosses branches; the operational record does not

**Role:** Front Desk · **Module:** MPI · **Criticality:** C1 · **Priority:** P2
**Runbook:** the §13A "Known limitation"

**Steps** — at branch A, search for a patient registered at branch B.

**Expected Result — read this before filing anything.** The MPI will offer them as a **search
candidate** (identity is not site-specific), and **opening their branch-B record is refused**. That
combination is **recorded technical debt and a PRODUCT DECISION**, not a defect: ADR-0015 §5 says
patient lookup is tenant-wide, the repository scopes it to a branch, and doing neither is the only
certainly-wrong option. Record it against this scenario and move on.

**Automation Coverage**

- Integration: `✅ — apps/api/src/branchIsolation.int.test.ts` §18 ("patient identity crosses
  branches; operational records do not") and §19 ("resolving a patient grants no access to the other
  branch's records") — the current behaviour is pinned in both directions. **And
  `apps/api/src/patients.int.test.ts` §6 adds the half §18 does not have: registering the same
  person at the OTHER site is REFUSED `HMS-PAT-002`, so identity crossing branches is a prevention
  and not merely a disclosure.** Falsified — adding `scopeFilter()` to `findCandidates` turns 3 red.
- Manual: **⬜ Not Tested**

---

### Module: Visit / Queue (the walk-in door)

#### FD-VIS-001 — Starting a visit issues a token and puts the patient on the day's register

**Role:** Front Desk · **Module:** Encounters · **Criticality:** C1 · **Priority:** P0
**Runbook:** JR-05

**Steps** — `/reception` → start a visit for the FD-REG-002 patient → choose the doctor / department.

**Expected Result** — `201`; a **token** is issued; the patient appears on the day's register against
the right doctor. A **consultation charge is raised** shortly after (billing listens for
`encounter.started`), not instantly.

**Negative / Boundary** — starting a visit for a patient with no name resolvable is impossible by
construction; starting one against a closed branch is refused.

**Downstream Verification** — the token appears on the doctor's `/my-patients`; the charge appears on
`/billing` pending.

**Automation Coverage**

- Integration: `✅ — apps/api/src/encounters.int.test.ts` §"a government hospital runs a whole clinic
  with NO appointment book" and §"an encounter records when the doctor actually saw the patient";
  charge creation `✅ — apps/api/src/billing.int.test.ts`
- E2E: `⚠️ partial` — `e2e/emergencyWorkflow.spec.ts` drives registration→board through the real
  desk; the ordinary OPD visit is not separately swept.
- Manual: **⬜ Not Tested**

---

#### FD-VIS-002 — 🔴 Starting a visit twice resumes it; it never duplicates it

**Role:** Front Desk · **Module:** Encounters · **Criticality:** C1 · **Priority:** P0
**Runbook:** JR-06

**Steps** — start a visit for the **same patient** a second time, on the same day.

**Expected Result** — **the same visit is handed back — resumed, not duplicated.** The register shows
**one** row and **one** token.

**Negative / Boundary** — enforced in the database by the partial-unique index
`one_open_encounter_per_patient`, not only in code. Double-clicking the button must also produce one.

**Downstream Verification** — two open visits is _the commonest data-quality disaster in an OPD_: the
census double-counts and the bill splits in two. Confirm `/billing` shows one consultation charge.

**Automation Coverage**

- Integration: `✅ — apps/api/src/encounters.int.test.ts` §"a patient cannot be in the building twice"
  and §"starting a visit refuses when the database cannot enforce one open encounter"
- Unit: `✅ — apps/api/src/schemaReadiness.test.ts`
- E2E: `❌`
- Manual: **⬜ Not Tested**

---

#### FD-VIS-003 — The register's day is the BRANCH's day

**Role:** Front Desk · **Module:** Encounters · **Criticality:** C2 · **Priority:** P0
**Runbook:** TZ-08 · **Regression check for risk-register D2 (fixed `8330faa`)**

**Priority is P0 against a C2 criticality deliberately** — nobody is harmed by a wrong day, but this
is the first screen the hospital opens each morning, and it was a real defect.

**Steps** — as the desk at **branch B** (`America/New_York`), near a date boundary, read
`/reception` with `?date=` set. Compare against branch A.

**Expected Result** — the register resolves the requested day in the **branch's** zone. Each site
shows its own day. It must not use `env.DEFAULT_TIMEZONE`.

**Automation Coverage**

- Unit: `✅ — apps/api/src/core/time/day.test.ts`, `apps/api/src/core/time/zone.test.ts`, `apps/web/__tests__/day.test.ts`
- Integration: `✅ — apps/api/src/appointments.tz.int.test.ts` §"the register's day is the BRANCH's
  day, not the hospital default's"
- Manual: **⬜ Not Tested**

---

#### FD-VIS-004 — The register covers a span of days, not only today

**Role:** Front Desk · **Module:** Encounters · **Criticality:** C2 · **Priority:** P2

**Steps** — on `/reception`, leave the **To** field empty (one day), then set it a week later.

**Expected Result** — empty **To** keeps the screen answering _who came in today_. Setting it widens
the register across the span, still in the branch's zone, still half-open at the closing bound.

**Automation Coverage**

- Integration: `✅ — apps/api/src/appointments.tz.int.test.ts` §"the register's DATE RANGE is the branch's days too"
- E2E: `❌`
- Manual: **⬜ Not Tested**

---

#### FD-VIS-005 — Every row on the register and the queue names its patient

**Role:** Front Desk / Doctor · **Module:** Encounters · **Criticality:** C1 · **Priority:** P0
**Regression check for risk-register D18 (fixed 2026-08-19)**

**Preconditions** — a hospital with **more than 100 patients**, and a queued patient who registered
_before_ the most recent 100. This is the whole point: any fixture with five patients passes against
the defect.

**Steps** — open `/reception` and `/my-patients`. Read every row.

**Expected Result** — every row carries the patient's **name and UHID**, resolved **server-side**
(`EncounterRow` carries `patientName` and `uhid`). No row reads `—`.

**Negative / Boundary** — if a queue is longer than the page it asks for, the screen must **say how
many are beyond it** rather than silently dropping the tail.

**Automation Coverage**

- Integration: `✅ — apps/api/src/encounters.int.test.ts` §8 (buries the queued patient under 120 later registrations)
- Web component: `✅ — apps/web/__tests__/queueIdentity.test.tsx` (answers `/patients` with a hundred _other_ people)
- E2E: `⚠️ partial` — `e2e/clinicalSafety.spec.ts` proves it on the ward and the round, not the OPD queue.
- Manual: **⬜ Not Tested**

---

#### FD-VIS-006 — Registration refuses safely when the database cannot enforce one open visit

**Role:** Front Desk · **Module:** Encounters · **Criticality:** C0 · **Priority:** P1
**Runbook:** DRIFT-06 · §16A

**Preconditions** — read §16A of the runbook **including the restore block** before dropping
anything. `pnpm seed:migrate` will **not** put a dropped index back and will report "converged"
while the ward is disarmed.

**Steps** — drop `one_open_encounter_per_patient` on the validation tenant. As the **Receptionist**,
register an arrival for a patient with no open encounter.

**Expected Result** — **`503 HMS-ENC-001`**, `Retry-After: 60`, and a message that tells the clerk
what to do _instead_ (register on paper). Patients already in the queue can still be **called in and
closed**. The appointment desk's **check-in** reaches the same guard and refuses the same way.

**Downstream Verification** — `encounters.countDocuments({ patientId, open: true })` → **0**. The
refusal left nothing to reconcile.

**Recovery** — recreate the index per §16A, wait up to 60 s for the readiness cache, retry, then
`pnpm --silent seed:migrate --check --json | jq '.verdict'` must print `READY`.

**Automation Coverage**

- Unit: `✅ — apps/api/src/schemaReadiness.test.ts`
- Integration: `✅ — apps/api/src/schemaGuard.int.test.ts` §2 (falsification) and
  `apps/api/src/encounters.int.test.ts` §"starting a visit refuses when the database cannot enforce
  one open encounter"
- Manual: **⬜ Not Tested** — _and this is one of the five refusals no human has ever seen on a screen._

---

### Module: Appointments

#### FD-APT-001 — Slots are computed in the CLINIC's zone, never the server's

**Role:** Front Desk · **Module:** Appointments · **Criticality:** C2 · **Priority:** P1

**Steps** — `/appointments` → availability for a doctor at branch B, read from a machine in another
zone.

**Expected Result** — slots are generated from the **branch's** calendar. Availability is **computed,
never stored**.

**Automation Coverage**

- Integration: `✅ — apps/api/src/appointments.tz.int.test.ts` §"slots are generated in the CLINIC's
  zone, not the server's" and §"booking and leave agree with the clinic's calendar"
- Manual: **⬜ Not Tested**

---

#### FD-APT-002 — Check-in reaches the same front door as a walk-in

**Role:** Front Desk · **Module:** Appointments · **Criticality:** C1 · **Priority:** P0
**Runbook:** JR-07

**Steps** — book an appointment, confirm it, then **check in**.

**Expected Result** — check-in produces a visit **exactly as starting a walk-in did**, and
FD-VIS-002's one-open-visit rule **still holds against it**. Check-in reaches the same
`startEncounter`.

**Negative / Boundary** — if check-in can create a second open visit for a patient who already walked
in, FD-VIS-002's guard has a hole.

**Automation Coverage**

- Integration: `✅ — apps/api/src/appointments.int.test.ts` §"lifecycle (STATE_MACHINE_CATALOG §1)"
  and `apps/api/src/encounters.int.test.ts` §"a patient cannot be in the building twice"
- E2E: `❌`
- Manual: **⬜ Not Tested**

---

#### FD-APT-003 — The appointment state machine refuses illegal edges

**Role:** Front Desk · **Module:** Appointments · **Criticality:** C2 · **Priority:** P1

**Steps** — walk one appointment through confirm → check-in → start → complete. Then attempt
`cancel` on the completed one, `no-show` on a checked-in one, and `reschedule` on a cancelled one.

**Expected Result** — legal edges succeed; illegal edges are refused `422 HMS-STATE-001` naming the
current state.

**Automation Coverage**

- Integration: `✅ — apps/api/src/appointments.int.test.ts` §"lifecycle"
- Manual: **⬜ Not Tested**

---

#### FD-APT-004 — 🔴 A foreign site cannot drive this site's clinic list

**Role:** Front Desk (branch B) · **Module:** Appointments · **Criticality:** C0 · **Priority:** P0
**Runbook:** BR-11 · **Regression check for risk-register D9 (fixed `4732dd8`) — the only confirmed
cross-branch WRITE**

**Preconditions** — an appointment booked at **branch A**, in `requested` or `confirmed`. Note its id.

**Steps** — as a **branch-B** clerk holding `appointment:cancel` / `appointment:update`, POST each of
`/cancel`, `/no-show`, `/check-in` against the branch-A appointment id with `X-Active-Branch: B`.

**Expected Result** — all three refuse, `404 HMS-GEN-404`. **Then re-read the appointment as an A
user: it must still be in the state it started in.**

> **The trap, and it is the whole row.** Before the fix, the FIRST call succeeded (200, `cancelled`)
> and the next two returned **422** — refused by the state machine for being _already cancelled_.
> Three refusals in a row looks exactly like a working boundary. **The second half — re-reading the
> state as an A user — is what actually proves it.**

**Automation Coverage**

- Integration: `✅ — apps/api/src/branchIsolation.int.test.ts` §23 — all three transitions, the
  positive control, **and the re-read**. Falsified: removing branch scope on the appointment read
  turns all four red, including _"leaves the Hyderabad appointment untouched"_.
- E2E: `❌`
- Manual: **⬜ Not Tested**

---

#### FD-APT-005 — Doctor leave at one site does not close the clinic at another

**Role:** Front Desk · **Module:** Appointments · **Criticality:** C2 · **Priority:** P2

**Steps** — record leave for a doctor at branch A; read availability at branch B.

**Expected Result** — branch B's clinic is unaffected. A doctor can hold the same weekday at two
sites.

**Automation Coverage**

- Integration: `✅ — apps/api/src/branchIsolation.int.test.ts` §"leave at one site does not close the
  clinic at another" and §"a doctor can hold the same weekday at two sites"
- Manual: **⬜ Not Tested**

---

### Module: Payment at the desk (Front Office / Cashier)

#### FD-PAY-001 — What the visit costs appears without anybody typing it

**Role:** Front Office / Cashier · **Module:** Billing · **Criticality:** C1 · **Priority:** P0

**Steps** — after FD-VIS-001, open `/billing` → pending.

**Expected Result** — the consultation charge is there, priced from the tariff, raised by the
`encounter.started` event rather than by a form. A missing price **does not stop the patient being
treated**.

**Automation Coverage**

- Integration: `✅ — apps/api/src/billing.int.test.ts` §"a missing price does not stop a patient being
  treated" and §"the same software bills a private hospital and a government hospital"
- Manual: **⬜ Not Tested**

---

#### FD-PAY-002 — An unpaid charge holds laboratory work, and says so

**Role:** Front Desk / Lab · **Module:** Billing ↔ Orders · **Criticality:** C1 · **Priority:** P1

**Steps** — order a lab test without collecting payment. Open the lab `/worklist`.

**Expected Result** — the item is on the bench with a **payment badge that agrees with the server**.
Payment is **advisory at the API and held at the web worklist** — documented in
`AI_Workflow/docs/PAYMENT_POLICY.md`. Collect the payment; the badge clears.

**Negative / Boundary** — only a **real, raised, unpaid** charge holds work. A test with no charge is
not held. **An emergency is held like anything else, today** — that is current behaviour and a
product decision, not a defect to file.

**Automation Coverage**

- Unit: `✅ — apps/web/__tests__/paymentHold.test.ts` (every payment state the API can answer)
- Integration: `✅ — apps/api/src/orders.int.test.ts` §"payment is visible to the lab, and gates nothing"
- E2E: `✅ — e2e/labWorklist.spec.ts` (the badge agrees with the server)
- Manual: **⬜ Not Tested**

---

#### FD-PAY-003 — Advance, receipt, and the reprint that must work from the other site

**Role:** Front Office / Cashier · **Module:** Wallet · **Criticality:** C1 · **Priority:** P2
**Runbook:** BR-12 — **a NEGATIVE check. Do not "fix" this.**

**Steps** — take an advance at branch **A**. As a **branch-B** cashier, open the patient's wallet,
then reprint via `GET /api/v1/wallet/entries/:id`.

**Expected Result** — balance and statement show the A deposit; the receipt reprints, `200`. **A
refusal here is a defect, not a security improvement.** One patient has one advance purse for the
hospital, and an advance taken at A is spendable at B.

> This row exists because during the 2026-08-17 audit this read was "fixed" to be branch-scoped and
> then reverted. A statement showing a line whose receipt will not open is the failure.

**Automation Coverage**

- Integration: `✅ — apps/api/src/branchIsolation.int.test.ts` §24 (pinned hospital-wide on purpose)
- Manual: **⬜ Not Tested**

---

### Module: Vitals at the desk

#### FD-VIT-001 — The desk measures, and sees only what it measured

**Role:** Front Desk · **Module:** Vitals · **Criticality:** C2 · **Priority:** P2

**Steps** — record height, weight, BP and temperature on today's visit. Then attempt to open the
consultation note.

**Expected Result** — the readings save and appear on the OP slip with a BMI. The consultation note
is refused (`403 HMS-AUTH-005`) — the desk holds `vitals:read`, not `emr:read`. **The flags the
readings carry are adult reference ranges and advisory only**; nothing here makes the desk a clinical
decision-maker.

**Automation Coverage**

- Integration: `✅ — apps/api/src/vitals.int.test.ts` §"authorization", §"validation", §"server-side assessment"
- Web component: `✅ — apps/web/__tests__/vitalsWrite.test.tsx` §5 ("the form decides nothing clinical")
- Manual: **⬜ Not Tested**

---

### Module: Front-desk authorization boundaries

#### FD-SEC-001 — The desk is refused every clinical write, at the API

**Role:** Front Desk · **Module:** RBAC · **Criticality:** C0 · **Priority:** P0
**Runbook:** PERM-02, PERM-03, NEG-01

> **Constitution §3.6: UI gating is convenience, not security.** A hidden button is not evidence; a
> `403` is. Every row here is verified at the API with `curl`, and the UI check is a second, weaker
> observation.

**Steps** — as `reception@sunrise.test`, call:

| Attempt                                               | Expected           |
| ----------------------------------------------------- | ------------------ |
| `POST /encounters/:id/medication-administrations`     | `403 HMS-AUTH-005` |
| `GET /encounters/:id/medication-schedule`             | `403 HMS-AUTH-005` |
| `POST /encounters/:id/notes` (doctor's clinical note) | `403 HMS-AUTH-005` |
| `POST /encounters/:id/nursing-notes`                  | `403 HMS-AUTH-005` |
| `GET /patients/:id`                                   | `200`              |
| `POST /patients`                                      | `201`              |

**Negative / Boundary** — every denial's **UI** shape must be an explanation, not a dead button and
not a raw error (PERM-08).

**Automation Coverage**

- Integration: `✅ — apps/api/src/rbac.int.test.ts` §"the matrix: role × route" — **every protected
  `/api/v1` route is probed against RECEPTIONIST**, and §"route coverage" fails the build if a new
  protected route ships without a probe. Also §"privilege boundaries that must never move".
- E2E: `❌` — the UI shape of a denial (PERM-08) is not swept.
- Manual: **⬜ Not Tested**

---

#### FD-SEC-002 — A branch-confined desk user cannot exceed their binding

**Role:** Front Desk, bound to one branch · **Module:** RBAC / branch scope · **Criticality:** C0 · **Priority:** P0
**Runbook:** BR-07 — _"the highest-value single account in the campaign"_

**Preconditions** — a front-desk user created with `assignRole(userId, roleId, [branchB])`, so
`branchScope = "branches"`. No seeded account has this; create one through the roles UI as tenant
admin. **No code change needed.**

**Steps** — as that user, list patients three times: with `X-Active-Branch: B`, with
`X-Active-Branch: MAIN`, and with **no header at all**.

**Expected Result** — the same B-only result every time. **The header filters within what you may
see. It does not grant.** An unbound admin sees both sites' counts.

**Automation Coverage**

- Integration: `✅ — apps/api/src/branchIsolation.int.test.ts` §2, plus confined NURSEs in `mar.int.test.ts`
  and `nursing.int.test.ts`; `apps/api/src/rbac.int.test.ts` §"row scope: branch confinement (the P2 bug, pinned)";
  and `apps/api/src/patients.int.test.ts` §6 proves a **branch-confined clerk still meets the MPI** —
  the one place in the hospital that could otherwise quietly mint a second UHID.
- E2E: `❌`
- Manual: **🟡 Partially executed 2026-08-19 by an agent at the API layer** (a GC01-bound desk user
  saw 4 GC01 patients under all three header conditions). **Never executed by a person through a
  UI. Status here remains ⬜ Not Tested.**

---

## 4. DOCTOR

**Role:** `DOCTOR`.
**Screens (web):** `/my-patients`, `/patients/[id]`, `/ward`, `/worklist` (read), `/alerts`,
`/medication-round` (read-only), `/doctors` (own availability), `/theatres`, `/emergency`,
`/discharge-summary/[id]`, `/ip-sheet/[id]`.
**Screens (mobile):** the whole M2 surface — see §4.9.
**Modules:** Queue · Chart & timeline · Vitals · Consultation · Orders · Results · Prescribing ·
Admission & bed · Discharge · Theatre record · Emergency workup.

### Module: The queue

#### DOC-QUE-001 — The doctor's list loads, in an order the waiting room accepts

**Criticality:** C1 · **Priority:** P0

**Steps** — sign in as `drrao@sunrise.test`, open `/my-patients`.

**Expected Result** — today's queued patients for **this doctor**, at **this branch**, in token
order. Every row names the patient and carries the UHID (see FD-VIS-005).

**Negative / Boundary** — a doctor with nobody booked gets a **real empty state**, not a blank page —
_"an empty list is a fact, not a failure"_. A queue longer than the page must say how many are beyond
it; the rows are in token order, so the hundred shown are the earliest arrivals and a silent cap
would hide the tail.

**Automation Coverage**

- Integration: `✅ — apps/api/src/encounters.int.test.ts` §8
- Web: `✅ — apps/web/__tests__/queueIdentity.test.tsx` §1, §4
- Mobile: `✅ — apps/mobile/__tests__/doctor.test.ts` §2–§6
- E2E: `⚠️ partial` — reached as a fixture by `emergencyWorkflow` and `pharmacyDispensing`; no spec owns it.
- Manual: **⬜ Not Tested**

---

#### DOC-CHT-001 — Opening a patient opens the right visit, and says who they are first

**Criticality:** C0 · **Priority:** P0 · **Runbook:** M2-17, M3-08

**Steps** — open a patient from the queue and from the ward.

**Expected Result** — the chart opens **with the visit in context** (the `encounterId`, not just the
patient). Identity reads **name → UHID → age/sex, in that order**, and the UHID is readable
digit-by-digit at arm's length.

**Negative / Boundary** — a very long patient name must wrap or truncate **with the UHID still
visible**. A truncated name with no UHID leaves nothing to identify the patient by (FR-03).

**Downstream Verification** — the same encounter receives the note, the orders and the prescription.
A wrong encounter is a wrong chart.

**Automation Coverage**

- Integration: `✅ — apps/api/src/encounters.int.test.ts` §"the episode of care is the care story"
- Mobile: `✅ — apps/mobile/__tests__/clinical.test.ts` §"identity is a safety control"
- E2E: `✅ — e2e/clinicalSafety.spec.ts` (the chart carries a UHID)
- Manual: **⬜ Not Tested**

---

#### DOC-CHT-002 — Age and every clinical timestamp are the hospital's, never the device's

**Criticality:** C1 · **Priority:** P1 · **Runbook:** M2-18, M2-22, TZ-01, TZ-07, WEB-21

**Steps** — set the phone or the workstation to `Pacific/Kiritimati`. Re-open the chart, the vitals
and the medication schedule.

**Expected Result** — **age does not change.** Every timestamp carries the **branch's** zone label
and does not move.

**Automation Coverage**

- Unit: `✅ — apps/api/src/core/time/zone.test.ts`, `apps/web/__tests__/day.test.ts`
- Mobile: `✅ — apps/mobile/__tests__/clinical.test.ts` §11, §11b; `routes.test.ts` ("a clinical time is never rendered in the device's zone")
- Manual: **⬜ Not Tested** — _needs a device whose OS zone you can change; no test layer can prove the rendered clock._

---

#### DOC-CHT-003 — Allergies are visible, and "none recorded" is not "no allergies"

**Criticality:** C0 · **Priority:** P0 · **Runbook:** M3-10, M3-11

**Steps** — open the seeded severe-allergy patient, then a patient with none.

**Expected Result** — the allergy is shown on the **worklist row**, the **chart**, and the **dose
confirmation** — all three. For a patient with none, the wording is _"None recorded… that is not the
same as no allergies"_. **Never "no allergies"** — that is a clinical assertion the record cannot
support.

**Negative / Boundary** — **allergies are hospital-wide on purpose**: _an allergy does not stop at a
site boundary_. Seeing a branch-A allergy while working at branch B is correct and must not be filed.

**Automation Coverage**

- Integration: `✅ — apps/api/src/allergies.int.test.ts`; `apps/api/src/nursing.int.test.ts` §"allergies reach the whole hospital"
- Unit: `✅ — apps/api/src/modules/drugSafety/drugSafety.test.ts`
- Mobile: `✅ — apps/mobile/__tests__/medication-round.test.ts` §"allergy context"
- E2E: `❌` — the three-surface presence is not swept in a browser.
- Manual: **⬜ Not Tested**

---

### Module: Consultation

#### DOC-CON-001 — The note saves, and typed clinical text is never lost

**Criticality:** C1 · **Priority:** P0 · **Runbook:** M2-25, M2-26, M2-27, M3-18

**Steps** — type a consultation note. Leave via the header chevron, hardware back **and** edge swipe
(mobile) or browser back (web). Then save. Then save again with the network off.

**Expected Result** — the discard prompt fires on **all three** exits. A successful save shows
"Saved HH:MM" **in the branch's zone**. **Offline, the pill reads "Not saved" and the typed words are
still on screen** — a false "Saved" is a P1.

**Automation Coverage**

- Integration: `✅ — apps/api/src/encounters.int.test.ts`; consultation route coverage in `rbac.int.test.ts`
- Web: `✅ — apps/web/__tests__/chartNote.test.tsx` (all four blocks, including the idempotency key the form never used to send)
- Mobile: `✅ — apps/mobile/__tests__/writes.test.ts` §1–§6; `routes.test.ts` ("a screen that writes clinical text protects it")
- E2E: `❌`
- Manual: **⬜ Not Tested**

---

#### DOC-CON-002 — The doctor's note and the nurse's note are different routes with different rights

**Criticality:** C1 · **Priority:** P0 · **Runbook:** PERM-04, PERM-05

**Steps** — as the doctor, `POST /encounters/:id/notes` (`emr:write`) → `201`. As the nurse, the same
call → `403`. As the nurse, `POST /encounters/:id/nursing-notes` (`nursing:manage`) → `201`. As the
doctor, that one → `403`.

**Expected Result** — exactly as above. **The nurse must have a working note route of her own AND be
refused the doctor's. Either half alone is the wrong outcome.**

**Automation Coverage**

- Integration: `✅ — apps/api/src/rbac.int.test.ts` §"privilege boundaries that must never move";
  `apps/api/src/nursing.int.test.ts` §"nursing notes"
- Web: `✅ — apps/web/__tests__/chartNote.test.tsx` §1, §2
- Manual: **⬜ Not Tested**

> **Known product gap, not a defect to file:** **web has no nursing-note surface.** Mobile gained
> `POST /nursing-notes` at M3-S2; the web ward page still gates notes on `emr:write`. The boundary is
> correct; the _screen_ is missing. Recorded on the tracker's open-risk list.

---

### Module: Orders

#### DOC-ORD-001 — An order reaches the department's bench with no hand-off

**Criticality:** C1 · **Priority:** P0 · **Runbook:** JR-09

**Steps** — from the consultation, order a lab test. Then order an imaging study. Open `/worklist` as
`labtech@` and as `radiographer@`.

**Expected Result** — `201` each. The lab test appears on the **lab's** worklist and the study on the
**imaging** worklist, named and UHID'd, without anybody forwarding anything. A **charge is raised**
for each.

**Negative / Boundary** — if it does not reach the queue, ADR-0013 §3's single-spine claim is not true
in the product. **An ED order must land on the ordinary bench**, not a second pipeline.

**Automation Coverage**

- Integration: `✅ — apps/api/src/orders.int.test.ts` §"the order carries work to the lab and the
  result back to the doctor", §"the department worklist"; ED→ordinary-bench in `emergency.int.test.ts`
- E2E: `✅ — e2e/labWorklist.spec.ts`, `e2e/radiologyWorkflow.spec.ts`
- Mobile: `✅ — apps/mobile/__tests__/writes.test.ts` §7
- Manual: **⬜ Not Tested**

---

#### DOC-ORD-002 — Ordering the same thing twice orders it once, and says so

**Criticality:** C1 · **Priority:** P1 · **Runbook:** DUP-02, NEG-13

**Steps** — double-click the order button. Repeat with DevTools throttled to 3G.

**Expected Result** — **one** `orders` row and one work item on the bench. The second attempt answers
**`200` with `duplicate: true`**, and the screen says _already ordered_.

> **Why `200` and not `409`, and why this matters to a tester.** The MAR answers a repeated dose with
> `409 HMS-MAR-001` because charting the same slot twice is a clinical contradiction a human must
> see. A repeated **order or dispense** is almost always a double-click, so the server returns the
> original row. **A `409` here would be a defect in the opposite direction.** Verify by counting
> rows, not by reading the status code.

**Automation Coverage**

- Integration: `✅ — apps/api/src/idempotency.int.test.ts` §"a request sent twice happens once",
  §"two identical requests arriving together execute once", §"the guarantee holds on the critical
  clinical writes"; `apps/api/src/orders.int.test.ts` §"ordering the same thing twice"
- Unit: `✅ — apps/api/src/core/idempotency/fingerprint.test.ts`
- Mobile: `✅ — apps/mobile/__tests__/writes.test.ts` §8; `errors.test.ts` §13 ("the three 409s mean
  different things and must not be collapsed")
- Manual: **⬜ Not Tested**

---

#### DOC-ORD-003 — An order cannot be raised against a visit that is over

**Criticality:** C1 · **Priority:** P1

**Steps** — close the encounter, then attempt an order against it.

**Expected Result** — refused. A closed visit does not accept new work.

**Automation Coverage**

- Integration: `✅ — apps/api/src/orders.int.test.ts` §"an order cannot be raised against a visit that is over"
- Manual: **⬜ Not Tested**

---

#### DOC-ORD-004 — Ordering refuses safely when the database cannot enforce one-order-per-request

**Criticality:** C0 · **Priority:** P1 · **Runbook:** DRIFT-04

**Steps** — drop `one_order_per_request_id`. As the **Doctor**, place a test.

**Expected Result** — **`503 HMS-ORD-001`**. **And the lab can still accept / start / complete /
verify / release work already on the bench** — the state machine is deliberately unguarded, because
samples must not be stranded mid-analysis.

> **Two logins are required and the row is misread without them.** The technician performs; the
> **pathologist** verifies and releases. A `403` means wrong account, not the refusal being tested.

**Downstream Verification** — `orders.countDocuments({ encounterId })` unchanged by the refused
placement.

**Automation Coverage**

- Integration: `✅ — apps/api/src/schemaGuard.int.test.ts`; `apps/api/src/orders.int.test.ts`
  §"ordering refuses when the database cannot enforce one-order-per-request"
- Manual: **⬜ Not Tested** — _one of the five refusals never seen on a screen._

---

### Module: Results

#### DOC-RES-001 — A result is invisible until it is released

**Criticality:** C0 · **Priority:** P0 · **Runbook:** M2-20

**Steps** — open an order the lab has completed but the pathologist has not verified or released.

**Expected Result** — status reads **"Awaiting verification"** and **no values are shown**. Leaking
an unverified number is a P1 — a doctor acting on a figure nobody has certified is the failure the
two-person rule exists to prevent.

**Automation Coverage**

- Integration: `✅ — apps/api/src/orders.int.test.ts` §"a result is certified by someone qualified to read it"
- Web: `✅ — apps/web/__tests__/resultRelease.test.ts` (all four blocks, both doctor-facing screens)
- Mobile: `✅ — apps/mobile/__tests__/clinical.test.ts` §"a result is invisible until it is released"
- E2E: `✅ — e2e/radiologyWorkflow.spec.ts` (release is what makes it readable on the chart)
- Manual: **⬜ Not Tested**

---

#### DOC-RES-002 — A critical result announces itself, and stops announcing once read

**Criticality:** C0 · **Priority:** P0 · **Runbook:** M2-21

**Steps** — have the lab release a **critical** value. Watch the ordering doctor's bell. Open it.
Reload the page. Sign in as an administrator holding every permission.

**Expected Result** — the bell shows a **badge**; the alert names the event without the value on the
lock screen; opening it **tells the server** (survives a reload); the message stays on `/alerts` once
read, filed rather than deleted; **the administrator sees none of it** — an alert follows the person,
not the permission set.

**Negative / Boundary** — a panic value must not be buried under six routine results. **Critical is
the server's word**, recognised by the template key, never by matching words in the text.

**Automation Coverage**

- Integration: `✅ — apps/api/src/orders.int.test.ts` §"a critical result is alerted immediately, not
  eventually"; `apps/api/src/notifications.int.test.ts` §"a person can read the messages addressed to
  them", §"a staff alert does not depend on a mail server"; `apps/api/src/branchIsolation.int.test.ts`
  §"a person's inbox follows the person, not the branch picker"
- Unit: `✅ — apps/api/src/pushCopy.test.ts` (what a locked screen may say)
- Web: `✅ — apps/web/__tests__/alertInbox.test.ts`
- Mobile: `✅ — apps/mobile/__tests__/alerts.test.ts`
- E2E: `✅ — e2e/alertInbox.spec.ts` (badge, server-side read, persistence, and the negative)
- Manual: **⬜ Not Tested**

---

#### DOC-RES-003 — The report file opens from the chart, and only from the right site

**Criticality:** C0 · **Priority:** P0 · **Runbook:** BR-10 · **Regression check for D10 (fixed `c02dd09`)**

> **The least clickable row in the whole campaign.** The report _list_ was already branch-scoped, so
> the UI never offered the link while the API still served the PDF. **A tester following screens
> would report everything as working.** It must be probed directly.

**Steps**

1. As an **A** user, note a report id from `GET /patients/:id/reports`.
2. As a **branch-B** user holding `emr:read`, call the same list — **the id must not appear**.
3. Then request `GET /api/v1/reports/:id/file` for the noted id with `X-Active-Branch: B`.

**Expected Result** — step 2 omits it; step 3 refuses `404 HMS-GEN-404`. **A `200` returning PDF
bytes is a P1 regression.** Record the first bytes: `%PDF` means it served the file.

**Also check** — the A user can still open it. A refusal in **both** directions is the fix
over-applied and is its own defect.

**Automation Coverage**

- Integration: `✅ — apps/api/src/branchIsolation.int.test.ts` §22 — real upload, list check, exploit
  by id, All-branches mode, the positive control, **and that the refusal carries no PDF bytes**.
  Falsified: removing branch scope on the single-report read turns it red with _"a Chennai
  administrator downloaded a Hyderabad report (status 200)"_.
- E2E: `❌`
- Manual: **⬜ Not Tested** — _the automated test proves the API; this row proves no client — a stale
  tab, a bookmark, a shared URL, a mobile deep link — can still reach the bytes._

---

### Module: Prescribing

#### DOC-RX-001 — Availability informs the prescriber and restricts them not at all

**Criticality:** C1 · **Priority:** P0

**Steps** — open the prescribing pad. Find a drug with stock and one with none.

**Expected Result** — the pad shows **"40 in stock"** / **"out of stock"**, and **both can be
prescribed**.

> **Why this is a safety row and not a convenience one.** Wiring availability to `disabled` means a
> patient who would happily have bought the drug at the chemist next door goes home **without a
> prescription for it**. The falsification is recorded: wiring availability to `disabled` turns
> `e2e/pharmacyDispensing.spec.ts` red.

**Automation Coverage**

- Web: `✅ — apps/web/__tests__/medicineAvailability.test.ts`, `pharmacyStock.test.ts`
  ("availability informs the prescriber and never restricts them")
- Integration: `✅ — apps/api/src/prescriptions.int.test.ts` §"a clinic sends the patient to the chemist next door"
- E2E: `✅ — e2e/pharmacyDispensing.spec.ts`
- Manual: **⬜ Not Tested**

---

#### DOC-RX-002 — An allergy blocks the signature until a human acknowledges it

**Criticality:** C0 · **Priority:** P0 · **Runbook:** M2-29, JR-11

**Steps** — compose a prescription that trips the allergy / interaction screen. Review. Sign.

**Expected Result** — the finding presents as a **review step**, not as a failed save. The signature
is blocked until acknowledged, and the acknowledgement is recorded.

**Negative / Boundary** — **an alert shaped like an error gets clicked past.** If the screen renders
the contraindication the same way it renders a 500, that is the defect this row exists for.

> **Scope limit, stated so nobody over-reads a pass:** allergy screening covers roughly 15 demo drugs
> and **is not a formulary**. Do not widen the drug list without widening the safety data.

**Automation Coverage**

- Unit: `✅ — apps/api/src/modules/drugSafety/drugSafety.test.ts`
- Integration: `✅ — apps/api/src/prescriptions.int.test.ts` §"an allergy blocks the signature until it is acknowledged"
- Mobile: `✅ — apps/mobile/__tests__/signing.test.ts` §"a contraindication is a review step, not a failure"
- E2E: `❌`
- Manual: **⬜ Not Tested**

---

#### DOC-RX-003 — A signed prescription is a signature, and cannot be edited

**Criticality:** C0 · **Priority:** P0

**Steps** — sign, then attempt `PATCH /prescriptions/:id`. Then attempt to sign it again.

**Expected Result** — the edit is refused. The second signature is refused `HMS-STATE-001`, and the
client reads **`signedAt`, not `status`**, as the oracle.

**Negative / Boundary** — a **draft authorises nothing**: dispensing against an unsigned prescription
must be refused.

**Automation Coverage**

- Integration: `✅ — apps/api/src/prescriptions.int.test.ts` §"a draft authorises nothing", §"a signed prescription cannot be edited", §"the quantity guard"
- Mobile: `✅ — apps/mobile/__tests__/signing.test.ts`; `writes.test.ts` §21
- Manual: **⬜ Not Tested**

---

#### DOC-RX-004 — A lost signature response reconciles; it never double-signs

**Criticality:** C0 · **Priority:** P0 · **Runbook:** M2-30

**Steps** — sign, and kill the network the instant you tap. Reopen the prescription.

**Expected Result** — it reads **signed if the server signed it** — reconciled from **`signedAt`**,
never from a retry that could double-sign. The attempt signs **at most once**, never in a loop.
Errors decided _before_ the write are not reconciled.

**Automation Coverage**

- Mobile: `✅ — apps/mobile/__tests__/signing.test.ts` §17–§20 and §"the attempt signs AT MOST ONCE"
- Integration: `✅ — apps/api/src/idempotency.int.test.ts` §"the guarantee holds on the critical clinical writes"
- Manual: **⬜ Not Tested** — _needs a real radio; a mocked failure is a decision, a lost packet is an accident._

---

### Module: Admission and bed

#### DOC-ADM-001 — Admission closes the OP visit and opens an IP stay in the same episode

**Criticality:** C1 · **Priority:** P0 · **Runbook:** JR-13

**Steps** — from `/my-patients`, admit the patient to a **free** bed in General Ward.

**Expected Result** — `201`. The OP visit becomes **`admitted`** (terminal) and an **IP** encounter
opens **in the same episode**. The patient appears on `/ward`.

**Negative / Boundary** — if the OP visit is still `open`, the two-encounter transaction did not hold
and the patient is in the building twice.

**Automation Coverage**

- Integration: `✅ — apps/api/src/admissions.int.test.ts` §"admission opens a second encounter in the same care story"
- Mobile: `✅ — apps/mobile/__tests__/ipd.test.ts`
- E2E: `⚠️ partial` — `e2e/emergencyWorkflow.spec.ts` admits from the ED and asserts the patient leaves the board.
- Manual: **⬜ Not Tested**

---

#### DOC-ADM-002 — 🔴 One bed cannot hold two patients, however the two requests interleave

**Criticality:** C0 · **Priority:** P0 · **Runbook:** JR-14, JR-16

**Steps** — admit a second patient to the bed just filled. Then, as a **nurse**, transfer a third
patient _onto_ an occupied bed.

**Expected Result** — **`409 HMS-STATE-001`** both times, _"that bed is already occupied"_, naming
ward and bed. **A `201` here is a P1** — two patients in one bed is the classic HIS bug.

**Negative / Boundary** — the guard is the partial-unique index
`one_open_stay_per_bed_per_branch`, arbitrated in the database, **not** a read-then-write. Two
concurrent admissions to the same bed must produce exactly one stay. **Admitting and moving a bed are
two different permissions held by two different roles** (`admission:create` → DOCTOR,
`bed:allocate` → NURSE); one login cannot do both halves.

**Automation Coverage**

- Integration: `✅ — apps/api/src/admissions.int.test.ts` §"one bed cannot hold two patients, however
  the two requests interleave" and §"bed assignment refuses when the database cannot enforce one stay
  per bed"; `apps/api/src/branchIsolation.int.test.ts` §"bed occupancy is isolated per branch"
- Mobile: `✅ — apps/mobile/__tests__/routes.test.ts` ("bed occupancy is never worked out on the phone")
- E2E: `❌`
- Manual: **⬜ Not Tested**

---

#### DOC-ADM-003 — Admission and transfer refuse safely when the occupancy rule is unenforceable

**Criticality:** C0 · **Priority:** P1 · **Runbook:** DRIFT-05

**Steps** — drop `one_open_stay_per_bed_per_branch`. Doctor admits; nurse transfers a bed.

**Expected Result** — both **`503 HMS-ADM-003`**. **Discharge still works and the bed board still
loads** — deliberately, because a ward that can neither admit nor discharge simply fills up.

**Downstream Verification** — `encounters.countDocuments({ class: "IP", open: true })` unchanged; the
OP encounter still `open: true` and **not** `admitted`.

**Automation Coverage**

- Integration: `✅ — apps/api/src/schemaGuard.int.test.ts`; `apps/api/src/admissions.int.test.ts`
- Manual: **⬜ Not Tested**

---

#### DOC-ADM-004 — Bed-days bill per calendar day started, in the branch's timezone

**Criticality:** C0 (financial integrity) · **Priority:** P1 · **Runbook:** JR-20, TZ-09 ·
**Regression check for D3 (fixed `1719360`)**

**Steps** — admit at 22:00 and discharge at 09:00 the next morning. Read the stay's charges.

**Expected Result** — **two** bed-day charges, **minimum one**, counted in the **branch's** zone. Each
day is its own charge.

**Automation Coverage**

- Integration: `✅ — apps/api/src/admissions.int.test.ts` §"the bed is billed by the day, and every day is its own charge"
- Unit: `✅ — apps/api/src/core/time/day.test.ts`
- Manual: **⬜ Not Tested** — _"This is money, and it was a real defect."_

---

### Module: Discharge

#### DOC-DIS-001 — Nobody goes home without a summary, and never with two

**Criticality:** C1 · **Priority:** P0 · **Runbook:** JR-18, JR-19

**Steps** — discharge with a summary. Then attempt a **second** summary on the same stay.

**Expected Result** — the first `201`; the stay closes and the bed is free on `/ward`. The second is
**refused** — exactly one summary per admission. _"A stay ends with two summaries and nothing says
which one was sent to the patient."_

**Negative / Boundary** — `admission:discharge` is **DOCTOR-only** and deliberately not the nurse's; a
`403` for the nurse is correct.

**Automation Coverage**

- Integration: `✅ — apps/api/src/admissions.int.test.ts` §"nobody goes home without a summary" and §"a stay cannot end with two discharge summaries"
- Mobile: `✅ — apps/mobile/__tests__/ipd.test.ts`
- Manual: **⬜ Not Tested**

---

#### DOC-DIS-002 — A stay can end in a way that is not a discharge

**Criticality:** C1 · **Priority:** P2

**Steps** — end a stay with each `DISCHARGE_DISPOSITIONS` outcome the product offers (LAMA,
absconded, deceased) via `POST /encounters/:id/outcome`.

**Expected Result** — each records distinctly, with an `outcome_note`, and is distinguishable from an
ordinary discharge in `/reports/discharge-outcomes`.

**Automation Coverage**

- Integration: `⚠️ partial` — the terminal-states gap is recorded as **closed** on the tracker
  (`endStayWithOutcome`), and `rbac.int.test.ts` probes the route; no suite walks each disposition.
- Manual: **⬜ Not Tested**

---

#### DOC-HND-001 — Handing the patient to another doctor

**Criticality:** C2 · **Priority:** P2 · **Runbook:** JR-06 (the two-doctor row)

**Steps** — as `drrao@`, transfer the case to `drkhan@`. Sign in as `drkhan@` and open `/my-patients`.

**Expected Result** — the patient is on the second doctor's list and off the first's; the record shows
both.

**Automation Coverage**

- Integration: `✅ — apps/api/src/admissions.int.test.ts` §"handing the patient to another doctor"
- Manual: **⬜ Not Tested**

---

### Module: Doctor authorization boundaries

#### DOC-SEC-001 — A doctor may READ the round and may not chart on it

**Criticality:** C0 · **Priority:** P0 · **Runbook:** PERM-01, PERM-09, WEB-19, NEG-01

**Steps** — as the doctor, open `/medication-round`. Then call
`POST /encounters/:id/medication-administrations` directly.

**Expected Result** — the round **renders** (it is gated on `emr:read`, and a doctor reconciling what
their patient actually received is a legitimate reader) with **every dose action inert**. The API call
is refused **`403 HMS-AUTH-005`**.

> **This is correct behaviour, not a permission leak.** The boundary that matters is on the WRITE. A
> doctor who can actually chart a dose from the UI is a P1.

**Automation Coverage**

- Integration: `✅ — apps/api/src/rbac.int.test.ts` §"the matrix: role × route"; `apps/api/src/mar.int.test.ts` §"authorization"
- Web: `✅ — apps/web/__tests__/medicationRound.test.tsx` §8 ("viewing and administering are different rights")
- E2E: `✅ — e2e/clinicalSafety.spec.ts` (a doctor's round renders with every dose row inert; a nurse's does not)
- Manual: **⬜ Not Tested**

---

#### DOC-SEC-002 — A cross-branch chart is refused and must never render

**Criticality:** C0 · **Priority:** P0 · **Runbook:** BR-03, BR-04, M2-15

**Steps** — while at branch B, navigate directly to a branch-A patient / encounter (URL on web, deep
link on mobile). Then attempt a nursing note and a dose against a branch-A encounter with `curl`.

**Expected Result** — _"Not available here"_ / not found; the server returns **`404 HMS-GEN-404`**.
**It must not render even for a frame.** Both writes refused.

**Automation Coverage**

- Integration: `✅ — apps/api/src/branchIsolation.int.test.ts` §2, §19; `apps/api/src/mar.int.test.ts` §"branch isolation"
- Mobile: `✅ — apps/mobile/__tests__/branch.test.ts` §8; `mobileContract.int.test.ts` §"a phone cannot reach across a branch, whatever it sends"
- E2E: `✅ — e2e/branchSwitch.spec.ts` (no bed from the previous site survives a switch)
- Manual: **⬜ Not Tested** — _the API is proven; whether a client can be talked into rendering it is not._

---

### 4.9 Doctor — the mobile surface (M2)

**Preserved verbatim from `MANUAL_VALIDATION_RUNBOOK.md` §6 and
[`MOBILE_M2_DEVICE_CHECKLIST.md`](../../AI_Workflow/docs/MOBILE_M2_DEVICE_CHECKLIST.md) (61 rows).
Status: 0 of 61 performed.** These are re-homed here rather than rewritten, because the runbook is
still the authority for what each row means. Every ID below appears in the §9 mapping table.

| Group                   | IDs           | Criticality | Priority | Automated coverage of the _logic_ beneath                                                                                    | Manual        |
| ----------------------- | ------------- | ----------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------- |
| **A. Auth and session** | M2-01 … M2-09 | C1          | P0       | `apps/mobile/__tests__/session.test.ts`, `foundation.test.ts`; `apps/api/src/auth.int.test.ts`, `mobileContract.int.test.ts` | ⬜ Not Tested |
| **B. Branch**           | M2-10 … M2-15 | C0          | P0       | `apps/mobile/__tests__/branch.test.ts`, `hardening.test.ts` §1; `branchIsolation.int.test.ts`                                | ⬜ Not Tested |
| **C. Clinical reads**   | M2-16 … M2-24 | C0          | P0       | `apps/mobile/__tests__/clinical.test.ts`, `doctor.test.ts`                                                                   | ⬜ Not Tested |
| **D. Clinical writes**  | M2-25 … M2-34 | C0          | P0       | `apps/mobile/__tests__/writes.test.ts`, `signing.test.ts`, `vitals-capture.test.ts`                                          | ⬜ Not Tested |
| **E. Screen lock**      | M2-35 … M2-47 | C1          | P1       | `apps/mobile/__tests__/lock.test.ts` — **the LOGIC only. The OS prompt is not automatable.**                                 | ⬜ Not Tested |
| **F. Accessibility**    | M2-48 … M2-51 | C1          | P2       | **None. Needs eyes and a device.**                                                                                           | ⬜ Not Tested |
| **G. Unbuilt areas**    | M2-52         | C3          | P3       | `apps/mobile/__tests__/routes.test.ts` ("every route a screen navigates to is a route that exists")                          | ⬜ Not Tested |

**Three things in this block that no test layer can reach, stated so a green suite is not mistaken
for coverage:** biometrics (M2-35…M2-47 — no enrolled fingerprint or Face ID exists in CI or a
simulator), app-switcher snapshots and sunlight legibility (M2-46, M2-51), and layout at the largest
OS text size (M2-48).

> **🟡 K4-02 — an open, known item that lands squarely in this block.** `RuntimeProvider` passes
> `secureStore`, `preferences`, `push` and `logger` to `createRuntime` — **and not `biometrics`**. So
> `platform/biometrics.ts` is imported by no shipping code, `runtime.biometrics` is always
> `undefined`, and **the M2 screen lock can only ever ask for a passcode**. It is one line. It is
> deliberately not fixed, and it means **M2-38 through M2-45 will fail on hardware as written** until
> it is. Book it into the same hardware session.

---

## 5. NURSE

**Role:** `NURSE`.
**Screens (web):** `/ward`, `/medication-round`, `/beds`, `/patients/[id]`, `/emergency`,
`/theatres` (runs the list), `/mortuary`, `/ip-sheet/[id]`.
**Screens (mobile):** the whole M3 surface — see §5.8.
**Modules:** Ward worklist · Vitals · Nursing notes · **Medication Administration Record** ·
Bed movement · Triage · OT list.

**Nurse permissions**, from the catalogue: `patient:read`, `encounter:read`, `encounter:update`,
`record:read`, `consent:manage`, `emr:read`, `vitals:record`, `allergy:read`, `allergy:manage`,
`nursing:manage`, `mar:administer`, `lab:collect`, `order:read`, `order:perform`, `bed:allocate`,
`triage:perform`, `ot:schedule`, `mortuary:manage`, `mortuary:release`, `appointment:read`,
`file:read`. **Deliberately NOT `emr:write` and NOT `encounter:close`.**

> **§5 is where the product's safety argument lives.** Every C0 in this section is a control that
> exists because of a specific way people get hurt. Read `MANUAL_VALIDATION_RUNBOOK.md` §8.1 before
> running any MAR row: **database uniqueness and `Idempotency-Key` are different mechanisms**, and
> classifying a failure against the wrong one sends someone to the wrong file.

### Module: Ward worklist

#### NUR-WRK-001 — The ward is walked in the order a ward is walked

**Criticality:** C1 · **Priority:** P1 · **Runbook:** M3-04, M3-05, M3-06, M3-07

**Steps** — open the ward list. Pick a ward chip, then pick **All wards** again. Scroll the 45-bed
ward to the bottom. Pull to refresh.

**Expected Result** — **overdue first, then due, then bed order NUMERICALLY** (`GW-2` before `GW-10`
— string ordering hides a bed). The ward filter round-trips in **both** directions. The next page
loads without a stall. **On refresh the rows stay on screen while it spins — the list must never
blank.**

**Automation Coverage**

- Integration: `✅ — apps/api/src/mar.int.test.ts` §"the ward worklist"; `apps/api/src/nursing.int.test.ts` §"the inpatient list can be narrowed to one ward"
- Web: `✅ — apps/web/__tests__/round.test.ts` §1, §4
- Mobile: `✅ — apps/mobile/__tests__/nurse.test.ts` ("triage order"), `ipd.test.ts`
- E2E: `✅ — e2e/clinicalSafety.spec.ts` (every ward row is named)
- Manual: **⬜ Not Tested**

---

#### NUR-WRK-002 — Every ward row names its patient; every administering surface adds the UHID

**Criticality:** C0 · **Priority:** P0 · **Runbook:** WEB-04 (**amended 2026-08-18**), FR-01, FR-02

> **Read the amendment before testing this.** The original row demanded "Name + UHID on every row" of
> `/ward`. **The product was deliberately not changed**, and the row was corrected instead: §9 of the
> runbook says the five rights apply to _"every administering surface … the confirmation screen a
> nurse reads at the moment of giving"_, and **a ward list is not one** — no drug can be given from
> it. It is a navigation rail beside a patient panel, and the panel carries both identifiers.

**Steps** — read every row of `/ward`. Then open the chart a row leads to. Then read every row of
`/medication-round` and its confirmation.

**Expected Result** — **name on every ward row**; **name AND UHID together on the chart, on every
medication-round row, and on the confirmation.**

**Automation Coverage**

- E2E: `✅ — e2e/clinicalSafety.spec.ts` — asserts every dose row on the round carries a name **and**
  a UHID. Falsified: removing the UHID turns it red with _"a dose row carried no UHID beside the
  patient's name"_.
- Web: `✅ — apps/web/__tests__/wardIdentity.test.tsx`, `medicationRound.test.tsx` §7
- Manual: **⬜ Not Tested**

---

#### NUR-WRK-003 — The long-stay patient still has a name

**Criticality:** C0 · **Priority:** P0 · **Runbook:** FR-02, WEB-05 · **Regression check for web defect D-1 (fixed `375e4cf`)**

**Preconditions** — `--verify` confirms _"long-stay patient outside the recent-100 window"_ — bed
**GW-1**, registered first, with enough later registrations that the window genuinely excludes them.

**Steps** — find bed **GW-1** on `/ward` and `/medication-round`. Read the row. Select a dose and read
the confirmation.

**Expected Result** — name **and** UHID present on both, resolved **server-side**.

**Concern** — **`—`, `Patient: —`, a blank, or an id where a name belongs = FAIL, safety. Stop and
report.** The browser used to rebuild names client-side from `listPatients({ limit: 100 })`, so a
patient admitted before the 100 most recent registrations had no name to find.

**Automation Coverage**

- Web: `✅ — apps/web/__tests__/wardIdentity.test.tsx` §1 ("a patient beyond the recent-registration window")
- Integration: `✅ — apps/api/src/encounters.int.test.ts` §8
- E2E: `✅ — e2e/clinicalSafety.spec.ts`
- Manual: **⬜ Not Tested** — _"the fix has never been seen in a browser."_

---

### Module: Vitals

#### NUR-VIT-001 — A reading saves, an implausible one is refused, and nothing typed disappears

**Criticality:** C1 · **Priority:** P0 · **Runbook:** M3-12, M3-13, M3-15

**Steps** — enter a full set; save. Then enter pulse `900`; save. Then airplane mode; save.

**Expected Result** — the reading appears on the chart **with the ward's time**. Pulse `900` is
refused **and your typed value is still on screen**. Offline, the button is disabled **with a
reason**, and nothing claims success.

**Negative / Boundary** — the phone and the browser check **plausibility, not clinical judgement**;
blood pressure the right way round is a plausibility check, not a diagnosis. **The server's flags are
the only assessment** — nothing on a client re-assesses a number.

**Automation Coverage**

- Integration: `✅ — apps/api/src/vitals.int.test.ts` §"validation", §"server-side assessment", §"timestamps"
- Web: `✅ — apps/web/__tests__/vitalsWrite.test.tsx`
- Mobile: `✅ — apps/mobile/__tests__/vitals-capture.test.ts`
- Manual: **⬜ Not Tested**

---

#### NUR-VIT-002 — A lost vitals response reconciles to one reading — and a real second reading still works

**Criticality:** C0 · **Priority:** P0 · **Runbook:** LR-04, LR-05, WEB-18, M3-14 ·
**Regression check for web defect D-2 (fixed `375e4cf`)**

**Preconditions** — a patient with **no vitals yet** (the validation seed deliberately creates none).

**Steps**

1. Record a full set; save. Kill the network **during** the request.
2. Read the UI. Restore. Reconcile / retry. Check the chart.
3. Then record a **genuinely new** set minutes later.

**Expected Result** — step 2: the UI does **not** claim "Saved"; on reconnect it reconciles and
reports what it found; the chart holds **exactly one** observation for that moment. Step 3: **accepted,
and both readings are kept.**

**Concern — in both directions.** A duplicated observation is a corrupted clinical trend. A false
"Saved" is worse — the nurse stops. **And refusing a real second observation is a P1 the other way**:
a nurse who cannot record a deteriorating patient's second reading. **Vitals carry no uniqueness
constraint by design.**

**Automation Coverage**

- Integration: `✅ — apps/api/src/vitals.int.test.ts` §"idempotency" and §"clinical duplicates are not duplicates"
- Web: `✅ — apps/web/__tests__/vitalsWrite.test.tsx` §2, §3, §4
- Mobile: `✅ — apps/mobile/__tests__/vitals-capture.test.ts` §"saving when the network is not certain"
- E2E: `❌`
- Manual: **⬜ Not Tested** — _"Never confirmed in a browser."_

---

### Module: Nursing notes

#### NUR-NOT-001 — A note is attributed, appears once, and cannot be lost by a swipe

**Criticality:** C1 · **Priority:** P1 · **Runbook:** M3-17, M3-18, M3-19

**Steps** — write and save a note. Start typing another and swipe back. Save the same note twice
quickly.

**Expected Result** — it appears on the stay's timeline **attributed to you**, with the time. The
unsaved-changes prompt appears on the swipe. **Exactly one note** from the double-tap.

**Automation Coverage**

- Integration: `✅ — apps/api/src/nursing.int.test.ts` §"nursing notes", §"nursing note retry safety"; `apps/api/src/admissions.int.test.ts` §"a ward note honours Idempotency-Key"
- Mobile: `✅ — apps/mobile/__tests__/writes.test.ts`
- Manual: **⬜ Not Tested**

---

### Module: Medication Administration Record — the safety core

#### NUR-MAR-001 — The round is one request, in the branch's day, ordered by what is late

**Criticality:** C1 · **Priority:** P0 · **Runbook:** M3-21, M3-23, M3-34, TZ-01 … TZ-06

**Steps** — open `/medication-round`. Compare the most-overdue patient against `--verify`'s overdue
count. Switch to branch B.

**Expected Result** — **one request per page — no per-patient fan-out.** The most overdue is first.
The day is the **branch's** (`Asia/Kolkata` at A, `America/New_York` at B), and switching repaints to
Annexe Ward with B's wards in the picker. **Due / overdue derives from the branch zone and
`OVERDUE_AFTER_MS` (1 h)** — never from client arithmetic.

**Negative / Boundary** — near the **phone's** midnight but not the ward's, the round must **not** roll
over or empty. Near the **ward's** midnight it must.

**Automation Coverage**

- Integration: `✅ — apps/api/src/mar.int.test.ts` §"the dose schedule resolves in the ward's timezone", §"the medication round"
- Web: `✅ — apps/web/__tests__/medicationRound.test.tsx` §1–§4, §13
- Mobile: `✅ — apps/mobile/__tests__/medication-round.test.ts`, `nurse.test.ts` ("the worklist does not fan out per patient")
- Manual: **⬜ Not Tested** — _TZ-02 and TZ-03 need a real clock at a real boundary; plan around it._

---

#### NUR-MAR-002 — 🔴 The five rights, on the screen a drug is given from

**Criticality:** C0 · **Priority:** P0 · **Runbook:** FR-01, WEB-07, M3-22, M3-28

> **This is not a UI review.** Each of the five is a field a nurse legally relies on before putting a
> drug into a person. **A blank patient name, a missing UHID or an ambiguous dose is a SAFETY
> CONCERN. If any is missing on a real screen, stop that scenario and report it** — do not finish the
> round and mention it later.

**Steps** — run once on **mobile** and once on **web**, on the dose confirmation screen.

| #   | Right                | Expected                                                                           |
| --- | -------------------- | ---------------------------------------------------------------------------------- |
| 1   | **Right patient**    | Named **FIRST**, full name **and** UHID, not truncated to uselessness              |
| 2   | **Right medication** | The name from the **signed line** — `Paracetamol 500mg Tablet`, never a code       |
| 3   | **Right dose**       | `500 mg`                                                                           |
| 4   | **Right route**      | `oral` for every seeded line                                                       |
| 5   | **Right time**       | The scheduled time **in the branch's zone** — e.g. `14:00` for the TDS middle dose |

Plus **bed**, which the round row carries alongside the five.

**Negative / Boundary** — **drug-first ordering invites the wrong-patient error.** The confirmation
must name the patient before the drug.

**Evidence** — a photograph of the confirmation screen, **plus the same five read back from
`GET /encounters/:id/medication-schedule`**, so screen and server can be compared field for field.

**Automation Coverage**

- E2E: `✅ — e2e/clinicalSafety.spec.ts` (name AND UHID on every dose row — falsified)
- Web: `✅ — apps/web/__tests__/medicationRecord.test.tsx` §2, `medicationRound.test.tsx` §7; `apps/web/__tests__/marAdminister.test.ts` §2, §5
- Mobile: `✅ — apps/mobile/__tests__/mar-administer.test.ts` ("what the nurse confirms"), `medication-round.test.ts` ("a medication row can never be ambiguous between two patients")
- Manual: **⬜ Not Tested** — _the seven fields on a real screen at arm's length is exactly what no test layer can judge._

---

#### NUR-MAR-003 — Give is the server's word, not the screen's

**Criticality:** C0 · **Priority:** P0 · **Runbook:** M3-29, WEB-12

**Steps** — confirm a due scheduled dose.

**Expected Result** — returns to the round; the dose reads **Given, from the server** — not
optimistically. **The screen never claims a dose before the server does.**

**Automation Coverage**

- Integration: `✅ — apps/api/src/mar.int.test.ts`
- Web: `✅ — apps/web/__tests__/medicationRecord.test.tsx` §5, `medicationRound.test.tsx` §9
- Mobile: `✅ — apps/mobile/__tests__/mar-administer.test.ts`
- E2E: `❌`
- Manual: **⬜ Not Tested**

---

#### NUR-MAR-004 — Hold demands a reason; Refused does not

**Criticality:** C1 · **Priority:** P1 · **Runbook:** M3-30, M3-31, WEB-13, WEB-14

**Expected Result** — **Hold** stays disabled until a reason is typed (_a blank in the MAR is a
question nobody can answer later_). **Refused** records **without** a reason, but the reason field is
offered anyway (_forcing a reason on a refusal invents data_).

**Negative / Boundary** — **`not_available`** is a real `MAR_STATUS` the backend accepts and both
clients **display** but neither **offers**. **PRODUCT DECISION REQUIRED** — should a nurse be able to
select it? Record; do not file as a defect.

**Automation Coverage**

- Web: `✅ — apps/web/__tests__/marAdminister.test.ts` §1, `medicationRecord.test.tsx` §3, §3b
- Mobile: `✅ — apps/mobile/__tests__/mar-administer.test.ts` ("outcomes", "a held or refused slot is answered")
- Integration: `✅ — apps/api/src/mar.int.test.ts` §"held and refused are answers, not gaps"
- Manual: **⬜ Not Tested**

---

#### NUR-MAR-005 — 🔴 A dose already charted is answered, never re-offered

**Criticality:** C0 · **Priority:** P0 · **Runbook:** MAR-01, M3-32, WEB-15, NEG-03

**Steps** — reopen a dose you already gave. Then attempt to give it again by any route the UI still
offers. If none is offered, that is M3-32 passing — record it, then confirm the server's answer with
`curl`.

**Expected Result** — **no Give button at all — facts only.** At the API, **`409 HMS-MAR-001`**
carrying `details.existing`. The UI says _"already given"_, names **who** and **when**, and **offers
no retry.** A generic error is a FAIL.

**Concern** — **a retry button here is a P1**: it invites the exact action the constraint exists to
prevent. _"Not saved — try again"_ would be the pre-W3 behaviour returning.

**Downstream Verification** — the MAR-03 query: exactly **one** document for
`{ prescriptionId, lineIndex, scheduledFor }`.

**Automation Coverage**

- Integration: `✅ — apps/api/src/mar.int.test.ts` §"a scheduled dose slot holds at most one administration", §"the 409 carries what a client needs to reconcile"
- Web: `✅ — apps/web/__tests__/marAdminister.test.ts` §"HMS-MAR-001 never invites a retry", `medicationRecord.test.tsx` §4
- Mobile: `✅ — apps/mobile/__tests__/mar-administer.test.ts` ("reading HMS-MAR-001 off the wire", "HMS-MAR-001 never invites a retry"); `errors.test.ts` §13
- Manual: **⬜ Not Tested**

---

#### NUR-MAR-006 — 🔴 Two nurses, two devices, one dose

**Criticality:** C0 · **Priority:** P0 · **Runbook:** MAR-02, WEB-16 — _the most important scenario in the plan_

**Preconditions** — ENV-04 READY. **Two devices.** Nurse A on one, **Nurse B on the other** — two
identities, not one account signed in twice. A **scheduled** dose that is due and unanswered. Note
patient, bed, drug and scheduled time before starting.

**Steps** — both open the **same** dose confirmation. Confirm both screens show the same patient,
drug, dose and scheduled time. **On a count of three, both press Give.**

**Expected Result** — **exactly one succeeds.** The other receives `409 HMS-MAR-001`, is told the dose
is already given, by whom and when, **with no retry offered**. Neither nurse sees a generic error.

**Concern** — **two successes is a P0. Stop immediately, capture everything, and check ENV-04 before
concluding** — this exact symptom was produced on 2026-08-14 by a _missing index_, not a code defect.

**Downstream Verification** — MAR-03: exactly one document, **and** the unique index is present and
armed:

```
{ tenantId, prescriptionId, lineIndex, scheduledFor }
  unique, partialFilterExpression: { scheduledFor: { $exists: true } }
```

**If that index is absent, every result in this module is void.**

**Automation Coverage**

- Integration: `✅ — apps/api/src/mar.int.test.ts` — **two real HTTP clients race the same dose.** The
  concurrency invariant _is_ proven at the server.
- Manual: **🟡 The human half is genuinely not automatable and is not covered.** _"Two nurses reaching
  for the same drug is a human scenario, not a client one."_ Status: **⬜ Not Tested**, and it needs
  two people and two handsets.

---

#### NUR-MAR-007 — PRN is deliberately different, and line identity is a position

**Criticality:** C0 · **Priority:** P1 · **Runbook:** MAR-04, MAR-05, NEG-06

**Steps**

1. On the seeded "same drug scheduled **and** as-required" patient, give the **SOS** line. Then give
   it again.
2. On the 3-line prescription (Metformin / Amlodipine / Cetirizine), give **line 1** at its time, then
   open **line 0** at its own time.

**Expected Result** — (1) **both succeed.** An as-required drug may be given more than once; the
partial filter is what makes that legal. (2) Line 0 is **still givable** — charting one line does not
answer another.

**Concern** — if the second PRN dose is refused, the partial filter is wrong and the constraint is now
_causing_ harm by blocking real care. **Report as P1 — worse than the defect 0049 fixes.** If giving
one line marks another answered, dose identity is keyed on the drug rather than the position — **a
P0-class defect.**

**Automation Coverage**

- Integration: `✅ — apps/api/src/mar.int.test.ts` §"PRN is not caught by the slot rule", §"prescription line identity"
- Unit: `✅ — apps/api/src/modules/mar/schedule.test.ts`
- Mobile: `✅ — apps/mobile/__tests__/mar-administer.test.ts` ("a dose is identified by its slot, not by its drug"); `medication-round.test.ts` ("a dose on the round is the S1 slot, not a drug")
- Manual: **⬜ Not Tested**

---

#### NUR-MAR-008 — A client may not declare its own slot, and a dead prescription authorises nothing

**Criticality:** C0 · **Priority:** P1 · **Runbook:** NEG-07, NEG-08

**Steps** — at the API, chart a **fabricated `scheduledFor`** not on the schedule. Then chart against
a **draft** prescription, and against a **cancelled** one.

**Expected Result** — all refused. The slot is the server's; the prescription must be **in force**.

**Automation Coverage**

- Integration: `✅ — apps/api/src/mar.int.test.ts` §"a client may not declare its own slot"; `apps/api/src/prescriptions.int.test.ts` §"a draft authorises nothing"
- Manual: **⬜ Not Tested**

---

#### NUR-MAR-009 — 🔴 A lost MAR response reconciles; it never charts twice

**Criticality:** C0 · **Priority:** P0 · **Runbook:** LR-01, LR-02, LR-03, WEB-17, NEG-05, NEG-12

> **The dangerous case is not "the request failed".** It is: **the server committed and the client
> never heard back.** The client then knows only that it does not know.

**Steps**

1. Open a due, unanswered **scheduled** dose. Note `prescriptionId`, `lineIndex`, `scheduledFor`.
2. Press **Give**. Kill the network **during** the request.
3. Read what the app says. Restore. Press Give again / let it reconcile. Query the database.
4. Then retry with the **same** `Idempotency-Key`. Then reuse that spent key with a **different**
   body.

**Expected Result**

- **Step 3:** the app says it **could not confirm** — never "not saved", never "saved".
- **Step 3 resolution:** _"already recorded, nothing was recorded twice"_ — not a second dose, not a
  blind retry. **Exactly one MAR row.**
- **Same key, same body:** the **same record id** is returned. No new row.
- **Same key, different body:** **`409 HMS-REQ-002`.**

**Concern** — "Not saved" after a successful commit is a **P1** — it invites the nurse to give the
drug again. **A second MAR row is a P0.** A new id on replay means the key is not being honoured —
reclassify as an **Idempotency-Key** failure, not a uniqueness failure.

**Also** — **back-grounding the app mid-save must let the mutation finish** (LR-06). Cancelling
in-flight _and_ discarding the key means the app created the ambiguity itself.

**Automation Coverage**

- Integration: `✅ — apps/api/src/idempotency.int.test.ts` (all seven blocks, including §"a key is a
  promise about success, not a lock on the endpoint" and §"the store holds the answer and not the
  question"); `apps/api/src/mar.int.test.ts` §"Idempotency-Key and slot uniqueness are different mechanisms"
- Unit: `✅ — apps/api/src/core/idempotency/fingerprint.test.ts`
- Mobile: `✅ — apps/mobile/__tests__/mar-administer.test.ts`, `errors.test.ts` §14, §15
- Manual: **⬜ Not Tested** — _walk out of wifi range for at least one run. A mocked failure is a decision; a lost packet is an accident._

---

#### NUR-MAR-010 — A stale row is safe to tap

**Criticality:** C0 · **Priority:** P0 · **Runbook:** M3-35, M3-36, M3-37, NEG-04

**Steps** — Nurse A opens the round. **Nurse B gives a dose.** Nurse A taps it. Then background A's
app for a minute while B gives another, and resume. Then leave the round untouched in the foreground
for five minutes.

**Expected Result** — the tap **re-reads and shows "already answered"**. Nurse A must **never** see an
active Give. On resume the round refetches. **After five minutes idle the round may legitimately show
the older state** — the round is _advisory_, the confirmation screen is _authoritative_. **Do not
report the stale list itself as a defect; confirm a stale tap still lands on "already answered".**

**Automation Coverage**

- Web: `✅ — apps/web/__tests__/medicationRound.test.tsx` §9 ("the round re-reads itself rather than painting a row")
- Mobile: `✅ — apps/mobile/__tests__/medication-round.test.ts` ("dose state is read, never derived")
- Integration: `✅ — apps/api/src/mar.int.test.ts`
- Manual: **⬜ Not Tested** — _needs two identities; this is the near-miss duplicate protection exists to catch before the database has to._

---

#### NUR-MAR-011 — The round is honest about how much of the ward it can see

**Criticality:** C0 · **Priority:** P0 · **Runbook:** M3-25, WEB-08, M3-24, WEB-09, WEB-10, M3-26, WEB-11

| Sub-check      | Expected                                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Pagination** | 42 patients at page size 20 — **the footer says there are more pages** rather than ending silently                |
| **Quiet**      | A patient with nothing due says _"No scheduled doses today"_ or _"All doses answered"_ — **never a blank row**    |
| **Answered**   | A patient whose doses are all answered **shows the given/held/refused doses** — not the summary _instead_ of them |
| **Later dose** | On a TDS patient, selecting **14:00** gives a confirmation naming **14:00**, not 08:00                            |

**Concern** — _"a nurse reading '2 doses due' off page one of three and stopping"_ is the failure the
pagination row exists for. A blank row reads as "nothing to give". Hiding answered doses hides the
record — that was a real defect.

**Automation Coverage**

- Web: `✅ — apps/web/__tests__/round.test.ts` §3 ("the summary is honest about how much it can see"), `medicationRound.test.tsx` §5, §11
- Mobile: `✅ — apps/mobile/__tests__/medication-round.test.ts` ("a paged round says so rather than summarising a page as a ward"; "the four ways a row can be quiet are four different sentences")
- Manual: **⬜ Not Tested**

---

#### NUR-MAR-012 — 🔴 Charting refuses when the database cannot enforce the dose-duplication rule

**Criticality:** C0 · **Priority:** P0 · **Runbook:** DRIFT-01, DRIFT-02, DRIFT-09, DRIFT-10, DRIFT-11, DRIFT-12

**Preconditions** — read §16A of the runbook **including the restore block**. You are dropping a real
index on a real tenant; put it back in the same session.

**Steps**

1. Drop `one_administration_per_dose_slot`. As **Nurse A**, chart a due dose.
2. On the same drop, **record observations** and **write a nursing note**.
3. Re-read the chart and the worklist.
4. Repeat step 1 **on the handset**.
5. Watch the API log throughout.

**Expected Result**

| #   | Expected                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **`503 HMS-MAR-002`**, header **`Retry-After: 60`**, and the message names **paper**. The nurse must be able to tell this from "no signal".                                              |
| 2   | **Both still succeed.** Proportionality — if either is blocked it is a **P0 over-block**, not a nice-to-have.                                                                            |
| 3   | **No dose recorded.** `medicationAdministrations.countDocuments({prescriptionId, lineIndex, scheduledFor})` → **0**.                                                                     |
| 4   | The phone classifies the 503 as **`unknown`**, re-reads the slot, sees it still due, and reports it **could not confirm**. It never shows the dose as given.                             |
| 5   | **One `error` line per refusal** carrying `code`, `status`, `tenant`, `traceId` and the missing rule + migration — **and no patient name, UHID, encounter id, prescription id or drug.** |

**Judging DRIFT-10** — ask one question: _would a nurse holding this phone know the dose was NOT
recorded, and know to chart on paper?_ If she would know it failed but not what to do, record a
**P2 UX finding against the classifier**, not a safety failure — the write provably did not happen.

**Recovery** — recreate the index, wait up to 60 s for the readiness TTL, retry the same act, then
`pnpm --silent seed:migrate --check --json | jq '.verdict'` must print `READY`. **If the retry needs
an API restart, that is DRIFT-07 failing, and it is a P1.**

**Automation Coverage**

- Unit: `✅ — apps/api/src/schemaReadiness.test.ts`, `apps/api/src/errorContract.test.ts` (the PHI assertion in DRIFT-12)
- Integration: `✅ — apps/api/src/schemaGuard.int.test.ts` (all seven blocks, including falsification
  and the "every unique index is a declared invariant or explicitly exempt" guard);
  `apps/api/src/mar.int.test.ts` §"charting refuses when the database cannot enforce the dose-duplication rule"
- Mobile: `✅ — apps/mobile/__tests__/errors.test.ts` ("a clinical schema refusal tells the clinician what to do instead") — **regression check for D13 (fixed `bd09795`)**
- Manual: **⬜ Not Tested** — _"the 503 nobody has ever seen in the field"; five clinical refusals, none ever seen by a person on a screen._

---

#### NUR-BED-001 — Moving a bed is the nurse's, and the tariff does not follow

**Criticality:** C1 · **Priority:** P1 · **Runbook:** JR-15

**Steps** — `/ward` → Move bed → a free bed.

**Expected Result** — `200`; the board shows the new bed and frees the old one. **The stay tariff does
not change.** Different permission from admission (`bed:allocate`, not `admission:create`) — a `403`
means the wrong login, not a defect.

**Automation Coverage**

- Integration: `✅ — apps/api/src/admissions.int.test.ts`; `rbac.int.test.ts` matrix
- Manual: **⬜ Not Tested**

---

#### NUR-SEC-001 — A nurse is refused the doctor's authority, at the API

**Criticality:** C0 · **Priority:** P0 · **Runbook:** PERM-05, PERM-06, PERM-07

| Attempt                                           | Expected                                                                         |
| ------------------------------------------------- | -------------------------------------------------------------------------------- |
| `POST /encounters/:id/nursing-notes`              | `201`                                                                            |
| `POST /encounters/:id/vitals`                     | `201`                                                                            |
| `POST /encounters/:id/medication-administrations` | `201`                                                                            |
| `POST /encounters/:id/notes` (`emr:write`)        | `403 HMS-AUTH-005`                                                               |
| `POST /encounters/:id/close`                      | `403` — closing freezes what can be billed and asserts the consultation happened |
| `POST /encounters/:id/discharge`                  | `403` — `admission:discharge` is the doctor's                                    |

**Automation Coverage**

- Integration: `✅ — apps/api/src/rbac.int.test.ts` §"the matrix: role × route" and §"privilege
  boundaries that must never move" (**NURSE is one of the five roles probed against every protected route**)
- Manual: **⬜ Not Tested**

---

### 5.8 Nurse — the mobile surface (M3)

**Preserved from `MANUAL_VALIDATION_RUNBOOK.md` §7 and
[`MOBILE_M3_DEVICE_CHECKLIST.md`](../../AI_Workflow/docs/MOBILE_M3_DEVICE_CHECKLIST.md) (45 rows).
Status: 0 of 45 performed.** M2-01…M2-12 are a prerequisite and are not repeated.

| Group                                 | IDs           | Criticality | Priority | Automated coverage of the logic beneath                              | Manual        |
| ------------------------------------- | ------------- | ----------- | -------- | -------------------------------------------------------------------- | ------------- |
| **A. Login and session**              | M3-01 … M3-03 | C1          | P0       | `apps/mobile/__tests__/session.test.ts`, `navigation.test.ts` §9     | ⬜ Not Tested |
| **B. Ward worklist**                  | M3-04 … M3-07 | C1          | P1       | `apps/mobile/__tests__/nurse.test.ts`, `ipd.test.ts`                 | ⬜ Not Tested |
| **C. Patient identity and chart**     | M3-08, M3-09  | C0          | P0       | `apps/mobile/__tests__/clinical.test.ts`, `ipd.test.ts` §4, §5       | ⬜ Not Tested |
| **D. Allergies**                      | M3-10, M3-11  | C0          | P0       | `apps/mobile/__tests__/medication-round.test.ts` ("allergy context") | ⬜ Not Tested |
| **E. Vitals**                         | M3-12 … M3-16 | C1          | P0       | `apps/mobile/__tests__/vitals-capture.test.ts`                       | ⬜ Not Tested |
| **F. Nursing notes**                  | M3-17 … M3-20 | C1          | P1       | `apps/mobile/__tests__/writes.test.ts`                               | ⬜ Not Tested |
| **G. Schedule and round**             | M3-21 … M3-27 | C0          | P0       | `apps/mobile/__tests__/medication-round.test.ts`, `nurse.test.ts`    | ⬜ Not Tested |
| **H–K. Give / Hold / Refused**        | M3-28 … M3-33 | C0          | P0       | `apps/mobile/__tests__/mar-administer.test.ts`                       | ⬜ Not Tested |
| **Q–T. Branch, TZ, perms, staleness** | M3-34 … M3-37 | C0          | P0       | `apps/mobile/__tests__/branch.test.ts`, `hardening.test.ts` §1       | ⬜ Not Tested |

**M3-27 (screen reader through a dose row) and M3-24's blank-row case are the two rows in this block
with no automated proxy at all.** Colour alone must never carry "overdue"; that is an accessibility
requirement **and** a safety requirement, and only a person with TalkBack or VoiceOver can judge it.

---

## 6. LABORATORY

**Roles:** `LAB_TECHNICIAN` (collects, runs, enters) · `PATHOLOGIST` (verifies, releases, owns the
catalogue). **These are deliberately two people.**
**Screens:** `/worklist`, `/lab-catalogue`.
**Module:** LIS v1 — order → charge → payment → bench → result → verify → release → doctor.

> **The two-person rule is a safety property, not bureaucracy.** `LAB_TECHNICIAN` holds
> `order:perform` and emphatically **not** `order:verify`: the person who ran the assay must not be
> the one who certifies the number, because the check is on the **measurement**. Radiology is
> deliberately different — see §7.

#### LAB-WRK-001 — The bench shows the work, who it is for, and what may be done to it

**Criticality:** C1 · **Priority:** P0 · **Runbook:** JR-09, DRIFT-04 (partial)

**Steps** — as `labtech@`, open `/worklist` after DOC-ORD-001.

**Expected Result** — the ordered test is on the queue, **named and UHID'd**, grouped by patient, with
how long they have been waiting. The **payment badge agrees with the server**. The matching control
(accept / start / complete) is offered — and **verify and release are not**.

**Negative / Boundary** — a worklist that loads **empty** because the page sends no branch is the
failure mode this is swept for. A row that cannot name its patient is the other.

**Automation Coverage**

- Integration: `✅ — apps/api/src/orders.int.test.ts` §"the department worklist", §"the order list can be read as a queue or as a history"
- Web: `✅ — apps/web/__tests__/labWorklist.test.ts`
- E2E: `✅ — e2e/labWorklist.spec.ts`
- Manual: **⬜ Not Tested**

---

#### LAB-STA-001 — The order state machine moves only along legal edges

**Criticality:** C1 · **Priority:** P0

**Steps** — walk `placed → accepted → in_progress → completed → verified → released`. Then attempt to
skip an edge, and to act on a `cancelled` order.

**Expected Result** — legal edges succeed; every skip and every act on a terminal state is refused
`422 HMS-STATE-001`.

**Automation Coverage**

- Integration: `✅ — apps/api/src/orders.int.test.ts` §"the order state machine"
- Manual: **⬜ Not Tested**

---

#### LAB-VER-001 — 🔴 The technician cannot certify their own number

**Criticality:** C0 · **Priority:** P0 · **Runbook:** JR-10, DRIFT-04

**Steps** — as `labtech@`, complete the test and then attempt `POST /orders/:id/verify`. Then sign in
as `pathologist@` and verify, then release.

**Expected Result** — the technician is refused `403 HMS-AUTH-005`. **Only after `released` does the
result reach the ordering doctor.** `lab:approve` is what gives PATHOLOGIST **authority over the LAB
category** — a radiologist holds `order:verify` too and still cannot sign off a blood test.

**Negative / Boundary** — **two logins are required.** A tester using one account will record BLOCKED
against a working feature. Same person doing both is a **patient-safety failure, not a shortcut**.

**Automation Coverage**

- Integration: `✅ — apps/api/src/orders.int.test.ts` §"a result is certified by someone qualified to
  read it" (and `order.authority.ts`, which holds the category rule)
- E2E: `⚠️ partial` — `e2e/radiologyWorkflow.spec.ts` proves the _radiology_ side of category
  authority; the lab's two-person split is not swept in a browser.
- Manual: **⬜ Not Tested**

---

#### LAB-RES-001 — A critical value is alerted immediately, not eventually

**Criticality:** C0 · **Priority:** P0

**Steps** — release a result outside the analyte's critical range.

**Expected Result** — the ordering doctor is alerted at once (see DOC-RES-002). **A panic value is not
buried under six routine results.**

**Automation Coverage**

- Integration: `✅ — apps/api/src/orders.int.test.ts` §"a critical result is alerted immediately, not eventually"
- Web: `✅ — apps/web/__tests__/alertInbox.test.ts`; Mobile: `✅ — apps/mobile/__tests__/clinical.test.ts`
- E2E: `✅ — e2e/alertInbox.spec.ts`
- Manual: **⬜ Not Tested**

---

#### LAB-CAT-001 — One catalogue for the hospital, not one per site

**Criticality:** C1 · **Priority:** P2

**Steps** — as `pathologist@`, open `/lab-catalogue` at branch A and again at branch B.

**Expected Result** — the same five seeded tests (CBC, LFT, RFT, Glucose, Lipid Profile) with their
analytes and reference ranges, on the **same codes the tariff prices**. **Read tenant-wide** — it was
branch-filtered against a per-tenant unique index, which made a seeded catalogue invisible the moment
a site was selected.

**Automation Coverage**

- Integration: `✅ — apps/api/src/branchIsolation.int.test.ts` §"the lab test catalogue is the
  hospital's, not a site's"; `apps/api/src/orders.int.test.ts` §"the laboratory catalogue a hospital starts with"
- E2E: `❌` — **`/lab-catalogue` is not in the page sweep.** The eleven pages `e2e/pageHealth.spec.ts`
  loads are `/mrd`, `/mortuary`, `/theatres`, `/ambulance`, `/assets`, `/packages`, `/tariff`,
  `/feedback`, `/audit`, `/subscription`, `/reports` — this one was never added.
- Manual: **⬜ Not Tested**

---

#### LAB-SEC-001 — The bench stops at the branch, and the technician never gets the chart

**Criticality:** C0 · **Priority:** P0

**Steps** — as a branch-A technician, switch to B and read the worklist. Then attempt to open a
patient chart.

**Expected Result** — the bench clears to B's work only. The chart is refused — `LAB_TECHNICIAN` holds
`order:read` and **not** `emr:read`. It can read the metadata of reports on the orders it is working
(`GET /reports?orderIds=`) and **never the report bytes or the patient's history**.

> **Granting the chart to make a worklist work is the mistake this product has made before.**

**Automation Coverage**

- Integration: `✅ — apps/api/src/branchIsolation.int.test.ts` §"the laboratory worklist shows only
  the site being worked in"; `apps/api/src/orders.int.test.ts` §"a lab technician can see the reports
  on the orders in front of them"
- E2E: `✅ — e2e/labWorklist.spec.ts` ("does not show one site's bench to the other")
- Manual: **⬜ Not Tested**

---

> **LIS depth that is NOT built, so no scenario claims it:** specimen tracking, accession numbers,
> barcodes, analyser interfacing, QC/EQAS, panels, delta checks. `lab:collect` and `lab:result` are
> correctly `future()` — **there is no specimen entity.** Do not write a UAT row against one.

---

## 7. RADIOLOGY

**Roles:** `RADIOLOGY_TECHNICIAN` (performs, reports **and releases** — no radiologist required) ·
`RADIOLOGIST` (optional consultant).
**Screens:** `/worklist` (the same worklist — that is the claim of ADR-0013 §3).
**Module:** RIS v1 — order → charge → bench → findings & impression → verify → release → chart.

> **The one deliberate difference from the lab, and why it is not a weakening.** `RADIOLOGY_TECHNICIAN`
> also holds `order:verify`, `order:release` and **`radiology:sign`**, so it can carry a study all the
> way to the doctor. In a hospital with no radiologist — which is most hospitals this product is sold
> to — the person who takes the film writes _"AP chest, no focal consolidation, film attached"_ and
> the treating doctor reads the image. **There is no second reader to be had, and inventing a
> requirement for one means the report never reaches anybody.** `radiology:sign` confines that
> authority to imaging: this role still cannot certify a blood result.

#### RAD-WRK-001 — A radiographer takes a study from the console to the chart, with no radiologist

**Criticality:** C1 · **Priority:** P0

**Steps** — as `radiographer@`: settle the charge from advance, accept, start, record **findings and
impression**, attach the film, verify, release. Then sign in as the ordering doctor and read it on
`/patients/[id]`.

**Expected Result** — every step succeeds with **no radiologist involved**, and the report is readable
on the chart.

**Negative / Boundary** — **the imaging console must show findings-and-impression, not the
laboratory's analyte grid.** Falsified: showing imaging the lab's result form turns the spec red.
Removing `radiology:sign` from the role turns it red with _"the study could be reported and never
released"_ — the exact failure the milestone exists to prevent: a hospital that can take the film,
type the report and deliver neither.

**Automation Coverage**

- Integration: `✅ — apps/api/src/orders.int.test.ts` §"radiology runs end to end without a radiologist"
- Web: `✅ — apps/web/__tests__/imagingReport.test.ts` ("the result form knows an X-ray from a blood count")
- E2E: `✅ — e2e/radiologyWorkflow.spec.ts` (all three tests)
- Manual: **⬜ Not Tested**

---

#### RAD-SEC-001 — The radiographer the hospital actually has cannot open a chart

**Criticality:** C0 · **Priority:** P0

**Steps** — as `radiographer@`, attempt `GET /patients/:id` clinical history and
`GET /reports/:id/file` for a report on an order they are **not** working.

**Expected Result** — refused. `RADIOLOGY_TECHNICIAN` deliberately does **not** hold `emr:read`.

**Automation Coverage**

- Integration: `✅ — apps/api/src/rbac.int.test.ts` §"the matrix: role × route" — **RADIOLOGY_TECHNICIAN
  is now swept against every protected route**, which is where "widen the role until the worklist
  works" would show up: granting it `emr:read` turns **21** rows red, including the patient chart,
  the ward worklist and the medication round. Plus `apps/api/src/orders.int.test.ts`
- E2E: `✅ — e2e/radiologyWorkflow.spec.ts` §"the radiographer the hospital actually has cannot open a chart"
- Manual: **⬜ Not Tested**

---

#### RAD-SEC-002 — The imaging bench stops at the branch; imaging is gated on the module

**Criticality:** C0 · **Priority:** P1

**Steps** — read the imaging worklist at A, then at B. Then, on a tenant whose edition lacks
`module.clinical.ris`, attempt to order a study.

**Expected Result** — the bench narrows to the site. The unentitled tenant is refused
**`403 HMS-PLAN-002` naming the flag** — not a permission error.

**Automation Coverage**

- Integration: `✅ — apps/api/src/branchIsolation.int.test.ts` §"the imaging worklist shows only the
  site being worked in"; `apps/api/src/orders.int.test.ts` §"radiology is gated on the module the hospital bought"
- Web: `✅ — apps/web/__tests__/imagingReport.test.ts` ("the imaging worklist is the same worklist")
- Manual: **⬜ Not Tested**

---

> **RIS depth NOT built:** PACS, DICOM, modality worklists, RIS scheduling, mandatory sign-off,
> second reader, structured imaging templates. `radiology:report` stays `future()`.

---

## 8. PHARMACY

**Role:** `PHARMACIST`.
**Screens:** `/pharmacy` (the counter), `/medicines` (the master and the shelf).
**Modules:** Dispensing (`module.pharmacy.dispensing`) · Medicine master, batches and stock
(`module.pharmacy.full`).

> **Three different questions, kept apart deliberately: prescription, dispensing, billing.**
> Prescribing is free; **dispensing is what costs money**; and what bills is what **crossed the
> counter**, not what was written.

#### PHR-DIS-001 — The counter's queue holds signed prescriptions and nothing else

**Criticality:** C0 · **Priority:** P0

**Steps** — as `pharmacy@`, open `/pharmacy`. Attempt to dispense against a **draft** prescription
via the API.

**Expected Result** — the queue lists **signed** prescriptions with quantity outstanding. The draft is
refused — **a draft authorises nothing.**

**Automation Coverage**

- Integration: `✅ — apps/api/src/prescriptions.int.test.ts` §"a draft authorises nothing", §"prescribing is free; dispensing is what costs money"
- E2E: `✅ — e2e/pharmacyDispensing.spec.ts`
- Manual: **⬜ Not Tested**

---

#### PHR-DIS-002 — 🔴 Partial handover: the patient is charged for what they were given

**Criticality:** C0 (financial + clinical) · **Priority:** P0 · **Runbook:** JR-12

**Steps** — on a line prescribed **20**, hand over **12**. Read the counter, the prescriber's view and
the bill.

**Expected Result** — `201`; `dispensedQty` rises **to 12**; the screen keeps **"12/20 given · 8 still
owed"**; the doctor sees `12/20 given`; and **the charge follows the 12**.

**Concern** — falsified: making the counter send the _prescribed_ quantity turns the spec red with
_"the patient was charged for 20 tablets they were given 12 of"_. A charge that never arrives at all
is money the hospital loses silently — billing listens for the event, so the charge appears **shortly
after**, not instantly.

**Negative / Boundary** — **over-dispensing is refused**; a lot cannot be over-drawn. A **shortfall is
recorded as `reconcile` rather than refused**, because a bookkeeping problem must not hold a patient's
medicine. **An uncollected prescription does not strand the patient.**

**Automation Coverage**

- Integration: `✅ — apps/api/src/prescriptions.int.test.ts` §"the quantity guard", §"prescribing is
  free; dispensing is what costs money", §"an uncollected prescription does not strand the patient",
  §"who gave what, when"; `apps/api/src/billing.int.test.ts`
- E2E: `✅ — e2e/pharmacyDispensing.spec.ts` (partial handover; "charges for what was handed over, not what was prescribed")
- Manual: **⬜ Not Tested**

---

#### PHR-DIS-003 — Dispensing the same thing twice hands it over once

**Criticality:** C0 · **Priority:** P0 · **Runbook:** DUP-01

**Steps** — **double-click** the dispense button. Then repeat with DevTools throttled to 3G.

**Expected Result** — **one** `dispenses` row. **`200` with `duplicate: true`, NOT a `409`** — the
second attempt answers with the FIRST handover. `dispensedQty` rises **once**; stock decrements
**once**. See DOC-ORD-002 for why `200` and not `409`, and verify by counting rows.

**Automation Coverage**

- Integration: `✅ — apps/api/src/idempotency.int.test.ts` §"the guarantee holds on each money-moving operation"; `apps/api/src/prescriptions.int.test.ts`
- Manual: **⬜ Not Tested**

---

#### PHR-STK-001 — 🔴 FEFO, and an expired box never leaves the shelf

**Criticality:** C0 · **Priority:** P0

**Steps** — with two lots of one drug on the shelf, dispense. Then put an **expired** lot in front and
dispense again. Then open `/medicines` → batches.

**Expected Result** — the **earliest-expiring** allocatable lot is opened first. **The expired lot is
never allocated** — it is excluded by the QUERY, not by an `if`. The pharmacist's shelf view **shows
expired lots, labelled**, because somebody has to pull them and write them off.

**Concern** — both falsified and both red: _"an expired box was handed to a patient"_ when expired
lots were made allocatable, and _"the newer lot was opened while an older one was still on the shelf"_
when FEFO was reversed.

**Negative / Boundary** — receiving stock demands **a batch number and an expiry together, or
neither**. Receiving already-expired stock is refused `422 HMS-STATE-001`.

**Automation Coverage**

- Integration: `✅ — apps/api/src/prescriptions.int.test.ts` §"stock is kept by batch, and expiry is what makes that worth doing"
- Web: `✅ — apps/web/__tests__/pharmacyStock.test.ts` ("the pharmacist's shelf shows what has to be pulled")
- E2E: `✅ — e2e/pharmacyDispensing.spec.ts` ("shows the pharmacist the batch behind the stock")
- Manual: **⬜ Not Tested**

---

#### PHR-DIS-004 — Dispensing refuses safely when the one-handover rule is unenforceable

**Criticality:** C0 · **Priority:** P1 · **Runbook:** DRIFT-03

**Steps** — drop `one_dispense_per_request_id`. As the **PHARMACIST** (the only role holding
`pharmacy:dispense` — a nurse or doctor gets a `403`, which is **not** the refusal being tested), hand
over drugs.

**Expected Result** — **`503 HMS-PHM-004`**. **MAR charting still works** — two capabilities, one
tenant, independent. `dispenses.countDocuments({prescriptionId})` unchanged; `lines[].dispensedQty`
unchanged.

**Automation Coverage**

- Integration: `✅ — apps/api/src/schemaGuard.int.test.ts`; `apps/api/src/prescriptions.int.test.ts` §"dispensing refuses when the database cannot enforce one-handover-per-request"
- Manual: **⬜ Not Tested**

---

#### PHR-SEC-001 — The shelf is not open to a prescriber, and the counter is branch-aware

**Criticality:** C1 · **Priority:** P1

**Steps** — as a **doctor**, call `GET /medicines` and `POST /medicines/:id/receive`. Then, as the
pharmacist, compare the counter at branch A and branch B.

**Expected Result** — the prescriber is refused the shelf (`pharmacy:stock` is the store's permission,
not the pad's — the pad reads `GET /medicines/availability` under `prescription:create`).

> **Open product decision, recorded not filed:** **pharmacy stock is hospital-wide, not per branch.**
> The general store's balance _is_ per branch (§9). The objection that stopped the pharmacy splitting
> — how do you divide an existing balance? — does not reach a new collection. This is a **PRODUCT
> DECISION**, not an oversight.

**Automation Coverage**

- Integration: `✅ — apps/api/src/rbac.int.test.ts` matrix (**PHARMACIST is one of the thirteen roles
  swept against every protected route**); `apps/api/src/branchIsolation.int.test.ts` §"stock movements record the site they happened at"
- E2E: `✅ — e2e/pharmacyDispensing.spec.ts` ("does not open the shelf to a prescriber")
- Manual: **⬜ Not Tested**

---

#### PHR-BIL-001 — A pharmacist can answer "what do I owe?"

**Criticality:** C2 · **Priority:** P2

**Expected Result** — the pharmacist holds `billing:read` and `payment:collect` on purpose: a counter
hands drugs over **and** takes the money for them. Without `billing:read` they could not answer the
question every single patient asks them.

**Automation Coverage** — Integration: `✅ — apps/api/src/rbac.int.test.ts` matrix. Manual: **⬜ Not Tested**

---

> **Pharmacy depth NOT built:** procurement, vendors for drugs, GRN, warehouses, OTC/walk-in sale
> (`pharmacy:sell`), substitution, barcode hardware, expiry and low-stock notifications (both
> evaluated and declined — see `AI_Workflow/docs/PHARMACY.md`).

---

## 9. GENERAL STORES

**Role:** `STORE_KEEPER` — **and it touches no patient.** No `patient:read`, no `emr:read`, nothing
clinical. Every other operational role carries `patient:read` because their work is _about a person_;
a store keeper's work is about a box of gloves. `GET /inventory-destinations` exists precisely so the
picker can be filled without handing them the patient list.
**Screen:** `/inventory`. **Module:** `module.support.inventory`. Three verbs, one shelf **per site**,
one append-only ledger.

#### STO-STK-001 — A delivery goes in, an issue goes out, and the ledger explains both

**Criticality:** C1 · **Priority:** P1

**Steps** — as `store@`: add a supplier, add an item, receive a delivery, issue to a ward, open the
item's movements.

**Expected Result** — the shelf rises on receipt and falls on issue; **the ledger reproduces the
number on the screen**, movement by movement; each movement can be traced to a party (which supplier,
which destination).

**Automation Coverage**

- Integration: `✅ — apps/api/src/inventory.int.test.ts` §2 ("the ledger reproduces the number on the screen"), §4 ("a movement can be traced to a party"), §6 ("the store list")
- Web: `✅ — apps/web/__tests__/generalStore.test.tsx`
- E2E: `✅ — e2e/inventoryStore.spec.ts` ("a delivery is booked in, issued to a ward, and the ledger explains both")
- Manual: **⬜ Not Tested**

---

#### STO-STK-002 — 🔴 The shelf cannot go below zero

**Criticality:** C1 · **Priority:** P0

**Steps** — issue more than the shelf holds. Then have two keepers issue the last boxes concurrently.

**Expected Result** — refused **in words**, and **nothing moves**. Under concurrency exactly one wins
— arbitrated by a **conditional update**, not a read-then-write.

> This is the one rule the pharmacy deliberately does **not** have. Do not report the difference as an
> inconsistency; report it against PHR-SEC-001's product decision if you want it revisited.

**Automation Coverage**

- Integration: `✅ — apps/api/src/inventory.int.test.ts` §1 ("the shelf cannot go below zero")
- E2E: `✅ — e2e/inventoryStore.spec.ts` ("issuing more than the shelf holds is refused, in words, and moves nothing")
- Manual: **⬜ Not Tested**

---

#### STO-SEC-001 — A store is a room, and the room is at a site

**Criticality:** C1 · **Priority:** P1

**Steps** — receive at branch A; read the shelf at branch B. Then attempt each of the four acts
holding only `inventory:manage`.

**Expected Result** — **the balance is per branch.** The four permissions gate the four controls
independently: `inventory:manage` (read + master), `inventory:purchase` (receive),
`inventory:issue` (issue), `inventory:audit` (correct the count).

**Negative / Boundary** — a write is **not offered** until a site is chosen (**regression check for
D19**), and the server still answers `HMS-BRANCH-001` if one is attempted anyway. A hospital that
never bought the store sees no menu entry (**regression check for D20**) and the API answers
`HMS-PLAN-002`.

**Automation Coverage**

- Integration: `✅ — apps/api/src/inventory.int.test.ts` §3 ("a store is a room, and the room is at a site"), §5 ("the boundaries hold"); and `apps/api/src/rbac.int.test.ts` now sweeps **STORE_KEEPER** against every protected route, which is what makes "it holds nothing clinical" a property of the whole surface rather than of one module
- Web: `✅ — apps/web/__tests__/generalStore.test.tsx` (D19 and D20 both pinned), `navigationEntitlement.test.tsx`
- E2E: `✅ — e2e/inventoryStore.spec.ts`; `e2e/branchSwitch.spec.ts` (the "All branches" starting state)
- Manual: **⬜ Not Tested**

---

#### STO-IDM-001 — A retried receipt receives once

**Criticality:** C1 · **Priority:** P2

**Expected Result** — receive, issue and adjust all honour `Idempotency-Key`: a retry replays, it does
not repeat.

**Automation Coverage** — Integration: `✅ — apps/api/src/idempotency.int.test.ts` §"the guarantee
holds on each money-moving operation". Manual: **⬜ Not Tested**

---

> **NOT built, so no scenario claims it:** purchase orders, approval chains, rate contracts, GRN
> matching, accounts payable, sub-stores, inter-branch transfer, ABC/VED, EOQ, barcodes,
> batch/expiry for consumables, patient-level consumable billing. **Do not write procurement rows.**

---

## 10. EMERGENCY DEPARTMENT

**Not a role — a module,** worked by `NURSE` and `DOCTOR` holding **`triage:perform`**, and reached
from the front desk. `triage:perform` is deliberately **not** the registration desk's.
**Screens:** `/reception` (arrival), `/emergency` (the board), then the **ordinary** clinical screens.
**Module:** `module.clinical.emergency`.

> **The ED is not a second hospital, it is a way in.** `origin: "emergency"` and `class: "ER"` already
> existed, and the encounter's own state machine already _is_ arrived → triaged → with a doctor →
> treatment → disposition. The module owns exactly two things: **the triage judgement** (a person, a
> priority, a time) and **the board**.

#### EMG-ARR-001 — An emergency arrival is a visit, registered the ordinary way

**Criticality:** C1 · **Priority:** P0

**Steps** — from `/reception`, register an arrival with the emergency checkbox. Open `/emergency`.

**Expected Result** — the patient is on the board **within a minute**, **untriaged**.

**Automation Coverage**

- Integration: `✅ — apps/api/src/emergency.int.test.ts` §"an emergency arrival is a visit, registered the ordinary way"
- E2E: `✅ — e2e/emergencyWorkflow.spec.ts`
- Manual: **⬜ Not Tested**

---

#### EMG-TRI-001 — 🔴 An unassessed patient sorts ABOVE every assessed one

**Criticality:** C0 · **Priority:** P0

**Steps** — with a critical triaged patient and an untriaged arrival on the board together, read the
order. Then triage, then re-triage.

**Expected Result** — **untriaged sorts above critical, and the banner says so.** _Unknown severity is
not low severity._ Triage records a person, a priority and a time; a re-triage is a **revision**, with
the modal pre-filled.

**Automation Coverage**

- Integration: `✅ — apps/api/src/emergency.int.test.ts` §"the board ranks the department"
- Web: `✅ — apps/web/__tests__/emergencyBoard.test.tsx`
- E2E: `✅ — e2e/emergencyWorkflow.spec.ts` ("the nurse sees them at the TOP as untriaged, and assesses them")
- Manual: **⬜ Not Tested**

---

#### EMG-WRK-001 — The ED is worked on the ordinary clinical screens, and its orders land on the ordinary bench

**Criticality:** C1 · **Priority:** P0

**Steps** — send to doctor; open the doctor's queue; order imaging from the ED encounter; check the
radiology worklist. Confirm the board **names the doctor** and the arrival time.

**Expected Result** — the ED patient is in the ordinary queue, the order pad is the ordinary order
pad, and **an ED imaging order lands on the ordinary radiology bench**. _That is the claim the whole
module rests on._ The board row says which doctor (**regression check for D15/D18-family display
gaps**).

**Automation Coverage**

- Integration: `✅ — apps/api/src/emergency.int.test.ts` (an ED lab order is driven and asserted to land on the ordinary bench)
- Web: `✅ — apps/web/__tests__/emergencyBoard.test.tsx` ("the board names the doctor and the arrival")
- E2E: `✅ — e2e/emergencyWorkflow.spec.ts` (all five tests)
- Manual: **⬜ Not Tested**

---

#### EMG-DIS-001 — A patient leaves the board exactly when they leave the department

**Criticality:** C1 · **Priority:** P0

**Steps** — take three ED patients to three dispositions: **discharge**, **admission**, and
**transfer out**.

**Expected Result** — each leaves the board. Admission **closes the ER encounter and opens an IP
stay**. Transfer-out records **destination, reason, time and actor**, and walks
`arrived → in_progress → closed`.

**Automation Coverage**

- Integration: `✅ — apps/api/src/emergency.int.test.ts` §"a patient leaves the board exactly when they leave the department"
- E2E: `✅ — e2e/emergencyWorkflow.spec.ts` ("a disposition takes them off the board")
- Manual: **⬜ Not Tested**

---

#### EMG-STA-001 — A visit that has already ended refuses both writes

**Criticality:** C0 · **Priority:** P0 · **Regression check for risk-register D14 (fixed `9d4715b`, found in a browser)**

**Steps** — on a closed ED encounter, attempt `POST /emergency/triage` and
`POST /emergency/transfer-out`.

**Expected Result** — both refused. **D14 was found because a browser showed a plausible refusal while
the collection showed a destroyed destination** — so verify the database, not the screen.

**Automation Coverage**

- Integration: `✅ — apps/api/src/emergency.int.test.ts` §"a visit that has already ended refuses both writes"
- Manual: **⬜ Not Tested**

---

#### EMG-SEC-001 — Who may look, who may judge, and which hospital's board it is

**Criticality:** C0 · **Priority:** P0

**Steps** — read the board as the desk (`encounter:read` — the desk can answer _"where is my
father"_). Attempt triage as the desk. Cross-tenant: call both directions with the other hospital's
ids. Cross-branch: read a booking made at MAIN while working at the second site. On a `PLAN_CLINIC`
tenant, call anything in the module.

**Expected Result** — the desk reads and **cannot triage** (`403 HMS-AUTH-005`). Cross-tenant is
**`HMS-TEN-003` in both directions**. Cross-branch returns `[]`. The clinic plan is refused
**`403 HMS-PLAN-002` naming `module.clinical.emergency`** — not a permission error.

**Automation Coverage**

- Integration: `✅ — apps/api/src/emergency.int.test.ts` §"who may look, and who may judge",
  §"permissions do not cross the tenancy boundary", §"row scope", §"branch", §"entitlement"
- Web: `✅ — apps/web/__tests__/moduleRefusal.test.tsx` §1
- E2E: `✅ — e2e/branchSwitch.spec.ts` ("guards the emergency board's writes the same way")
- Manual: **⬜ Not Tested**

---

> **ED depth NOT built:** five-level triage scales (ESI), bay assignment, manual board re-ordering,
> MLC registration, ambulance/referral integration, ED analytics, ED-specific billing. `ed:board:manage`
> stays `future()`. **Notifications were evaluated and declined** — _"a critical patient arrived" is
> addressed to a room, not a person, and the board is the alert._

---

## 11. OPERATING THEATRE

**Not a role.** `ot:schedule` is held by **DOCTOR and NURSE** — the surgeon books, and the circulating
nurse runs the board, because the surgeon is scrubbed in and nowhere near a keyboard for the hours in
between. **`ot:record` is the DOCTOR's alone**, because the operation record is the surgeon's
statement, and the nurse's grant deliberately stops short of it. `facility:manage` (the registry) is
the administrator's.
**Screens:** `/theatres`, plus the **Procedures tab** on `/patients/[id]`.
**Module:** `module.clinical.ot`. **Theatre v1 only.**

#### OT-REG-001 — The registry is the administrator's; a doctor reads it

**Criticality:** C2 · **Priority:** P2

**Expected Result** — creating a theatre needs `facility:manage`; a doctor sees the registry read-only.

> **Environment note:** **`seed:demo` creates no operating theatre.** Theatre reads as unbuilt on a
> fresh seed until an admin adds one. That is a seed-data gap, not a product defect — do not file it.

**Automation Coverage** — Integration: `✅ — apps/api/src/theatres.int.test.ts` §"authorization".
E2E: `✅ — e2e/pageHealth.spec.ts` (`/theatres` loads and offers "Book a procedure"). Manual: **⬜ Not Tested**

---

#### OT-BOK-001 — 🔴 Two procedures cannot share a theatre and a moment — and back-to-back is legal

**Criticality:** C1 · **Priority:** P0

**Steps** — book a window. Book an **overlapping** one. Then book one that starts **exactly** when the
first ends. Then race two identical bookings concurrently.

**Expected Result** — the overlap is refused **in the browser with `HMS-VAL-001` and the form
preserved**. The back-to-back slot at a shared boundary is **accepted** — the intervals are half-open,
and a list that cannot run back-to-back is a list nobody can use. Under concurrency exactly one wins.

**Automation Coverage**

- Integration: `✅ — apps/api/src/theatres.int.test.ts` §"two procedures cannot share a theatre and a moment" (tested at its **boundaries** and under concurrency)
- E2E: `✅ — e2e/theatreWorkflow.spec.ts`
- Manual: **⬜ Not Tested**

---

#### OT-STA-001 — The booking moves only along legal edges, and the record describes an operation that happened

**Criticality:** C1 · **Priority:** P0

**Steps** — walk `scheduled → started → completed`. Cancel another. Then attempt an operative note on
a **scheduled** booking, and a **second** note on one that already has one.

**Expected Result** — legal edges succeed. **A note on a scheduled or cancelled booking is refused
`409`** — it would record an operation that did not happen. **A second note is refused `409`** — the
record is **write-once**, enforced by a conditional update rather than a read-then-write.

**Automation Coverage**

- Integration: `✅ — apps/api/src/theatres.int.test.ts` §"a booking moves only along legal edges", §"an operation record describes an operation that happened"
- Web: `✅ — apps/web/__tests__/operativeNote.test.tsx`
- E2E: `✅ — e2e/theatreWorkflow.spec.ts`
- Manual: **⬜ Not Tested**

---

#### OT-CHT-001 — The operation reaches the durable chart, not just the live queue

**Criticality:** C1 · **Priority:** P1 · **Regression check for the 2026-08-19 audit gap**

**Steps** — after OT-STA-001, close the visit. Then open `/patients/[id]` → **Procedures**.

**Expected Result** — the operative note is there, **and names the operating surgeon**
(**regression check for D15**, where the surgeon was required, stored and never displayed). It was
previously reachable only from `/my-patients` — the doctor's LIVE queue — so it left the product's
reach the moment the visit closed.

**Automation Coverage**

- Integration: `✅ — apps/api/src/theatres.int.test.ts` §"the operation reaches the patient's chart"
- Web: `✅ — apps/web/__tests__/patientProcedures.test.tsx`
- E2E: `✅ — e2e/theatreWorkflow.spec.ts` ("the operation is readable from the patient's chart afterwards")
- Manual: **⬜ Not Tested**

---

#### OT-SEC-001 — Who may run the list, who may write the record, and whose list it is

**Criticality:** C1 · **Priority:** P1

**Steps** — across five roles, attempt list, book, transition and note. Cross-tenant both directions.
Read a MAIN booking while working at the second site. Then on a tenant without `module.clinical.ot`.

**Expected Result** — a reader without `ot:record` **sees the record and cannot author one**.
Cross-tenant refused. Cross-branch returns `[]`. Unentitled tenant refused `HMS-PLAN-002`.

**Automation Coverage**

- Integration: `✅ — apps/api/src/theatres.int.test.ts` §"authorization", §"permissions do not cross the tenancy boundary", §"row scope", §"entitlement"
- Web: `✅ — apps/web/__tests__/moduleRefusal.test.tsx` §2, `patientProcedures.test.tsx` §2
- E2E: `✅ — e2e/theatreWorkflow.spec.ts` ("a reader without ot:record sees the record but cannot author one")
- Manual: **⬜ Not Tested**

---

> **Theatre depth NOT built:** pre-op checklists, anaesthesia, team roster, instrument/implant
> tracking, CSSD, OT inventory, PACU, blood, consumables, utilisation analytics, **amending a
> record**. **Billing is a documented dependency, not a second system** — a `procedure` ORDER is what
> bills; a booking is scheduling.

---

## 12. BILLING / FINANCE

**Roles:** `CASHIER` · `FRONT_OFFICE` (desk + cash) · `PHARMACIST` (takes money at the counter) ·
`AUDITOR` (reads bills and can change nothing).
**Screens:** `/billing`, `/receipts`, `/receipt/[id]`, `/receipt/advance/[id]`, `/reports`,
`/tariff`, `/packages`.
**Modules:** Charges · Invoices · Payments · Wallet · Packages · Reports.

> **The same software bills a private hospital and a government hospital.** Code asks the **policy**
> (`is billingMode zero_tariff?`), never the **type** (`is this a government hospital?`) — that
> distinction is what decides whether a customer is sellable, and it is pinned by test.

#### BIL-CHG-001 — Charges arrive from events, and nobody types them twice

**Criticality:** C1 · **Priority:** P0 · **Runbook:** JR-21

**Steps** — walk one patient through consultation, a lab order, a dispensed drug and two bed-days.
Then open the encounter's charges.

**Expected Result** — every line is there, raised by `encounter.started`, `order.placed`,
`medication.dispensed`, `patient.admitted` / `patient.discharged` — **no line typed by hand**. **A
patient is never billed twice for one thing.**

**Negative / Boundary** — **a cancelled order stops costing money**. **A missing price does not stop a
patient being treated.** A finalized bill missing the drugs means the dispensing event never landed.

**Automation Coverage**

- Integration: `✅ — apps/api/src/billing.int.test.ts` §"a patient is never billed twice for one
  thing", §"a cancelled order stops costing money", §"a missing price does not stop a patient being treated"
- Manual: **⬜ Not Tested**

---

#### BIL-INV-001 — Finalizing turns a running tab into a document

**Criticality:** C1 · **Priority:** P0

**Steps** — finalize the bill; read the invoice; open its signatories.

**Expected Result** — the invoice totals consultation + drugs + investigations + bed-days, carries an
invoice number, and **can name the people who took the money**. Finalizing needs `billing:finalize`.

**Automation Coverage**

- Integration: `✅ — apps/api/src/billing.int.test.ts` §"the bill becomes a document", §"a bill can name the people who took the money"
- Manual: **⬜ Not Tested**

---

#### BIL-PAY-001 — 🔴 The money adds up, including under concurrency

**Criticality:** C0 (financial integrity) · **Priority:** P0

**Steps** — take a payment; print the receipt. Then post two payments against the same invoice
concurrently. Then retry one payment with the **same** `Idempotency-Key`.

**Expected Result** — the payment records once, the receipt is available, and **the totals are correct
under concurrent posting**. The retry replays; it does not double-collect.

**Automation Coverage**

- Integration: `✅ — apps/api/src/billing.int.test.ts` §"the money adds up under concurrency";
  `apps/api/src/idempotency.int.test.ts` §"the guarantee holds on each money-moving operation"
- Manual: **⬜ Not Tested**

---

#### BIL-PAY-002 — Discount and refund are their own permissions, and the cashier does not hold them

**Criticality:** C1 · **Priority:** P1

**Steps** — as `cashier@`, attempt `POST /invoices/:id/discount` and `POST /invoices/:id/refund`.

**Expected Result** — both refused `403 HMS-AUTH-005`. The CASHIER role's own description says it:
_"Cannot discount or refund without approval."_

**Automation Coverage**

- Integration: `✅ — apps/api/src/rbac.int.test.ts` matrix; `apps/api/src/billing.int.test.ts`
- Manual: **⬜ Not Tested**

---

#### BIL-CSH-001 — A cashier can find and bill care nobody has billed yet

**Criticality:** C1 · **Priority:** P1

**Steps** — open `/billing` → pending.

**Expected Result** — care that has been given and never invoiced is findable, billable and
collectable from one screen. This is the revenue-leakage path, and `/reports/revenue-leakage` is its
report.

**Automation Coverage**

- Integration: `✅ — apps/api/src/billing.int.test.ts` §"a cashier can find, bill and collect for care nobody has billed yet"
- E2E: `✅ — e2e/pageHealth.spec.ts` (`/reports` loads)
- Manual: **⬜ Not Tested**

---

#### BIL-WAL-001 — One advance purse per patient, spendable at either site

**Criticality:** C1 · **Priority:** P1 · **Runbook:** BR-12 — see FD-PAY-003, the negative check

**Steps** — deposit an advance; settle an admitted patient's test from it when the advance is
**short**; refund the remainder.

**Expected Result** — the settlement handles the shortfall rather than refusing; the statement and the
receipt agree; the balance is **hospital-wide**.

**Automation Coverage**

- Integration: `✅ — apps/api/src/billing.int.test.ts` §"an admitted patient's test settles even when
  the advance is short"; `apps/api/src/branchIsolation.int.test.ts` §24
- Manual: **⬜ Not Tested**

---

#### BIL-GOV-001 — A government hospital gives the same care for nothing

**Criticality:** C1 · **Priority:** P2

**Steps** — on a tenant provisioned with a `zero_tariff` billing policy, run the same journey.

**Expected Result** — the clinic runs with no appointment book, admits for nothing, and hands out the
same drugs for nothing. **Identical code path, different policy.**

**Automation Coverage**

- Unit: `✅ — apps/api/src/organizations.test.ts`
- Integration: `✅ — apps/api/src/billing.int.test.ts` §"the same software bills a private hospital and
  a government hospital"; `apps/api/src/admissions.int.test.ts` §"a government hospital admits for
  nothing"; `apps/api/src/prescriptions.int.test.ts` §"a government hospital hands out the same drugs
  for nothing"; `apps/api/src/encounters.int.test.ts` §"a government hospital runs a whole clinic with NO appointment book"
- Manual: **⬜ Not Tested**

---

#### BIL-PKG-001 — Care packages are a module a hospital buys

**Criticality:** C2 · **Priority:** P2

**Steps** — on `PLAN_HOSPITAL` (which does **not** include `module.finance.packages`), open the nav
and then call the package routes directly.

**Expected Result** — **no "Care packages" entry in the sidebar**, and the API answers
`403 HMS-PLAN-002`. On a plan that includes it, enrolment posts a fixed price and can be cancelled.

**Automation Coverage**

- Integration: `✅ — apps/api/src/billing.int.test.ts` §"care packages: a hospital that did not buy them cannot use them"
- Web: `✅ — apps/web/__tests__/navigationEntitlement.test.tsx`, `moduleRefusal.test.tsx` §4, `patientProcedures.test.tsx` §3
- E2E: `✅ — e2e/pageHealth.spec.ts` (`/packages`)
- Manual: **⬜ Not Tested**

---

#### BIL-RPT-001 — A report exports a file named for the period it covers

**Criticality:** C2 · **Priority:** P2

**Steps** — `/reports` → pick a period → Export CSV.

**Expected Result** — a file arrives, **named for the period**, with rows under its header. The
Blob → object URL → anchor → revoke path is what breaks silently: a button that spins, succeeds and
delivers nothing.

**Automation Coverage**

- E2E: `✅ — e2e/reportsExport.spec.ts`
- Integration: `⚠️ partial` — the report queries themselves are only reached through `rbac.int.test.ts`.
- Manual: **⬜ Not Tested**

---

#### BIL-SEC-001 — Finance boundaries

**Criticality:** C0 · **Priority:** P0

| Attempt (as `cashier@`)                           | Expected           |
| ------------------------------------------------- | ------------------ |
| `POST /invoices/:id/payments`                     | `201`              |
| `POST /encounters/:id/bill/finalize`              | `200`              |
| `GET /patients/:id`                               | `200`              |
| `GET /encounters/:id/consultation` (`emr:read`)   | `403 HMS-AUTH-005` |
| `POST /encounters/:id/medication-administrations` | `403 HMS-AUTH-005` |
| `POST /invoices/:id/discount`                     | `403 HMS-AUTH-005` |

**Automation Coverage** — Integration: `✅ — apps/api/src/rbac.int.test.ts` §"the matrix: role ×
route" — **CASHIER is now one of the thirteen roles swept against every protected `/api/v1` route**,
in both directions (denied what it lacks, reached what it holds). Individual probes also exist in
`billing.int.test.ts`. Manual: **⬜ Not Tested**

---

> **Finance depth NOT built:** general ledger, accounts payable, corporate billing, insurance beyond
> MVP, SaaS invoicing / dunning. **Insurance policies and claims exist as routes with an RBAC probe
> and nothing more** — see §20.4.

---

## 13. HOSPITAL ADMINISTRATOR

**Role:** `TENANT_ADMIN`.
**Screens:** `/staff`, `/roles`, `/branches`, `/departments`, `/doctors`, `/beds`, `/tariff`,
`/packages`, `/medicines`, `/lab-catalogue`, `/mrd`, `/assets`, `/inventory`, `/feedback`, `/audit`,
`/subscription`, `/settings/*`, `/mortuary`, `/ambulance`.

> **`TENANT_ADMIN`'s clinical reach is a per-hospital configuration.** Where the permission matrix
> below says _by role config_, **verify against the seeded role rather than assuming**, and mark
> `PRODUCT DECISION REQUIRED` if the repository does not state the intent.

#### ADM-USR-001 — Staff, roles and the seat limit

**Criticality:** C1 · **Priority:** P0

**Steps** — create a colleague, grant a role, sign in as them, deactivate them, reset their password.
Then create accounts past the plan's `maxUsers`.

**Expected Result** — the colleague's sidebar is **smaller** — the nav is a function of the permission
set. Deactivation blocks sign-in. **The 11th account on a 10-seat plan is refused cleanly**, naming
the limit, not a 500.

**Automation Coverage**

- Integration: `✅ — apps/api/src/rbac.int.test.ts`; `apps/api/src/tenancy.int.test.ts` §"lifecycle guards"
- E2E: `✅ — e2e/staffDirectory.spec.ts`; `apps/web/__tests__/staffCount.test.tsx`
- Manual: **⬜ Not Tested**

---

#### ADM-USR-002 — The staff directory follows the site being worked in, and says which

**Criticality:** C2 · **Priority:** P2

**Steps** — open `/staff` at branch A, then at B, then in All-branches mode.

**Expected Result** — the directory narrows to the active site, **says which scope it counted**, shows
each person's branch binding, and the count comes from **the server's total**, not the page length.

**Automation Coverage**

- Integration: `✅ — apps/api/src/branchIsolation.int.test.ts` §"the staff directory follows the branch you are working in"
- Web: `✅ — apps/web/__tests__/staffCount.test.tsx`
- E2E: `✅ — e2e/staffDirectory.spec.ts` (falsified twice: removing the exclusion, and reading the count off the page)
- Manual: **⬜ Not Tested**

---

#### ADM-ROL-001 — 🔴 Every permission is held by somebody

**Criticality:** C1 · **Priority:** P0 · **Runbook:** PERM-10

**Steps** — for every permission a route enforces (`pnpm --filter @medicore/api routes`), confirm
**some seeded role holds it**.

**Expected Result** — no orphans.

> **This is a recurring bug class in this codebase and it has bitten six times**: `user:read` for the
> receptionist, the admit pair, `nursing:manage`, `ot:schedule`, the five `inventory:*` codes, and a
> queued job the queue silently refused. **A permission granted to no one is a feature nobody has**,
> and the symptom is always "the screen exists and nobody can open it".

**Automation Coverage**

- Unit: `✅ — apps/api/src/permissionLifecycle.test.ts`, `apps/api/src/featureLifecycle.test.ts`
- Integration: `✅ — apps/api/src/rbac.int.test.ts` §"route coverage (the unprotected-route problem)" —
  fails the build if a protected route ships with no probe, or requires a permission not in the
  catalogue, or if a probe names a route that no longer exists.
- Manual: **⬜ Not Tested**

---

#### ADM-ROL-002 — A custom role takes effect immediately, and the nav follows it

**Criticality:** C1 · **Priority:** P1

**Steps** — create a role, grant a subset, assign it, sign in. Then remove a permission while that
user is signed in and have them retry the action.

**Expected Result** — the sidebar shows exactly the entries their grants allow. Removing a permission
takes effect on the next request — **permissions are not carried in the JWT**.

**Automation Coverage**

- Integration: `✅ — apps/api/src/rbac.int.test.ts`; `apps/api/src/branchIsolation.int.test.ts` §"branch membership is live, not carried in the JWT"
- Web: `✅ — apps/web/__tests__/navigationEntitlement.test.tsx`
- Mobile: `✅ — apps/mobile/__tests__/navigation.test.ts` §9, §9b, §10
- Manual: **⬜ Not Tested**

---

#### ADM-BRN-001 — Adding a site, and the two traps that come with it

**Criticality:** C1 · **Priority:** P1

**Steps** — create a second branch with a timezone. Try an invalid timezone. Then open a second site
on a hospital whose historical records carry no branch.

**Expected Result** — the timezone is **validated** (shape + `Intl`), not trusted. Console provisioning
gives a new hospital its **Main Branch**; the Main-Branch backfill **declines on a multi-branch
hospital**. **A second site cannot open while historical records carry no site** — that window is shut
at branch creation (the control that closed D11 and D12).

**Negative / Boundary** — **two sites can each have a ward of the same name**; bed occupancy is
isolated per branch; an idempotency key is spent in the branch that spent it.

**Automation Coverage**

- Integration: `✅ — apps/api/src/branchIsolation.int.test.ts` §"a branch cannot be given a timezone
  the server cannot format in", §"console provisioning gives the hospital its Main Branch", §"the
  Main Branch backfill declines on a multi-branch hospital", §"two sites can each have a ward of the
  same name", §"a second site cannot open while historical records carry no site", §"an idempotency
  key is spent in the branch that spent it"
- Manual: **⬜ Not Tested**

---

#### ADM-BRN-002 — A branch deactivated underneath a working user

**Criticality:** C1 · **Priority:** P1 · **Runbook:** BR-06, M2-13

**Steps** — as admin, set the branch a nurse is working in **inactive**. Resume the nurse's app.

**Expected Result** — the client **falls back to a valid branch** rather than continuing to send the
dead one. **A closed branch cannot be worked in, however the client asks.**

**Automation Coverage**

- Integration: `✅ — apps/api/src/branchIsolation.int.test.ts` §"a closed branch cannot be worked in, however the client asks"
- Mobile: `✅ — apps/mobile/__tests__/branch.test.ts` §6, §7
- Manual: **⬜ Not Tested**

---

#### ADM-CFG-001 — Configuration changes reach the workflow downstream

**Criticality:** C1 · **Priority:** P1

For each configuration change, verify the downstream behaviour rather than the form:

| Change                                 | Downstream verification                                                                         |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Add a **department**                   | It appears as an order destination and an inventory destination; the hierarchy is cycle-guarded |
| Add a **ward → room → bed**            | The bed is offered on admission; **tariff resolution is most-specific-wins**                    |
| Set a **service tariff**               | The next order of that service carries that price                                               |
| Add a **lab test** with analytes       | The result form shows those analytes and reference ranges                                       |
| Add a **medicine** and receive a batch | It appears on the prescribing pad's availability and on the shelf, with expiry                  |
| Add a **doctor session / leave**       | Appointment availability changes at **that** site only                                          |
| Change the **plan** (operator)         | The nav and the API refusals both change — see ADM-ENT-001                                      |

**Automation Coverage**

- Integration: `✅` in pieces — `branchIsolation.int.test.ts` (roster, ward names, catalogue),
  `orders.int.test.ts` (catalogue), `admissions.int.test.ts` (bed tariff), `billing.int.test.ts` (price)
- E2E: `✅ — e2e/pageHealth.spec.ts` loads `/tariff`, `/mrd`, `/assets`, `/packages` and asserts each
  was **refused nothing it did not expect** — but **creates nothing**.
- Manual: **⬜ Not Tested** — _the back-office WRITES are the largest manual-only surface in the plan; see §20.5._

---

#### ADM-ENT-001 — The nav sells only what the edition includes

**Criticality:** C2 · **Priority:** P1 · **Regression check for risk-register D20 (fixed 2026-08-19)**

**Steps** — on a `PLAN_CLINIC` tenant, read the sidebar. Then type the URL of a module the plan
excludes. Then call its API directly.

**Expected Result** — the entry is **absent** from the nav; the page says **"Feature not in your
edition"** with a reference; the API answers **`403 HMS-PLAN-002` naming the flag**. `/mortuary` on
`PLAN_HOSPITAL` is the worked example — `module.support.mortuary` is not in that edition, and the
sweep asserts the refusal **still reads as an explanation rather than a blank register**.

**Automation Coverage**

- Web: `✅ — apps/web/__tests__/navigationEntitlement.test.tsx` (against the **real** `EDITIONS` data:
  withdraw one flag, assert exactly the dependent entries disappear), `moduleRefusal.test.tsx`
- Integration: `✅ — apps/api/src/rbac.int.test.ts` §"entitlement (layer 1)"; `emergency.int.test.ts`, `theatres.int.test.ts`, `orders.int.test.ts`, `billing.int.test.ts` each own their module's gate
- E2E: `⚠️ deliberately not covered` — proving the nav for a clinic needs a `PLAN_CLINIC` tenant, and
  the only way to make one mid-run is an operator feature override. **A run that died between the
  override and its restore would leave the shared seeded hospital missing a module and poison every
  other spec.** Recorded as a known gap rather than papered over.
- Manual: **⬜ Not Tested**

---

#### ADM-AUD-001 — 🔴 The activity trail records what happened, and can prove it was not altered

**Criticality:** C0 · **Priority:** P0 · **Regression check for D17 and D21 (both fixed 2026-08-19)**

**Steps** — perform a create and an update on a PHI-bearing model (the ED triage flow is the worked
example). Open `/audit`. Run **Check integrity**. Then export CSV.

**Expected Result** — an entry for **every** mutation of PHI or money, each naming **its own actor**,
its hospital and its branch. **A no-op and a failed write record nothing.** **Every entry recomputes
to its stored hash**, and the chain verifies.

> **Why this is a P0 with two regression numbers behind it.** `auditPlugin` carries the requirement
> for 54 models and, when D17 was found, **not one test asserted that it wrote anything**. The query
> path discarded any write it had found no pre-image for — silently throwing away the first write of
> every document created by an upsert. Fixing it exposed **D21** within the hour, from the first
> assertion in the project that recomputed a stored hash: an update that only ADDS fields produced an
> empty `before`, Mongoose's `minimize` stripped it after the hash had been taken over it, and the
> entry **could never verify**. The tamper alarm would have fired on an entry nobody touched.

**Automation Coverage**

- Integration: `✅ — apps/api/src/auditPlugin.int.test.ts` — all four blocks, including §"the tamper-evident chain"
- E2E: `✅ — e2e/pageHealth.spec.ts` (`/audit` loads and offers Export CSV)
- Manual: **⬜ Not Tested** — _the CSV export itself is deliberately not swept in a browser; `/reports` proves the same Blob-and-anchor path._

---

#### ADM-SIT-001 — The public site, the logo and the API keys

**Criticality:** C2 · **Priority:** P2

**Steps** — set the hospital profile, upload and delete a logo, edit site settings, create and revoke
an API key.

**Expected Result** — each is gated on its own permission (`hospital:manage`, `branding:manage`,
`apikey:manage`). `GET /site` and `GET /site/logo` are **public** — that is what lets the login page
brand itself before anybody signs in, and it is what makes XC-TEN-002 possible.

**Automation Coverage** — Integration: `✅ — apps/api/src/rbac.int.test.ts` (`PUBLIC_ROUTES` is a
declaration the suite enforces). E2E: `✅ — e2e/auth.spec.ts`. Manual: **⬜ Not Tested**

---

#### ADM-SEC-001 — What the administrator cannot do

**Criticality:** C0 · **Priority:** P0

| Attempt (as `admin@`)                             | Expected                                |
| ------------------------------------------------- | --------------------------------------- |
| `POST /encounters/:id/medication-administrations` | `403` — `mar:administer` is the nurse's |
| `POST /subscription/plan` (`plan:manage`)         | `403` — **operator only**               |
| Read another person's alert inbox                 | Nothing — the inbox follows the person  |
| Edit or delete an audit entry                     | **No code path exists**                 |

**Automation Coverage**

- Integration: `✅ — apps/api/src/rbac.int.test.ts` §"privilege boundaries that must never move" (TENANT_ADMIN is swept); `apps/api/src/branchIsolation.int.test.ts` §"a person's inbox follows the person, not the branch picker"
- E2E: `✅ — e2e/alertInbox.spec.ts` ("does not show one person's alerts to another")
- Manual: **⬜ Not Tested**

---

## 14. PLATFORM OPERATOR

**Roles:** `SUPER_ADMIN` (everything) · `SUPPORT` (read-only over the fleet; may impersonate for
support, **cannot** provision, suspend or re-price).
**Surface:** the admin console — **a separate application on a separate address**, because hospital
staff must never see it. Routes are `/api/platform/v1/*`.

#### OPS-HOS-001 — Creating a hospital creates a database

**Criticality:** C0 · **Priority:** P0

**Steps** — provision a hospital from the console. Sign in to it. Then attempt to reach it from
another tenant's session.

**Expected Result** — its **own database** (ADR-0005), its own admin account, its **Main Branch**, and
its migrations applied **inside provisioning**. **A hospital cannot be exposed before its schema
exists.**

**Automation Coverage**

- Integration: `✅ — apps/api/src/tenancy.int.test.ts` §"provisioning"; `apps/api/src/schemaGuard.int.test.ts` §7 ("tenant provisioning cannot expose a hospital before its schema exists")
- Manual: **⬜ Not Tested**

---

#### OPS-PLN-001 — Plans and limits are the operator's, and a hospital cannot upgrade itself

**Criticality:** C1 · **Priority:** P1

**Steps** — change a hospital's plan and limits from the console. Then attempt the same from inside
the hospital as `admin@`.

**Expected Result** — the console succeeds and the change is visible immediately in the hospital's nav
and API refusals. The hospital admin is refused — **`plan:manage` is operator-only, by design.**

> **`limits.maxBranches` is a catalogue figure deliberately never applied to a tenant** (risk-register
> D5, reclassified as BY DESIGN). What is open is narrower and is a **PRODUCT DECISION**: should
> provisioning seed the cap from the plan? Record; do not file.

**Automation Coverage** — Integration: `✅ — apps/api/src/rbac.int.test.ts`, `tenancy.int.test.ts`.
Manual: **⬜ Not Tested**

---

#### OPS-SUS-001 — Suspension locks a hospital out and touches none of its data

**Criticality:** C0 · **Priority:** P1

**Expected Result** — a suspended hospital's staff cannot sign in; the refusal is `HMS-TEN-002`,
distinct from unknown (`001`), licence lapsed (`005`) and registry unreachable (`004`). The data is
untouched and returns on reactivation.

**Automation Coverage** — Integration: `✅ — apps/api/src/tenancy.int.test.ts` §"lifecycle guards",
§"host → tenant resolution"; `apps/api/src/registryCache.int.test.ts`. Manual: **⬜ Not Tested**

---

#### OPS-LIC-001 … OPS-LIC-006 — The five licence states, and the one still blocked

**Criticality:** C1 · **Priority:** P1 · **Runbook:** LIC-01 … LIC-06

**Fixture** — provision a dedicated hospital ONCE and **never point this at the validation tenant**
(the script refuses any slug without `licence` in it, for exactly that reason):

```bash
pnpm seed:hospital -- --name "Licence Lab" --slug licence-lab --plan PLAN_ENTERPRISE
pnpm seed:migrate  -- --slug licence-lab
pnpm seed:licence  -- --slug licence-lab --state active|expiring|grace|expired|--show
```

Each command prints the state **the server computed** (`effectiveLicenseState`, the same function the
request gate uses), so the line it prints is the state you are actually testing.

| ID         | State                                  | Expected                                                                                                                                                                                                                                         | Manual        |
| ---------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| **LIC-01** | Healthy                                | No banner anywhere                                                                                                                                                                                                                               | ⬜ Not Tested |
| **LIC-02** | EXPIRING (5 of `LICENSE_WARN_DAYS`=10) | Amber strip above the tab bar with a day count. **Check the layout** — the banner is new and has never been seen on a device.                                                                                                                    | ⬜ Not Tested |
| **LIC-03** | GRACE                                  | Red strip — **and every clinical write still works.** `blocksWrites` deliberately excludes GRACE: a hospital the server is still serving must still be able to record what was done to a patient. **A red strip AND a working MAR is the pass.** | ⬜ Not Tested |
| **LIC-04** | EXPIRED (past grace)                   | "Subscription expired" as a blocking state; save controls disabled **with that reason**, rather than failing after the tap                                                                                                                       | ⬜ Not Tested |
| **LIC-05** | Renewal mid-session                    | Operator renews while the app is open; pull to refresh clears the block **without a restart**                                                                                                                                                    | ⬜ Not Tested |
| **LIC-06** | Edition without the nursing module     | The round says **"Not in this edition"**, never an empty ward. **🔴 STILL BLOCKED** — needs a tenant whose edition excludes `module.clinical.nursing`; use `pnpm seed:hospital` with such a plan, then `seed:migrate --slug`.                    | 🟡 Blocked    |

**Criticality note:** LIC-02 sits at **half** the warning window deliberately. A licence expiring in
exactly `LICENSE_WARN_DAYS` days is the boundary case, and a banner that failed to appear there would
be reported as a broken banner when it is an ambiguous fixture.

**Automation Coverage**

- Mobile: `✅ — apps/mobile/__tests__/licence.test.ts` (all eleven blocks, including §"grace warns;
  only expiry blocks" and §"an expired licence is learned from the refusal, because nothing else can
  tell") — **regression check for D8** (the banner painted under the status bar)
- Integration: `✅ — apps/api/src/mobileContract.int.test.ts` §"a phone hears about licence and lifecycle without polling"
- Manual: **⬜ Not Tested / 🟡 Blocked** — _"PREPARED means the state can be produced on demand and was, on 2026-08-17 — not that anybody has looked at the screen."_

---

## 15. AUDITOR

**Role:** `AUDITOR` — **defined by what it cannot do.** `audit:view`, `audit:export`, `user:read`,
`mrd:register:view`, `billing:read`. **It cannot post, finalize, discount, refund or take a payment.**
Not seeded by `seed:demo`; create one to run this section.

#### AUD-SEC-001 — Read-only means read-only

**Criticality:** C1 · **Priority:** P2

**Steps** — as an auditor: open `/audit`, export it, read `/billing`, read the disease register. Then
attempt a payment, a discount, a charge and a patient registration.

**Expected Result** — the four reads succeed; **every write is refused `403 HMS-AUTH-005`**.

**Automation Coverage** — Integration: `✅ — apps/api/src/rbac.int.test.ts` §"the matrix: role ×
route" — **AUDITOR is now swept against every protected route.** It is also the role the expansion
was falsified against: seeding AUDITOR with a cashier's grant turns **27** rows red — 6 of them
"was denied … but holds" (the authorized half) and 21 "reached … without" (the unauthorized half).
Manual: **⬜ Not Tested**

---

## 16. PATIENT — declared, not built

**`Not Applicable / Obsolete` for functional UAT.** The `PATIENT` role exists in the catalogue with
`self:manage` and `booking:public`, and `GET /site` / `GET /site/logo` are public. **There is no
patient portal, no online registration, no patient login screen and no patient app** — the tracker
lists G2/G3 (portals) and M8 (patient app, deferred to the final phase) as not started.

**Do not write UAT rows against a patient portal.** The only patient-facing behaviour that exists
today is **outbound notification**: appointment confirmations and reminders by email, covered in
XC-NOT-001.

---

## 17. CROSS-CUTTING VALIDATION

These are the properties that must hold **in every role section above**. They are gathered here so
they are tested deliberately once, rather than assumed everywhere.

### 17.1 Tenant isolation

#### XC-TEN-001 — 🔴 Hospital A cannot reach Hospital B, holding a valid Hospital A login

**Criticality:** C0 · **Priority:** P0 · **Runbook:** TEN-01

**Steps** — sign in to **`district`**. Search for a `sunrise` patient by name and by UHID. Then take
`sunrise`'s patient id, encounter id, prescription id, order id, report id and invoice id, and call
each directly at the API with the district session.

**Expected Result** — **nothing is found and nothing is served.** Separate databases entirely
(ADR-0005). Cross-tenant identity refusals answer **`HMS-TEN-003`**.

**Concern** — **any leak is a P0. Stop the campaign and report immediately.**

**Automation Coverage**

- Integration: `✅ — apps/api/src/tenancy.int.test.ts` §"TENANT ISOLATION — the property the whole
  platform rests on"; `apps/api/src/auth.int.test.ts` §"TENANT ISOLATION of identity"; plus per-module
  cross-tenant blocks in `mar.int.test.ts` ("another hospital's dose is unreachable"),
  `push.int.test.ts` ("one hospital cannot reach another's phones"), `emergency.int.test.ts`,
  `theatres.int.test.ts`, `idempotency.int.test.ts` ("a key belongs to one hospital and one user"),
  `auditPlugin.int.test.ts` ("the trail belongs to one hospital and one branch"), and
  `apps/api/src/patients.int.test.ts` §6 — with the SAME person registered in both hospitals, each
  one's duplicate check offers only its own chart. The positive control runs **first**, on purpose:
  "no candidates came back" from a hospital holding no patients is a test that passes on an empty
  database.
- Manual: **⬜ Not Tested**

---

#### XC-TEN-002 — The address is the tenant, and a wrong address says so before a password is typed

**Criticality:** C1 · **Priority:** P0 · **Runbook:** WEB-02 — **DECIDED 2026-08-18; the product was changed to match the runbook**

**Steps** — browse a slug that does not exist. Then browse a **real** hospital while the API is
restarting.

**Expected Result** — the unknown slug says _"This address does not belong to any hospital"_ **on
load**, before a password is submitted. The real hospital, mid-restart, is **never** told it does not
exist.

> **Why the product changed.** `BrandingProvider` calls the public `GET /site` on every page load, and
> on an unknown host that returns exactly `HMS-TEN-001`. The provider caught it and set
> `loaded: true` — so **the only way to learn you were at the wrong address was to type your real
> password into a host that is not your hospital's.** The fix publishes one flag, `hostIsUnknown`, and
> is deliberately narrow: **`HMS-TEN-001` only**, so a network blip cannot accuse a working hospital
> of not existing.

**Automation Coverage**

- Integration: `✅ — apps/api/src/tenancy.int.test.ts` §"host → tenant resolution"; `apps/api/src/registryCache.int.test.ts` (an unknown host is remembered, and the absence is forgotten the instant the hospital is born)
- E2E: `✅ — e2e/auth.spec.ts` — the positive **and** the negative ("does not accuse a real hospital's address of being wrong"). Falsified.
- Manual: **⬜ Not Tested**

---

### 17.2 Branch isolation

#### XC-BRN-001 — A → B → A, and nothing of the previous site survives

**Criticality:** C0 · **Priority:** P0 · **Runbook:** BR-01, BR-02, BR-08, WEB-20, M2-11, M2-12, M3-34

**Steps** — note the ward list, the round and a chart at A. Switch to B **without leaving the screen**.
Switch back. Then reload the page.

**Expected Result** — the ward becomes **Annexe Ward** with B's patients; the round shows B's doses.
**No row, name, bed or dose from A survives anywhere on screen.** Coming back re-reads A's ward — not
a cached frame and not a merge of both. On web the routed subtree is **keyed on the branch scope** so
it is discarded and reloaded; on mobile the query cache is cleared. **The choice outlives a reload.**

**Concern** — _header says one site, data is another's_ is the original defect this whole design
exists to prevent.

**Automation Coverage**

- Integration: `✅ — apps/api/src/branchIsolation.int.test.ts` (33 blocks; this is the largest suite in the repository)
- Web: `✅ — apps/web/__tests__/branchScope.test.ts`, `branchScope.render.test.tsx`, `medicationRound.test.tsx` §12
- Mobile: `✅ — apps/mobile/__tests__/branch.test.ts` §8, `hardening.test.ts` §1, `doctor.test.ts` §6, `ipd.test.ts` §13
- E2E: `✅ — e2e/branchSwitch.spec.ts` — falsified: removing `BranchScope`'s subtree key turns it red with _"beds from Main Branch survived a switch to apollo golconda"_
- Manual: **⬜ Not Tested**

---

#### XC-BRN-002 — What is deliberately hospital-wide — read this before filing anything

**Criticality:** C1 · **Priority:** P1 · **Runbook:** §11.1

| Data                                    | Scope                                     | Why                                           |
| --------------------------------------- | ----------------------------------------- | --------------------------------------------- |
| Encounters, admissions, ward lists      | **Branch**                                | A stay happens at a site                      |
| Medication schedule and administrations | **Branch**                                | A dose is given at a site                     |
| Nursing notes, vitals                   | **Branch** (vitals fixed `bdc027f`)       | Was the D1 exposure                           |
| Report **files**                        | **Branch** (fixed `c02dd09`)              | Was the D10 exposure → DOC-RES-003            |
| Appointment **transitions**             | **Branch** (fixed `4732dd8`)              | Was the D9 cross-branch WRITE → FD-APT-004    |
| Patient **identity lookup**             | **Hospital-wide, deliberate**             | A name is not site-specific                   |
| **Allergies**                           | **Hospital-wide, deliberate**             | _An allergy does not stop at a site boundary_ |
| **Wallet balance and receipts**         | **Hospital-wide, deliberate**             | One advance purse per patient → FD-PAY-003    |
| **Alert inbox**                         | **Person, not branch**                    | A message is addressed to a person            |
| Lab test catalogue, service tariff      | **Tenant-wide**                           | One definition per hospital                   |
| **General store balance**               | **Branch**                                | A store is a room, and the room is at a site  |
| **Pharmacy stock**                      | **Hospital-wide** — open product decision | See PHR-SEC-001                               |

**On the patient TREND view, a reading taken at the other site must still appear** — that read is
hospital-wide on purpose (`forPatientAcrossBranches`). **Losing it is the D1 fix over-applied, and is
its own defect.**

**Automation Coverage** — Integration: `✅ — apps/api/src/branchIsolation.int.test.ts` §"vitals reads
stop at the branch the visit belongs to (D1)", §24, §"a tenant-wide catalogue survives having a branch
selected", `scopedReads.test.ts` (guards that the inbox stays unscoped). Manual: **⬜ Not Tested**

---

#### XC-BRN-003 — An unknown `X-Active-Branch` is IGNORED, and that is the design

**Criticality:** C3 · **Priority:** P3 · **Runbook:** BR-09, NEG-14 · **risk-register D4 — 🔵 NOT A DEFECT**

**Steps** — send garbage, a valid-but-not-a-branch ObjectId, and another tenant's branch id.

**Expected Result** — all return `200` scoped to the caller's **own** binding (on the validation ward,
`total=45` across all sites rather than 42 at branch A). **The header is silently ignored — it cannot
exceed the caller's binding.** ADR-0015 chose fail-safe-to-own-scope and tests pin it.

**Classification** — **confirm the DESIGN. Record; do not re-report.** The UX wart — one site's name
over aggregate data — is a product decision.

**Automation Coverage** — Integration: `✅ — apps/api/src/branchIsolation.int.test.ts`;
`apps/api/src/mobileContract.int.test.ts` §"a phone cannot reach across a branch, whatever it sends".
Manual: **⬜ Not Tested**

---

#### XC-BRN-004 — A branch-stamping write is not offered until a site is chosen

**Criticality:** C3 · **Priority:** P2 · **Regression check for risk-register D19 (fixed 2026-08-19)**

**Steps** — sign in as an administrator reachable at several sites and **choose nothing**. Open
`/theatres`, `/emergency`, `/inventory`.

**Expected Result** — the switcher says **"All branches"** without having been told to, and the
branch-stamping controls ("Book a procedure", "Dispatch", "Issue") are **disabled with a reason**.
**And the server still answers `HMS-BRANCH-001` if one is attempted anyway** — a fix that disabled the
button and relaxed the server would be worse than the defect.

**Automation Coverage**

- Web: `✅ — apps/web/__tests__/branchScope.test.ts` §"must the user choose a site before a branch-stamping write", `generalStore.test.tsx`, `emergencyBoard.test.tsx`
- E2E: `✅ — e2e/branchSwitch.spec.ts` (both halves, in one test)
- Manual: **⬜ Not Tested**

---

#### XC-BRN-005 — Switching branch mid-workflow does not complete against the old one

**Criticality:** C0 · **Priority:** P0 · **Runbook:** NEG-09 — _"the most likely place for a real cross-branch write"_

**Steps** — open a dose confirmation at branch A. **Switch branch.** Then confirm.

**Expected Result** — the action does **not** complete against the old branch under the new branch's
header.

**Automation Coverage** — Web: `✅ — apps/web/__tests__/medicationRound.test.tsx` §12; Mobile:
`✅ — apps/mobile/__tests__/hardening.test.ts` §1. Integration: `✅ — branchIsolation.int.test.ts`.
**E2E: `❌`.** Manual: **⬜ Not Tested**

---

### 17.3 RBAC — refusal at the API, not concealment in the UI

#### XC-RBAC-001 — Every protected route has an owner, and every permission has a holder

**Criticality:** C0 · **Priority:** P0 · **Runbook:** §15, PERM-01…PERM-10

**Steps** — run `pnpm --filter @medicore/api routes`. For each protected route, confirm the permission
is one a role actually holds. Then, per §15.3's `curl` template, probe the eleven refusals in the
matrix.

**Expected Result** — **`403 HMS-AUTH-005`** for a permission the role lacks. **`404 HMS-GEN-404`** for
a resource outside the caller's scope — deliberately, because a 403 would confirm the record exists.
**`403 HMS-PLAN-002`** for a module the hospital did not buy.

> **A hidden button is not evidence; a `403` is.** Where a UI check is also listed it is a second,
> weaker observation. **Node's `fetch` (undici) forbids setting a `Host` header** — if you script this
> in Node rather than `curl`, use the tenant **subdomain in the URL**, or you will get a 404 and think
> the route is missing.

**Automation Coverage**

- Integration: `✅ — apps/api/src/rbac.int.test.ts` — five blocks, and the route-coverage block is a
  **release gate**: a new protected route that ships without a probe fails the build.
- Unit: `✅ — apps/api/src/permissionLifecycle.test.ts`, `apps/api/src/deploymentGate.test.ts`
- **Coverage:** the matrix sweeps **thirteen of the fourteen** catalogue roles — every operational
  role the product ships. `PATIENT` is excluded with a written reason and a guard of its own (§20.3).
  Two further guards now hold the ROLE side of the suite the way the route side was already held: a
  new role must be swept or excluded, and an excluded role must hold **no permission that gates a
  tenant route**.
- Manual: **⬜ Not Tested**

---

#### XC-RBAC-002 — Every denial's UI shape is an explanation

**Criticality:** C3 · **Priority:** P2 · **Runbook:** PERM-08

**Expected Result** — an explanation, **not a dead button and not a raw error**. A bare greyed-out
control with no reason is a defect (M2-34). A `403` must **never** bounce the user to the login screen.

**Automation Coverage** — Mobile: `✅ — apps/mobile/__tests__/errors.test.ts` §12, `doctor.test.ts` §14,
`writes.test.ts` §26. Web: `❌`. E2E: `❌`. Manual: **⬜ Not Tested**

---

### 17.4 Patient identity across the whole journey

#### XC-ID-001 — One patient, one identity, from the front desk to the bill

**Criticality:** C0 · **Priority:** P0 · **Runbook:** JR-22

**Steps** — after the OPD journey (§18.1), re-open the patient.

**Expected Result** — **one patient, one episode, both encounters, the whole story in order.** The
same name and UHID on the register, the queue, the chart, the ward row, the medication-round row, the
confirmation screen, the report, the invoice and the receipt.

**Concern** — **if the journey reads as two unrelated patients, FD-REG-004 or FD-VIS-002 failed and
nobody noticed.**

**Automation Coverage** — Integration: `✅ — apps/api/src/encounters.int.test.ts` §"the episode of care
is the care story", §8. Web: `✅ — queueIdentity.test.tsx`, `wardIdentity.test.tsx`. E2E:
`✅ — e2e/clinicalSafety.spec.ts`. Manual: **⬜ Not Tested**

---

### 17.5 Idempotency

#### XC-IDM-001 — A retry replays; it never repeats

**Criticality:** C0 · **Priority:** P0 · **Runbook:** LR-02, LR-03, NEG-12, NEG-13, DUP-01, DUP-02

**The three 409s mean different things and must not be collapsed:**

| Code          | Means                                 | Where                             |
| ------------- | ------------------------------------- | --------------------------------- |
| `HMS-MAR-001` | **Someone** already charted this slot | Database uniqueness · NUR-MAR-005 |
| `HMS-REQ-002` | **Same key, different body**          | Idempotency store · NUR-MAR-009   |
| `HMS-REQ-004` | **Same key, still in flight**         | 60 s claim timeout                |

**Expected Result** — a double-click produces `409 HMS-REQ-004` **or** one clean result — **never two
records.** A key is scoped to `tenant + user + key`, has a 24 h TTL, and is **spent in the branch that
spent it**. A key is _a promise about success, not a lock on the endpoint_.

**Automation Coverage**

- Integration: `✅ — apps/api/src/idempotency.int.test.ts` (all seven blocks); `branchIsolation.int.test.ts` §"an idempotency key is spent in the branch that spent it"
- Unit: `✅ — apps/api/src/core/idempotency/fingerprint.test.ts`
- Mobile: `✅ — apps/mobile/__tests__/errors.test.ts` §13, §15; `writes.test.ts` §8
- Web: `✅ — apps/web/__tests__/chartNote.test.tsx` §3, `confirmDialog.test.tsx`
- Manual: **⬜ Not Tested**

---

### 17.6 State transitions

#### XC-STA-001 — Every state machine refuses its illegal edges

**Criticality:** C1 · **Priority:** P0

Walk each and attempt one illegal edge on each. All are catalogued in
`AI_Workflow/docs/STATE_MACHINE_CATALOG.md`.

| Object              | States                                                                                                                    | Covered by                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **Encounter**       | `planned · arrived · in_queue · in_progress · awaiting_results · closed · cancelled · left_without_being_seen · admitted` | `encounters.int.test.ts` §"the encounter state machine"          |
| **Order**           | `placed · accepted · in_progress · completed · verified · released · cancelled`                                           | `orders.int.test.ts` §"the order state machine"                  |
| **Appointment**     | requested → confirmed → checked-in → started → completed (+ cancel, no-show, reschedule)                                  | `appointments.int.test.ts` §"lifecycle"                          |
| **Prescription**    | draft → signed (→ amended / cancelled / discarded); dispenses append-only                                                 | `prescriptions.int.test.ts`                                      |
| **Invoice**         | draft → finalized → paid (+ discount, refund, payer split)                                                                | `billing.int.test.ts`                                            |
| **OT booking**      | scheduled → started → completed / cancelled                                                                               | `theatres.int.test.ts` §"a booking moves only along legal edges" |
| **ED**              | arrived → in_progress → closed (disposition)                                                                              | `emergency.int.test.ts`                                          |
| **Ambulance trip**  | transitions exist as routes                                                                                               | **`⚠️ rbac probe only`**                                         |
| **Insurance claim** | transitions exist as routes                                                                                               | **`⚠️ rbac probe only`**                                         |

**Automation Coverage** — **roll-up.** Each row names the suite that owns it; the two `⚠️` rows are
real gaps and appear in §19. Unit: `N/A` · Integration: `✅` (per the table) · E2E: `⚠️ partial` ·
Mobile: `N/A`

**Manual:** **⬜ Not Tested**

---

### 17.7 Financial integrity

#### XC-FIN-001 — Charges, payments and dispensing stay consistent

**Criticality:** C0 · **Priority:** P0

**Expected Result** — the sum of charges equals the invoice; the sum of payments plus wallet
settlements equals what was collected; **`dispensedQty` equals what was charged**; a cancelled order
leaves no charge; a voided charge leaves an audit entry. Bed-days count **calendar days started, in
the branch's zone** (DOC-ADM-004).

**Automation Coverage** — Integration: `✅ — apps/api/src/billing.int.test.ts` (ten blocks),
`prescriptions.int.test.ts`, `admissions.int.test.ts`. E2E: `✅ — e2e/pharmacyDispensing.spec.ts`
("charges for what was handed over"). Manual: **⬜ Not Tested**

---

### 17.8 Clinical safety — the four wrongs, tested explicitly

#### XC-SAF-001 — Wrong patient · wrong medicine · wrong result · wrong branch

**Criticality:** C0 · **Priority:** P0

| The wrong     | The control                                                                                | Scenario                 |
| ------------- | ------------------------------------------------------------------------------------------ | ------------------------ |
| **patient**   | Name **and** UHID on every administering surface, resolved server-side                     | NUR-MAR-002, NUR-WRK-003 |
| **medicine**  | The drug name from the **signed line**; allergy screening at signing                       | NUR-MAR-002, DOC-RX-002  |
| **dose slot** | `prescriptionId + lineIndex + scheduledFor` as identity; the client may not declare a slot | NUR-MAR-007, NUR-MAR-008 |
| **result**    | Nothing is visible until `released`; category authority on who may sign                    | DOC-RES-001, LAB-VER-001 |
| **branch**    | Row scope answers `404`, both on read and on write                                         | XC-BRN-001, DOC-SEC-002  |
| **twice**     | A unique index, not an `if`; `409` as an **answer**, never a retry                         | NUR-MAR-005, NUR-MAR-006 |
| **nothing**   | A refusal leaves nothing to reconcile — every DRIFT row's real point                       | NUR-MAR-012, FD-VIS-006  |

**Automation Coverage** — **roll-up over the scenarios named.** Unit: `✅` · Integration: `✅` ·
E2E: `✅` · Mobile: `✅` — every row above resolves to a suite listed in its own scenario. This entry
exists so the seven wrongs are checked as a set, not because it adds a layer.

**Manual:** **⬜ Not Tested**

---

### 17.9 The network matrix

#### XC-NET-001 … XC-NET-009 — Runbook NET-01 … NET-09, unchanged

**Criticality:** C1 · **Priority:** P1

| ID         | Scenario                       | Mandatory?                  | Expected                                                                                                                     | Manual        |
| ---------- | ------------------------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------- |
| **NET-01** | Normal wifi                    | **Mandatory**               | Baseline for everything else                                                                                                 | ⬜ Not Tested |
| **NET-02** | Airplane mode, read screen     | **Mandatory**               | An explained offline state with retry — never a blank page                                                                   | ⬜ Not Tested |
| **NET-03** | Airplane mode, write screen    | **Mandatory**               | Save disabled **with a reason**; nothing claims success                                                                      | ⬜ Not Tested |
| **NET-04** | Server unreachable, network up | **Mandatory**               | _"Cannot reach the hospital's system"_, **not** "no internet" — these are genuinely different and the app distinguishes them | ⬜ Not Tested |
| **NET-05** | Interrupted mid-flight         | **Mandatory**               | Reconciliation, never a blind retry → NUR-MAR-009                                                                            | ⬜ Not Tested |
| **NET-06** | Slow network (3G)              | **Mandatory**               | Loading states appear **and resolve**; no screen sits blank                                                                  | ⬜ Not Tested |
| **NET-07** | Reconnect                      | **Mandatory**               | Queries refetch on reconnect **without** a manual pull                                                                       | ⬜ Not Tested |
| **NET-08** | **Cellular handover**          | Optional but **do it once** | The only one that tests a genuine radio transition. **Not automatable at any layer.**                                        | ⬜ Not Tested |
| **NET-09** | Backgrounded during save       | Optional                    | The mutation completes → LR-06                                                                                               | ⬜ Not Tested |

**Automation Coverage** — Mobile: `✅ — apps/mobile/__tests__/errors.test.ts` §14 ("a transport failure
is not an API failure"), `foundation.test.ts`, `session.test.ts`. **NET-08 is `N/A` at every layer:
a mocked failure is a decision; a lost packet is an accident, and only the second tests
reconciliation honestly.**

---

### 17.10 Session and authentication

#### XC-AUTH-001 — Sign-in, refresh, theft detection, and the session that ends mid-write

**Criticality:** C0 · **Priority:** P0 · **Runbook:** M2-01…M2-09, WEB-01, WEB-24, NEG-10

**Steps** — sign in; leave the session past the access token's 15 minutes and act; rotate a refresh
token once and then **replay the old one**; revoke the session server-side while a consultation is
open and save; sign out and press back; sign out with airplane mode on; try a wrong password, an
unknown email and a disabled account.

**Expected Result**

- Refresh is invisible; three concurrent 401s cause **exactly one** refresh.
- **Replaying a rotated refresh token destroys the whole session family** — for the thief _and_ the
  real user.
- A session revoked mid-write produces an **explicit "session ended"** and a route to sign-in.
  **Typed text must not vanish without warning.**
- Back after logout lands on sign-in; **a reachable chart after logout is a P1.**
- Offline logout completes locally in ~3 s — **this one fails silently if the timeout regresses.**
- **Wrong password, unknown email and a disabled account are indistinguishable.** Login is not a way
  to discover who has an account here. A wrong password **keeps the email you typed**.

**Automation Coverage**

- Integration: `✅ — apps/api/src/auth.int.test.ts` (eight blocks: login, tenant isolation of
  identity, refresh rotation and reuse detection per ADR-0009, the authenticate middleware, logout and
  session management, password policy, brute-force lockout, MFA)
- Mobile: `✅ — apps/mobile/__tests__/session.test.ts`, `hardening.test.ts` §3, §4
- Web: `✅ — apps/web/__tests__/sessionEnd.test.tsx`, `middleware.test.ts`
- E2E: `✅ — e2e/auth.spec.ts`
- Manual: **⬜ Not Tested**

---

### 17.11 Notifications and staff push (M4)

#### XC-NOT-001 — The message reaches the person, once per cause

**Criticality:** C1 · **Priority:** P1

**Expected Result** — one message per cause, enforced by a lease (`dedupeKey` unique per tenant). A
patient with no email is **a data problem, not an outage**. **The hospital owns the words** (editable
templates). The ledger is the answer to _"did they get it?"_. Booking an appointment actually
**schedules** the reminder — asserted on the **queued job**, not on a call.

> **A four-month-old defect this rule caught: no appointment reminder had ever been scheduled.** BullMQ
> builds keys as `bull:<queue>:<jobId>` and **rejects a custom id containing a colon**;
> `reminder:{tenantId}:{appointmentId}` therefore made `add()` reject on every booking since the
> notification module shipped. It failed inside an awaited call in a consumer, so it surfaced as an
> ordinary job retry and **nothing said so.** `scheduleTask` now refuses a colon up front.

**Automation Coverage**

- Unit: `✅ — apps/api/src/taskQueue.test.ts` (the colon guard), `apps/api/src/pushCopy.test.ts`
- Integration: `✅ — apps/api/src/notifications.int.test.ts` (ten blocks, including §"booking actually
  SCHEDULES the reminder — asserted on the queue, not on a call")
- Manual: **⬜ Not Tested**

---

#### XC-NOT-002 — Critical alerts and routine alerts use different Android channels

**Criticality:** C1 · **Priority:** P1 · **Checklist:** M4-10 · **K4-01, fixed 2026-08-20**

**Expected Result** — two channels: **`critical` at HIGH importance** and **`default` at DEFAULT**,
both created by the app **before any token is minted**, and **every push names one**. A routine
released result must **not** interrupt the way a critical one does.

> **Why the ids live in `@medicore/types`:** a server and an app that disagree on a channel id **lose
> the notification outright** — Android discards it and **Expo still returns an `ok` ticket**. That is
> the same silent-nothing family as the colon above.

**Automation Coverage**

- Unit: `✅ — apps/api/src/notificationChannels.test.ts` (includes a falsification that fails if both map to one channel)
- Integration: `✅ — apps/api/src/push.int.test.ts`
- Mobile: `✅ — apps/mobile/__tests__/push.test.ts` ("the app creates every push channel the server can address")
- Manual: **⬜ Not Tested** — _M4-10 is the one row that verifies it on hardware._

---

#### XC-NOT-003 … XC-NOT-020 — The eighteen device rows (M4-01 … M4-18)

**Criticality:** C1 · **Priority:** P1 · **Status: 🟡 BLOCKED — 0 of 18 performed.**

Preserved from [`MOBILE_M4_DEVICE_CHECKLIST.md`](../../AI_Workflow/docs/MOBILE_M4_DEVICE_CHECKLIST.md).

| Group             | IDs           | What it proves                                                                                                                                                                                                            |
| ----------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Registration**  | M4-01 … M4-05 | The permission prompt once; the handset registers; **declining changes nothing else**; sign-out/in does not double-register                                                                                               |
| **Delivery**      | M4-06 … M4-11 | Foreground, background, force-quit, **screen locked** — and the banner carries **no patient name, no test name, no value**; the routine/critical channel split; a ten-minute airplane gap delivers late rather than never |
| **The tap**       | M4-12 … M4-15 | Opens **that order**, including from a **cold start**; signed-out lands on login with the alert still in the inbox; an unopenable subject lands on Alerts, not a blank screen                                             |
| **The lifecycle** | M4-16 … M4-18 | Sign-out silences the handset; **the shared-phone case** (A's alert must not reach B); uninstall retires the token (`DeviceNotRegistered`)                                                                                |

**Blocking prerequisite — external, and it is the user's to clear:**

| #     | Prerequisite            | State                                                                                                                                                                                                                                                           |
| ----- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B4-01 | EAS project             | ✅ done — `@nasarj/medicore-staff`, recorded in `app.json`                                                                                                                                                                                                      |
| B4-04 | Firebase + FCM V1       | 🟡 half — project and Android app registered, `google-services.json` uploaded as an EAS file variable; **the service-account key still has to be uploaded via `eas credentials`**                                                                               |
| B4-02 | **A development build** | 🔴 **next** — `eas build --profile development --platform android`. **Expo Go has carried no remote push since SDK 53**, so all eighteen rows are unrunnable in it: the app mints no token and looks exactly like a handset whose user declined the permission. |
| B4-03 | Apple Developer Program | 🔴 external, optional — blocks 4 of the 18, not the other 14                                                                                                                                                                                                    |

**Automation Coverage** — Integration: `✅ — apps/api/src/push.int.test.ts` (drives the real service
against a loopback server speaking Expo's protocol: registration, reassignment on a shared handset,
release, ownership, tenant isolation, payload contents, priority, ticket errors,
`DeviceNotRegistered` retirement, partial batches, and the scheduling itself asserted on the queued
BullMQ job) · Unit: `✅ — apps/api/src/pushCopy.test.ts` · Mobile: `✅ — apps/mobile/__tests__/push.test.ts`.
**None of it can see** an OS permission dialog, a notification arriving, a banner's rendered text, a
lock screen, Doze, a cold-start tap, or an FCM token that Expo's sandbox accepts and production does
not. **Manual: ⬜ Not Tested (blocked).**

---

### 17.12 Page health — the refusal that draws a zero

#### XC-INT-001 — Every back-office page loads and is refused nothing it did not expect

**Criticality:** C1 · **Priority:** P1

**Steps** — load `/mrd`, `/mortuary`, `/theatres`, `/ambulance`, `/assets`, `/packages`, `/tariff`,
`/feedback`, `/audit`, `/subscription`, `/reports`, and the patient chart, watching the network.

**Expected Result** — **every request the page made came back, and none was refused unless the refusal
is declared with its reason.** The one declared refusal is `/mortuary` on `PLAN_HOSPITAL`
(`HMS-PLAN-002`), and it must read as **an explanation, not a blank register**.

> **This sweep found two live defects of one shape.** `/feedback` asked `GET /users?limit=200` and the
> patient chart asked `GET /orders?limit=200`; **the cap on every list is 100**, both were refused
> `HMS-VAL-001`, and both pages had a `catch` written for the _permission_ case which folded a
> validation error into ordinary emptiness. The visible symptoms were _every ticket's assignee shown
> as an unresolved id, never a name_ and **"Tests 0" on a patient holding three orders**. Neither is
> visible from below: the API is correct and its tests pass, and the jsdom suites mock `fetch` and
> never send the bad request.

**Automation Coverage** — E2E: `✅ — e2e/pageHealth.spec.ts` (falsified — reverting either `limit`
turns it red). Manual: **⬜ Not Tested**

---

#### XC-INT-002 — The seeded environment is proved before the browser opens

**Criticality:** C1 · **Priority:** P1

**Expected Result** — `e2e/preflight.setup.ts` checks over HTTP, in about a second, that the four demo
accounts sign in, the nurse can work in two open sites, **both sites have occupied beds and their bed
codes are disjoint**, doses are scheduled today, and the directory has people. Each failure names
`pnpm docker:dev && pnpm seed:migrate && pnpm seed:validation`.

> **Why the third check matters.** `branchSwitch.spec.ts` asserts no bed from site A survives a switch
> to site B — and **on a hospital whose second site is empty, that compares against nothing and passes
> for free.** The specs used to guard this with `test.skip(sites.length < 2)`, which **reports a
> missing environment as a PASS**. Every skip is now a hard assertion.

**Automation Coverage** — E2E: `✅ — e2e/preflight.setup.ts` (a setup project every other project
depends on; falsified twice). Manual: `N/A` — this is an environment gate, and ENV-04 is its manual
equivalent.

---

## 18. END-TO-END JOURNEYS

**A journey is not a sum of its scenarios.** Each row below is a **handoff** — the moment one role's
work has to become another role's input — and handoffs are where an integrated hospital system
actually fails. Run these **after** §17.3 (RBAC) and §3 (environment), and run each as **one
continuous patient**: here, and only here, a failure at one step legitimately blocks the next.

> **Run every journey at ONE branch.** A patient registered at branch B cannot be opened from branch
> A (FD-REG-008) — that is recorded technical debt, and walking a journey across two sites will
> produce a "failure" that is a known product decision.

### 18.1 OPD — the walk-in

| #   | Role        | Action                         | Expected handoff                                          | Scenario       | Unit | Int | E2E | Mobile |
| --- | ----------- | ------------------------------ | --------------------------------------------------------- | -------------- | :--: | :-: | :-: | :----: |
| 1   | Front Desk  | Search, then register          | UHID issued and visible                                   | FD-REG-001/002 | N/A  | ⚠️  | ⚠️  |  N/A   |
| 2   | Front Desk  | Register the same person again | **`409 HMS-PAT-002` naming the candidate**                | FD-REG-004     |  ❌  | ❌  | ❌  |  N/A   |
| 3   | Front Desk  | Start a visit                  | Token issued; **consultation charge raised by the event** | FD-VIS-001     | N/A  | ✅  | ⚠️  |  N/A   |
| 4   | Front Desk  | Start it again                 | **Same visit resumed — one row, one token**               | FD-VIS-002     |  ✅  | ✅  | ❌  |  N/A   |
| 5   | Front Desk  | Record vitals                  | Doctor meets a patient they already know something about  | FD-VIT-001     | N/A  | ✅  | ❌  |  N/A   |
| 6   | **Doctor**  | Call the token in, consult     | Note saved against **that** encounter; the queue advances | DOC-CON-001    | N/A  | ✅  | ❌  |   ✅   |
| 7   | **Doctor**  | Prescribe and sign             | Allergy presents as a **review step**                     | DOC-RX-002     |  ✅  | ✅  | ❌  |   ✅   |
| 8   | **Cashier** | Finalize and take payment      | Invoice totals everything; receipt available              | BIL-INV-001    | N/A  | ✅  | ❌  |  N/A   |
| 9   | **Doctor**  | Re-open the patient            | **One patient, one episode, the whole story in order**    | XC-ID-001      | N/A  | ✅  | ✅  |  N/A   |

**Manual status: ⬜ Not Tested (9 handoffs).**

### 18.2 Inpatient

| #   | Role    | Action                         | Expected handoff                                                     | Scenario                                | Int | E2E |
| --- | ------- | ------------------------------ | -------------------------------------------------------------------- | --------------------------------------- | :-: | :-: |
| 1   | Doctor  | Admit to a free bed            | **OP becomes `admitted`; an IP encounter opens in the same episode** | DOC-ADM-001                             | ✅  | ⚠️  |
| 2   | Doctor  | Admit a second patient to it   | **`409 HMS-STATE-001`**                                              | DOC-ADM-002                             | ✅  | ❌  |
| 3   | Nurse   | Move bed                       | Board updates; **tariff unchanged**                                  | NUR-BED-001                             | ✅  | ❌  |
| 4   | Nurse   | Vitals, note, dose on the stay | **All attach to the IP encounter, not the closed OP one**            | NUR-VIT-001 · NUR-NOT-001 · NUR-MAR-003 | ✅  | ✅  |
| 5   | Nurse   | The medication round           | Five rights on the confirmation                                      | NUR-MAR-002                             | ✅  | ✅  |
| 6   | Doctor  | Discharge with a summary       | Stay closes; bed frees on `/ward`                                    | DOC-DIS-001                             | ✅  | ❌  |
| 7   | Doctor  | A second summary               | **Refused — exactly one per admission**                              | DOC-DIS-001                             | ✅  | ❌  |
| 8   | Cashier | Bed-days on the bill           | **One charge per calendar day started, in the branch's zone**        | DOC-ADM-004                             | ✅  | ❌  |

**Manual status: ⬜ Not Tested (8 handoffs).**

### 18.3 Emergency

| #   | Role       | Action                               | Expected handoff                                              | Scenario    | Int | E2E |
| --- | ---------- | ------------------------------------ | ------------------------------------------------------------- | ----------- | :-: | :-: |
| 1   | Front Desk | Arrival with the ED checkbox         | On the board **within a minute, untriaged**                   | EMG-ARR-001 | ✅  | ✅  |
| 2   | Nurse      | Triage, then re-triage               | **Untriaged sorts above critical**; re-triage is a revision   | EMG-TRI-001 | ✅  | ✅  |
| 3   | Nurse      | Send to doctor                       | **The board names the doctor**                                | EMG-WRK-001 | ✅  | ✅  |
| 4   | Doctor     | Work up on ordinary screens          | **An ED imaging order lands on the ORDINARY bench**           | EMG-WRK-001 | ✅  | ✅  |
| 5   | Doctor     | Disposition                          | Discharge / admit / transfer-out **takes them off the board** | EMG-DIS-001 | ✅  | ✅  |
| 6   | —          | Retry a write on the closed ED visit | **Both refused** (D14 regression)                             | EMG-STA-001 | ✅  | ❌  |

**Manual status: ⬜ Not Tested (6 handoffs).** _The best-covered journey in the product — five of six
handoffs are proven in a browser._

### 18.4 Pharmacy

| #   | Role       | Action                  | Expected handoff                                           | Scenario                  | Int | E2E |
| --- | ---------- | ----------------------- | ---------------------------------------------------------- | ------------------------- | :-: | :-: |
| 1   | Doctor     | Prescribe, seeing stock | **Out-of-stock is still prescribable**                     | DOC-RX-001                | ✅  | ✅  |
| 2   | Doctor     | Sign                    | It reaches the counter's queue                             | PHR-DIS-001               | ✅  | ✅  |
| 3   | Pharmacist | Hand over 12 of 20      | `12/20 given · 8 still owed`; **FEFO picks the lot**       | PHR-DIS-002 · PHR-STK-001 | ✅  | ✅  |
| 4   | Pharmacist | Double-click dispense   | **One row; `200 duplicate:true`, not a 409**               | PHR-DIS-003               | ✅  | ❌  |
| 5   | Billing    | The charge              | **Follows the 12, not the 20** — and arrives shortly after | PHR-DIS-002               | ✅  | ✅  |
| 6   | Doctor     | The chart afterwards    | Reads `12/20 given`                                        | PHR-DIS-002               | ✅  | ✅  |

**Manual status: ⬜ Not Tested (6 handoffs).**

### 18.5 Laboratory

| #   | Role        | Action                    | Expected handoff                                  | Scenario    | Int | E2E |
| --- | ----------- | ------------------------- | ------------------------------------------------- | ----------- | :-: | :-: |
| 1   | Doctor      | Order a test              | Charge raised; **on the bench, named and UHID'd** | DOC-ORD-001 | ✅  | ✅  |
| 2   | Cashier     | Collect                   | **The payment badge on the bench clears**         | FD-PAY-002  | ✅  | ✅  |
| 3   | Lab tech    | Accept → start → complete | Legal edges only                                  | LAB-STA-001 | ✅  | ✅  |
| 4   | Lab tech    | Attempt to verify         | **`403` — the runner may not certify**            | LAB-VER-001 | ✅  | ⚠️  |
| 5   | Pathologist | Verify → release          | **Only now does the doctor see values**           | DOC-RES-001 | ✅  | ✅  |
| 6   | Doctor      | The bell                  | Critical alerted immediately; read state persists | DOC-RES-002 | ✅  | ✅  |

**Manual status: ⬜ Not Tested (6 handoffs).**

### 18.6 Radiology

| #   | Role          | Action                               | Expected handoff                                    | Scenario    | Int | E2E |
| --- | ------------- | ------------------------------------ | --------------------------------------------------- | ----------- | :-: | :-: |
| 1   | Doctor        | Order a study                        | On the **imaging** bench — the same worklist object | DOC-ORD-001 | ✅  | ✅  |
| 2   | Radiographer  | Accept → start                       | The imaging console, **not the lab's analyte grid** | RAD-WRK-001 | ✅  | ✅  |
| 3   | Radiographer  | Findings + impression, film attached | A narrative report through the reports module       | RAD-WRK-001 | ✅  | ✅  |
| 4   | Radiographer  | Verify → release                     | **No radiologist required** (`radiology:sign`)      | RAD-WRK-001 | ✅  | ✅  |
| 5   | Doctor        | Read it on the chart                 | The report is there                                 | RAD-WRK-001 | ✅  | ✅  |
| 6   | Branch-B user | Request the file by id               | **`404` — and no PDF bytes** (D10 regression)       | DOC-RES-003 | ✅  | ❌  |

**Manual status: ⬜ Not Tested (6 handoffs).**

### 18.7 Theatre

| #   | Role   | Action                          | Expected handoff                                          | Scenario   | Int | E2E |
| --- | ------ | ------------------------------- | --------------------------------------------------------- | ---------- | :-: | :-: |
| 1   | Admin  | Add a theatre                   | It appears in the registry (**`seed:demo` creates none**) | OT-REG-001 | ✅  | ✅  |
| 2   | Nurse  | Book a window                   | On the OT list                                            | OT-BOK-001 | ✅  | ✅  |
| 3   | Nurse  | Book an overlap                 | **Refused in the browser, form preserved**                | OT-BOK-001 | ✅  | ✅  |
| 4   | Nurse  | Book back-to-back               | **Accepted — half-open intervals**                        | OT-BOK-001 | ✅  | ✅  |
| 5   | Nurse  | Start, then complete            | Legal edges only                                          | OT-STA-001 | ✅  | ✅  |
| 6   | Doctor | Write the operative note        | **Write-once; refused on a `scheduled` booking**          | OT-STA-001 | ✅  | ✅  |
| 7   | Doctor | Close the visit, open the chart | **Procedures tab carries it, naming the surgeon**         | OT-CHT-001 | ✅  | ✅  |

**Manual status: ⬜ Not Tested (7 handoffs).**

---

## 19. COVERAGE SUMMARY

**Counts are of the 149 numbered scenarios in §3A–§17.** The 232 runbook IDs, the 107 mobile device
rows and the 9 network rows are re-homed _inside_ those scenarios and are counted separately in §21.
A layer is marked here only where the scenario's own Automation Coverage block names a real file.

### 19.1 By role

| Role                  | Scenarios | Unit | Integration |     E2E | Web (jsdom) | Mobile | Manual     |
| --------------------- | --------: | ---: | ----------: | ------: | ----------: | -----: | ---------- |
| **Front Desk**        |        25 |    6 |     23 +2⚠️ |  1 +3⚠️ |           3 |      1 | **25 ⬜**  |
| **Doctor**            |        26 |    6 |     24 +1⚠️ |  7 +2⚠️ |           7 |     16 | **26 ⬜**  |
| **Nurse**             |        20 |    3 |          17 |       4 |          12 |     14 | **20 ⬜**  |
| **Laboratory**        |         6 |    0 |           6 |  3 +1⚠️ |           2 |      1 | **6 ⬜**   |
| **Radiology**         |         3 |    0 |           3 |       2 |           2 |      0 | **3 ⬜**   |
| **Pharmacy**          |         7 |    0 |           7 |       4 |           1 |      0 | **7 ⬜**   |
| **General Stores**    |         4 |    0 |           4 |       3 |           2 |      0 | **4 ⬜**   |
| **Emergency**         |         6 |    0 |           6 |       5 |           3 |      0 | **6 ⬜**   |
| **Theatre**           |         5 |    0 |           5 |       5 |           3 |      0 | **5 ⬜**   |
| **Billing / Finance** |        10 |    1 |      9 +1⚠️ |       3 |           1 |      0 | **10 ⬜**  |
| **Hospital Admin**    |        11 |    1 |          11 |  6 +1⚠️ |           3 |      2 | **11 ⬜**  |
| **Platform Operator** |         4 |    0 |           4 |       0 |           0 |      1 | **4 ⬜**   |
| **Auditor**           |         1 |    0 |           1 |       0 |           0 |      0 | **1 ⬜**   |
| **Cross-cutting**     |        21 |    6 |          16 |  9 +1⚠️ |           6 |      9 | **21 ⬜**  |
| **TOTAL**             |   **149** |   23 |    136 +4⚠️ | 52 +8⚠️ |          45 |     44 | **149 ⬜** |

**The shape of this table is the finding.** Integration coverage is deep and even; **Playwright
coverage is concentrated in the modules that were built last** (Emergency 5/6, Theatre 5/5, Radiology
2/3, Stores 3/4) and is thinnest exactly where the product is oldest and most used — **Front Desk
1 of 25, Laboratory 3 of 6, Billing 3 of 10.** The Operator column is 0 for E2E because the console
is a separate application with no browser suite at all.

### 19.2 By criticality

| Criticality | Scenarios | Automated at ≥1 layer | Needing manual validation | Gaps                             |
| ----------- | --------: | --------------------: | ------------------------: | -------------------------------- |
| **C0**      |        65 |                    65 |                        65 | **0 — closed 2026-08-22**        |
| **C1**      |        65 |                    64 |                        65 | **0 with none · 1 partial only** |
| **C2**      |        16 |                    16 |                        16 | 0                                |
| **C3**      |         3 |                     3 |                         3 | 0                                |

### 19.3 By priority

| Priority | Scenarios | Automated at ≥1 layer | Needing manual validation |  Remaining automation gap |
| -------- | --------: | --------------------: | ------------------------: | ------------------------: |
| **P0**   |        85 |                    85 |                        85 | **0 — closed 2026-08-22** |
| **P1**   |        43 |                    43 |                        43 | **0 — closed 2026-08-22** |
| **P2**   |        20 |                    19 |                        20 |                     **1** |
| **P3**   |         1 |                     1 |                         1 |                         0 |

> **"Automated at ≥1 layer" is a blunt instrument, and §20 is the sharp one.** A scenario counts
> here as soon as any suite proves any _part_ of it. **Seven C0/P0 rows score as covered here and
> are still ranked as gaps in §20.1** — XC-BRN-005, FD-REG-001, XC-SAF-001, XC-ID-001, XC-FIN-001,
> DOC-CHT-003 and the residual half of FD-REG-002 — because the specific invariant each one is about
> has no owner. Read the two together: this table says how broad the net is, §20.1 says where the
> holes are, and only §20.1 is a work list.

**Every one of the 149 needs manual validation, and none has had it.** That column is not a
formality: `TESTING.md` §11b records that the first browser pass over an already-green product —
2,060 integration tests, 45 Playwright specs, 0 boundary violations — **found seven defects in one
sitting.** That ratio is the argument for this document.

---

## 20. IMPORTANT SCENARIOS WITHOUT AUTOMATED COVERAGE

The roadmap for whoever writes tests next, in the order to write them.

> **Five entries were closed on 2026-08-22** by the hardening pass recorded in §20.6 —
> FD-REG-002, FD-REG-004, FD-REG-005, FD-REG-006 and BIL-SEC-001. What remains is below.

### 20.1 C0 / P0 — write these first

Ranked. **Items 3, 4 and 5 are one spec, not three** — a single integration walk-through that carries
one patient through registration, the queue, the ward, the round and the bill, and then attempts each
refusal against that same patient. They are listed separately because they fail for different reasons
and would be reported against different modules.

| #   | Scenario        | Role              | What is actually missing                                                                                                                                                                                                                                                                                                                                      | Recommended layer                                                                                                              |
| --- | --------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **XC-BRN-005**  | any clinical role | Nothing **interleaves** the switch with an in-flight write. `medicationRound.test.tsx` §12 proves a switch clears the round; `hardening.test.ts` §1 proves the mobile cache clears; `branchIsolation.int.test.ts` proves the server refuses a foreign encounter. None opens a dose confirmation, switches, and then submits.                                  | Playwright (`e2e/branchSwitch.spec.ts`) **+** one integration case sending the new branch header at the old branch's encounter |
| 2   | **FD-REG-001**  | Front Desk        | `?q=` is exercised for scoping and for the merged filter, and **no test asserts that a search by name, by UHID and by phone each find the same person**. This is the step BEFORE the MPI: a clerk who cannot find the patient registers a new one.                                                                                                            | Integration, in the existing `apps/api/src/patients.int.test.ts`                                                               |
| 3   | **XC-SAF-001**  | Cross-cutting     | Every one of the seven wrongs resolves to a suite; **nothing checks them as a SET, on one patient, in one pass.** A real safety regression is one control silently not applying to a patient who crossed several modules — and per-module fixtures cannot see that.                                                                                           | Integration walk-through                                                                                                       |
| 4   | **XC-ID-001**   | Cross-cutting     | Identity is asserted per surface (`queueIdentity`, `wardIdentity`, `clinicalSafety`, the MPI suite). **No test carries one UHID through register → queue → ward → round → invoice.** D18 was exactly this shape: right everywhere except one join.                                                                                                            | The same walk-through                                                                                                          |
| 5   | **XC-FIN-001**  | Billing           | `billing.int.test.ts` owns each rule; **nothing reconciles one encounter's charges against its payments and its dispensed quantities** at the end.                                                                                                                                                                                                            | The same walk-through                                                                                                          |
| 6   | **DOC-CHT-003** | Doctor · Nurse    | The round ROW's allergy is covered in jsdom (`medicationRound.test.tsx` §10, screen-reader text included). **The chart and the ward row are not, and no browser test covers any of the three.** jsdom proves the component renders what it is handed; only a browser proves the page hands it the right thing — which is how both `limit=200` defects got in. | Playwright, extending `e2e/clinicalSafety.spec.ts`                                                                             |
| 7   | **FD-REG-002**  | Front Desk        | Issue and uniqueness are closed. **The UHID counter is never raced.** `nextUhid` is an atomic `$inc` inside the transaction, and its own comment says registration is deliberately serialized per hospital and holes in the sequence are unacceptable — neither half is checked.                                                                              | Integration, two parallel registrations                                                                                        |

**And one that no test will ever close:** **NUR-MAR-006**, the human half of two nurses on two
handsets. The server race IS proven — two real HTTP clients contend for the same dose in
`mar.int.test.ts`. What is missing needs two people and two phones, and it is listed in §20.5 so it
is not mistaken for a to-do.

### 20.2 C0 / P1 and C1 / P0

| Scenario       | What is missing                                                                                                                                                                               | Suggested home                      |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| **FD-REG-006** | Closed for the merge itself. **Still open: the `patient.patients.merged` event actually re-pointing billing and the other consumers** — the half that makes a merge mean anything downstream. | `apps/api/src/patients.int.test.ts` |
| **XC-STA-001** | **Ambulance trip** and **insurance claim** transitions have an RBAC probe and no functional test.                                                                                             | new module suites                   |
| **XC-NOT-003** | The eighteen M4 device rows are **blocked on an external build**, not on a missing test. See §20.5.                                                                                           | —                                   |

### 20.3 The RBAC sweep — CLOSED 2026-08-22

`rbac.int.test.ts` §"the matrix: role × route" now probes **every protected `/api/v1` route** against
**thirteen** roles: `TENANT_ADMIN · DOCTOR · NURSE · RECEPTIONIST · FRONT_OFFICE · CASHIER ·
PHARMACIST · STORE_KEEPER · LAB_TECHNICIAN · PATHOLOGIST · RADIOLOGY_TECHNICIAN · RADIOLOGIST ·
AUDITOR`. That is every operational role the product ships.

**`PATIENT` is deliberately excluded, with the reason written into the suite.** It is a portal
identity holding `self:manage` and `booking:public`, neither of which gates an `/api/v1` route, so
sweeping it would generate ~260 assertions all restating what the `noRole` baseline proves in one.
The risk it would have covered is covered directly instead: **"no excluded role can reach the staff
API at all"** fails the moment a tenant route is wired to a permission that identity holds.

**Two new guards hold the role side the way the route side was already held**, and both were
falsified: dropping `AUDITOR` from the sweep without excluding it fails
_"A role shipped without anyone deciding whether the matrix should probe it"_; moving `CASHIER` into
the exclusion list fails _"CASHIER is excluded from the matrix but holds a permission that gates a
tenant route"_, naming all eight.

**Cost:** 1,316 → 3,375 tests in that file, 23 s → 42 s. Most added probes are denials, which
short-circuit before touching Mongo.

### 20.4 Modules with an RBAC probe and no functional test

Each of these has routes, a screen, and a `pageHealth` load — **and nothing that exercises what it
does**:

| Module            | Routes | What exists                                     | What is missing                                                    |
| ----------------- | -----: | ----------------------------------------------- | ------------------------------------------------------------------ |
| **Insurance**     |      6 | `rbac.int.test.ts` probes                       | Policies, claim transitions, settlement, payer split               |
| **MRD / HIM**     |      6 | `rbac` + `auditPlugin` touches it               | ICD master, encounter coding, the disease register                 |
| **Mortuary**      |      4 | `rbac` + `pageHealth` (as a **plan refusal**)   | Receive into custody, release, **the medico-legal clearance rule** |
| **Ambulance**     |      6 | `rbac` + `pageHealth`                           | Dispatch, the trip state machine                                   |
| **Assets**        |      5 | `rbac` + `pageHealth`                           | Register, maintenance history                                      |
| **Feedback**      |      5 | `rbac` + `pageHealth` (**found a live defect**) | Log, assign, the ticket state machine                              |
| **Consents**      |      3 | `rbac` + `orders.int.test.ts` touches it        | Grant, withdraw                                                    |
| **Death records** |      2 | `rbac`                                          | Certification, and its link to the mortuary                        |
| **Reports**       |     13 | `rbac` + `e2e/reportsExport.spec.ts` (one CSV)  | The twelve other report queries                                    |

**Mortuary release is the one with a safety argument behind it** — release refuses a medico-legal
body without a police clearance, whoever holds the permission — and **nothing tests it.**

### 20.5 Genuinely not automatable — stated plainly, not quietly dropped

These were **never manually executed either**, so nothing is being lost. They are listed so a green
suite is not mistaken for coverage of them.

| Area                                                | Why no layer can reach it                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Biometrics** (M2-35…M2-47)                        | No enrolled fingerprint or Face ID exists in CI or a simulator. The lock's _logic_ is covered; the **OS prompt** is not. **And K4-02 means it is currently wired to nothing.**                                                                                                                                                                                                 |
| **A real radio** (NET-08, and one run of LR-01)     | A mocked failure is a decision; **a lost packet is an accident**, and only the second tests reconciliation honestly                                                                                                                                                                                                                                                            |
| **App-switcher snapshots, sunlight, largest text**  | Need eyes and a device (M2-46, M2-48, M2-51)                                                                                                                                                                                                                                                                                                                                   |
| **Two devices in two hands** (MAR-02 / NUR-MAR-006) | The concurrency invariant _is_ proven — two real HTTP clients race the same dose — but **two nurses reaching for the same drug is a human scenario, not a client one**                                                                                                                                                                                                         |
| **All eighteen M4 push rows**                       | An OS permission dialog, a banner, a lock screen, Doze, a cold-start tap, and a production APNs/FCM token. **Blocked on an external development build** — see XC-NOT-003                                                                                                                                                                                                       |
| **Writes on the back-office registers**             | `e2e/pageHealth.spec.ts` loads all eleven and **creates nothing**: driving a theatre booking or an ambulance dispatch through a browser would leave rows in the shared seeded hospital and make the suite's second run differ from its first. Those writes are proven at the integration layer instead — **except for the modules in §20.4, where they are not proven at all** |
| **A `PLAN_CLINIC` nav in a browser** (ADM-ENT-001)  | The only way to make one mid-run is an operator feature override; **a run that died between the override and its restore would poison every other spec.** Proved in jsdom against the real `EDITIONS` data instead                                                                                                                                                             |
| **The activity trail's CSV export**                 | `/reports` proves the same Blob-and-anchor path; a second browser test would re-prove the plumbing at a minute per run                                                                                                                                                                                                                                                         |

### 20.6 Hardening pass — 2026-08-22

The first pass against this document's own gap list, run before manual UAT rather than after it.
**Two gaps closed, both at the integration layer, no application behaviour changed.**

| What                                         | Where                                                                                                                                                                                                                  |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The MPI has a suite** — 31 tests, 6 groups | `apps/api/src/patients.int.test.ts` (new). Detection · the `HMS-PAT-002` refusal and its candidate payload · the threshold arithmetic · the `patient:merge` gate on `force` · merge · the branch and tenant boundaries |
| **The RBAC sweep covers every staff role**   | `apps/api/src/rbac.int.test.ts` — `ROLES_UNDER_TEST` 5 → 13, plus three guards on the role side of the suite                                                                                                           |

**Ten falsifications, every one red, every one restored.** The point of listing them is that a
derived matrix and a green new suite are both easy to write and easy to write vacuously:

| Protection removed                                             | Result                                                                               |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| The duplicate refusal itself (`if (blocking && !force) throw`) | 🔴 8 — three registrations that must 409 returned 201; the chart counts hit 3 and 4  |
| `DUPLICATE_THRESHOLD` 60 → 30                                  | 🔴 4 — the three deliberate near-misses started blocking                             |
| The `patient:merge` check on `force`                           | 🔴 3 — a receptionist minted a second chart                                          |
| `scopeFilter()` added to `findCandidates`                      | 🔴 3 — the other site registered a second UHID for the same human                    |
| `status: "active"` dropped from `findCandidates`               | 🔴 1 — an already-merged chart was offered back as a candidate                       |
| The merge chain guard (`survivor.status !== "active"`)         | 🔴 1 — A → B → C was accepted                                                        |
| AUDITOR seeded with CASHIER's grant                            | 🔴 **27** — 6 "was denied … but holds", 21 "reached … without". **Both directions.** |
| RADIOLOGY_TECHNICIAN widened with `emr:read`                   | 🔴 21 — the chart, the ward worklist and the medication round all opened             |
| AUDITOR dropped from the sweep without being excluded          | 🔴 the new role-coverage guard                                                       |
| CASHIER moved into the exclusion list                          | 🔴 the new exclusion guard, naming all eight permissions it holds that gate routes   |

**What this pass deliberately did not do:** implement the rest of §20. The remaining C0/P0 items are
a browser test and a walk-through, and the ranked list stands.

---

## 21. EXISTING MANUAL VALIDATION RUNBOOK — RECONCILIATION

### 21.1 The count

| Measure                                                                 |                                                                                                             Count |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------: |
| Distinct check IDs in `AI_Workflow/docs/MANUAL_VALIDATION_RUNBOOK.md`   |                                                                                                           **232** |
| Migrated into this plan                                                 |                                                                                                           **232** |
| Dropped, simplified away, or unmapped                                   |                                                                                                             **0** |
| Carrying automated coverage at ≥1 layer                                 |                                                                                                           **201** |
| Carrying **no** automated coverage at any layer                         |                                                                                                            **31** |
| **Still requiring manual validation**                                   |                                                                                                           **232** |
| Marked obsolete / Not Applicable                                        |                                           **0** — see §21.2 for the one obsolete _claim_, which is not a test row |
| **Amended** — the expectation inverted, or the disagreement was decided |                                                                                                            **11** |
| **Blocked today**                                                       | **1** (LIC-06) — plus **89 mobile rows that need hardware and eyes**, which is a prerequisite rather than a block |

**Verified mechanically**, not by eye: the ID set extracted from the runbook and the ID set in §21.3
are identical, 232 = 232, with no invented rows.

### 21.2 The eleven amended rows — read these before running them

Nine had their **expected result inverted** because the defect they documented has been fixed; two
were disagreements between the runbook and the implementation that have since been **decided in
opposite directions**, which is the point: neither _"the doc wins"_ nor _"the code wins"_ is a rule.

| Row        | Was                                                       | Now                                                                                                                                      |
| ---------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **BR-05**  | Expect a cross-branch vitals leak                         | ✅ D1 fixed `bdc027f` — **expect a refusal**, and check the patient trend still crosses sites                                            |
| **BR-07**  | **BLOCKED** — no branch-confined account exists           | Unblocked; proven by test, executed at the API by an agent. **Still unproven through a UI by a person**                                  |
| **BR-09**  | Known defect D4                                           | 🔵 **NOT A DEFECT** — ADR-0015's fail-safe-to-own-scope. Confirms the design                                                             |
| **BR-10**  | Expect a cross-branch PDF                                 | ✅ D10 fixed `c02dd09` — **regression check**                                                                                            |
| **BR-11**  | Expect a cross-branch write to succeed                    | ✅ D9 fixed `4732dd8` — **regression check**, and the re-read is what proves it                                                          |
| **TZ-08**  | _"Expected to be wrong"_ — register in `DEFAULT_TIMEZONE` | ✅ D2 fixed `8330faa` — **the register's day is the BRANCH's day**                                                                       |
| **TZ-09**  | _"Expected to be wrong"_ — bed-days one night out         | ✅ D3 fixed `1719360` — **regression check. Money**                                                                                      |
| **ENV-07** | _"Expo Go is sufficient"_ — asserted, never proven        | **Decided 2026-08-20: NOT sufficient for M4.** Expo Go has carried no remote push since SDK 53                                           |
| **ENV-06** | Switch `TENANT_BASE_DOMAIN` to an sslip domain            | Prefer `pnpm --filter @medicore/api dev:device-domains` — the production path, and the browser keeps working                             |
| **WEB-02** | _"the runbook and the code disagree"_                     | **DECIDED — the runbook was right and the PRODUCT WAS CHANGED.** The app already held the answer and discarded it                        |
| **WEB-04** | "Name + UHID on every row" of `/ward`                     | **AMENDED — the row was stricter than the §9 rule it cited. Product unchanged**; the requirement is now tested where it actually applies |

### 21.2b Two further stale claims in the source, found while writing this

Neither is a test row, and neither was silently dropped.

**1. The runbook's §15.1 role × operation matrix has two wrong cells today.** It says _"Record vitals
· `vitals:record` · NURSE ✅ · DOCTOR ✅ · RECEPTIONIST ❌"_. Read from
`packages/permissions/src/index.ts`, **`vitals:record` is held by `NURSE`, `RECEPTIONIST` and
`FRONT_OFFICE` — and NOT by `DOCTOR`.** Both cells moved for the same documented reason: the desk
measures the patient at registration (the weighing scale is next to the counter), and the doctor reads
what was measured rather than measuring it. **A tester working from the runbook's matrix would file a
correct `403` for a doctor as a permission bug, and would miss that the desk can write.** This plan
follows the implementation: FD-VIT-001 and NUR-SEC-001 are written from the catalogue, not from the
matrix. **PERM-06 (nurse records vitals) is unaffected and still correct.**

**2. `/insurance` is not a page.** §22.7 of the runbook lists it among the twelve pages with no manual
coverage. **There is no such page** — insurance is a tab on the patient chart. The eleven others in
that list are real and are covered by XC-INT-001.

### 21.3 The full mapping — all 232 rows

**Coverage marks describe the scenario the row now lives in.** `⚠️` means the layer exercises the
path without asserting this row's invariant. **Manual is `⬜ Not Tested` for every row, without
exception** — no row in the source document has ever been executed by a person, and this plan
inherits that fact rather than resetting it.

| Runbook check | What it is                                                                                                             | New home                                  | Unit | Integration | E2E | Mobile | Manual | Status                                                                                                                                                                                   |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | :--: | :---------: | :-: | :----: | :----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ENV-01**    | Infrastructure up                                                                                                      | `§3 ENV-01`                               | N/A  |     N/A     | N/A |  N/A   |   ⬜   | Migrated as a prerequisite gate                                                                                                                                                          |
| **ENV-02**    | Accounts and hospitals                                                                                                 | `§3 ENV-02 · §22.1`                       | N/A  |     N/A     | N/A |  N/A   |   ⬜   | Migrated; account table refreshed to 13 seeded logins                                                                                                                                    |
| **ENV-03**    | Schema convergence                                                                                                     | `§3 ENV-03`                               | N/A  |     ✅      | N/A |  N/A   |   ⬜   | Migrated as a hard gate; `schemaGuard.int.test.ts` §5 proves the checker                                                                                                                 |
| **ENV-04**    | Build and verify the ward                                                                                              | `§3 ENV-04`                               | N/A  |     ✅      | ✅  |  N/A   |   ⬜   | Migrated as THE gate; `e2e/preflight.setup.ts` is its automated cousin                                                                                                                   |
| **ENV-05**    | What the ward contains                                                                                                 | `§22.2`                                   | N/A  |     N/A     | N/A |  N/A   |   ⬜   | Migrated into Test Data Requirements                                                                                                                                                     |
| **ENV-06**    | Reaching the API from a handset                                                                                        | `§3 ENV-06`                               | N/A  |     N/A     | N/A |  N/A   |   ⬜   | Amended — prefer `dev:device-domains` over the TENANT_BASE_DOMAIN switch                                                                                                                 |
| **ENV-07**    | Expo Go or a development build                                                                                         | `§3 ENV-07 · XC-NOT-003`                  | N/A  |     N/A     | N/A |   ✅   |   ⬜   | **Amended — decided 2026-08-20.** Expo Go is NOT sufficient for M4 push (no remote push since SDK 53); a development build is required                                                   |
| **ENV-08**    | Devices and browsers                                                                                                   | `§22.3`                                   | N/A  |     N/A     | N/A |  N/A   |   ⬜   | Migrated into the device matrix                                                                                                                                                          |
| **M2-01**     | Login succeeds                                                                                                         | `§4.9 group A`                            | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated verbatim; 0/9 performed                                                                                                                                                         |
| **M2-02**     | Login fails safely                                                                                                     | `§4.9 group A`                            | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated verbatim; 0/9 performed                                                                                                                                                         |
| **M2-03**     | MFA                                                                                                                    | `§4.9 group A`                            | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated verbatim; 0/9 performed                                                                                                                                                         |
| **M2-04**     | Cold start, live session                                                                                               | `§4.9 group A`                            | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated verbatim; 0/9 performed                                                                                                                                                         |
| **M2-05**     | Cold start, dead session                                                                                               | `§4.9 group A`                            | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated verbatim; 0/9 performed                                                                                                                                                         |
| **M2-06**     | Token refresh mid-session                                                                                              | `§4.9 group A`                            | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated verbatim; 0/9 performed                                                                                                                                                         |
| **M2-07**     | Logout                                                                                                                 | `§4.9 group A`                            | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated verbatim; 0/9 performed                                                                                                                                                         |
| **M2-08**     | Offline logout                                                                                                         | `§4.9 group A`                            | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated verbatim; 0/9 performed                                                                                                                                                         |
| **M2-09**     | Session expiry mid-write                                                                                               | `§4.9 group A`                            | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated verbatim; 0/9 performed                                                                                                                                                         |
| **M2-10**     | Branch on arrival                                                                                                      | `§4.9 group B · XC-BRN-001`               | N/A  |     ✅      | ✅  |   ✅   |   ⬜   | Migrated verbatim; 0/6 performed                                                                                                                                                         |
| **M2-11**     | Switch A → B                                                                                                           | `§4.9 group B · XC-BRN-001`               | N/A  |     ✅      | ✅  |   ✅   |   ⬜   | Migrated verbatim; 0/6 performed                                                                                                                                                         |
| **M2-12**     | Switch back B → A                                                                                                      | `§4.9 group B · XC-BRN-001`               | N/A  |     ✅      | ✅  |   ✅   |   ⬜   | Migrated verbatim; 0/6 performed                                                                                                                                                         |
| **M2-13**     | Branch deactivated                                                                                                     | `§4.9 group B · XC-BRN-001`               | N/A  |     ✅      | ✅  |   ✅   |   ⬜   | Migrated verbatim; 0/6 performed                                                                                                                                                         |
| **M2-14**     | All-branches aggregate                                                                                                 | `§4.9 group B · XC-BRN-001`               | N/A  |     ✅      | ✅  |   ✅   |   ⬜   | Migrated verbatim; 0/6 performed                                                                                                                                                         |
| **M2-15**     | Cross-branch deep link                                                                                                 | `§4.9 group B · XC-BRN-001`               | N/A  |     ✅      | ✅  |   ✅   |   ⬜   | Migrated verbatim; 0/6 performed                                                                                                                                                         |
| **M2-16**     | Queue / patient list                                                                                                   | `§4.9 group C · DOC-CHT-001/002`          | N/A  |     ✅      | ⚠️  |   ✅   |   ⬜   | Migrated verbatim; 0/9 performed                                                                                                                                                         |
| **M2-17**     | Patient identity                                                                                                       | `§4.9 group C · DOC-CHT-001/002`          | N/A  |     ✅      | ⚠️  |   ✅   |   ⬜   | Migrated verbatim; 0/9 performed                                                                                                                                                         |
| **M2-18**     | Age is the hospital's                                                                                                  | `§4.9 group C · DOC-CHT-001/002`          | N/A  |     ✅      | ⚠️  |   ✅   |   ⬜   | Migrated verbatim; 0/9 performed                                                                                                                                                         |
| **M2-19**     | Vitals display                                                                                                         | `§4.9 group C · DOC-CHT-001/002`          | N/A  |     ✅      | ⚠️  |   ✅   |   ⬜   | Migrated verbatim; 0/9 performed                                                                                                                                                         |
| **M2-20**     | Unreleased result                                                                                                      | `§4.9 group C · DOC-CHT-001/002`          | N/A  |     ✅      | ⚠️  |   ✅   |   ⬜   | Migrated verbatim; 0/9 performed                                                                                                                                                         |
| **M2-21**     | Critical result                                                                                                        | `§4.9 group C · DOC-CHT-001/002`          | N/A  |     ✅      | ⚠️  |   ✅   |   ⬜   | Migrated verbatim; 0/9 performed                                                                                                                                                         |
| **M2-22**     | Timestamps                                                                                                             | `§4.9 group C · DOC-CHT-001/002`          | N/A  |     ✅      | ⚠️  |   ✅   |   ⬜   | Migrated verbatim; 0/9 performed                                                                                                                                                         |
| **M2-23**     | Overflow                                                                                                               | `§4.9 group C · DOC-CHT-001/002`          | N/A  |     ✅      | ⚠️  |   ✅   |   ⬜   | Migrated verbatim; 0/9 performed                                                                                                                                                         |
| **M2-24**     | Smallest screen                                                                                                        | `§4.9 group C · DOC-CHT-001/002`          | N/A  |     ✅      | ⚠️  |   ✅   |   ⬜   | Migrated verbatim; 0/9 performed                                                                                                                                                         |
| **M2-25**     | Consultation, discard guard                                                                                            | `§4.9 group D · DOC-CON-001, DOC-RX-004`  | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated verbatim; 0/10 performed                                                                                                                                                        |
| **M2-26**     | Consultation, save                                                                                                     | `§4.9 group D · DOC-CON-001, DOC-RX-004`  | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated verbatim; 0/10 performed                                                                                                                                                        |
| **M2-27**     | Consultation, offline                                                                                                  | `§4.9 group D · DOC-CON-001, DOC-RX-004`  | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated verbatim; 0/10 performed                                                                                                                                                        |
| **M2-28**     | Order pad                                                                                                              | `§4.9 group D · DOC-CON-001, DOC-RX-004`  | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated verbatim; 0/10 performed                                                                                                                                                        |
| **M2-29**     | Prescription, safety alert                                                                                             | `§4.9 group D · DOC-CON-001, DOC-RX-004`  | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated verbatim; 0/10 performed                                                                                                                                                        |
| **M2-30**     | Prescription, response lost                                                                                            | `§4.9 group D · DOC-CON-001, DOC-RX-004`  | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated verbatim; 0/10 performed                                                                                                                                                        |
| **M2-31**     | Ward note                                                                                                              | `§4.9 group D · DOC-CON-001, DOC-RX-004`  | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated verbatim; 0/10 performed                                                                                                                                                        |
| **M2-32**     | Ward note, response lost                                                                                               | `§4.9 group D · DOC-CON-001, DOC-RX-004`  | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated verbatim; 0/10 performed                                                                                                                                                        |
| **M2-33**     | Discharge                                                                                                              | `§4.9 group D · DOC-CON-001, DOC-RX-004`  | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated verbatim; 0/10 performed                                                                                                                                                        |
| **M2-34**     | Disabled controls explain                                                                                              | `§4.9 group D · DOC-CON-001, DOC-RX-004`  | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated verbatim; 0/10 performed                                                                                                                                                        |
| **M2-35**     | Enable the lock on a device with **no** enrolled biometric                                                             | `§4.9 group E`                            | N/A  |     N/A     | N/A |   ⚠️   |   ⬜   | Migrated verbatim. **🟡 K4-02: biometrics is wired to nothing — M2-38…M2-45 will fail as written until one line is fixed**                                                               |
| **M2-36**     | Background < 15 min, resume                                                                                            | `§4.9 group E`                            | N/A  |     N/A     | N/A |   ⚠️   |   ⬜   | Migrated verbatim. **🟡 K4-02: biometrics is wired to nothing — M2-38…M2-45 will fail as written until one line is fixed**                                                               |
| **M2-37**     | Background > 15 min, resume                                                                                            | `§4.9 group E`                            | N/A  |     N/A     | N/A |   ⚠️   |   ⬜   | Migrated verbatim. **🟡 K4-02: biometrics is wired to nothing — M2-38…M2-45 will fail as written until one line is fixed**                                                               |
| **M2-38**     | The OS prompt                                                                                                          | `§4.9 group E`                            | N/A  |     N/A     | N/A |   ⚠️   |   ⬜   | Migrated verbatim. **🟡 K4-02: biometrics is wired to nothing — M2-38…M2-45 will fail as written until one line is fixed**                                                               |
| **M2-39**     | Successful scan                                                                                                        | `§4.9 group E`                            | N/A  |     N/A     | N/A |   ⚠️   |   ⬜   | Migrated verbatim. **🟡 K4-02: biometrics is wired to nothing — M2-38…M2-45 will fail as written until one line is fixed**                                                               |
| **M2-40**     | Failed scan (wrong finger)                                                                                             | `§4.9 group E`                            | N/A  |     N/A     | N/A |   ⚠️   |   ⬜   | Migrated verbatim. **🟡 K4-02: biometrics is wired to nothing — M2-38…M2-45 will fail as written until one line is fixed**                                                               |
| **M2-41**     | **Cancelled** prompt                                                                                                   | `§4.9 group E`                            | N/A  |     N/A     | N/A |   ⚠️   |   ⬜   | Migrated verbatim. **🟡 K4-02: biometrics is wired to nothing — M2-38…M2-45 will fail as written until one line is fixed**                                                               |
| **M2-42**     | "Use password" on the OS sheet                                                                                         | `§4.9 group E`                            | N/A  |     N/A     | N/A |   ⚠️   |   ⬜   | Migrated verbatim. **🟡 K4-02: biometrics is wired to nothing — M2-38…M2-45 will fail as written until one line is fixed**                                                               |
| **M2-43**     | Five failed scans                                                                                                      | `§4.9 group E`                            | N/A  |     N/A     | N/A |   ⚠️   |   ⬜   | Migrated verbatim. **🟡 K4-02: biometrics is wired to nothing — M2-38…M2-45 will fail as written until one line is fixed**                                                               |
| **M2-44**     | Sign out from the lock screen                                                                                          | `§4.9 group E`                            | N/A  |     N/A     | N/A |   ⚠️   |   ⬜   | Migrated verbatim. **🟡 K4-02: biometrics is wired to nothing — M2-38…M2-45 will fail as written until one line is fixed**                                                               |
| **M2-45**     | Remove the enrolled biometric while backgrounded, resume                                                               | `§4.9 group E`                            | N/A  |     N/A     | N/A |   ⚠️   |   ⬜   | Migrated verbatim. **🟡 K4-02: biometrics is wired to nothing — M2-38…M2-45 will fail as written until one line is fixed**                                                               |
| **M2-46**     | App switcher                                                                                                           | `§4.9 group E`                            | N/A  |     N/A     | N/A |   ⚠️   |   ⬜   | Migrated verbatim. **🟡 K4-02: biometrics is wired to nothing — M2-38…M2-45 will fail as written until one line is fixed**                                                               |
| **M2-47**     | Force-quit while locked, relaunch                                                                                      | `§4.9 group E`                            | N/A  |     N/A     | N/A |   ⚠️   |   ⬜   | Migrated verbatim. **🟡 K4-02: biometrics is wired to nothing — M2-38…M2-45 will fail as written until one line is fixed**                                                               |
| **M2-48**     | Largest OS text size — identity line, save controls and lock screen all usable, nothing clips.                         | `§4.9 group F`                            |  ❌  |     ❌      | ❌  |   ❌   |   ⬜   | Migrated verbatim. **No automated proxy at any layer — needs eyes and a device**                                                                                                         |
| **M2-49**     | VoiceOver / TalkBack — the allergy banner and the lock's attempt warning are announced as **alerts**, not walked onto. | `§4.9 group F`                            |  ❌  |     ❌      | ❌  |   ❌   |   ⬜   | Migrated verbatim. **No automated proxy at any layer — needs eyes and a device**                                                                                                         |
| **M2-50**     | Every tappable target comfortably thumb-hittable (tokens set 48pt; only a hand confirms it).                           | `§4.9 group F`                            |  ❌  |     ❌      | ❌  |   ❌   |   ⬜   | Migrated verbatim. **No automated proxy at any layer — needs eyes and a device**                                                                                                         |
| **M2-51**     | High brightness / sunlight — amber and red banner tones and the critical-result flag remain distinguishable.           | `§4.9 group F`                            |  ❌  |     ❌      | ❌  |   ❌   |   ⬜   | Migrated verbatim. **No automated proxy at any layer — needs eyes and a device**                                                                                                         |
| **M2-52**     | ComingLater surfaces                                                                                                   | `§4.9 group G`                            | N/A  |     N/A     | N/A |   ✅   |   ⬜   | Migrated verbatim                                                                                                                                                                        |
| **M3-01**     | Nurse lands on Ward                                                                                                    | `§5.8 group A`                            | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated verbatim; 0/3 performed                                                                                                                                                         |
| **M3-02**     | Cold start                                                                                                             | `§5.8 group A`                            | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated verbatim; 0/3 performed                                                                                                                                                         |
| **M3-03**     | Nurse swap                                                                                                             | `§5.8 group A`                            | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated verbatim; 0/3 performed                                                                                                                                                         |
| **M3-04**     | Triage order                                                                                                           | `§5.8 group B · NUR-WRK-001`              | N/A  |     ✅      | ✅  |   ✅   |   ⬜   | Migrated verbatim                                                                                                                                                                        |
| **M3-05**     | Ward filter round-trip                                                                                                 | `§5.8 group B · NUR-WRK-001`              | N/A  |     ✅      | ✅  |   ✅   |   ⬜   | Migrated verbatim                                                                                                                                                                        |
| **M3-06**     | Long ward scroll                                                                                                       | `§5.8 group B · NUR-WRK-001`              | N/A  |     ✅      | ✅  |   ✅   |   ⬜   | Migrated verbatim                                                                                                                                                                        |
| **M3-07**     | Pull to refresh                                                                                                        | `§5.8 group B · NUR-WRK-001`              | N/A  |     ✅      | ✅  |   ✅   |   ⬜   | Migrated verbatim                                                                                                                                                                        |
| **M3-08**     | Chart in context                                                                                                       | `§5.8 group C · NUR-WRK-002`              | N/A  |     ✅      | ✅  |   ✅   |   ⬜   | Migrated verbatim                                                                                                                                                                        |
| **M3-09**     | Identity on every surface                                                                                              | `§5.8 group C · NUR-WRK-002`              | N/A  |     ✅      | ✅  |   ✅   |   ⬜   | Migrated verbatim                                                                                                                                                                        |
| **M3-10**     | Severe allergy                                                                                                         | `§5.8 group D · DOC-CHT-003`              |  ✅  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated verbatim                                                                                                                                                                        |
| **M3-11**     | No allergies                                                                                                           | `§5.8 group D · DOC-CHT-003`              |  ✅  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated verbatim                                                                                                                                                                        |
| **M3-12**     | Record vitals                                                                                                          | `§5.8 group E · NUR-VIT-001/002`          | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated verbatim                                                                                                                                                                        |
| **M3-13**     | Implausible value                                                                                                      | `§5.8 group E · NUR-VIT-001/002`          | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated verbatim                                                                                                                                                                        |
| **M3-14**     | Repeat observation                                                                                                     | `§5.8 group E · NUR-VIT-001/002`          | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated verbatim                                                                                                                                                                        |
| **M3-15**     | Offline                                                                                                                | `§5.8 group E · NUR-VIT-001/002`          | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated verbatim                                                                                                                                                                        |
| **M3-16**     | Lost response                                                                                                          | `§5.8 group E · NUR-VIT-001/002`          | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated verbatim                                                                                                                                                                        |
| **M3-17**     | Write a note                                                                                                           | `§5.8 group F · NUR-NOT-001`              | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated verbatim                                                                                                                                                                        |
| **M3-18**     | Unsaved-changes                                                                                                        | `§5.8 group F · NUR-NOT-001`              | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated verbatim                                                                                                                                                                        |
| **M3-19**     | Double-tap save                                                                                                        | `§5.8 group F · NUR-NOT-001`              | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated verbatim                                                                                                                                                                        |
| **M3-20**     | Wrong endpoint                                                                                                         | `§5.8 group F · NUR-NOT-001`              | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated verbatim                                                                                                                                                                        |
| **M3-21**     | Round loads                                                                                                            | `§5.8 group G · NUR-MAR-001/002/011`      | N/A  |     ✅      | ✅  |   ✅   |   ⬜   | Migrated verbatim. **M3-27 (screen reader) has no automated proxy**                                                                                                                      |
| **M3-22**     | Five-rights read                                                                                                       | `§5.8 group G · NUR-MAR-001/002/011`      | N/A  |     ✅      | ✅  |   ✅   |   ⬜   | Migrated verbatim. **M3-27 (screen reader) has no automated proxy**                                                                                                                      |
| **M3-23**     | Most overdue on top                                                                                                    | `§5.8 group G · NUR-MAR-001/002/011`      | N/A  |     ✅      | ✅  |   ✅   |   ⬜   | Migrated verbatim. **M3-27 (screen reader) has no automated proxy**                                                                                                                      |
| **M3-24**     | Nothing due                                                                                                            | `§5.8 group G · NUR-MAR-001/002/011`      | N/A  |     ✅      | ✅  |   ✅   |   ⬜   | Migrated verbatim. **M3-27 (screen reader) has no automated proxy**                                                                                                                      |
| **M3-25**     | Pagination is visible                                                                                                  | `§5.8 group G · NUR-MAR-001/002/011`      | N/A  |     ✅      | ✅  |   ✅   |   ⬜   | Migrated verbatim. **M3-27 (screen reader) has no automated proxy**                                                                                                                      |
| **M3-26**     | Later dose selectable                                                                                                  | `§5.8 group G · NUR-MAR-001/002/011`      | N/A  |     ✅      | ✅  |   ✅   |   ⬜   | Migrated verbatim. **M3-27 (screen reader) has no automated proxy**                                                                                                                      |
| **M3-27**     | Screen reader                                                                                                          | `§5.8 group G · NUR-MAR-001/002/011`      | N/A  |     ✅      | ✅  |   ✅   |   ⬜   | Migrated verbatim. **M3-27 (screen reader) has no automated proxy**                                                                                                                      |
| **M3-28**     | Confirmation order                                                                                                     | `§5.8 group H–K · NUR-MAR-003/004/005`    | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated verbatim. **M3-33 `not_available` remains PRODUCT DECISION REQUIRED**                                                                                                           |
| **M3-29**     | **Give**                                                                                                               | `§5.8 group H–K · NUR-MAR-003/004/005`    | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated verbatim. **M3-33 `not_available` remains PRODUCT DECISION REQUIRED**                                                                                                           |
| **M3-30**     | **Hold**                                                                                                               | `§5.8 group H–K · NUR-MAR-003/004/005`    | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated verbatim. **M3-33 `not_available` remains PRODUCT DECISION REQUIRED**                                                                                                           |
| **M3-31**     | **Refused**                                                                                                            | `§5.8 group H–K · NUR-MAR-003/004/005`    | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated verbatim. **M3-33 `not_available` remains PRODUCT DECISION REQUIRED**                                                                                                           |
| **M3-32**     | Already answered                                                                                                       | `§5.8 group H–K · NUR-MAR-003/004/005`    | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated verbatim. **M3-33 `not_available` remains PRODUCT DECISION REQUIRED**                                                                                                           |
| **M3-33**     | `not_available`                                                                                                        | `§5.8 group H–K · NUR-MAR-003/004/005`    | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated verbatim. **M3-33 `not_available` remains PRODUCT DECISION REQUIRED**                                                                                                           |
| **M3-34**     | Round follows branch                                                                                                   | `§5.8 group Q–T · NUR-MAR-010`            | N/A  |     ✅      | ✅  |   ✅   |   ⬜   | Migrated verbatim                                                                                                                                                                        |
| **M3-35**     | Stale row is safe                                                                                                      | `§5.8 group Q–T · NUR-MAR-010`            | N/A  |     ✅      | ✅  |   ✅   |   ⬜   | Migrated verbatim                                                                                                                                                                        |
| **M3-36**     | Refetch on resume                                                                                                      | `§5.8 group Q–T · NUR-MAR-010`            | N/A  |     ✅      | ✅  |   ✅   |   ⬜   | Migrated verbatim                                                                                                                                                                        |
| **M3-37**     | Advisory vs authoritative                                                                                              | `§5.8 group Q–T · NUR-MAR-010`            | N/A  |     ✅      | ✅  |   ✅   |   ⬜   | Migrated verbatim                                                                                                                                                                        |
| **MAR-01**    | Duplicate — same nurse                                                                                                 | `NUR-MAR-005`                             | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated                                                                                                                                                                                 |
| **MAR-02**    | Concurrent — two nurses, two devices                                                                                   | `NUR-MAR-006`                             | N/A  |     ✅      | ❌  |   ❌   |   ⬜   | Migrated. **The server race IS proven; the two-human half is not automatable**                                                                                                           |
| **MAR-03**    | Verify the server, not the screen                                                                                      | `NUR-MAR-006 (Downstream Verification)`   | N/A  |     ✅      | N/A |  N/A   |   ⬜   | Migrated as the verification procedure for every MAR row                                                                                                                                 |
| **MAR-04**    | PRN is deliberately unconstrained                                                                                      | `NUR-MAR-007`                             |  ✅  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated                                                                                                                                                                                 |
| **MAR-05**    | Line identity is a position                                                                                            | `NUR-MAR-007`                             |  ✅  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated                                                                                                                                                                                 |
| **FR-01**     | The five rights on every administering surface                                                                         | `NUR-MAR-002`                             | N/A  |     ✅      | ✅  |   ✅   |   ⬜   | Migrated — now the plan's flagship C0/P0                                                                                                                                                 |
| **FR-02**     | The long-stay patient (web defect D-1)                                                                                 | `NUR-WRK-003`                             | N/A  |     ✅      | ✅  |   ❌   |   ⬜   | Migrated as a regression check; falsified in Playwright                                                                                                                                  |
| **FR-03**     | Identity survives a long name                                                                                          | `DOC-CHT-001 (Negative / Boundary)`       | N/A  |     ❌      | ❌  |   ❌   |   ⬜   | Migrated. **No automated proxy — needs a device at largest text size**                                                                                                                   |
| **LR-01**     | Lost MAR response                                                                                                      | `NUR-MAR-009`                             |  ✅  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated                                                                                                                                                                                 |
| **LR-02**     | Retry with the held key replays                                                                                        | `NUR-MAR-009 · XC-IDM-001`                |  ✅  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated                                                                                                                                                                                 |
| **LR-03**     | Same key, different body                                                                                               | `NUR-MAR-009 · XC-IDM-001`                |  ✅  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated                                                                                                                                                                                 |
| **LR-04**     | Lost vitals response (web defect D-2)                                                                                  | `NUR-VIT-002`                             | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated as a regression check                                                                                                                                                           |
| **LR-05**     | Legitimate repeat observations                                                                                         | `NUR-VIT-002`                             | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated — the over-correction check                                                                                                                                                     |
| **LR-06**     | Backgrounded mid-save                                                                                                  | `NUR-MAR-009 (Also)`                      | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated                                                                                                                                                                                 |
| **BR-01**     | A → B, clinical surfaces                                                                                               | `XC-BRN-001`                              | N/A  |     ✅      | ✅  |   ✅   |   ⬜   | Migrated                                                                                                                                                                                 |
| **BR-02**     | B → A, back again                                                                                                      | `XC-BRN-001`                              | N/A  |     ✅      | ✅  |   ✅   |   ⬜   | Migrated                                                                                                                                                                                 |
| **BR-03**     | Cross-branch chart is refused                                                                                          | `DOC-SEC-002`                             | N/A  |     ✅      | ✅  |   ✅   |   ⬜   | Migrated                                                                                                                                                                                 |
| **BR-04**     | Cross-branch writes are refused                                                                                        | `DOC-SEC-002`                             | N/A  |     ✅      | ✅  |   ✅   |   ⬜   | Migrated                                                                                                                                                                                 |
| **BR-05**     | Cross-branch vitals                                                                                                    | `XC-BRN-002`                              | N/A  |     ✅      | ❌  |   ❌   |   ⬜   | **Amended — D1 FIXED `bdc027f`. Expectation INVERTED: expect refusal, not rows.** Also check the trend still crosses sites                                                               |
| **BR-06**     | Branch deactivated underneath you                                                                                      | `ADM-BRN-002`                             | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated                                                                                                                                                                                 |
| **BR-07**     | Branch-confined user                                                                                                   | `FD-SEC-002`                              | N/A  |     ✅      | ❌  |   ❌   |   ⬜   | **Amended — no longer BLOCKED.** Proven by test; executed at the API by an agent 2026-08-19; still unproven through a UI by a person                                                     |
| **BR-08**     | Stale UI across a switch                                                                                               | `XC-BRN-001`                              | N/A  |     ✅      | ✅  |   ✅   |   ⬜   | Migrated                                                                                                                                                                                 |
| **BR-09**     | Unknown X-Active-Branch                                                                                                | `XC-BRN-003`                              | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | **Amended — D4 reclassified 🔵 NOT A DEFECT.** Confirms the DESIGN                                                                                                                       |
| **BR-10**     | Cross-branch report FILE                                                                                               | `DOC-RES-003`                             | N/A  |     ✅      | ❌  |   ❌   |   ⬜   | **Amended — D10 FIXED `c02dd09`; now a regression check.** Falsified                                                                                                                     |
| **BR-11**     | Cross-branch appointment WRITE                                                                                         | `FD-APT-004`                              | N/A  |     ✅      | ❌  |   ❌   |   ⬜   | **Amended — D9 FIXED `4732dd8`; now a regression check.** Read the trap                                                                                                                  |
| **BR-12**     | Wallet advance is hospital-wide                                                                                        | `FD-PAY-003 · BIL-WAL-001`                | N/A  |     ✅      | ❌  |   ❌   |   ⬜   | Migrated as a NEGATIVE check — a refusal here is the defect                                                                                                                              |
| **TZ-01**     | Clinical time is the branch's                                                                                          | `NUR-MAR-001 · DOC-CHT-002`               |  ✅  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated                                                                                                                                                                                 |
| **TZ-02**     | Clinical time is the branch's                                                                                          | `NUR-MAR-001 · DOC-CHT-002`               |  ✅  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated                                                                                                                                                                                 |
| **TZ-03**     | Clinical time is the branch's                                                                                          | `NUR-MAR-001 · DOC-CHT-002`               |  ✅  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated                                                                                                                                                                                 |
| **TZ-04**     | Clinical time is the branch's                                                                                          | `NUR-MAR-001 · DOC-CHT-002`               |  ✅  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated                                                                                                                                                                                 |
| **TZ-05**     | Clinical time is the branch's                                                                                          | `NUR-MAR-001 · DOC-CHT-002`               |  ✅  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated                                                                                                                                                                                 |
| **TZ-06**     | Clinical time is the branch's                                                                                          | `NUR-MAR-001 · DOC-CHT-002`               |  ✅  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated                                                                                                                                                                                 |
| **TZ-07**     | Timestamps carry the zone                                                                                              | `DOC-CHT-002`                             |  ✅  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated                                                                                                                                                                                 |
| **TZ-08**     | Reception register `?date=`                                                                                            | `FD-VIS-003`                              |  ✅  |     ✅      | ❌  |  N/A   |   ⬜   | **Amended — D2 FIXED `8330faa`. Expectation INVERTED: the register's day is the BRANCH's day**                                                                                           |
| **TZ-09**     | Bed-day billing zone                                                                                                   | `DOC-ADM-004`                             |  ✅  |     ✅      | ❌  |  N/A   |   ⬜   | **Amended — D3 FIXED `1719360`. Expectation INVERTED.** Money — still worth eyes on                                                                                                      |
| **WEB-01**    | Login and nav                                                                                                          | `XC-AUTH-001`                             | N/A  |     ✅      | ✅  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **WEB-02**    | Wrong host                                                                                                             | `XC-TEN-002`                              | N/A  |     ✅      | ✅  |  N/A   |   ⬜   | **DECIDED 2026-08-18 — the runbook was right and the PRODUCT WAS CHANGED.** Now `AUTOMATED — PLAYWRIGHT`, with the negative asserted too                                                 |
| **WEB-03**    | Ward page                                                                                                              | `NUR-WRK-001`                             | N/A  |     ✅      | ✅  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **WEB-04**    | Ward identity                                                                                                          | `NUR-WRK-002`                             | N/A  |     ✅      | ✅  |  N/A   |   ⬜   | **AMENDED 2026-08-18 — the runbook was over-specified against its own §9. Product unchanged; the row now says where the requirement applies**, and it is tested there for the first time |
| **WEB-05**    | Long-stay patient (D-1)                                                                                                | `NUR-WRK-003`                             | N/A  |     ✅      | ✅  |  N/A   |   ⬜   | Migrated as a regression check                                                                                                                                                           |
| **WEB-06**    | Round loads                                                                                                            | `NUR-MAR-001`                             | N/A  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **WEB-07**    | Five rights                                                                                                            | `NUR-MAR-002`                             | N/A  |     ✅      | ✅  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **WEB-08**    | Pagination is honest                                                                                                   | `NUR-MAR-011`                             | N/A  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **WEB-09**    | Answered doses stay visible                                                                                            | `NUR-MAR-011`                             | N/A  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **WEB-10**    | Nothing due                                                                                                            | `NUR-MAR-011`                             | N/A  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **WEB-11**    | Later dose                                                                                                             | `NUR-MAR-011`                             | N/A  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **WEB-12**    | Give                                                                                                                   | `NUR-MAR-003`                             | N/A  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **WEB-13**    | Hold                                                                                                                   | `NUR-MAR-004`                             | N/A  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **WEB-14**    | Refused                                                                                                                | `NUR-MAR-004`                             | N/A  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **WEB-15**    | Duplicate                                                                                                              | `NUR-MAR-005`                             | N/A  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **WEB-16**    | Concurrency                                                                                                            | `NUR-MAR-006`                             | N/A  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **WEB-17**    | Lost MAR response                                                                                                      | `NUR-MAR-009`                             | N/A  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **WEB-18**    | Vitals + lost response                                                                                                 | `NUR-VIT-002`                             | N/A  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **WEB-19**    | Viewer sees inert actions                                                                                              | `DOC-SEC-001`                             | N/A  |     ✅      | ✅  |  N/A   |   ⬜   | Migrated — correct behaviour, not a leak                                                                                                                                                 |
| **WEB-20**    | Branch switch                                                                                                          | `XC-BRN-001`                              | N/A  |     ✅      | ✅  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **WEB-21**    | Timezone in the browser                                                                                                | `DOC-CHT-002`                             |  ✅  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **WEB-22**    | Tablet / narrow                                                                                                        | `§22.3 device matrix`                     |  ❌  |     ❌      | ❌  |  N/A   |   ⬜   | Migrated. **No automated proxy — DevTools emulation by hand**                                                                                                                            |
| **WEB-23**    | Accessibility on the round                                                                                             | `NUR-MAR-002 (Negative)`                  |  ❌  |     ❌      | ❌  |  N/A   |   ⬜   | Migrated. **No automated proxy — keyboard + screen reader by hand**                                                                                                                      |
| **WEB-24**    | Session expiry                                                                                                         | `XC-AUTH-001`                             | N/A  |     ✅      | ✅  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **JR-01**     | Register a new patient                                                                                                 | `FD-REG-002`                              | N/A  |     ⚠️      | ⚠️  |  N/A   |   ⬜   | Migrated. **Gap: no suite owns UHID issue**                                                                                                                                              |
| **JR-02**     | MPI duplicate refusal                                                                                                  | `FD-REG-004`                              | N/A  |     ❌      | ❌  |  N/A   |   ⬜   | Migrated. **🔴 Largest automation gap in the plan**                                                                                                                                      |
| **JR-03**     | Deliberate override (force)                                                                                            | `FD-REG-005`                              | N/A  |     ❌      | ❌  |  N/A   |   ⬜   | Migrated. **🔴 Untested, including its `patient:merge` gate**                                                                                                                            |
| **JR-04**     | Patient lookup                                                                                                         | `FD-REG-001`                              | N/A  |     ⚠️      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **JR-05**     | Start a visit                                                                                                          | `FD-VIS-001`                              | N/A  |     ✅      | ⚠️  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **JR-06**     | Start it again — resumed, not duplicated                                                                               | `FD-VIS-002`                              | N/A  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **JR-07**     | Appointment check-in → the same door                                                                                   | `FD-APT-002`                              | N/A  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **JR-08**     | Consultation                                                                                                           | `DOC-CON-001`                             | N/A  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **JR-09**     | Order an investigation                                                                                                 | `DOC-ORD-001`                             | N/A  |     ✅      | ✅  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **JR-10**     | Perform, verify, release                                                                                               | `LAB-VER-001`                             | N/A  |     ✅      | ⚠️  |  N/A   |   ⬜   | Migrated — two logins required                                                                                                                                                           |
| **JR-11**     | Prescribe and sign                                                                                                     | `DOC-RX-002`                              | N/A  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **JR-12**     | Dispense                                                                                                               | `PHR-DIS-002`                             | N/A  |     ✅      | ✅  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **JR-13**     | Admit                                                                                                                  | `DOC-ADM-001`                             | N/A  |     ✅      | ⚠️  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **JR-14**     | Occupied bed                                                                                                           | `DOC-ADM-002`                             | N/A  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **JR-15**     | Move bed                                                                                                               | `NUR-BED-001`                             | N/A  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **JR-16**     | Move onto a taken bed                                                                                                  | `DOC-ADM-002`                             | N/A  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **JR-17**     | Vitals, notes, doses on the stay                                                                                       | `NUR-VIT-001 · NUR-NOT-001 · NUR-MAR-003` | N/A  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **JR-18**     | Discharge                                                                                                              | `DOC-DIS-001`                             | N/A  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **JR-19**     | A second summary                                                                                                       | `DOC-DIS-001`                             | N/A  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **JR-20**     | Bed-days                                                                                                               | `DOC-ADM-004`                             | N/A  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **JR-21**     | Finalize and pay                                                                                                       | `BIL-INV-001 · BIL-PAY-001`               | N/A  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **JR-22**     | The record afterwards                                                                                                  | `XC-ID-001`                               | N/A  |     ✅      | ✅  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **DUP-01**    | Duplicate dispensing                                                                                                   | `PHR-DIS-003`                             |  ✅  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated — expects `200 duplicate:true`, NOT a 409                                                                                                                                       |
| **DUP-02**    | Duplicate order                                                                                                        | `DOC-ORD-002`                             |  ✅  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated — same shape                                                                                                                                                                    |
| **TEN-01**    | Second-tenant isolation                                                                                                | `XC-TEN-001`                              | N/A  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated — any leak is a P0, stop the campaign                                                                                                                                           |
| **NET-01**    | Normal wifi                                                                                                            | `XC-NET-001`                              | N/A  |     ⚠️      | ❌  |   ✅   |   ⬜   | Migrated                                                                                                                                                                                 |
| **NET-02**    | Airplane, read                                                                                                         | `XC-NET-002`                              | N/A  |     ⚠️      | ❌  |   ✅   |   ⬜   | Migrated                                                                                                                                                                                 |
| **NET-03**    | Airplane, write                                                                                                        | `XC-NET-003`                              | N/A  |     ⚠️      | ❌  |   ✅   |   ⬜   | Migrated                                                                                                                                                                                 |
| **NET-04**    | Server unreachable                                                                                                     | `XC-NET-004`                              | N/A  |     ⚠️      | ❌  |   ✅   |   ⬜   | Migrated                                                                                                                                                                                 |
| **NET-05**    | Interrupted mid-flight                                                                                                 | `XC-NET-005`                              | N/A  |     ⚠️      | ❌  |   ✅   |   ⬜   | Migrated                                                                                                                                                                                 |
| **NET-06**    | Slow network                                                                                                           | `XC-NET-006`                              | N/A  |     ⚠️      | ❌  |   ✅   |   ⬜   | Migrated                                                                                                                                                                                 |
| **NET-07**    | Reconnect                                                                                                              | `XC-NET-007`                              | N/A  |     ⚠️      | ❌  |   ✅   |   ⬜   | Migrated                                                                                                                                                                                 |
| **NET-08**    | Cellular handover                                                                                                      | `XC-NET-008`                              | N/A  |     ❌      | ❌  |   ❌   |   ⬜   | Migrated. **N/A at every automated layer — a mocked failure is a decision, a lost packet is an accident**                                                                                |
| **NET-09**    | Backgrounded during save                                                                                               | `XC-NET-009`                              | N/A  |     ⚠️      | ❌  |   ✅   |   ⬜   | Migrated                                                                                                                                                                                 |
| **PERM-01**   | Doctor administers a dose                                                                                              | `DOC-SEC-001`                             | N/A  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **PERM-02**   | Receptionist administers                                                                                               | `FD-SEC-001`                              | N/A  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **PERM-03**   | Receptionist reads the schedule                                                                                        | `FD-SEC-001`                              | N/A  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **PERM-04**   | Nurse writes a nursing note                                                                                            | `NUR-SEC-001`                             | N/A  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **PERM-05**   | Nurse attempts the doctor's note                                                                                       | `DOC-CON-002 · NUR-SEC-001`               | N/A  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **PERM-06**   | Nurse records vitals                                                                                                   | `NUR-SEC-001`                             | N/A  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **PERM-07**   | Nurse closes an encounter                                                                                              | `NUR-SEC-001`                             | N/A  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **PERM-08**   | Every denial's UI shape                                                                                                | `XC-RBAC-002`                             |  ❌  |     ❌      | ❌  |   ✅   |   ⬜   | Migrated. **Web and E2E have no coverage of the SHAPE of a denial**                                                                                                                      |
| **PERM-09**   | Doctor opens the round on web                                                                                          | `DOC-SEC-001`                             | N/A  |     ✅      | ✅  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **PERM-10**   | Permission held by nobody                                                                                              | `ADM-ROL-001`                             |  ✅  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated — now a build-failing gate                                                                                                                                                      |
| **NEG-01**    | Wrong role administers                                                                                                 | `DOC-SEC-001 · FD-SEC-001`                | N/A  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **NEG-02**    | Write to a branch-B encounter                                                                                          | `DOC-SEC-002`                             | N/A  |     ✅      | ✅  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **NEG-03**    | Duplicate scheduled dose                                                                                               | `NUR-MAR-005`                             | N/A  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **NEG-04**    | Act on a stale screen                                                                                                  | `NUR-MAR-010`                             | N/A  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **NEG-05**    | Lost response, then retry                                                                                              | `NUR-MAR-009`                             | N/A  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **NEG-06**    | Wrong prescription line                                                                                                | `NUR-MAR-007`                             | N/A  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **NEG-07**    | Fabricated `scheduledFor`                                                                                              | `NUR-MAR-008`                             | N/A  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **NEG-08**    | Draft or cancelled prescription                                                                                        | `NUR-MAR-008 · PHR-DIS-001`               | N/A  |     ✅      | ✅  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **NEG-09**    | Switch branch mid-workflow                                                                                             | `XC-BRN-005`                              | N/A  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **NEG-10**    | Expired session mid-write                                                                                              | `XC-AUTH-001`                             | N/A  |     ✅      | ✅  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **NEG-11**    | Network interruption mid-write                                                                                         | `XC-NET-005 · NUR-MAR-009`                | N/A  |     ⚠️      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **NEG-12**    | Reuse a key with a different body                                                                                      | `XC-IDM-001`                              | N/A  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **NEG-13**    | Double-click a submit                                                                                                  | `XC-IDM-001 · DOC-ORD-002`                | N/A  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **NEG-14**    | Unknown X-Active-Branch                                                                                                | `XC-BRN-003`                              | N/A  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated                                                                                                                                                                                 |
| **DRIFT-01**  | MAR dose-slot index dropped                                                                                            | `NUR-MAR-012`                             |  ✅  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated. **None has ever been seen by a person on a screen**                                                                                                                            |
| **DRIFT-02**  | Proportionality — vitals and notes still work                                                                          | `NUR-MAR-012`                             |  ✅  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated. **None has ever been seen by a person on a screen**                                                                                                                            |
| **DRIFT-03**  | Dispense index dropped                                                                                                 | `PHR-DIS-004`                             |  ✅  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated. **None has ever been seen by a person on a screen**                                                                                                                            |
| **DRIFT-04**  | Order index dropped                                                                                                    | `DOC-ORD-004`                             |  ✅  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated. **None has ever been seen by a person on a screen**                                                                                                                            |
| **DRIFT-05**  | Bed-occupancy index dropped                                                                                            | `DOC-ADM-003`                             |  ✅  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated. **None has ever been seen by a person on a screen**                                                                                                                            |
| **DRIFT-06**  | Open-encounter index dropped                                                                                           | `FD-VIS-006`                              |  ✅  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated. **None has ever been seen by a person on a screen**                                                                                                                            |
| **DRIFT-07**  | Recovery within 60 s, no restart                                                                                       | `NUR-MAR-012 (Recovery)`                  |  ✅  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated. **None has ever been seen by a person on a screen**                                                                                                                            |
| **DRIFT-08**  | Second hospital unaffected                                                                                             | `XC-TEN-001 · NUR-MAR-012`                |  ✅  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated. **None has ever been seen by a person on a screen**                                                                                                                            |
| **DRIFT-09**  | Nothing was written                                                                                                    | `NUR-MAR-012 · XC-SAF-001`                |  ✅  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated. **None has ever been seen by a person on a screen**                                                                                                                            |
| **DRIFT-10**  | Mobile behaviour on a 503                                                                                              | `NUR-MAR-012`                             |  ✅  |     ✅      | ❌  |   ✅   |   ⬜   | Migrated. **None has ever been seen by a person on a screen**                                                                                                                            |
| **DRIFT-11**  | Server log carries the operator's facts                                                                                | `NUR-MAR-012`                             |  ✅  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated. **None has ever been seen by a person on a screen**                                                                                                                            |
| **DRIFT-12**  | No PHI in the refusal line                                                                                             | `NUR-MAR-012`                             |  ✅  |     ✅      | ❌  |  N/A   |   ⬜   | Migrated. **None has ever been seen by a person on a screen**                                                                                                                            |
| **LIC-01**    | Healthy                                                                                                                | `OPS-LIC row 1`                           | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | PREPARED, unexecuted                                                                                                                                                                     |
| **LIC-02**    | Expiring                                                                                                               | `OPS-LIC row 2`                           | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | PREPARED, unexecuted — the banner has never been seen on a device                                                                                                                        |
| **LIC-03**    | Grace                                                                                                                  | `OPS-LIC row 3`                           | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | PREPARED, unexecuted — **a red strip AND a working MAR is the pass**                                                                                                                     |
| **LIC-04**    | Expired                                                                                                                | `OPS-LIC row 4`                           | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | PREPARED, unexecuted                                                                                                                                                                     |
| **LIC-05**    | Renewal mid-session                                                                                                    | `OPS-LIC row 5`                           | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | PREPARED, unexecuted                                                                                                                                                                     |
| **LIC-06**    | Edition without the nursing module                                                                                     | `OPS-LIC row 6`                           | N/A  |     ✅      | ❌  |   ✅   |   ⬜   | **🔴 STILL BLOCKED** — needs a plan that omits `module.clinical.nursing`                                                                                                                 |

---

## 22. TEST DATA REQUIREMENTS

**Everything below is produced by a command in this repository.** Nothing here is aspirational, and
no fixture is described that the seeds do not build. All data is synthetic; **no real credentials
appear in this document and none may be added to it.**

### 22.1 Accounts — `pnpm seed:operator && pnpm seed:demo`

Two hospitals (`sunrise`, `district`) and **thirteen staff accounts at each**, all
`<key>@sunrise.test`, **password `123456`**.

| Alias        | Account                     | Role                   | The scenarios that need this person                                     |
| ------------ | --------------------------- | ---------------------- | ----------------------------------------------------------------------- |
| Tenant admin | `admin@sunrise.test`        | `TENANT_ADMIN`         | All of §13; ADM-BRN-002; the licence fixtures                           |
| Receptionist | `reception@sunrise.test`    | `RECEPTIONIST`         | All of §3A; FD-VIS-006 (DRIFT-06)                                       |
| Doctor       | `drrao@sunrise.test`        | `DOCTOR`               | All of §4; DOC-ORD-004; DOC-ADM-003                                     |
| Doctor 2     | `drkhan@sunrise.test`       | `DOCTOR`               | **DOC-HND-001 — the one scenario needing two doctors**                  |
| **Nurse A**  | `nurse@sunrise.test`        | `NURSE`                | All of §5                                                               |
| **Nurse B**  | `nurse2@sunrise.test`       | `NURSE`                | **NUR-MAR-006 and NUR-MAR-010 — two identities, not one account twice** |
| Lab tech     | `labtech@sunrise.test`      | `LAB_TECHNICIAN`       | §6; DOC-ORD-004                                                         |
| Pathologist  | `pathologist@sunrise.test`  | `PATHOLOGIST`          | **LAB-VER-001 — a different person from the technician**                |
| Radiographer | `radiographer@sunrise.test` | `RADIOLOGY_TECHNICIAN` | All of §7                                                               |
| Radiologist  | `radiologist@sunrise.test`  | `RADIOLOGIST`          | §7 optional path — the demo works without this login                    |
| Pharmacist   | `pharmacy@sunrise.test`     | `PHARMACIST`           | All of §8; **PHR-DIS-004 — the only role with `pharmacy:dispense`**     |
| Cashier      | `cashier@sunrise.test`      | `CASHIER`              | All of §12                                                              |
| Store keeper | `store@sunrise.test`        | `STORE_KEEPER`         | All of §9                                                               |
| Operator     | `ops@paperlesstech.in`      | `SUPER_ADMIN`          | §14                                                                     |

**Three accounts you must create yourself — no seed makes them, and four scenarios need them:**

| Account                               | How                                                                               | Needed by      |
| ------------------------------------- | --------------------------------------------------------------------------------- | -------------- |
| A **branch-confined** front-desk user | Roles UI as tenant admin: assign with `branchIds: [branchB]`. **No code change.** | FD-SEC-002     |
| An **`AUDITOR`**                      | Roles UI                                                                          | AUD-SEC-001    |
| A **`FRONT_OFFICE`** user             | Roles UI                                                                          | FD-PAY-001/003 |

> **Why the second nurse and the second doctor exist at all.** One account signed in twice is **one
> identity**, which is precisely what the concurrency scenarios must not have. If only one device is
> available on the day, run everything except NUR-MAR-006 and mark it **BLOCKED** rather than faking
> a second nurse.

### 22.2 The clinical ward — `pnpm seed:validation`, then `-- --verify`

| Item                    | Value                                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Tenant                  | `sunrise`                                                                                                                        |
| **Branch A**            | Main Branch · `Asia/Kolkata` · **General Ward** · beds `GW-1`…`GW-45` · **42 admitted**                                          |
| **Branch B**            | second site · `America/New_York` · **Annexe Ward** · beds `AW-…` · **3 admitted**                                                |
| **Long-stay patient**   | bed **GW-1**, registered _first_, pushed outside the 100-most-recent window → **NUR-WRK-003**                                    |
| Medicated patients      | 12, from 6 prescription shapes                                                                                                   |
| Quiet patients          | 30 with nothing due → **NUR-MAR-011**                                                                                            |
| Drugs                   | Paracetamol 500mg · Pantoprazole 40mg · Metformin 500mg · Amlodipine 5mg · Cetirizine 10mg — **all route `oral`, 5-day courses** |
| `lineIndex` cases       | a **3-line** prescription, and the **same drug scheduled AND as-required** → **NUR-MAR-007**                                     |
| Allergies               | ≥1 severe → **DOC-CHT-003**                                                                                                      |
| **Deliberately absent** | **no vitals, no nursing notes, no administered doses** — those are the writes you are here to make                               |
| Round times             | OD 08 · BD 08/20 · TDS 08/14/20 · QID 06/12/18/22 · HS 22 · SOS as-required · STAT once                                          |

> **Overdue doses are a clock state, not a seeded row.** A course runs from the prescription's
> `signedAt`, so one signed at noon has no 08:00 dose to be late for. `--verify` prints the wall-clock
> minute the first overdue dose appears. **Seed before 08:00 ward time** for a full day of natural
> due→overdue transitions. `OVERDUE_AFTER_MS` is 1 hour.
>
> **Do not backdate `signedAt` to manufacture an overdue dose.** It is a medico-legal timestamp;
> falsifying it to make a test convenient is not a testing technique.

**Fixtures the validation ward does NOT build, and how to get them:**

| Needed for                                    | How to produce it                                                                                                                 |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| A register big enough to page and date-filter | `pnpm seed:clinical -- --patients 300` — ~400 patients spread over recent months                                                  |
| An **occupied bed** to collide with           | Admit one (DOC-ADM-001), then attempt DOC-ADM-002 against the same bed                                                            |
| An **expired batch**                          | `POST /medicines/:id/receive` refuses expired stock — receive a near-expiry lot and let it lapse, or seed the batch date directly |
| An **out-of-stock** medicine                  | Any drug in the master with no batch received → DOC-RX-001                                                                        |
| An **operating theatre**                      | **`seed:demo` creates none.** Add one as admin → OT-REG-001                                                                       |
| A **licence state**                           | `pnpm seed:licence -- --slug licence-lab --state …` on a **dedicated** hospital                                                   |
| A **`PLAN_CLINIC`** tenant                    | `pnpm seed:hospital -- --plan PLAN_CLINIC …` then `pnpm seed:migrate --slug …`                                                    |
| A **schema-drifted** tenant                   | Runbook §16A — drop one index, **and restore it in the same session**                                                             |

### 22.3 Devices and browsers

| Surface                     | Needed for                               | Genuinely requires hardware?                                                               |
| --------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Android phone**           | All of M3; M2-35…M2-47; all of M4        | **Yes** — a simulator has no enrolled fingerprint, no real radio, no app-switcher snapshot |
| **A second Android/iPhone** | **NUR-MAR-006**, M3-35                   | **Yes** — two identities must be two sessions                                              |
| **iPhone with Face ID**     | M2-35…M2-47 on iOS                       | **Yes** — the lock's failure modes differ per platform in ways the port hides              |
| **Small phone (SE / 5")**   | M2-24                                    | **Yes**                                                                                    |
| **Desktop browser**         | Everything in §3A–§17 that is not mobile | No                                                                                         |
| **Tablet / narrow browser** | WEB-22                                   | No — DevTools emulation is adequate for layout                                             |

**Simulators are acceptable** for layout, navigation and network-off scenarios. They are **not**
acceptable for biometrics, cellular handover, app-switcher snapshots, push, or NUR-MAR-006.

**Record for every device:** model, OS version, app build/commit, and **Expo Go or a development
build** — remembering that M4 requires a development build and M2/M3 may not.

---

## 23. DEFECT CLASSIFICATION

### 23.1 Before you file anything — three questions, in order

1. **Is the environment sound?** Re-run `pnpm seed:validation -- --verify`. If it does not say READY,
   the finding is **ENVIRONMENT ISSUE** until proven otherwise. _On 2026-08-14 this single question
   was the difference between seven P0 reports and zero._
2. **Is it already known?** Check `AI_Workflow/docs/RISK_REGISTER.md` §0 and the "Amended" list in
   §21.2. If yes → **KNOWN DEFECT**: cite the ID and move on. Do not re-report.
3. **Does the repository define what should happen?** If not → **PRODUCT DECISION REQUIRED**. Describe
   what you saw, what you expected, and why. **Do not invent the expected result** — a tester's opinion
   silently becoming the spec is how a product acquires requirements nobody agreed to.

### 23.2 Categories

| Category                        | Use when                                                                                                                                         | Default severity |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| **Patient Safety**              | Wrong patient, wrong drug, wrong dose slot, a duplicated or lost clinical record, a blank five-rights field, a false success on a clinical write | **P0**           |
| **Security / Tenant Isolation** | Any data crossing a hospital boundary                                                                                                            | **P0**           |
| **RBAC**                        | An action the API allows that the role should not have — **or a permission nobody holds**                                                        | P0 / P1          |
| **Branch Isolation**            | Data or a write crossing a site boundary. **Check §17.2's table first** — several reads are hospital-wide _on purpose_                           | P1               |
| **Data Integrity**              | Duplicates, orphans, a state machine accepting an illegal edge, an audit entry that cannot verify                                                | P1               |
| **Financial**                   | A charge that does not match what was delivered; money that does not add up; a bed-day off by one                                                | P1               |
| **Clinical Workflow**           | A handoff that does not arrive — an order that never reaches the bench, a result that never reaches the doctor                                   | P1               |
| **Operational Workflow**        | Registration, scheduling, admission or stores workflows that do not complete                                                                     | P2               |
| **UX**                          | A disabled control with no reason; an unreadable refusal; a legible-but-wrong label                                                              | P2 / P3          |
| **Performance**                 | A screen that does not resolve; a list that stalls; a round that fans out per patient                                                            | P2               |
| **Mobile**                      | Anything device-specific: the lock, a snapshot, a push, a radio transition                                                                       | by impact        |
| **Integration**                 | The outbox, the queue, a consumer that never fires — **the silent-nothing family**                                                               | P1               |

### 23.3 Severity, and what it obliges you to do

| Sev    | Meaning                                                       | Obligation                                                                                                                                                                                                         |
| ------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **P0** | Patient harm, data loss, or a cross-tenant breach is possible | **Stop the affected workflow immediately.** Capture §23.4's extended set. Do not retry before recording the first occurrence. Do not continue tests depending on the same mechanism. **Report before proceeding.** |
| **P1** | Major clinical, security or financial failure                 | Report before the end of the session; stop that workflow                                                                                                                                                           |
| **P2** | Important, workflow continues                                 | Record with evidence and carry on                                                                                                                                                                                  |
| **P3** | Minor / cosmetic                                              | Record                                                                                                                                                                                                             |

### 23.4 Evidence standard

**Every test:**

```
TEST ID        e.g. NUR-MAR-006  (and the runbook row it carries, e.g. MAR-02)
DATE/TIME      with timezone — the branch's and the device's if they differ
DEVICE         model · OS version · Expo Go or dev build · commit
SURFACE        mobile / web / API
TENANT         sunrise
BRANCH         Main Branch (Asia/Kolkata) | second site (America/New_York)
ROLE           the account, by alias
PRECONDITION   what was true before, including the --verify result
STEPS          what you actually did, not what this document said
EXPECTED       from this document
ACTUAL         what happened
RESULT         PASS / FAIL / BLOCKED / ENVIRONMENT ISSUE / DATA ISSUE / KNOWN DEFECT /
               PRODUCT DECISION REQUIRED / N/A
EVIDENCE       screenshot / video / network capture / query output
NOTES          anything that surprised you
```

**Additionally, for any safety failure:**

```
SERVER RESPONSE     status code, error code, full body
DATABASE STATE      the MAR-03 query output, or the equivalent count for this scenario
DUPLICATE COUNT     exact number of rows for that dose slot / dispense / order
USER IDENTITY       which person, both sessions if concurrent
TIMESTAMPS          request sent · server committed · client observed
REPRODUCTION        minimal steps; whether it reproduced on a second attempt
SEVERITY            P0 / P1 / P2 / P3 with the reasoning
CLINICAL STATE      did clinical data change, duplicate, or get lost?
NETWORK CONDITION   for any lost-response test
BOTH SESSIONS       for any concurrency test — screenshots of both screens
```

### 23.5 Raise, never work around

Never work around and continue: **a missing safety constraint · a duplicated or lost clinical record ·
cross-branch or cross-tenant data · a false success message · a five-rights field that is blank ·
anything that made you say "that can't be right" and then carry on.**

---

## 24. WHAT THIS PLAN STILL CANNOT TELL YOU

Stated so nobody mistakes preparation for coverage.

1. **No result in this document is a result.** All 149 scenarios and all 232 inherited rows are
   `⬜ Not Tested`. **Nobody has looked at this product with their eyes.** The 2026-08-19 pass was an
   agent driving a real browser — better than a person at reading the database after every write,
   and **incapable of judging legibility, layout, density, or whether a screen is usable under time
   pressure.**
2. **The environment gate covers one tenant at one moment.** Risk-register **T2** — a fleet-wide
   convergence metric — remains open. `pnpm seed:migrate --check` is a command, not a scraped gauge.
3. **Mobile is 0 of 106 device rows** (M2 61, M3 45) **plus 0 of 18 for push**, and none is
   addressable without hardware. **K4-02 means the biometric block will fail as written until one
   line is fixed.**
4. **Thirteen of the fourteen roles are now inside the RBAC route sweep** (§20.3, closed
   2026-08-22), and a new role must be swept or excluded for a written reason. `PATIENT` is the one
   exclusion, guarded separately. What the sweep still cannot see is a route that enforces the right
   permission on the wrong ROW — that is row scope, and it lives in `branchIsolation.int.test.ts`.
5. **Nine modules have routes, screens and no functional test** (§20.4). **Mortuary release — which
   refuses a medico-legal body without a police clearance — is the one among them with a safety
   argument behind it.**
6. **Where the implementation is self-consistent but the intent is unstated, this plan says
   `PRODUCT DECISION REQUIRED` rather than guessing.** The open ones are: `not_available` as a
   selectable MAR outcome (M3-33); per-branch pharmacy stock (PHR-SEC-001); the cross-branch patient
   record (FD-REG-008); `administeredBy` rendering an id rather than a name (risk-register D7); and
   whether provisioning should seed `maxBranches` from the plan (D5). **Those are decisions for
   people, not for a tester and not for an agent.**
7. **Counts in §19 are of scenarios, not of tests.** Test counts are deliberately absent from this
   document because they go stale silently and then get quoted. Run `pnpm gate:full` and quote the
   run.

---

_Generated 2026-08-22 from the repository at `feature/0.1`; coverage re-verified the same day after
the §20.6 hardening pass. When a module changes, change its scenarios in the same commit — a test
plan updated afterwards is a test plan nobody trusts._
