# ERROR CODES

The **only** legal source of API error codes. Every thrown `AppError` uses a code from this file; new errors are added here in the same PR (Guidelines §4). Never reuse or renumber a code.

**Scheme:** `HMS-<DOMAIN>-<NNN>` · Response shape: `{ error: { code, message, details?, traceId } }` · Messages are user-safe (no internals); `details` carries field-level info for 400s.

**Retry semantics:** `retryable: yes` means the client may retry idempotently (same Idempotency-Key where applicable).

## Platform & Auth

| Code           | HTTP | Message (EN)                                 | Recovery                                       | Retry         |
| -------------- | ---- | -------------------------------------------- | ---------------------------------------------- | ------------- |
| HMS-AUTH-001   | 401  | Invalid credentials                          | Re-enter; lockout after N attempts             | no            |
| HMS-AUTH-002   | 401  | Session expired                              | Refresh token / re-login                       | yes (refresh) |
| HMS-AUTH-003   | 401  | Refresh token reuse detected                 | Family revoked; force re-login; security alert | no            |
| HMS-AUTH-004   | 403  | MFA required                                 | Complete MFA challenge                         | no            |
| HMS-AUTH-005   | 403  | Insufficient permission                      | Request access from admin                      | no            |
| HMS-TEN-001    | 404  | Organization not found                       | Check subdomain/domain                         | no            |
| HMS-TEN-002    | 403  | Organization suspended                       | Contact support/billing                        | no            |
| HMS-TEN-003    | 403  | Tenant mismatch                              | Token does not belong to this domain; re-login | no            |
| HMS-TEN-004    | 503  | Tenant database unavailable                  | Automatic failover in progress                 | yes (backoff) |
| HMS-TEN-005    | 403  | Subscription expired (licence past grace)    | Operator must renew the licence (ADR-0016)     | no            |
| HMS-BRANCH-001 | 400  | No active branch selected for a write        | Pick a branch in the switcher (ADR-0015)       | no            |
| HMS-PLAN-001   | 402  | Plan limit reached (`details.metric`)        | Upgrade edition or free capacity               | no            |
| HMS-PLAN-002   | 403  | Feature not in your edition                  | Upgrade path in `details.requiredEdition`      | no            |
| HMS-VAL-001    | 400  | Validation failed                            | Fix `details.fields`                           | no            |
| HMS-REQ-001    | 429  | Too many requests                            | Respect `Retry-After`                          | yes           |
| HMS-REQ-002    | 409  | Duplicate request (idempotency)              | Original response returned in `details`        | no            |
| HMS-REQ-003    | 409  | Record was modified by someone else          | Reload and reapply changes (version conflict)  | no            |
| HMS-REQ-004    | 409  | Idempotency-Key still in progress            | Retry shortly; the first attempt is running    | yes (backoff) |
| HMS-STATE-001  | 422  | Invalid state transition (`details.from→to`) | See STATE_MACHINE_CATALOG                      | no            |

## Patient & Clinical

| Code        | HTTP | Message                                                                         | Recovery                                                       | Retry         |
| ----------- | ---- | ------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------- |
| HMS-PAT-001 | 404  | Patient not found                                                               | Verify UHID/search                                             | no            |
| HMS-PAT-002 | 409  | Possible duplicate patient                                                      | Review `details.candidates`; merge or override with permission | no            |
| HMS-APT-001 | 409  | Slot no longer available                                                        | Pick another slot (`details.alternatives`)                     | no            |
| HMS-APT-002 | 422  | Doctor not available at this time                                               | Check schedule                                                 | no            |
| HMS-ADM-001 | 409  | Bed already occupied                                                            | Bed board refresh; pick another                                | no            |
| HMS-ADM-002 | 422  | Discharge blocked: pending items                                                | Clear `details.blockers` (bill/orders/summary)                 | no            |
| HMS-ADM-003 | 503  | Bed assignment unavailable: this database cannot enforce one-stay-per-bed       | Allocate on the ward board and escalate; respect `Retry-After` | yes (backoff) |
| HMS-EMR-001 | 403  | Record is signed and immutable                                                  | Create an amendment/new version                                | no            |
| HMS-RX-001  | 422  | Allergy conflict (`details.allergen`)                                           | Licensed override with reason, or change drug                  | no            |
| HMS-RX-002  | 422  | Drug interaction (`details.severity`)                                           | Review; override per policy                                    | no            |
| HMS-LAB-001 | 422  | Sample rejected (`details.reason`)                                              | Recollect                                                      | no            |
| HMS-LAB-002 | 403  | Result approval requires pathologist role                                       | Route to approver                                              | no            |
| HMS-MAR-001 | 409  | This dose has already been administered                                         | Show `details.existing`; do NOT retry — see below              | no            |
| HMS-MAR-002 | 503  | Charting is unavailable: this database cannot enforce the dose-duplication rule | Chart on paper and escalate; respect `Retry-After` — see below | yes (backoff) |
| HMS-ORD-001 | 503  | Ordering is unavailable: this database cannot enforce one-order-per-request     | Order on paper and escalate; respect `Retry-After` — see below | yes (backoff) |

## Financial

| Code        | HTTP | Message                                                                                | Recovery                                                 | Retry         |
| ----------- | ---- | -------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------- |
| HMS-BIL-001 | 422  | Bill already finalized                                                                 | Use credit-note reversal flow                            | no            |
| HMS-BIL-002 | 422  | Discount exceeds your approval limit                                                   | Request approval (`details.approverRole`)                | no            |
| HMS-PAY-001 | 402  | Payment failed at gateway                                                              | Retry with same Idempotency-Key or other mode            | yes           |
| HMS-PAY-002 | 409  | Payment already captured                                                               | No action; original receipt in `details`                 | no            |
| HMS-PAY-003 | 422  | Refund exceeds source payment                                                          | Correct amount                                           | no            |
| HMS-WAL-001 | 422  | Insufficient wallet balance                                                            | Top up or change payment mode                            | no            |
| HMS-INS-001 | 422  | Pre-authorization required for this service                                            | Initiate pre-auth (W7)                                   | no            |
| HMS-INS-002 | 422  | Claim documents incomplete                                                             | Attach `details.missing`                                 | no            |
| HMS-PHM-001 | 409  | Insufficient stock (`details.available`)                                               | Partial dispense or backorder                            | no            |
| HMS-PHM-002 | 422  | Batch expired                                                                          | System blocks; pick valid batch                          | no            |
| HMS-PHM-003 | 402  | Dispense exceeds the patient's advance (`details.shortfall`)                           | Doctor authorises on credit (`pharmacy:credit-override`) | no            |
| HMS-PHM-004 | 503  | Dispensing unavailable: this database cannot enforce the one-handover-per-request rule | Hand over on paper and escalate; respect `Retry-After`   | yes (backoff) |
| HMS-INV-001 | 422  | GRN quantity exceeds PO                                                                | Verify receipt; amend PO per policy                      | no            |
| HMS-FIN-001 | 422  | Accounting period closed                                                               | Post to open period / reopen with permission             | no            |

## Files & Integrations

| Code         | HTTP | Message                                      | Recovery                               | Retry        |
| ------------ | ---- | -------------------------------------------- | -------------------------------------- | ------------ |
| HMS-FILE-001 | 413  | File exceeds size limit                      | Compress/split; limit in `details.max` | no           |
| HMS-FILE-002 | 422  | File type not allowed / failed scan          | Provide valid file                     | no           |
| HMS-INT-001  | 502  | Upstream service failed (`details.provider`) | Queued for retry where safe            | yes (system) |
| HMS-INT-002  | 504  | Upstream timeout                             | As above                               | yes (system) |
| HMS-INT-003  | 422  | Webhook signature invalid                    | Check secret configuration             | no           |

## Generic

| Code        | HTTP | Message                          | Recovery                                 | Retry |
| ----------- | ---- | -------------------------------- | ---------------------------------------- | ----- |
| HMS-GEN-404 | 404  | Resource not found               | Verify ID (within this tenant)           | no    |
| HMS-GEN-500 | 500  | Something went wrong             | Auto-reported with `traceId`; retry once | yes   |
| HMS-GEN-503 | 503  | Service in maintenance/read-only | See MAINTENANCE_MODE; retry after window | yes   |

**Adding a code:** next number in its domain block; include HTTP, message, recovery, retry; add i18n message keys; write the test that asserts the code is returned.

## Idempotency: which 409 means what

`HMS-REQ-002` and `HMS-REQ-004` both answer "this `Idempotency-Key` has been seen before", and they
are separate codes because the remedies are opposite.

- **`HMS-REQ-002`** — the key was used for a **different request**. The client has a bug: it spent
  one key on two intents. Nothing is retried; a new key is needed for the new operation.
  `details.original` carries what that key did the first time (its operation, when it was first
  seen, and — where it completed — its status and response), which is safe to return because a key
  is scoped to one tenant _and_ one user, so the original response is always the caller's own.
- **`HMS-REQ-004`** — the **same** request is still in flight. Usually a double-click. Retry after
  a short delay and the retry will replay the first attempt's result.

A successful retry of an identical request is **not** an error: it returns the original status and
body with `Idempotency-Replayed: true`. See `docs/IDEMPOTENCY.md` for the full contract and the
per-endpoint matrix.

### `HMS-MAR-001` is a THIRD kind of 409, and the distinction is clinical

An `Idempotency-Key` 409 says _"you already sent this request"_. `HMS-MAR-001` says _"somebody
already gave this dose"_ — possibly a different nurse, on a different device, with a different key.
Only a unique index can answer that, and only the database can arbitrate it (migration 0049).

`details.existing` carries the administration holding the slot: who gave it, when, and with what
outcome. That is what a client must show. **A client must never retry into it** — the whole purpose
of the code is that a lost response cannot become a second dose in a patient.

### `HMS-MAR-002` is what happens when the arbiter itself is gone

`HMS-MAR-001` is the rule working. `HMS-MAR-002` is the API refusing to chart because the rule
**cannot be enforced** — the unique index migration 0049 installs is not in that tenant's database,
so two nurses charting one dose would both succeed and the chart would read as a single dose.

It is a 503 with `Retry-After`, not a 4xx: nothing is wrong with the request, and it will work
unchanged once the schema is repaired. Nothing is written, so there is no partial state to reconcile.

**The client must tell the nurse to chart on paper and escalate**, not merely show a failure. And
the escalation is urgent for a reason that is not obvious: every dose charted into a drifted tenant
makes the repair harder, because a unique index cannot be rebuilt over rows that already violate it
— and the MAR is append-only, so those rows can never be withdrawn.

`details.missing` names the rule that is absent and the migration that installs it. See
`DEPLOYMENT_GATE.md` for how a tenant reaches this state and how it is repaired.

### `HMS-PHM-004` is the same refusal, for the pharmacy counter

`one_dispense_per_request_id` (migration 0015) is what arbitrates two clicks in flight at once —
the `findByRequestId` read before it is a courtesy that catches the ordinary sequential retry and
says so itself. Without the index both requests commit: **two handovers of the same drugs**, billed
twice, from one intent.

Same shape as `HMS-MAR-002` and for the same reasons: 503 rather than 4xx because the request is
fine and will work once the schema is repaired, nothing is written, and `Retry-After` is set. The
client should tell the pharmacist to hand over on paper and escalate — and the escalation is urgent
because a unique index cannot be rebuilt over rows that already violate it.

It is scoped to dispensing alone. A missing dispensing constraint says nothing about whether a
nurse may chart a dose, and does not block one.

### `HMS-ORD-001` refuses to RAISE work, and only that

`one_order_per_request_id` (migration 0013) is the sole race arbiter for placing an order —
`placeOrder` performs no read before it writes, and consults `findByRequestId` only after the
database has already answered E11000. Without the index a retried request raises a **second
investigation**: another tube of blood from a real arm, another exposure for an X-ray, and a
second bill for it.

It differs from the other two in **two** ways, both deliberate:

**It requires only its own capability, not `idempotent-replay`.** MAR and dispensing each have a
legitimate write that carries no module identifier (a PRN dose, a partial handover), so for those
the `Idempotency-Key` claim is the only lock and index 0048 must be sound. Every order write in
this system carries a `requestId` — both clients send it alongside the header, and the
`prescription.signed` consumer sets `rx:<prescriptionId>` — so losing 0048 alone leaves ordering
still arbitrated by 0013, and refusing then would block a hospital that is provably still safe.

**It guards placing only, never the state machine.** Accept, start, complete, verify, release and
cancel update a row that already exists and rest on nothing this index provides. A drifted tenant
can still finish the work already on its benches while somebody runs the migration; blocking those
would strand samples mid-analysis for a rule with no bearing on them.

The escalation is urgent for the usual reason: a unique index cannot be rebuilt over rows that
already violate it, so every duplicate raised into a drifted tenant makes the repair harder. The
pharmacy path is the sharpest case — it reaches `placeOrder` from an event with no HTTP request,
so no `Idempotency-Key` middleware exists there to fall back on, and at-least-once delivery is
guaranteed by design rather than merely possible.

### `HMS-ADM-003` refuses to PUT A PATIENT IN A BED, and only that

`one_open_stay_per_bed_per_branch` (migration 0046, which widened 0020's key so two sites may each
own an "ICU") is the sole arbiter of who is in a bed. Neither `admitPatient` nor `transferBed`
reads occupancy first: both write and then read E11000 as "somebody is already there". `getBed`
checks the catalogue's `blocked` flag, which is a maintenance state and says nothing about who is
lying in the bed.

Measured with the index absent: two patients are admitted into the same ward and bed at the same
branch, both accepted, and the ward board then shows one bed with two occupants and no way to say
which is real — which is also, in a fire, two people in a bay the list says holds one.

It guards **admission and bed transfer**. It deliberately does not guard **discharge**, or any
other way a stay ends: closing a stay removes the row from the partial filter and can never
violate the key, so a drifted hospital must still be able to send people home — refusing that
would fill the ward the refusal was protecting. Ward-board and chart reads are untouched for the
same reason: a board that goes dark is a board nobody can use to sort the mess out.

It requires `bed-occupancy` alone. `one_open_encounter_per_patient` is what `arrive()` rests on;
admission's "already admitted" refusal is an application check on the encounter's class, not an
index, so losing 0012 cannot put two patients in one bed.
