# STATE MACHINE CATALOG

Authoritative lifecycles for stateful entities. **Code must implement exactly these states and transitions**; adding/renaming a state without updating this file is a defect (Guidelines §4). Transitions not listed are invalid and must be rejected with `HMS-STATE-001` (see ERROR_CODES).

Conventions: state values are lowercase snake in code (`checked_in`); every transition records `{by, at, reason?}` in the entity's status history; terminal states are **bold**.

---

## 1. Appointment

```
requested → confirmed → checked_in → in_consultation → completed
requested|confirmed → cancelled            (by patient/staff; reason required)
confirmed → no_show                        (auto, post grace period)
confirmed → rescheduled                    (creates new appointment, links parent)
```

Guards: `checked_in` only on appointment day; `cancelled` after `checked_in` requires staff permission. Terminal: **completed, cancelled, no_show, rescheduled**.

> **An Appointment is a promise of an Encounter, not the Encounter (ADR-0013).** `checked_in` is the moment the promise is kept: it **creates the Encounter** (origin `appointment`) and hands the patient to §14. The appointment's own remaining states then merely mirror the encounter's — the clinical truth lives on the Encounter. A hospital with no appointment book skips this machine entirely and starts at §14.

## 2. Admission

```
requested → admitted → (transferred ⇄ admitted) → discharge_initiated → discharged
admitted → lama | absconded | deceased
```

Guards: `admitted` requires bed allocation in same transaction; `discharged` requires bill finalized or approved credit + discharge summary signed; `deceased` requires death summary → mortuary flow. Terminal: **discharged, lama, absconded, deceased**.

## 3. Bed

```
available → reserved → occupied → vacated_dirty → cleaning → available
available|reserved → blocked → available          (maintenance; reason required)
```

Guards: `occupied` only via admission/transfer transaction; concurrent allocation prevented by optimistic lock (double-allocation is the classic HIS bug). No terminal state (decommission = soft delete).

## 4. Invoice (Bill)

**Implemented (F-group, 2026-07-16) — reduced to what shipped.** The full graph below it remains the target; the refund and credit-note arms land with the insurance/claims work and are NOT built.

```
draft → finalized → paid
draft|finalized → cancelled
```

Guards:

- **`finalized` assigns the invoice number** from an atomic `counters` `$inc` and FREEZES the lines. An invoice that can still be edited once it is in a patient's hand is not a document, it is a suggestion. Two cashiers finalizing at the same instant must not both be handed `INV-2026-00042` — a duplicate invoice number is a tax problem, not a display bug.
- **A ₹0 total finalizes straight to `paid`.** A government hospital must not accumulate "unpaid" invoices nobody will ever pay: it would make every outstanding-balance report meaningless, and the product would be blamed for a problem it invented.
- **Payment is refused on a `draft`.** Taking money against a bill whose lines can still change is how a patient pays for a test they were never given. Overpayment is refused outright.
- `partially_paid` is NOT a state — it is `finalized` with `paid > 0`. A separate state buys nothing that the number does not already say, and every consumer would have to know both.

Not yet built: `pending_finalization`, discount approval thresholds, `cancelled_reversed` (credit notes), and the refund arm.

```
(target) draft → pending_finalization → finalized → partially_paid → paid
finalized|partially_paid → cancelled_reversed      (credit-note reversal only, never delete)
paid → refund_in_progress → refunded_partial|refunded_full
```

Terminal: **paid, cancelled**.

## 4b. Charge (tenant DB) — the ledger line

Not a state machine; a ledger. Charges are POSTED and may be VOIDED, never deleted — money that vanishes cannot be audited. A charge already attached to a finalized invoice cannot be voided; reversing it is a credit note, which is a different document.

Guards:

- **One charge per cause.** Unique on `(sourceId, code)` where `sourceId` exists. The outbox is at-least-once BY DESIGN, so the consumer that bills a lab order WILL run twice; without the index the patient pays for two blood tests and had one, and finds out at the counter in front of a queue. Partial, because a manual charge has no `sourceId` and a cashier must be able to post two identical dressings on purpose.
- **`listPrice` and `amount` are different numbers.** `listPrice` is what the care is worth; `amount` is what the patient owes. Under `zero_tariff` `amount` is 0 and `listPrice` is intact — free to the patient is not free to the state, which still has to cost the encounter and report drug consumption.
- **A missing tariff entry never blocks a clinical action.** The charge posts at ₹0 with a loud log. A biller's data-entry backlog must not be able to stop a doctor investigating a patient.

## 5. Payment

```
initiated → processing → captured → settled
initiated|processing → failed
captured → refund_initiated → refunded
processing → pending_reconciliation → captured|failed   (gateway webhook lag)
```

Guards: idempotency key mandatory at `initiated`; `captured` posts to journal exactly once. Terminal: **settled, failed, refunded**.

## 6. Prescription

**Implemented** — `modules/prescriptions/prescription.model.ts`, with one guard deliberately NOT built (stock; see below).

```
draft → signed → partially_dispensed → dispensed
draft → discarded
signed → cancelled                  (doctor only; reason; already-dispensed doses unaffected)
partially_dispensed → cancelled     (same; the tablets already given remain given)
```

Guards:

- **`signed` is immutable.** Editing one is refused, and the refusal names the way out (`POST /prescriptions/:id/amend`) — a new DRAFT at `version + 1` that supersedes the original, leaving it exactly as it was signed. Without an amend path, "immutable" would mean a doctor who typed 500mg for 50mg could only cancel and start again, and the fact that one was a CORRECTION OF THE OTHER — the most interesting thing about it six months later — would be lost.
- **The dispensing states are DERIVED, never chosen.** Nobody clicks "partially dispensed": it is what is true when some lines are handed over and some are not, computed from the quantities in `pharmacy.service.ts`. A status set by hand is a status that will eventually disagree with the quantities it claims to summarise.
- **Nobody gets more than was prescribed**, and the guard is in the QUERY (`$expr` + `$arrayElemAt`, `prescription.repository.ts`), not an `if`. A read-then-check lets two pharmacists both see "2 left", both pass, and both hand over 2 — the patient walks out with 12 tablets of a drug they were prescribed 10 of, and the ledger says it never happened.
- **There is no `dispensed → cancelled`.** Once everything is handed over there is nothing left to stop; telling the patient to stop taking it is a clinical instruction, not a state change on a document that has already been fully executed.

**NOT implemented: "dispensing decrements batch stock transactionally".** There are no batches — no inventory, no expiry, no purchasing. `pharmacy:stock` exists as a permission and nothing writes it. This module is a counter without a warehouse and says so: it will let you dispense a drug the shelf does not have. That is recorded as debt in PROJECT_MEMORY rather than papered over, because a stock number that is only sometimes decremented is worse than no stock number — people believe it.

Terminal: **dispensed, discarded, cancelled**.

### 6b. Dispense (append-only ledger)

Not a state machine — a LEDGER, and that is the point. "Was it dispensed" is not a boolean on the prescription: a prescription for 10 can be handed over as 6 today and 4 on Thursday, which is every pharmacy in the country by mid-afternoon. Each handover is its own immutable row (`dispenses`) carrying its own quantity, time and pharmacist. `dispensedQty` on a prescription line is a SUM of these rows — a total you can rebuild is a total you can audit; a total you can only increment is a total you have to trust.

There is no update path and no delete path. A handover that turns out to be wrong is corrected by a return, which is another row — never by editing history so that it says the drug was never given. The tablets are in the patient either way.

**Why each handover is separately chargeable:** billing keys the drug charge on the DISPENSE id. Keyed on the prescription, `one_charge_per_cause` (migration 0014) would take the first charge and silently swallow the second — ten tablets given, six paid for, no error anywhere.

## 7. Specimen (was "Lab Order" — SUPERSEDED by §15)

> **The lifecycle of a lab ORDER is §15, not this.** ADR-0013 §3 makes the Order one polymorphic object across lab, radiology, pharmacy, procedure, referral, admission and diet — one machine, because the lifecycle does not differ by category; only the destination does. Two competing order machines in this catalog would be a defect by its own opening rule, since code must implement _exactly_ these states.
>
> What was written here was never really an order lifecycle. It was **two** lifecycles wearing one name: the order's (`ordered → … → reported`) and the **specimen's** (`sample_pending → collected → received_in_lab → rejected_sample → recollect`). Those two genuinely are different — a tube of blood is a physical object that can be haemolysed, mislabelled, lost in transit, or drawn again — and merging them is what made the original machine unimplementable without a `category === "lab"` branch.
>
> So the sample states stay, as the SPECIMEN machine, and they will ship with the Lab module. The order states move to §15.

**Not yet implemented** — the Order (§15) carries lab work today, and does so without a specimen. A hospital that sends its samples to an outside lab needs exactly that and nothing more.

```
pending → collected → in_transit → received → accepted
collected|in_transit|received → rejected → pending      (recollect: haemolysed, clotted, mislabelled)
pending → cancelled                                     (the order was called off before the draw)
```

Guards:

- **A rejected specimen does NOT cancel the Order.** The order is still owed; a new tube is drawn against it. Collapsing the two is how a patient gets told their test was cancelled when in fact it is being repeated.
- **`rejected` must carry a reason**, and the reason is clinical, not administrative: a haemolysed potassium reads falsely high, which is the exact value most likely to trigger a panic alert. A specimen the lab silently re-ran is a wrong number nobody can trace.
- Cancelling an Order after the specimen is drawn must not silently discard it (§15) — the specimen has its own life, and somebody is holding the tube.

Terminal: **accepted, cancelled**.

## 8. Insurance Claim

```
draft → pre_auth_pending → pre_auth_approved|pre_auth_denied
pre_auth_approved → submitted → under_review → approved → settlement_pending → settled
under_review → queried → resubmitted → under_review
submitted|under_review → denied → appeal_submitted → under_review | written_off
```

Guards: `submitted` requires complete document checklist; every payer response recorded in `claimStatusHistory`. Terminal: **settled, written_off, pre_auth_denied** (unless converted to self-pay).

## 9. Asset

```
requisitioned → procured → installed → active ⇄ under_maintenance
active → breakdown → under_repair → active | condemned
active → transferred (branch move; stays active)
condemned → disposed
```

Guards: `active` requires calibration valid (for biomedical `assetType`); `disposed` requires disposal record (statutory for radiology assets). Terminal: **disposed**.

## 10. Support Ticket (SaaS, master DB)

```
open → triaged → in_progress → waiting_on_customer ⇄ in_progress → resolved → closed
open|triaged → escalated → in_progress
resolved → reopened → in_progress     (within 7 days, else new ticket)
```

SLA timers pause in `waiting_on_customer`. Terminal: **closed**.

## 11. Tenant (master DB)

```
provisioning → trial → active → suspended ⇄ active
suspended → terminated → exported → purged
trial → expired → active|terminated
```

Guards: `suspended` blocks logins but preserves data; `purged` only after retention window + export offered + owner approval (Constitution §3.9). Terminal: **purged**.

## 12. User Account (tenant DB)

```
invited → active → disabled ⇄ active
active|invited → locked → active        (unlock: admin, or lockout window elapses)
active|disabled|invited → archived
```

Guards: `invited` has no credential yet — only accepting the invitation sets one. `locked` is entered automatically after `LOGIN_MAX_ATTEMPTS` failures inside `LOGIN_LOCKOUT_MINUTES` and leaves automatically when that window elapses; an admin may unlock early. `disabled` is an explicit human act (offboarding) and blocks login until reversed. Only `active` may authenticate — every other state fails as `HMS-AUTH-001` (indistinguishable to the caller, so login is never a user-enumeration oracle). Deleting a clinician who has signed records is forbidden — clinical attribution must survive offboarding — so `archived` is soft and terminal. Terminal: **archived**.

## 13. Patient (tenant DB) — the MPI record

```
active → merged                        (a human declares this to be the same person)
```

That is the whole lifecycle, and its shortness is the design.

A patient does not become "inactive". Someone who has not visited in ten years is the same person with the same allergies, and a status that hid them would hide them from the clinician who needs them at 3am. There is no `deleted` either: a patient record is a legal document under a statutory retention period (DATA_RETENTION_POLICY), so **no code path deletes one** — the merge service marks and links, it never removes.

Guards:

- **`merged` is terminal and the merged row is KEPT** — with its UHID, its history and a `mergedInto` pointer. The old UHID is already on a wristband, a lab slip and an insurance claim, so a lookup by that number must still resolve or those documents become unverifiable.
- **No chains.** Merging into a record that is _itself_ merged is refused (`HMS-STATE-001`). Otherwise A → B → C forms, every consumer re-pointing a `patientId` has to walk a linked list, and one of those lists eventually contains a cycle. Merge into the record that is actually alive.
- **A merged record is immutable.** Editing demographics on it would silently change the evidence the merge decision was made on.
- Merging requires `patient:merge` — deliberately _not_ implied by `patient:register`. It is the one irreversible action in the module.

Deciding two records are one person is a **clinical safety** act, not a data-cleanup act: get it wrong and one person's allergies sit on another person's chart. So it is never automatic. The MPI (`mpi.ts`) only ever _proposes_ — `HMS-PAT-002` stops a probable duplicate and asks a human, and a human with the permission may still override, which is itself audited (`patient.duplicateOverridden`).

Terminal: **merged**.

---

## 14. Encounter (tenant DB) — THE CENTRAL CLINICAL OBJECT (ADR-0013)

One graph serves every organization type. The journeys of a private hospital, a small clinic and a government hospital differ by **policy**, not by shape (ADR-0013 §5) — there is no per-tenant workflow engine.

```
planned  → arrived → in_queue → in_progress → closed
arrived  → in_queue                     (token issued; `encounterPolicy.tokenIssuedAt`)
in_queue → in_progress                  (doctor calls the token)
in_progress → awaiting_results          (orders placed; patient leaves the room, keeps the encounter)
awaiting_results → in_progress          (patient returns; results are back — NOT a new encounter)
in_progress → closed                    (consultation complete)
in_progress → admitted                  (opens an INPATIENT encounter in the same Episode — see below)
planned|arrived|in_queue → cancelled    (reason required)
arrived|in_queue → left_without_being_seen
```

Guards:

- `planned` exists **only** for origin `appointment` (a promise not yet kept). A walk-in is created directly at `arrived` — the commonest case in a clinic or government hospital, and it must not be forced through a fake `planned` state.
- `in_progress` requires an assigned practitioner or an OP room (`encounterPolicy.routing`).
- `awaiting_results` is the state that stops a hospital creating a **second encounter** when the patient comes back from the lab. **That re-registration is the single commonest data-quality disaster in an OPD**: it fragments one visit into two, double-counts the census, and splits the bill.
- `admitted` does **NOT** end the care story: it closes this encounter and opens an inpatient one in the **same Episode of Care** (ADR-0013 §4). Continuity is a read model; separation is billing and statutory reality.

Terminal: **closed, cancelled, left_without_being_seen, admitted**.

## 15. Order (tenant DB) — the spine that carries work between departments (ADR-0013 §3)

One machine for `lab | radiology | pharmacy | procedure | referral | admission | diet`. The `category` chooses the destination queue; the lifecycle is identical, which is what makes a single work queue possible at all (ADR-0014).

```
placed → accepted → in_progress → completed → verified → released
placed|accepted → cancelled              (reason required; who cancelled is audited)
in_progress → completed                  (technician performed it)
completed → verified                     (pathologist/radiologist signs it off)
verified → released                      (visible to the ordering doctor and the patient)
```

Guards:

- **`placed` creates the destination department's work item** (via the outbox — ADR-0014). This is the whole of "doctor orders appear automatically in the destination department"; there is no separate hand-off, and no paper.
- **`verified` is a different permission from `completed`.** A technician performs; a pathologist verifies. Collapsing the two would let an unverified result reach a doctor, which is a patient-safety failure, not a workflow shortcut.
- **`released` is what makes the report available to the ordering doctor** and flips the encounter from `awaiting_results` back to actionable. A `panic` result additionally triggers a synchronous alert — the event path is not fast enough to be the only path for a value that can kill someone.
- Cancelling an order **after** `in_progress` must not silently discard a specimen already drawn; the sample lifecycle is separate.

Terminal: **released, cancelled**.

## 16. Work Item (tenant DB) — the universal queue entry (ADR-0014)

A **projection** of an Order or an Encounter, never a source of truth. Rebuildable from the domain at any time.

```
waiting → claimed → in_progress → done
waiting|claimed → cancelled        (the source order/encounter was cancelled)
claimed → waiting                  (lease expired, or the claimer released it)
```

Guards: `claimed` is a **lease** (`claimedBy` + `claimedAt`) — two technicians must not silently take the same sample. A stale lease returns to `waiting`, exactly as the outbox relay reclaims a dead relay's rows and the notification ledger reclaims a dead sender's message. Priority (`routine | urgent | stat | emergency`) orders the queue; triage sets it, and `stat` means the same thing at the lab bench as at the doctor's door.

Terminal: **done, cancelled**.

---

## Adding an entity lifecycle

Copy the pattern: states → transitions with actors → guards → terminals. Implement as a single `canTransition(entity, from, to, ctx)` guard in the owning service — never scattered `if (status === …)` checks.
