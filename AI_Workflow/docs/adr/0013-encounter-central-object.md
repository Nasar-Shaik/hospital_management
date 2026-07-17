# ADR-0013: Encounter is the Central Clinical Object (not Appointment)

**Status:** Accepted · **Date:** 2026-07-14 · **Supersedes:** nothing (extends ADR-0002, ADR-0011)

## Context

The system was built appointment-first, because appointments were built first. That is an accident of sequence, and it has already hardened into the architecture:

- `queues`, `tokens` and `waitingList` are specified as collections **inside** the Appointments module (Doc 02 E1). A hospital that never books an appointment must enable the appointment book to issue a token.
- `BUSINESS_WORKFLOWS` §1 calls a walk-in an **exception**: _"walk-in without appointment (queue-only token)"_. For a government hospital and a single-doctor clinic, the walk-in **is the journey** and the appointment is the exception. The dominant path is modelled as an edge case of the minority path.
- In code, `tokenNumber` lives on the `appointments` document. A walk-in patient cannot be issued a token today without fabricating an appointment.
- `visits` exists in Doc 03 as a **table with no lifecycle, no module and no state machine** — while Appointment, Admission, Bed, Invoice and Lab Order all have one. It was specified as storage and never as a concept.
- `admissions` hangs off `patients` as a **parallel root**, not off the visit. "The OP consultation, its investigations and its prescriptions should become part of the admission episode" is therefore _structurally impossible_: there is no object that holds them.

MediCore must serve 25 organization types from one codebase (Constitution §1) — private hospital, government hospital, medical college, diagnostic centre, single-doctor clinic, multi-branch network. **Not one of them is appointment-first except the private hospital.**

## Decision

**The Encounter is the central clinical object.** An Appointment is demoted to one of several _origins_ of an Encounter, and stops being an entry point.

### 1. The four clinical objects

| Object            | FHIR R4 analogue   | Answers                                                               |
| ----------------- | ------------------ | --------------------------------------------------------------------- |
| **Encounter**     | `Encounter`        | "Why is this person in the building, and where are they in the flow?" |
| **EpisodeOfCare** | `EpisodeOfCare`    | "Which encounters belong to one continuous care story?"               |
| **Order**         | `ServiceRequest`   | "What did we decide to do to them, and did it happen?"                |
| **Result**        | `DiagnosticReport` | "What came back, who verified it, and who is waiting for it?"         |

**We use the FHIR R4 names deliberately, and this is not aesthetics.** We are already committed to **NHCX** for insurance claims (EVENT_CATALOG). NHCX is part of **ABDM**, and ABDM is FHIR R4. Naming these objects to match FHIR costs nothing today and makes ABDM/NHCX integration a _mapping_ rather than a _translation_. Renaming them later — once they are foreign keys on every clinical row — is a PHI migration.

The blueprint's word **`visit` is retired** in favour of `encounter`. "Visit" is ambiguous in Indian hospital usage (it usually means one OP consultation), which is exactly the narrower thing we must not conflate with the episode.

### 2. Encounter origins

`encounter.origin` ∈ `appointment | walk_in | emergency | referral | camp | telemedicine | corporate | transfer`.

An Appointment is a **promise of a future encounter**. It is not the encounter. The Encounter is created at **arrival** (check-in, or registration for a walk-in) — because that is when the hospital actually starts owing the patient something. An appointment that is never attended produces a no-show, not an encounter.

### 3. The Order is the spine that makes information follow the patient

"Doctor orders appear automatically in the destination department; reports become available automatically to the requesting doctor" is **not a queue feature**. It is the Order lifecycle.

Order is **one polymorphic object** with a `category` (`lab | radiology | pharmacy | procedure | referral | admission | diet`), placed **against an Encounter**, not against an EMR note.

**Orders do NOT hang off `emrRecords`, and Doc 03 is corrected accordingly.** Documentation is not the thing that requests work. An order must survive a note being amended, and must exist where there is no note at all — a diagnostic centre performing a walk-in scan has orders and no consultation, and it is one of our six target organization types.

### 4. Admission is a LINKED encounter, not a continuing one

The OP encounter **closes**. An inpatient encounter **opens**. Both belong to one **EpisodeOfCare**.

Rejected: extending one encounter across the admission. Reasons, in the hospital's own terms:

- **Billing** — OP and IP tariffs differ, and bed charges accrue per day against the IP encounter. A merged encounter cannot be billed correctly.
- **Statutory reporting** — midnight census, ALOS, admission/discharge counts and NABH all count _encounters_. A merged object corrupts every one of those numbers.
- **Irreversibility** — two encounters can always be _joined_ into a timeline. One encounter can never be _split_ back apart once notes, orders and charges have accumulated on it.

> **Continuity is a read concern. Separation is a billing and statutory concern. Never trade the second away to buy the first.**

The doctor still sees one unbroken history, because the timeline is a **read model over the EpisodeOfCare** — not a storage decision. That delivers "all OP history becomes part of the admission episode" without destroying the ability to bill or report.

### 5. Journey variation is POLICY, not a workflow engine

**We will not build a configurable workflow/BPMN engine.** It is how HMS projects die: it becomes a programming language with no debugger, every hospital acquires a bespoke graph, and you arrive at "different codebases" — hidden inside data, where CI cannot see them and no test can cover them. That is the exact outcome the modular monolith exists to prevent.

The three canonical journeys share **one state graph**. They differ in about five switches, which live in an `encounterPolicy` on tenant/branch settings (ADR-0011: configuration-first):

| Policy          | Private hospital | Small clinic | Government hospital  |
| --------------- | ---------------- | ------------ | -------------------- |
| `entry`         | appointment      | walk-in      | walk-in              |
| `tokenIssuedAt` | check-in         | registration | registration         |
| `routing`       | named doctor     | the doctor   | department / OP room |
| `billingMode`   | prepaid          | postpaid     | zero-tariff          |
| `pharmacy`      | in-house         | external     | in-house             |

One state machine (STATE_MACHINE_CATALOG §14). Bounded configuration. No engine.

### 6. `organizationType` is a PRESET, never a branch

A tenant carries `organizationType` (private hospital, government hospital, medical college, diagnostic centre, clinic…). At **provisioning** it selects a bundle: which feature flags are on, which tariff (zero-rated or commercial), which `encounterPolicy`. **After that moment it is descriptive only.**

`if (tenant.organizationType === "government")` **is forbidden anywhere in the codebase.** Two reasons:

1. Constitution §1 requires 25 organization types from one codebase, differentiated _only_ by feature flags, limits, configuration and permissions. A type branch is a 26th axis that CI cannot enforce and tests cannot cover.
2. **The branch is not even true.** Government hospitals routinely run _paid private wards_ beside free general wards. A hard branch makes that customer unsellable; a tariff makes them a config change.

**"Government hospital" therefore does not mean "skip billing" — it means a ZERO-RATED TARIFF.** Every charge is still posted to the encounter at ₹0. A government hospital is legally required to report drug consumption, per-patient cost and NHM utilisation; if we skip billing for them we discard the very data they must produce, and it cannot be reconstructed. A zero-rupee invoice is a record. A missing invoice is a hole.

### 7. Feature flags are unbundled

`module.ops.opd` (encounter + queue) becomes **independent of** `module.ops.appointments`. A government hospital buys OPD without the appointment book. Today it cannot — that is the bug this ADR closes.

## Consequences

**Backward compatible.** Nothing already shipped is thrown away:

- **Patients (C1)** — unchanged. UHID is already the identity anchor; that decision holds up.
- **Appointments (E1)** — keeps its state machine _and_ its double-booking unique index (the correctness core survives untouched). It is demoted to an origin. `checked_in` now also creates an Encounter.
- **`tokenNumber` moves from `appointments` to `encounters`** — 6 source locations at the time of writing. Cheap now; a PHI migration once Lab/EMR/Billing reference it. **This is the single change that gets expensive if deferred.**
- **Notifications (A6)** — purely additive: gains `encounter.*` and `order.*` triggers. Existing templates keep working.
- **Audit (A5)** — Encounter becomes the access anchor and the natural unit for break-glass ("who opened this chart, during which encounter").

**Sequencing is not negotiable:** Encounter + Order + Queue land **before** EMR, Lab, Radiology and Billing. Every clinical row needs `encounterId` from birth. Retrofitting that foreign key into vitals, notes, orders and charges later is a migration across live PHI — the most expensive migration this system will ever perform.

**Cost accepted:** one extra object between Patient and everything clinical, and a two-step registration for the simplest clinic (register → encounter). We accept it because the alternative is a system that can only serve one of our six target organization types.

## Alternatives considered

**Keep Appointment as the entry point; treat walk-ins as appointments created at the desk.** Rejected: it is what we have, and it forces a government hospital to fabricate an appointment to see a patient. It also puts the queue inside a module a clinic may not have bought, and it models the majority journey as an exception to the minority one.

**Encounter and Admission as separate unrelated roots (the current blueprint).** Rejected: it makes "the admission inherits the OP history" impossible to express, which is the single loudest requirement from real hospital users.

**One Encounter spanning OP → IP → discharge.** Rejected — see §4. Un-splittable, unbillable, and it corrupts statutory census reporting.

**A configurable workflow engine per tenant.** Rejected — see §5. It is "different codebases" wearing a disguise.
