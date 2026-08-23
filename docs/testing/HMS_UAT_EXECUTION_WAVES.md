# MediCore HMS — UAT Execution Waves

**Companion to** [`HMS_ROLE_BASED_UAT_TEST_PLAN.md`](./HMS_ROLE_BASED_UAT_TEST_PLAN.md). That document
is the master plan and the only place an expected result is defined. **This document schedules it**:
which of its 149 scenarios to run first, in which order, against which fixtures, and where one role's
work has to become another role's input.

**Nothing here restates an expectation.** If a step and the master plan disagree, the master plan is
right and this file is stale. **No scenario below is marked passed** — every manual cell in this
repository reads `⬜ Not Tested` until a person has run it and written down what they saw.

Prepared 2026-08-22, after the automation hardening pass recorded in the master plan §20.6.
`pnpm gate` green at that commit: 2,435 unit · 4,320 integration · 0 boundary violations.

---

## 1. The executable set

Of 149 scenarios, **95 are P0 or C0** — 55 C0/P0, 29 C1/P0, 10 C0/P1, 1 C2/P0. Those 95 are scheduled
below and nothing else is. The remaining 54 (C1/P1 and quieter) are run **inside the wave that already
has their fixture standing**, not as a separate pass; the master plan's role sections are the list.

Criticality and priority stay separate throughout, and the two diverge in both directions in this set:
**FD-VIS-003** is C2/P0 (nobody is harmed by a wrong day, but it is the first screen the hospital opens
every morning, and it was a real defect) and **OPS-SUS-001** is C0/P1 (catastrophic if wrong, but the
mechanism is one database per tenant and it does not block a release).

### 1.1 Where the waves changed, and why

Seven judgments, each against the repository rather than against the shape of the grouping.

**a. Configuration cannot be Wave 6. It is Wave 0.** Three accounts that Waves 1 and 6 need have **no
seed at all** and must be made by the administrator in the Roles UI (master plan §22.1): a
branch-confined front-desk user (**FD-SEC-002**, Wave 1A), a `FRONT_OFFICE` user (**FD-PAY-001**, Wave
1A) and an `AUDITOR` (**AUD-SEC-001**, Wave 6). **`seed:demo` creates no operating theatre**, so Wave
4's first action is an administrator's (§18.7 row 1). And the master plan's own journey preamble says
to run the journeys **after §17.3 (RBAC)** — which is Wave 6 as proposed. Setup that must happen anyway
is scheduled as Wave 0 and **recorded as evidence** against the scenarios it satisfies, rather than
performed silently and then re-performed later as a test.

**b. What stays in Wave 6 is governance, and it is stronger last.** **ADM-AUD-001** asks whether the
activity trail records what happened and can prove it was not altered. Run on a fresh environment it
inspects nothing; run after Waves 1–5 it inspects a real day's work by twelve identities. Keep it last
deliberately.

**c. Each role's `-SEC` scenario runs at the end of its own wave, not in a security pass.** FD-SEC-001,
DOC-SEC-001/002, NUR-SEC-001, LAB-SEC-001, RAD-SEC-001/002, PHR-SEC-001, EMG-SEC-001 and BIL-SEC-001
are refusals **for a role that is already signed in with its fixture standing**. Moving them to Wave 6
means rebuilding twelve sessions to save nothing. Wave 6 keeps only what is genuinely cross-cutting —
tenant, branch, session, audit, platform.

**d. Wave 5 is not a wave. It is a parallel track.** `STORE_KEEPER` **touches no patient** (master plan
§9): no `patient:read`, no `emr:read`, a separate ledger at `/inventory`, and pharmacy stock lives
somewhere else entirely (`/medicines`). General Stores has **no handoff to or from any other wave**.
Scheduling it fifth idles a tester for four waves; run it on day one alongside Wave 1, or whenever a
second person is free.

**e. Wave 1 must not be paid for at the desk.** **FD-PAY-002** — an unpaid charge holds laboratory work
and says so — and journey §18.5 row 2 — the payment badge on the bench clears when the cashier collects
— are both unobservable if the consultation is settled at registration. **Leave Wave 1's charges unpaid
until the lab bench has been seen.** Payment state is called out per wave below for this reason.

**f. XC-BRN-005 belongs in Wave 2, on the medication round.** The master plan's #1 ranked automation
gap is that nothing **interleaves** a branch switch with an in-flight write. The sharpest place to do
that by hand is exactly where the round already is: open a dose confirmation, switch branch, submit.
Scheduling it as an abstract cross-cutting check in Wave 6 loses the fixture that makes it dangerous.

**g. Three actions damage the environment and are fenced.** **OPS-LIC-01…06** and **OPS-SUS-001** need
a **dedicated tenant** — the licence script refuses any slug without `licence` in it, for exactly this
reason. **ADM-BRN-002** deactivates a branch underneath a working nurse and runs **last**, after Wave 2
has released the ward. See §4.

---

## 2. The campaign calendar

**The clock, not the checklist, sets the order.** Three constraints are real and none is negotiable.

| Constraint                                                                                                                                                                                                                    | Consequence                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `seed:validation` must run **before 08:00 ward time** for a full day of natural due→overdue transitions. A course runs from `signedAt`, so one signed at noon has no 08:00 dose to be late for. `OVERDUE_AFTER_MS` is 1 hour. | **Wave 0 is a morning job. Wave 2 is an afternoon job.**            |
| **Do not backdate `signedAt`** to manufacture an overdue dose. It is a medico-legal timestamp.                                                                                                                                | If the seed was late, re-seed tomorrow. Do not improvise a fixture. |
| Branch A is `Asia/Kolkata`, Branch B is `America/New_York`. The MAR integration suite genuinely fails between roughly **05:30 and 09:30 IST** — a real ward-timezone window, not a flake.                                     | Check `TZ=America/New_York date` before calling a red run a defect. |

A workable two-day shape, with Wave 5 and the Wave 1 legs parallelised where the fixtures allow:

| Day | Morning                          | Afternoon                       | Parallel track         |
| --- | -------------------------------- | ------------------------------- | ---------------------- |
| 1   | **Wave 0** (seed before 08:00)   | **Wave 1A → 1B**                | **Wave 5** (Stores)    |
| 1   | —                                | **Wave 1C → 1D → 1E → roll-up** | **Wave 3** (Emergency) |
| 2   | **Wave 2** (needs overdue doses) | **Wave 4** (Theatre)            | —                      |
| 2   | —                                | **Wave 6**, ADM-BRN-002 last    | —                      |

---

## 3. What to test first

Every one of the 95 has automated coverage at some layer. **The manual campaign earns its keep where a
suite is not watching, or cannot watch.** Run these seventeen before anything else in their wave — they
are the scenarios the master plan itself names as unproven, and they are ordered by what a failure
would cost.

| #   | ID              | Wave | C/P   | What no test asserts today                                                                     |
| --- | --------------- | ---- | ----- | ---------------------------------------------------------------------------------------------- |
| 1   | **NUR-MAR-002** | 2    | C0/P0 | The five rights **on a real screen at arm's length** — "exactly what no test layer can judge"  |
| 2   | **XC-BRN-005**  | 2    | C0/P0 | Nothing **interleaves** a branch switch with an in-flight write (ranked gap #1)                |
| 3   | **DOC-CHT-003** | 1B   | C0/P0 | The allergy on the **chart** and the **ward row**; jsdom covers only the round row, no browser |
| 4   | **NUR-MAR-006** | 2    | C0/P0 | Two nurses, two handsets. The server race is proven; **the human half never can be**           |
| 5   | **FD-REG-001**  | 1A   | C0/P0 | Search by name, UHID and phone finding **the same person** — the step before the MPI           |
| 6   | **XC-SAF-001**  | 1R   | C0/P0 | The seven wrongs as a **set**, on one patient, in one pass                                     |
| 7   | **XC-ID-001**   | 1R   | C0/P0 | One UHID carried register → queue → ward → round → invoice. D18 was exactly this shape         |
| 8   | **XC-FIN-001**  | 1R   | C0/P0 | One encounter's charges reconciled against its payments and its dispensed quantities           |
| 9   | **FD-SEC-002**  | 1A   | C0/P0 | Proven at the API by an agent 2026-08-19; **still unproven through a UI by a person** (BR-07)  |
| 10  | **NUR-VIT-002** | 2    | C0/P0 | Web defect D-2 was fixed at `375e4cf` and **never confirmed in a browser**                     |
| 11  | **DOC-RES-003** | 1C   | C0/P0 | D10 regression — the cross-branch report **file**, no E2E                                      |
| 12  | **FD-APT-004**  | 1A   | C0/P0 | D9 regression — a foreign site driving this site's clinic list, no E2E                         |
| 13  | **BIL-PAY-001** | 1E   | C0/P0 | The money adding up **under concurrency**, no browser test                                     |
| 14  | **DOC-ADM-002** | 2    | C0/P0 | One bed, two patients, however the requests interleave — no E2E                                |
| 15  | **PHR-DIS-003** | 1D   | C0/P0 | The **double-click** at the counter — `200 duplicate:true`, never a second row                 |
| 16  | **LAB-VER-001** | 1C   | C0/P0 | The runner certifying their own number — E2E is `⚠️ partial`                                   |
| 17  | **FD-REG-002**  | 1A   | C0/P0 | The UHID counter is **never raced** (ranked gap #7). Two clerks, two browsers, one moment      |

Four of these — **XC-SAF-001, XC-ID-001, XC-FIN-001** and **FD-REG-001** — are the same items the
master plan ranks as its top automation gaps. **Running them by hand does not close those gaps**, and a
manual pass must not be recorded as if it had.

---

## 4. The waves

Every wave states what must be true before it starts, and what must be true before the next one does.
**Manual status is `⬜ Not Tested` for all 95 rows and stays that way until a person writes an outcome
against it**, using the master plan's eight result classifications (§1.5) and nothing else.

### Wave 0 — Configuration, and the accounts no seed makes

Administrator and platform operator. **No patient.** This is the wave that makes every later wave
possible, so its failures are blocking by definition.

|                      |                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Prerequisites**    | ENV-01…ENV-08 in order. **ENV-04 is the hard gate** — `pnpm seed:validation -- --verify` must print `READY`; if it prints `BLOCKED`, stop the campaign. `tenant converged` from ENV-03 is weaker evidence than it sounds: the migration runner skips what it has already recorded, so an index dropped by hand reports converged while changing nothing. **Every clinical result taken before ENV-04 says READY is void.** |
| **Users**            | `ops@paperlesstech.in` (SUPER_ADMIN) · `admin@sunrise.test` (TENANT_ADMIN)                                                                                                                                                                                                                                                                                                                                                 |
| **Patients**         | None.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Catalogue / data** | `pnpm seed:operator && pnpm seed:demo` → two hospitals, thirteen staff accounts each. `pnpm seed:validation` **before 08:00 ward time**. Optionally `pnpm seed:clinical -- --patients 300` if the register needs to page.                                                                                                                                                                                                  |
| **Payment state**    | N/A                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Ward / bed state** | Branch A General Ward `GW-1`…`GW-45`, **42 admitted → three beds free**. Branch B Annexe `AW-…`, 6 beds, 3 admitted → three free. **That is the whole budget for Wave 2 and Wave 4.**                                                                                                                                                                                                                                      |
| **Must produce**     | The three unseeded accounts, via the Roles UI, **no code change**: a **branch-confined** front-desk user (`branchIds: [branchB]`), a **`FRONT_OFFICE`** user, an **`AUDITOR`**. A **theatre** (`seed:demo` creates none) — record against OT-REG-001. A **`licence-lab`** tenant for Wave 6.                                                                                                                               |

| ID              | Scenario                                                     | C   | P   | Automated coverage | Manual |
| --------------- | ------------------------------------------------------------ | --- | --- | ------------------ | ------ |
| **XC-RBAC-001** | Every protected route has an owner, and every permission ha… | C0  | P0  | Int ✅ · Unit ✅   | ⬜     |
| **ADM-ROL-001** | Every permission is held by somebody                         | C1  | P0  | Int ✅ · Unit ✅   | ⬜     |
| **ADM-USR-001** | Staff, roles and the seat limit                              | C1  | P0  | Int ✅ · E2E ✅    | ⬜     |
| **OPS-HOS-001** | Creating a hospital creates a database                       | C0  | P0  | Int ✅             | ⬜     |
| **XC-TEN-002**  | The address is the tenant, and a wrong address says so befo… | C1  | P0  | Int ✅ · E2E ✅    | ⬜     |

**Handoffs** — the accounts created here are the fixtures for FD-SEC-002 (1A), FD-PAY-001 (1A),
AUD-SEC-001 (6); the theatre is the fixture for Wave 4; `licence-lab` is the fixture for OPS-LIC-01…06.

**Exit criteria** — `--verify` printed `READY`; `pnpm --filter @medicore/api routes` shows no permission
without a holder; the three accounts sign in and their sidebars differ.

### Wave 1 — Front Desk → Doctor → Lab / Radiology → Pharmacy → Billing

**One patient, one branch, five legs, in order.** The master plan is explicit that a journey runs at
**one branch** — a patient registered at branch B cannot be opened from branch A (FD-REG-008), which is
recorded technical debt, and walking across two sites produces a "failure" that is a product decision.

|                      |                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Prerequisites**    | Wave 0 exit criteria met.                                                                                                                                                                                                                                                                                                                                            |
| **Users**            | `reception@`, the **FRONT_OFFICE** user, the **branch-confined** desk user, `drrao@`, `labtech@`, `pathologist@`, `radiographer@`, `pharmacy@`, `cashier@`                                                                                                                                                                                                           |
| **Patients**         | **P1** — one synthetic patient registered in 1A and carried to the end. **P1-dup** — the same human's details retyped, for FD-REG-004/005. **P1-merge** — a second chart to fold in for FD-REG-006. A **Branch-B** patient for FD-APT-004 and DOC-SEC-002.                                                                                                           |
| **Catalogue / data** | A lab test and an imaging study in the catalogue. A drug **with stock** and one **with none** (DOC-RX-001). A drug the patient is **allergic to** (DOC-RX-002) — the validation ward seeds ≥1 severe allergy. A prescription line of **20** to hand over **12** of (PHR-DIS-002). At least two lots of one drug with **different expiry dates** (PHR-STK-001, FEFO). |
| **Payment state**    | **Consultation charge raised by the visit event and left UNPAID** until leg 1C has seen the bench hold the lab work. Collect in 1C, then finalize in 1E. An **advance** on P1's purse for FD-PAY-003.                                                                                                                                                                |
| **Ward / bed state** | None — Wave 1 is outpatient throughout.                                                                                                                                                                                                                                                                                                                              |

**Leg 1A — Front Desk.** Search before you register (FD-REG-001), because that is the step whose
failure causes every duplicate the MPI then has to catch.

| ID             | Scenario                                                     | C   | P   | Automated coverage                   | Manual |
| -------------- | ------------------------------------------------------------ | --- | --- | ------------------------------------ | ------ |
| **FD-REG-001** | Existing patient detection before a second record is created | C0  | P0  | Int ⚠️ · E2E ❌ · Unit N/A · Mob ✅  | ⬜     |
| **FD-REG-002** | Registration issues a UHID, and the UHID is for life         | C0  | P0  | Int ✅ · E2E ⚠️ · Unit N/A · Mob N/A | ⬜     |
| **FD-REG-004** | MPI duplicate refusal names the candidate it thinks this al… | C0  | P0  | Int ✅ · E2E ❌ · Unit ❌ · Mob N/A  | ⬜     |
| **FD-REG-005** | The override exists, and only a human can use it             | C0  | P0  | Int ✅ · E2E ❌                      | ⬜     |
| **FD-REG-006** | Merge joins two charts and deletes nothing                   | C0  | P1  | Int ✅ · E2E ❌                      | ⬜     |
| **FD-VIS-001** | Starting a visit issues a token and puts the patient on the… | C1  | P0  | Int ✅ · E2E ⚠️                      | ⬜     |
| **FD-VIS-002** | Starting a visit twice resumes it; it never duplicates it    | C1  | P0  | Int ✅ · E2E ❌ · Unit ✅            | ⬜     |
| **FD-VIS-003** | The register's day is the BRANCH's day                       | C2  | P0  | Int ✅ · Unit ✅                     | ⬜     |
| **FD-VIS-005** | Every row on the register and the queue names its patient    | C1  | P0  | Int ✅ · E2E ⚠️                      | ⬜     |
| **FD-VIS-006** | Registration refuses safely when the database cannot enforc… | C0  | P1  | Int ✅ · Unit ✅                     | ⬜     |
| **FD-APT-002** | Check-in reaches the same front door as a walk-in            | C1  | P0  | Int ✅ · E2E ❌                      | ⬜     |
| **FD-APT-004** | A foreign site cannot drive this site's clinic list          | C0  | P0  | Int ✅ · E2E ❌                      | ⬜     |
| **FD-PAY-001** | What the visit costs appears without anybody typing it       | C1  | P0  | Int ✅                               | ⬜     |
| **FD-SEC-001** | The desk is refused every clinical write, at the API         | C0  | P0  | Int ✅ · E2E ❌                      | ⬜     |
| **FD-SEC-002** | A branch-confined desk user cannot exceed their binding      | C0  | P0  | Int ✅ · E2E ❌                      | ⬜     |

**Leg 1B — Doctor.**

| ID              | Scenario                                                      | C   | P   | Automated coverage                 | Manual |
| --------------- | ------------------------------------------------------------- | --- | --- | ---------------------------------- | ------ |
| **DOC-QUE-001** | The doctor's list loads, in an order the waiting room accepts | C1  | P0  | Int ✅ · E2E ⚠️ · Web ✅ · Mob ✅  | ⬜     |
| **DOC-CHT-001** | Opening a patient opens the right visit, and says who they…   | C0  | P0  | Int ✅ · E2E ✅ · Mob ✅           | ⬜     |
| **DOC-CHT-003** | Allergies are visible, and "none recorded" is not "no aller…  | C0  | P0  | Int ✅ · E2E ❌ · Unit ✅ · Mob ✅ | ⬜     |
| **DOC-CON-001** | The note saves, and typed clinical text is never lost         | C1  | P0  | Int ✅ · E2E ❌ · Web ✅ · Mob ✅  | ⬜     |
| **DOC-CON-002** | The doctor's note and the nurse's note are different routes…  | C1  | P0  | Int ✅ · Web ✅                    | ⬜     |
| **DOC-ORD-001** | An order reaches the department's bench with no hand-off      | C1  | P0  | Int ✅ · E2E ✅ · Mob ✅           | ⬜     |
| **DOC-ORD-004** | Ordering refuses safely when the database cannot enforce on…  | C0  | P1  | Int ✅                             | ⬜     |
| **DOC-RX-001**  | Availability informs the prescriber and restricts them not…   | C1  | P0  | Int ✅ · E2E ✅ · Web ✅           | ⬜     |
| **DOC-RX-002**  | An allergy blocks the signature until a human acknowledges it | C0  | P0  | Int ✅ · E2E ❌ · Unit ✅ · Mob ✅ | ⬜     |
| **DOC-RX-003**  | A signed prescription is a signature, and cannot be edited    | C0  | P0  | Int ✅ · Mob ✅                    | ⬜     |
| **DOC-RX-004**  | A lost signature response reconciles; it never double-signs   | C0  | P0  | Int ✅ · Mob ✅                    | ⬜     |
| **DOC-SEC-001** | A doctor may READ the round and may not chart on it           | C0  | P0  | Int ✅ · E2E ✅ · Web ✅           | ⬜     |
| **DOC-SEC-002** | A cross-branch chart is refused and must never render         | C0  | P0  | Int ✅ · E2E ✅ · Mob ✅           | ⬜     |

**Leg 1C — Laboratory and Radiology.** The unpaid charge from 1A is spent here: read the bench **before**
the cashier collects, then collect and watch the badge clear.

| ID              | Scenario                                                       | C   | P   | Automated coverage                          | Manual |
| --------------- | -------------------------------------------------------------- | --- | --- | ------------------------------------------- | ------ |
| **LAB-WRK-001** | The bench shows the work, who it is for, and what may be do…   | C1  | P0  | Int ✅ · E2E ✅ · Web ✅                    | ⬜     |
| **LAB-STA-001** | The order state machine moves only along legal edges           | C1  | P0  | Int ✅                                      | ⬜     |
| **LAB-VER-001** | The technician cannot certify their own number                 | C0  | P0  | Int ✅ · E2E ⚠️                             | ⬜     |
| **LAB-RES-001** | A critical value is alerted immediately, not eventually        | C0  | P0  | Int ✅ · E2E ✅ · Web ✅ · Mob ✅           | ⬜     |
| **LAB-SEC-001** | The bench stops at the branch, and the technician never get…   | C0  | P0  | Int ✅ · E2E ✅                             | ⬜     |
| **RAD-WRK-001** | A radiographer takes a study from the console to the chart,…   | C1  | P0  | Int ✅ · E2E ✅ · Web ✅                    | ⬜     |
| **RAD-SEC-001** | The radiographer the hospital actually has cannot open a chart | C0  | P0  | Int ✅ · E2E ✅                             | ⬜     |
| **RAD-SEC-002** | The imaging bench stops at the branch; imaging is gated on…    | C0  | P1  | Int ✅ · Web ✅                             | ⬜     |
| **DOC-RES-001** | A result is invisible until it is released                     | C0  | P0  | Int ✅ · E2E ✅ · Web ✅ · Mob ✅           | ⬜     |
| **DOC-RES-002** | A critical result announces itself, and stops announcing on…   | C0  | P0  | Int ✅ · E2E ✅ · Unit ✅ · Web ✅ · Mob ✅ | ⬜     |
| **DOC-RES-003** | The report file opens from the chart, and only from the rig…   | C0  | P0  | Int ✅ · E2E ❌                             | ⬜     |

**Leg 1D — Pharmacy.**

| ID              | Scenario                                                     | C   | P   | Automated coverage       | Manual |
| --------------- | ------------------------------------------------------------ | --- | --- | ------------------------ | ------ |
| **PHR-DIS-001** | The counter's queue holds signed prescriptions and nothing…  | C0  | P0  | Int ✅ · E2E ✅          | ⬜     |
| **PHR-DIS-002** | Partial handover: the patient is charged for what they were… | C0  | P0  | Int ✅ · E2E ✅          | ⬜     |
| **PHR-DIS-003** | Dispensing the same thing twice hands it over once           | C0  | P0  | Int ✅                   | ⬜     |
| **PHR-STK-001** | FEFO, and an expired box never leaves the shelf              | C0  | P0  | Int ✅ · E2E ✅ · Web ✅ | ⬜     |
| **PHR-DIS-004** | Dispensing refuses safely when the one-handover rule is une… | C0  | P1  | Int ✅                   | ⬜     |

**Leg 1E — Billing.**

| ID              | Scenario                                                | C   | P   | Automated coverage | Manual |
| --------------- | ------------------------------------------------------- | --- | --- | ------------------ | ------ |
| **BIL-CHG-001** | Charges arrive from events, and nobody types them twice | C1  | P0  | Int ✅             | ⬜     |
| **BIL-INV-001** | Finalizing turns a running tab into a document          | C1  | P0  | Int ✅             | ⬜     |
| **BIL-PAY-001** | The money adds up, including under concurrency          | C0  | P0  | Int ✅             | ⬜     |
| **BIL-SEC-001** | Finance boundaries                                      | C0  | P0  | Int ✅             | ⬜     |

**Roll-up — the same patient, read end to end.** These four are not a sixth leg; they are the question
"did the five legs describe one person?" and they are only answerable **after** 1E.

| ID             | Scenario                                                     | C   | P   | Automated coverage                 | Manual |
| -------------- | ------------------------------------------------------------ | --- | --- | ---------------------------------- | ------ |
| **XC-ID-001**  | One patient, one identity, from the front desk to the bill   | C0  | P0  | Int ✅ · E2E ✅ · Web ✅           | ⬜     |
| **XC-FIN-001** | Charges, payments and dispensing stay consistent             | C0  | P0  | Int ✅ · E2E ✅                    | ⬜     |
| **XC-SAF-001** | Wrong patient · wrong medicine · wrong result · wrong branch | C0  | P0  | Int ✅ · E2E ✅ · Unit ✅ · Mob ✅ | ⬜     |
| **XC-IDM-001** | A retry replays; it never repeats                            | C0  | P0  | Int ✅ · Unit ✅ · Web ✅ · Mob ✅ | ⬜     |

**Cross-role handoffs — the rows that actually fail**

| From → To                     | The handoff                                                                | Scenario                  |
| ----------------------------- | -------------------------------------------------------------------------- | ------------------------- |
| Registration → **the charge** | Starting a visit raises the consultation charge **with nobody typing**     | FD-VIS-001 · BIL-CHG-001  |
| Registration → **the queue**  | Token issued; the doctor's list carries the **UHID**                       | FD-VIS-005 · DOC-QUE-001  |
| Desk vitals → **the doctor**  | The doctor meets a patient they already know something about               | FD-VIT-001 → DOC-CHT-001  |
| Doctor order → **the bench**  | On the department's worklist **with no hand-off**, named and UHID'd        | DOC-ORD-001 → LAB-WRK-001 |
| Unpaid charge → **the bench** | The bench **holds** the work and says so; collecting clears the badge      | FD-PAY-002 → LAB-WRK-001  |
| Verify → **release**          | Values are **invisible to the doctor until released**                      | LAB-VER-001 → DOC-RES-001 |
| Critical value → **the bell** | Alerted immediately; stops announcing once read                            | LAB-RES-001 → DOC-RES-002 |
| Signature → **the counter**   | Only **signed** prescriptions reach the queue — a draft authorises nothing | DOC-RX-003 → PHR-DIS-001  |
| Handover → **the charge**     | The charge follows the **12**, not the 20, and arrives shortly after       | PHR-DIS-002 → BIL-CHG-001 |
| Handover → **the chart**      | The prescriber reads `12/20 given`                                         | PHR-DIS-002 → DOC-RX-003  |
| Everything → **the invoice**  | One document totalling all of it, against one UHID                         | BIL-INV-001 → XC-ID-001   |

**Exit criteria** — P1 has one chart, one UHID, one episode, one invoice, and the invoice's total
equals what the five legs raised.

### Wave 2 — Admission → Nurse → Ward → Doctor → Medication → Discharge

**The safety wave.** Eighteen of its twenty-two rows are C0, and the two most valuable scenarios in the
whole campaign are here.

|                      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Prerequisites**    | Wave 1 complete. **Doses must be genuinely due or overdue** — that is a clock state, not a seeded row. `--verify` prints the wall-clock minute the first overdue dose appears; do not start before it.                                                                                                                                                                                                                                                                         |
| **Users**            | `drrao@`, **`nurse@` and `nurse2@` as two people on two devices** — one account signed in twice is one identity, which is exactly what NUR-MAR-006 must not have. If only one handset is available, run everything else and mark NUR-MAR-006 **BLOCKED**. Do not fake the second nurse.                                                                                                                                                                                        |
| **Patients**         | The **long-stay patient** in bed `GW-1`, registered first and pushed outside the 100-most-recent window (NUR-WRK-003). A **medicated** patient from the 12. A **quiet** patient from the 30 with nothing due (NUR-MAR-011). A patient with a **severe allergy** (DOC-CHT-003). **P2** — admitted fresh from Wave 1's OP visit (DOC-ADM-001).                                                                                                                                   |
| **Catalogue / data** | The five seeded drugs, **all route `oral`, 5-day courses**: Paracetamol 500mg · Pantoprazole 40mg · Metformin 500mg · Amlodipine 5mg · Cetirizine 10mg. A **3-line** prescription and **the same drug scheduled AND as-required** for NUR-MAR-007. Round times OD 08 · BD 08/20 · TDS 08/14/20 · QID 06/12/18/22 · HS 22 · SOS · STAT.                                                                                                                                         |
| **Payment state**    | Bed-days accrue per **calendar day started, in the branch's zone** (DOC-ADM-004). Leave the IP bill open until discharge.                                                                                                                                                                                                                                                                                                                                                      |
| **Ward / bed state** | **Three free beds in `GW`, and they are the whole budget.** DOC-ADM-001 spends one; NUR-BED-001 needs one free to move into; DOC-ADM-002 collides with an occupied bed and spends none; DOC-DIS-001 returns one. **If Wave 4 also admits, re-seed rather than improvise.** Bed codes are `GW-1`…`GW-45` on purpose — the server pages in bed order, which is a **string** sort, so `GW-10` arrives before `GW-2`. That is the thing being looked at, not a bug in the fixture. |

| ID              | Scenario                                                       | C   | P   | Automated coverage                | Manual |
| --------------- | -------------------------------------------------------------- | --- | --- | --------------------------------- | ------ |
| **DOC-ADM-001** | Admission closes the OP visit and opens an IP stay in the s…   | C1  | P0  | Int ✅ · E2E ⚠️ · Mob ✅          | ⬜     |
| **DOC-ADM-002** | One bed cannot hold two patients, however the two requests…    | C0  | P0  | Int ✅ · E2E ❌ · Mob ✅          | ⬜     |
| **DOC-ADM-003** | Admission and transfer refuse safely when the occupancy rul…   | C0  | P1  | Int ✅                            | ⬜     |
| **DOC-ADM-004** | Bed-days bill per calendar day started, in the branch's tim…   | C0  | P1  | Int ✅ · Unit ✅                  | ⬜     |
| **NUR-WRK-002** | Every ward row names its patient; every administering surfa…   | C0  | P0  | E2E ✅ · Web ✅                   | ⬜     |
| **NUR-WRK-003** | The long-stay patient still has a name                         | C0  | P0  | Int ✅ · E2E ✅ · Web ✅          | ⬜     |
| **NUR-VIT-001** | A reading saves, an implausible one is refused, and nothing…   | C1  | P0  | Int ✅ · Web ✅ · Mob ✅          | ⬜     |
| **NUR-VIT-002** | A lost vitals response reconciles to one reading — and a re…   | C0  | P0  | Int ✅ · E2E ❌ · Web ✅ · Mob ✅ | ⬜     |
| **NUR-MAR-001** | The round is one request, in the branch's day, ordered by w…   | C1  | P0  | Int ✅ · Web ✅ · Mob ✅          | ⬜     |
| **NUR-MAR-002** | The five rights, on the screen a drug is given from            | C0  | P0  | E2E ✅ · Web ✅ · Mob ✅          | ⬜     |
| **NUR-MAR-003** | Give is the server's word, not the screen's                    | C0  | P0  | Int ✅ · E2E ❌ · Web ✅ · Mob ✅ | ⬜     |
| **NUR-MAR-005** | A dose already charted is answered, never re-offered           | C0  | P0  | Int ✅ · Web ✅ · Mob ✅          | ⬜     |
| **NUR-MAR-006** | Two nurses, two devices, one dose                              | C0  | P0  | Int ✅                            | ⬜     |
| **NUR-MAR-007** | PRN is deliberately different, and line identity is a position | C0  | P1  | Int ✅ · Unit ✅ · Mob ✅         | ⬜     |
| **NUR-MAR-008** | A client may not declare its own slot, and a dead prescript…   | C0  | P1  | Int ✅                            | ⬜     |
| **NUR-MAR-009** | A lost MAR response reconciles; it never charts twice          | C0  | P0  | Int ✅ · Unit ✅ · Mob ✅         | ⬜     |
| **NUR-MAR-010** | A stale row is safe to tap                                     | C0  | P0  | Int ✅ · Web ✅ · Mob ✅          | ⬜     |
| **NUR-MAR-011** | The round is honest about how much of the ward it can see      | C0  | P0  | Web ✅ · Mob ✅                   | ⬜     |
| **NUR-MAR-012** | Charting refuses when the database cannot enforce the dose-…   | C0  | P0  | Int ✅ · Unit ✅ · Mob ✅         | ⬜     |
| **XC-BRN-005**  | Switching branch mid-workflow does not complete against the…   | C0  | P0  | Int ✅ · E2E ❌ · Web ✅ · Mob ✅ | ⬜     |
| **NUR-SEC-001** | A nurse is refused the doctor's authority, at the API          | C0  | P0  | Int ✅                            | ⬜     |
| **DOC-DIS-001** | Nobody goes home without a summary, and never with two         | C1  | P0  | Int ✅ · Mob ✅                   | ⬜     |

**Cross-role handoffs**

| From → To                         | The handoff                                                                   | Scenario                  |
| --------------------------------- | ----------------------------------------------------------------------------- | ------------------------- |
| Admission → **the episode**       | The OP visit **closes**; an IP encounter opens **in the same episode**        | DOC-ADM-001 → XC-ID-001   |
| Admission → **the ward board**    | The bed shows occupied; a second admission to it is `409 HMS-STATE-001`       | DOC-ADM-001 → DOC-ADM-002 |
| Nurse writes → **the right stay** | Vitals, note and dose attach to the **IP** encounter, not the closed OP one   | NUR-VIT-001 · NUR-MAR-003 |
| Prescription → **the round**      | Due and overdue rows appear in the **branch's** day, ordered by what is late  | DOC-RX-003 → NUR-MAR-001  |
| The round → **the chart**         | A charted dose is answered and **never re-offered**                           | NUR-MAR-005 → DOC-RX-003  |
| Discharge → **the bed**           | The stay closes and the bed **frees on `/ward`**; a second summary is refused | DOC-DIS-001 → NUR-WRK-002 |
| Discharge → **the bill**          | One bed-day charge per calendar day started                                   | DOC-ADM-004 → BIL-INV-001 |

**Exit criteria** — no dose charted twice, no dose lost, every administering surface carried a name
**and** a UHID, and the bed the patient left is free.

### Wave 3 — Emergency

**The best-covered journey in the product** — five of its six handoffs are already proven in a browser.
It is scheduled early anyway because it is short, self-contained, and shares no fixture with Wave 2.

|                      |                                                                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Prerequisites**    | Wave 0. Independent of Waves 1, 2, 4 and 5 — **runs in parallel with Wave 1 if a second tester is free.**                                                             |
| **Users**            | `reception@` (arrival), `nurse@` (triage), `drrao@` (work-up and disposition)                                                                                         |
| **Patients**         | **P3** — a fresh arrival registered with the ED checkbox. A second arrival so the board has something to sort against.                                                |
| **Catalogue / data** | An imaging study, to prove an ED order lands on the **ordinary** bench rather than a separate ED one.                                                                 |
| **Payment state**    | None required — do not settle, so the closed-visit refusals in EMG-STA-001 are clean.                                                                                 |
| **Ward / bed state** | Only if the disposition tested is **admit** — and that spends one of the three free beds. Prefer **discharge** or **transfer-out** here and leave the beds to Wave 2. |

| ID              | Scenario                                                      | C   | P   | Automated coverage       | Manual |
| --------------- | ------------------------------------------------------------- | --- | --- | ------------------------ | ------ |
| **EMG-ARR-001** | An emergency arrival is a visit, registered the ordinary way  | C1  | P0  | Int ✅ · E2E ✅          | ⬜     |
| **EMG-TRI-001** | An unassessed patient sorts ABOVE every assessed one          | C0  | P0  | Int ✅ · E2E ✅ · Web ✅ | ⬜     |
| **EMG-WRK-001** | The ED is worked on the ordinary clinical screens, and its…   | C1  | P0  | Int ✅ · E2E ✅ · Web ✅ | ⬜     |
| **EMG-DIS-001** | A patient leaves the board exactly when they leave the depa…  | C1  | P0  | Int ✅ · E2E ✅          | ⬜     |
| **EMG-STA-001** | A visit that has already ended refuses both writes            | C0  | P0  | Int ✅                   | ⬜     |
| **EMG-SEC-001** | Who may look, who may judge, and which hospital's board it is | C0  | P0  | Int ✅ · E2E ✅ · Web ✅ | ⬜     |

**Cross-role handoffs** — arrival → **on the board within a minute, untriaged**; triage → **untriaged
sorts above critical**, and a re-triage is a revision, not a second row; send to doctor → **the board
names the doctor**; disposition → **off the board**; then a retry against the closed visit → **both
writes refused** (the D14 regression).

**Exit criteria** — the board is empty of P3, and the closed visit refuses both writes.

### Wave 4 — Operating Theatre

|                      |                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Prerequisites**    | **A theatre exists.** `seed:demo` creates none — it was added in Wave 0 (OT-REG-001).                                                                  |
| **Users**            | `admin@` (registry, Wave 0), `nurse@` (booking and the list), `drrao@` (the operative note)                                                            |
| **Patients**         | **P4** — one patient with an open visit. Admission is not required for the booking itself.                                                             |
| **Catalogue / data** | A procedure and a surgeon. Two adjacent time windows for the back-to-back case.                                                                        |
| **Payment state**    | None.                                                                                                                                                  |
| **Ward / bed state** | None, **unless** the patient is admitted — in which case it competes with Wave 2 for the three free beds. Schedule Wave 4 **after** Wave 2 discharges. |

| ID             | Scenario                                                     | C   | P   | Automated coverage       | Manual |
| -------------- | ------------------------------------------------------------ | --- | --- | ------------------------ | ------ |
| **OT-BOK-001** | Two procedures cannot share a theatre and a moment — and ba… | C1  | P0  | Int ✅ · E2E ✅          | ⬜     |
| **OT-STA-001** | The booking moves only along legal edges, and the record de… | C1  | P0  | Int ✅ · E2E ✅ · Web ✅ | ⬜     |

**Cross-role handoffs** — admin registry → **nurse's list**; an overlapping booking → **refused in the
browser with the form preserved**; a **back-to-back** booking → **accepted**, because the intervals are
half-open; start → complete → the doctor's operative note is **write-once** and is **refused on a
`scheduled` booking**; closing the visit → the chart's **Procedures tab carries it, naming the surgeon**.

**Exit criteria** — one booking, one operative note, one procedures row, and the overlap refused.

### Wave 5 — General Stores · **parallel track, any day**

|                      |                                                                                                                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Prerequisites**    | Wave 0 only. **No dependency on any other wave, in either direction.**                                                                                                                                     |
| **Users**            | `store@` (STORE_KEEPER) — and note this role holds **no** `patient:read`. `GET /inventory-destinations` exists precisely so the ward picker can be filled without handing a store keeper the patient list. |
| **Patients**         | **None, ever.** A store keeper's work is about a box of gloves.                                                                                                                                            |
| **Catalogue / data** | A supplier, an item, a delivery to receive, a ward to issue to.                                                                                                                                            |
| **Payment state**    | N/A                                                                                                                                                                                                        |
| **Ward / bed state** | A ward exists as an **issue destination** only.                                                                                                                                                            |

| ID              | Scenario                       | C   | P   | Automated coverage | Manual |
| --------------- | ------------------------------ | --- | --- | ------------------ | ------ |
| **STO-STK-002** | The shelf cannot go below zero | C1  | P0  | Int ✅ · E2E ✅    | ⬜     |

**Also run here** (C1/P1, fixtures already standing): STO-STK-001 (the ledger reproduces the number on
the screen), STO-SEC-001 (a store is a room, and the room is at a site), STO-IDM-001 (a retried receipt
receives once).

**Exit criteria** — the shelf rises on receipt, falls on issue, refuses to go below zero **in words**,
and the ledger reproduces the number on the screen movement by movement.

### Wave 6 — Governance: tenancy, session, audit, platform

Cross-cutting only. Everything role-shaped has already been run at the end of its own wave.

|                      |                                                                                                                                                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Prerequisites**    | Waves 1–5 complete — **ADM-AUD-001 needs a real day's activity to inspect.**                                                                                                                                                                  |
| **Users**            | `admin@`, the **AUDITOR** from Wave 0, `ops@paperlesstech.in`, and a **`district`** hospital login for XC-TEN-001                                                                                                                             |
| **Patients**         | None new. The audit trail is read against the patients Waves 1–3 touched.                                                                                                                                                                     |
| **Catalogue / data** | The **`licence-lab`** tenant from Wave 0. `pnpm seed:licence -- --slug licence-lab --state active\|expiring\|grace\|expired` — each command prints the state **the server computed**, so the line it prints is the state actually under test. |
| **Payment state**    | N/A                                                                                                                                                                                                                                           |
| **Ward / bed state** | N/A                                                                                                                                                                                                                                           |

| ID              | Scenario                                                     | C   | P   | Automated coverage                  | Manual |
| --------------- | ------------------------------------------------------------ | --- | --- | ----------------------------------- | ------ |
| **XC-TEN-001**  | Hospital A cannot reach Hospital B, holding a valid Hospita… | C0  | P0  | Int ✅                              | ⬜     |
| **XC-BRN-001**  | A → B → A, and nothing of the previous site survives         | C0  | P0  | Int ✅ · E2E ✅ · Web ✅ · Mob ✅   | ⬜     |
| **XC-AUTH-001** | Sign-in, refresh, theft detection, and the session that end… | C0  | P0  | Int ✅ · E2E ✅ · Web ✅ · Mob ✅   | ⬜     |
| **XC-STA-001**  | Every state machine refuses its illegal edges                | C1  | P0  | Int ✅ · E2E ⚠️ · Unit ✅ · Mob N/A | ⬜     |
| **ADM-AUD-001** | The activity trail records what happened, and can prove it…  | C0  | P0  | Int ✅ · E2E ✅                     | ⬜     |
| **ADM-SEC-001** | What the administrator cannot do                             | C0  | P0  | Int ✅ · E2E ✅                     | ⬜     |
| **OPS-SUS-001** | Suspension locks a hospital out and touches none of its data | C0  | P1  | Int ✅                              | ⬜     |

**Also run here**: AUD-SEC-001 (read-only means read-only — the account made in Wave 0), OPS-PLN-001,
OPS-LIC-01…06 (**LIC-06 is 🟡 Blocked** — it needs a tenant whose edition excludes
`module.clinical.nursing`), ADM-BRN-001, ADM-CFG-001, ADM-ENT-001, XC-BRN-002/003/004, XC-RBAC-002,
XC-NET-001…009.

**Fenced actions — read before running**

| Action                                     | Fence                                                                                                                                        |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **OPS-SUS-001** — suspend a hospital       | **Never `sunrise`.** Use `licence-lab` or `district`. A suspended tenant's staff cannot sign in, and that ends the campaign.                 |
| **OPS-LIC-01…06** — licence states         | Dedicated tenant only. The script **refuses any slug without `licence` in it**, for exactly this reason.                                     |
| **ADM-BRN-002** — deactivate a branch      | **Last action of the campaign**, after Wave 2 has released the ward. Restore the branch in the same session.                                 |
| A **schema-drifted** tenant (runbook §16A) | Drop one index **and restore it in the same session.** A dropped safety index reports as seven catastrophic failures that are all the index. |

**Exit criteria** — a `403 HMS-AUTH-005` for a permission the role lacks, a `404 HMS-GEN-404` for a
resource outside scope (**deliberately, because a 403 would confirm the record exists**), a
`403 HMS-PLAN-002` for a module the hospital did not buy — and an audit trail that accounts for the
campaign.

---

## 5. Recording the run

**A hidden button is not evidence; a `403` is.** Where a UI observation is also available it is a
second, weaker one.

- Use only the master plan's eight classifications: **PASS · FAIL · BLOCKED · ENVIRONMENT ISSUE · DATA
  ISSUE · KNOWN DEFECT · PRODUCT DECISION REQUIRED · N/A**. `BLOCKED` is a respectable answer.
- **Never convert an automated PASS into a manual PASS**, and never convert an untested scenario into
  one. If the repository does not define the behaviour, write **PRODUCT DECISION REQUIRED**.
- **No scenario in this campaign requires performing an unsafe clinical action.** Every safety control
  is validated by _attempting_ the unsafe act and _observing the refusal_.
- Before filing anything, run the master plan's three questions (§23.1) — and write `D-2` in full,
  because **three different things are called that** (§1.6).
- Two failure modes that are not defects: containers showing `Exited (137)` are the local Docker memory
  ceiling; a red MAR run between 05:30 and 09:30 IST is a real ward-timezone window.

**Status of this campaign: ⬜ Not Tested — 0 of 95 executed.**
