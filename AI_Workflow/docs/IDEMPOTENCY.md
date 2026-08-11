# IDEMPOTENCY-KEY

The contract for retrying a mutation safely, and the record of which operations carry it.

**Binding sources:** Doc 04 §5.1 (`Idempotency-Key` header on POST for money/critical ops) ·
Doc 03 §3, §5.2, §7 (`idempotencyKeys` collection; keys on all money-moving POSTs; 24-hour TTL) ·
Constitution §7 · ERROR_CODES `HMS-REQ-002`, `HMS-REQ-004`.

---

## 1. What was already here

| Piece                             | State before this milestone                                                                                                                    |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration `0004-idempotency-keys` | Created `idempotencyKeys` + a TTL index on `expiresAt`. **Nothing ever wrote a row to it** for 44 subsequent migrations.                       |
| `orders.requestId`                | Real. Unique index `one_order_per_request_id` (0013); the service catches E11000 and returns the original order with `duplicate: true` at 200. |
| `dispenses.requestId`             | Real. Unique index `one_dispense_per_request_id` (0015); same shape as orders.                                                                 |
| `invoices.payments[].requestId`   | Real, but different: no index — an atomic `updateOne` whose filter carries `payments.requestId: {$ne: key}`. Replay answers `HMS-PAY-002` 409. |
| `invoices.refunds[].requestId`    | Same as payments.                                                                                                                              |
| Wallet deposit / refund           | **No protection of any kind** — not a header, not a `requestId`, not a unique index. Two clicks were two advances.                             |
| Invoice discount                  | Optimistic `version` guard only. Concurrency-safe; a sequential retry re-applied it (harmlessly, since `discount` is absolute).                |
| `apps/web/lib/idempotency.ts`     | A `useIdempotencyKey()` hook minting UUIDs — sent as the **body's `requestId`**, never as a header.                                            |
| Middleware chain                  | `app.ts` said "Remaining chain slot: idempotency (P2)". There was no middleware.                                                               |

So: two real per-module mechanisms with different replay semantics, one collection that was dead,
and a documented header no code had ever read.

---

## 2. The contract

### The key

`Idempotency-Key: <8–128 chars of [A-Za-z0-9_.:@+-]>`. A UUID per user intent is the intended
shape. A malformed key is a **400 `HMS-VAL-001`** — never silently ignored, because a client that
believes it is protected and is not is worse off than one that sent nothing.

The key names an **intent**, not an HTTP call: stable across every retry of the same submission,
fresh for a genuinely new one. A second part-payment on the same bill is not a duplicate.

### Scope

A claim is identified by **(tenant, user, key)** — unique index `one_claim_per_idempotency_key`
(migration 0048).

- **Tenant** — records live in the tenant's own database (the primary boundary) _and_ carry
  `tenantId` (belt and braces, house style). Two hospitals independently minting `receipt-4` never
  meet.
- **User** — two cashiers on two counters will both choose `receipt-1`. Sharing those would hand
  the second cashier the first one's receipt while the second patient's money went untaken.
- **Endpoint** — deliberately _not_ part of the key. It is part of the **fingerprint**, so one key
  spent on two endpoints is a loud 409 rather than two quiet executions.

### Fingerprint

`SHA-256` of canonical JSON over: method · concrete path (ids and all) · query · **post-validation**
body · active branch.

Post-validation because Zod has already stripped unknown keys and applied defaults, so a retry that
reorders its JSON, omits a defaulted field, or adds one the schema drops still hashes the same.
Nothing generated is included — no timestamp, no trace id, no nonce. A fingerprint containing
anything the client cannot reproduce would make every legitimate retry look new, and idempotency
would fail open on the money path with a green test suite.

**The request body itself is never stored.** Only the hash. A table of request payloads with a
24-hour life would be a second copy of the medical record living somewhere nobody audits.

### Outcomes

| Situation                        | Answer                                                                                       |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| No key                           | Executes normally. Nothing is recorded.                                                      |
| First request with a key         | Executes. The 2xx status + envelope are stored for 24 hours.                                 |
| Same key, same request, finished | **Replay** — the recorded status and body, byte for byte, plus `Idempotency-Replayed: true`. |
| Same key, same request, running  | **409 `HMS-REQ-004`** — retry shortly to receive its result. Retryable.                      |
| Same key, **different** request  | **409 `HMS-REQ-002`** — `details.original` carries what that key did the first time.         |
| Request failed (non-2xx)         | The claim is **released**. The corrected retry is a genuine first attempt.                   |
| Key older than 24 hours          | Gone. The next request executes — it is not a retry, it is a new intent.                     |

### Concurrency

The first thing a keyed request does is **insert** a claim. The unique index arbitrates; exactly
one insert survives. `if (!exists) create()` is not used and would not work: two identical requests
in flight both read "not found" and both execute, and a double-click lands inside that window.

A claim left `in_progress` for more than 60 seconds (a process killed mid-request) is taken over by
an atomic conditional update, so a crash cannot wedge a key for the rest of the day.

### Failure semantics

Only 2xx responses are persisted. A 500 from a dropped connection, a 409 from a bed since freed, a
402 the gateway will accept next time — pinning any of those for 24 hours converts a transient
failure into an endpoint the cashier cannot use. Nothing was created, so nothing needs guarding.

The per-module `requestId` guards remain underneath, untouched, as the last line if a handler ever
fails _after_ writing.

### Transaction boundary

The claim is **outside** the domain transaction, deliberately. Enrolling it would mean the claim
rolls back with the work — which is correct for a failure and catastrophic for a retry storm, since
every attempt would then re-execute. Claim first, work second, record the answer on `finish`.

The gap between "answer sent" and "answer recorded" is a few milliseconds; a retry landing inside it
gets `HMS-REQ-004`, which is accurate — the operation ran exactly once.

---

## 3. Ambiguities found in the documentation, and how they were resolved

1. **`HMS-REQ-002` says "Duplicate request (idempotency) — original response returned in
   `details`", which reads as though _every_ repeat is a 409.** But ERROR_CODES also calls
   `HMS-PAY-001` retryable "with the same Idempotency-Key", and a retry that always 409s is not a
   retry. Resolved: `HMS-REQ-002` is the **collision** case (same key, different request); a true
   retry replays. The "original response in `details`" is honoured on the collision, which is safe
   because a key is scoped to one tenant _and_ one user, so the original response is always the
   caller's own.

2. **Nothing documented the "same request already in flight" case.** Collapsing it into
   `HMS-REQ-002` would tell a cashier to investigate a client defect that does not exist — a
   double-click is the most common way it will ever occur. **`HMS-REQ-004` added** to ERROR_CODES
   in the same change, per Guidelines §4.

3. **The repo held two different replay semantics** — orders/dispense reply `200 { duplicate: true }`
   from the domain guard; payments/refunds reply `409 HMS-PAY-002`. Resolved by **not choosing**:
   the header mechanism sits in front and replays whatever the first request was actually sent, and
   the domain guards keep their existing behaviour for callers who send no header. Nothing about
   the existing endpoints changed.

4. **"Which endpoints _require_ the header?" — none, in v1.** Doc 04 §5.1 rules that changes inside
   a version are additive only, and an operation that starts refusing requests it used to accept is
   not additive. The key is therefore **honoured, not demanded**, and the requirement Doc 03 §5.2
   states ("idempotency keys on all money-moving POSTs") is met by _coverage_: every such operation
   is protected when a key is supplied, and the shipped clients supply one. Making it mandatory is a
   `/v2` change and is recorded as such.

---

## 4. The operation matrix

152 mutating operations. **24 carry `Idempotency-Key`.**

The rule: **an operation carries a key when repeating it would create a SECOND real thing** — a
second payment, a second order, a second patient, a second bed occupancy. It does not when the
mutation is a transition to a named target state, or when a unique business key already refuses the
second. Idempotency on those costs a write and buys nothing.

### 4.1 Covered (24)

| Endpoint                                           | Mutation                | Money / critical    | Key | Reason                                                                 |
| -------------------------------------------------- | ----------------------- | ------------------- | --- | ---------------------------------------------------------------------- |
| `POST /invoices/{id}/payments`                     | takes money             | money               | ✅  | The canonical case: a lost receipt makes a cashier pay twice.          |
| `POST /invoices/{id}/refund`                       | hands money back        | money               | ✅  | The worse leg — money out of the door.                                 |
| `POST /invoices/{id}/discount`                     | writes the bill down    | money               | ✅  | Approved write-down; records who approved it.                          |
| `POST /billing/orders/{id}/settle-from-advance`    | wallet → invoice        | money               | ✅  | Two documents, one transaction; a repeat drains the advance.           |
| `POST /charges`                                    | posts a charge line     | money               | ✅  | A second line is a second thing the patient pays for.                  |
| `POST /encounters/{id}/bill/finalize`              | freezes + numbers       | money               | ✅  | Consumes an invoice number from the statutory counter.                 |
| `POST /patients/{patientId}/wallet/deposits`       | takes an advance        | money               | ✅  | Had **no** protection of any kind before this milestone.               |
| `POST /patients/{patientId}/wallet/refunds`        | returns an advance      | money               | ✅  | Same.                                                                  |
| `POST /encounters/{id}/package-enrollments`        | enrols in a priced pack | money               | ✅  | A second enrolment is a second package billed.                         |
| `POST /insurance-claims/{id}/settle`               | records a settlement    | money               | ✅  | Reconciliation; a double entry misstates receipts.                     |
| `POST /patients/{patientId}/insurance-claims`      | files a claim           | money               | ✅  | A duplicate claim is an insurance-fraud flag.                          |
| `POST /orders`                                     | places an order         | clinical + money    | ✅  | Two tubes of blood. Body `requestId` still honoured too.               |
| `POST /prescriptions/{id}/dispense`                | hands drugs over        | clinical + money    | ✅  | Two lots of a controlled drug. Body `requestId` too.                   |
| `POST /prescriptions`                              | writes a prescription   | clinical            | ✅  | A duplicate script can be dispensed twice.                             |
| `POST /medicines/{id}/receive`                     | stock in                | stock               | ✅  | Phantom stock the pharmacy will dispense against.                      |
| `POST /medicines/{id}/adjust`                      | stock correction        | stock               | ✅  | A repeated correction corrects twice.                                  |
| `POST /patients`                                   | registers a patient     | clinical (identity) | ✅  | A twin record splits a history; the half nobody reads has the allergy. |
| `POST /encounters`                                 | opens a visit           | clinical            | ✅  | Two open visits, two consultation charges.                             |
| `POST /encounters/{id}/admit`                      | occupies a bed          | clinical            | ✅  | Two bed occupancies for one patient.                                   |
| `POST /encounters/{encounterId}/vitals`            | records an observation  | clinical            | ✅  | A duplicated reading distorts a trend a clinician acts on.             |
| `POST /encounters/{id}/medication-administrations` | records a dose given    | clinical (safety)   | ✅  | The MAR is the record of what entered the patient.                     |
| `POST /appointments`                               | books a slot            | clinical            | ✅  | Consumes a slot twice.                                                 |
| `POST /appointments/{id}/reschedule`               | cancels + rebooks       | clinical            | ✅  | A repeat books a SECOND new appointment.                               |
| `POST /death-records`                              | certifies a death       | legal               | ✅  | An irreversible statutory record.                                      |

### 4.2 Not covered (128), with the reason for each class

| Class                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Count | Reason                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **State transitions.** `encounters/{id}` × start, close, cancel, left, queue, transfer, summary, outcome · `orders/{id}` × accept, start, complete, verify, release, cancel · `appointments/{id}` × confirm, check-in, start, complete, no-show, cancel · `prescriptions/{id}` × sign, cancel, discard, amend · `ot-bookings/{id}`, `ambulance-trips/{id}`, `feedback/{id}`, `insurance-claims/{id}` transitions · `consents/{id}/withdraw` · `allergies/{id}/refute` · `charges/{id}/void` · `package-enrollments/{id}/cancel` · `users/{id}/status` · `mortuary/register/{id}/release` | 34    | The second call sets the same state or is refused by the state machine (`HMS-STATE-001`). There is no second thing to create, so a key would cost a write and buy nothing.                                                                                                                                                                                  |
| **Idempotent replacements** — `PUT` × 8 (roles' permissions, consultation, MRD coding, hospital profile, doctor schedule, doctor availability, notification template, site logo) and `PATCH` × 18 (every `/{resource}/{id}` edit).                                                                                                                                                                                                                                                                                                                                                       | 26    | A replacement applied twice yields the same document. Concurrent edits are governed by the optimistic `version` guard (`HMS-REQ-003`), which is the right control for a lost update — idempotency is not.                                                                                                                                                   |
| **Creates already guarded by a unique business key.** `roles` · `users` · `users/{id}/roles` · `tariff` · `packages` · `medicines` · `branches` · `departments` · `wards` · `rooms` · `beds` · `theatres` · `ot-bookings` · `ambulances` · `ambulance-trips` · `assets` · `lab-tests` · `mrd/icd-codes` · `mortuary/register` · `patients/{patientId}/allergies` · `encounters/{id}/discharge` · `encounters/{id}/transfer-bed`                                                                                                                                                          | 22    | A unique index refuses the second — `one_ward_name_per_branch`, `one_medicine_per_code`, `one_body_per_encounter`, `one_booking_per_theatre_start`, `one_trip_per_ambulance_start`, `one_active_allergy_per_allergen`, `one_discharge_summary_per_admission`, `one_open_stay_per_bed`, and the rest. A key would be a second lock on a door already locked. |
| **Authentication and session.** Tenant login, refresh, logout, change-password, forgot/reset password, MFA setup/verify/activate/disable, `DELETE /auth/sessions/{id}`, `users/{id}/reset-password`.                                                                                                                                                                                                                                                                                                                                                                                     | 12    | Nothing is created and nothing is money. Replaying a login would hand back a stored token pair from a 24-hour cache — a credential replay store, which is a security defect rather than a feature.                                                                                                                                                          |
| **Control plane** (`/api/platform/v1`). Operator login/logout/change-password, hospital provisioning, status, plan, limits, licence, domain, admin seeding, operator creation.                                                                                                                                                                                                                                                                                                                                                                                                           | 11    | Outside `resolveTenant`, so there is no tenant database in which to hold a claim, and no operator action here moves money. Provisioning is guarded by a unique slug; the rest are absolute replacements.                                                                                                                                                    |
| **Additive records with no unique key.** `encounters/{id}/notes` · `encounters/{id}/investigations` · `orders/{id}/reports` · `patients/{patientId}/documents` · `consents` · `feedback` · `feedback/{id}/assign` · `assets/{id}/maintenance` · `patients/{patientId}/insurance-policies` · `doctors/leave` · `api-keys`                                                                                                                                                                                                                                                                 | 11    | A duplicate is visible in the list, correctable by a human, harms nobody and is not money. For the two file uploads the fingerprint would additionally have to hash a multi-megabyte base64 body on every attempt, which is a real cost for a clerical duplicate.                                                                                           |
| **Deletes and revocations.** `roles/{id}` · `users/{id}/roles/{roleCode}` · `documents/{id}` · `api-keys/{id}` · `doctors/schedule/{id}` · `doctors/leave/{id}` · `site/logo`                                                                                                                                                                                                                                                                                                                                                                                                            | 7     | Naturally idempotent: the second delete finds nothing and says so. Replaying the first answer would hide from the caller that the record is already gone.                                                                                                                                                                                                   |
| **Advisory, or an absolute replacement.** `patients/check-duplicates` · `patients/merge` · `subscription/plan` · `feature-flags` · `invoices/{id}/payer-split`                                                                                                                                                                                                                                                                                                                                                                                                                           | 5     | `check-duplicates` writes nothing at all. `plan`, `feature-flags` and `payer-split` set an absolute value, so a repeat is the same value. `merge` is refused on the second attempt — the source patient is already merged.                                                                                                                                  |

---

## 5. Client usage

```ts
// One key per INTENT — minted when the user commits, persisted with the pending mutation,
// reused for every retry of that action, replaced for the next action.
const key = crypto.randomUUID();
await api.recordPayment(invoiceId, { amount, method }, key);

// Anything else the server honours, via the generic option:
await api.request<Invoice>("POST", `/api/v1/invoices/${id}/refund`, body, { idempotencyKey: key });
```

**Mobile.** Nothing in the mechanism needs a browser, a Node builtin, or a live connection: an
offline mutation queue stores `{ method, path, body, idempotencyKey }`, drains on reconnect, and
replays each row until it gets a non-5xx answer. A replayed answer is byte-identical to the first
and carries `Idempotency-Replayed: true`, so the queue can tell "this attempt did it" from "an
earlier attempt already did it" — which is what a receipt printer and a sync log both need.

A `409 HMS-REQ-002` from a queue is a client bug (one key, two payloads) and should be surfaced,
not retried. A `409 HMS-REQ-004` is normal and should be retried after a short delay.

---

## 6. Verification

`apps/api/src/idempotency.int.test.ts` — 24 tests. Five controls were deliberately broken and each
produced a red:

| Broken control                                            | Red |
| --------------------------------------------------------- | --- |
| The unique claim index (`unique: true` → `false`)         | 14  |
| Fingerprint comparison (always "same")                    | 3   |
| Replay lookup (execute instead of replaying)              | 9   |
| Per-tenant store scoping (one shared connection)          | 2   |
| The claim itself (insert-first → `if (!exists) create()`) | 2   |

Removing `tenantId` from the claim identity — while leaving the per-tenant connection intact —
stayed **green**, and that is the correct result: physical database-per-tenant isolation is the
primary boundary and `tenantId` is the second lock on the same door. Recorded here so nobody later
reads that field as the thing holding the line.
