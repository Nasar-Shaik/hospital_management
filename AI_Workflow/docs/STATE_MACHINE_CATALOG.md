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

```
draft → pending_finalization → finalized → partially_paid → paid
finalized|partially_paid → cancelled_reversed      (credit-note reversal only, never delete)
paid → refund_in_progress → refunded_partial|refunded_full
```

Guards: `finalized` assigns invoice number from `counters` and is immutable after; discounts beyond threshold require `billing:discount:approve` before finalization. Terminal: **paid** (unless refund), **cancelled_reversed, refunded_full**.

## 5. Payment

```
initiated → processing → captured → settled
initiated|processing → failed
captured → refund_initiated → refunded
processing → pending_reconciliation → captured|failed   (gateway webhook lag)
```

Guards: idempotency key mandatory at `initiated`; `captured` posts to journal exactly once. Terminal: **settled, failed, refunded**.

## 6. Prescription

```
draft → signed → (dispensing: partially_dispensed → dispensed)
draft → discarded
signed → cancelled          (doctor only; reason; already-administered doses unaffected)
```

Guards: `signed` is immutable (changes = new version); dispensing decrements batch stock transactionally. Terminal: **dispensed, discarded, cancelled**.

## 7. Lab Order

```
ordered → sample_pending → collected → received_in_lab → in_progress
       → resulted → verified → approved → reported
any-pre-resulted → cancelled (reason) ; sample states → rejected_sample → sample_pending (recollect)
approved → amended            (post-report correction: new version, audit, notify clinician)
```

Guards: `approved` requires `lab:approve` (pathologist); panic values at `resulted` trigger the panic alert path immediately (before approval). Terminal: **reported** (amendments create versions), **cancelled**.

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

---

## Adding an entity lifecycle

Copy the pattern: states → transitions with actors → guards → terminals. Implement as a single `canTransition(entity, from, to, ctx)` guard in the owning service — never scattered `if (status === …)` checks.
