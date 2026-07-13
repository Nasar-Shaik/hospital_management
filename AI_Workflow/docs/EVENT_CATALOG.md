# EVENT CATALOG

Registry of all domain events. **Every event published through the outbox MUST have an entry here in the same PR** (Guidelines §4). Names: `domain.entity.action` past tense (Doc 09 §2).

**Global rules (apply to every event unless overridden):**

- **Envelope:** `{ eventId (uuid), name, version, tenantId, branchId?, occurredAt, actorId?, traceId, payload }`.
- **Delivery:** transactional outbox → BullMQ → consumers; **at-least-once** — every consumer MUST be idempotent (dedupe on `eventId`).
- **Retry:** exponential backoff 5 attempts (1s→5m) → DLQ (alerted).
- **Versioning:** payload changes are additive; breaking change = publish `name` with `version+1` alongside old version for one deprecation cycle.
- **Payloads carry IDs + minimal denormalized display fields, never full PHI documents.**

## Seed Events (blueprint-derived; extend as implemented)

| Event (v1)                          | Producer                | Consumers                                                                                                | Payload (beyond envelope)                        | Notes / failure handling                                                     |
| ----------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------- |
| `patient.patient.registered`        | patients                | notifications, analytics                                                                                 | patientId, uhid, channel                         | —                                                                            |
| `patient.patients.merged`           | patients                | all modules holding patientId refs, audit                                                                | survivorId, mergedId                             | consumers re-point refs; replayable                                          |
| `appointment.appointment.booked`    | appointments            | notifications (confirm msg), queue, analytics                                                            | appointmentId, patientId, doctorId, slot         | reminder jobs scheduled by consumer                                          |
| `appointment.appointment.cancelled` | appointments            | notifications, waitingList, billing (refund check)                                                       | appointmentId, reason, cancelledBy               | waiting-list promotion is idempotent                                         |
| `admission.admission.created`       | admissions              | beds, billing (charge posting starts), dietetics, analytics                                              | admissionId, patientId, bedId, admittingDoctorId | bed allocation is transactional with admission; event is notification-only   |
| `admission.patient.discharged`      | admissions              | billing (finalize gate), beds (release), housekeeping (bed clean), MRD (chart completion), notifications | admissionId, dischargeType                       | housekeeping task creation retries safely                                    |
| `clinical.prescription.signed`      | consultation            | pharmacy (dispense queue), MAR (schedule build), analytics                                               | prescriptionId, patientId, itemCount             | MAR build idempotent on prescriptionId                                       |
| `clinical.order.placed`             | consultation            | lab/radiology (worklist), billing (charge)                                                               | orderId, type, priority                          | duplicate charge prevented by orderId idempotency                            |
| `lab.result.approved`               | lab                     | notifications (doctor+patient), EMR timeline, analytics                                                  | orderId, resultId, hasAbnormal, hasPanic         | panic=true also triggers synchronous alert path (not only event)             |
| `lab.result.panic`                  | lab                     | notifications (escalation chain)                                                                         | resultId, testCode, value                        | acknowledgment required + audited; unacked escalates per config              |
| `billing.invoice.finalized`         | billing                 | finance (journal posting), notifications, analytics                                                      | invoiceId, netAmount, payerType                  | journal posting idempotent on invoiceId                                      |
| `billing.payment.captured`          | billing                 | finance, notifications (receipt), wallet (if wallet-paid)                                                | paymentId, amount, mode                          | gateway webhooks reconciled separately; never double-post                    |
| `billing.payment.refunded`          | billing                 | finance, notifications                                                                                   | refundId, paymentId, amount, reason              | —                                                                            |
| `insurance.claim.submitted`         | insurance               | notifications, analytics                                                                                 | claimId, payerId, amount                         | NHCX/TPA transport failures retry in integration layer, not by re-publishing |
| `insurance.claim.denied`            | insurance               | denial workflow, notifications                                                                           | claimId, denialCode                              | —                                                                            |
| `pharmacy.stock.dispensed`          | pharmacy                | inventory analytics, reorder check                                                                       | saleId, items[{medicineId,batchId,qty}]          | stock decrement is transactional; event is downstream-only                   |
| `inventory.stock.belowReorder`      | inventory               | notifications (store), auto-PO (if enabled)                                                              | itemId, storeId, qty, reorderLevel               | auto-PO must dedupe per item+day                                             |
| `bed.bed.statusChanged`             | beds                    | bed board (realtime), housekeeping, analytics                                                            | bedId, from, to                                  | realtime consumers reconcile via REST on reconnect                           |
| `hr.payroll.completed`              | hr                      | finance (salary journal), notifications (payslips)                                                       | payrollRunId, period, totalNet                   | journal idempotent on payrollRunId                                           |
| `platform.tenant.provisioned`       | tenants (master)        | connection manager cache, onboarding emails, analytics                                                   | tenantId, slug, databaseName                     | consumer side-effects idempotent; re-provisioning forbidden                  |
| `platform.subscription.changed`     | subscriptions (master)  | entitlement cache invalidation, notifications                                                            | tenantId, fromPlan, toPlan                       | cache invalidation must fan out to all pods (Redis pub/sub)                  |
| `platform.limit.thresholdReached`   | usage metering (master) | notifications (tenant admin), sales analytics                                                            | tenantId, metric, pct (80/100)                   | dedupe per metric+period                                                     |

## Implemented Events (A5 — the outbox is live)

These are published TODAY through the transactional outbox and delivered to the BullMQ `events` queue. Everything in the seed table above remains planned.

| Event (v1)                        | Producer                                 | Consumers                                     | Payload (beyond envelope)                        | Notes                                                                                                                                                                 |
| --------------------------------- | ---------------------------------------- | --------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity.user.created`           | staff (`createStaff`)                    | _none yet_ → notifications (A6): welcome mail | userId, email, name, roles[], mustChangePassword | **Carries no password.** A6 mints its own single-use invite link rather than route a secret through a durable queue.                                                  |
| `identity.user.disabled`          | staff (`setStaffStatus`)                 | _none yet_ → integrations, rotas              | userId, sessionsRevoked                          | Sessions are already dead when this fires; the event is how downstream copies catch up.                                                                               |
| `identity.user.rolesChanged`      | rbac (`assignRoleByCode`/`revokeByCode`) | _none yet_ → permission-cache fan-out         | userId, change (assigned/revoked), role, roles[] | Until a consumer fans this out across pods, other pods keep a stale `perm:{userId}` until TTL.                                                                        |
| `platform.subscription.changed`   | subscriptions (`changePlan`)             | _none yet_ → entitlement cache, notifications | tenantId, fromPlan, toPlan                       | **Not atomic** with the plan write — the plan lives in the MASTER db, the outbox in the tenant's. A crash between them loses the notification, never the plan change. |
| `platform.limit.thresholdReached` | subscriptions (`assertWithinLimit`)      | _none yet_ → notifications, sales analytics   | metric, used, limit, pct, plan                   | Fires on every blocked attempt, so a retrying client produces a burst — **dedupe is the consumer's job** (per metric+period), per the global rules above.             |

**Delivery, as built:** `publish()` writes the event to `outboxEvents` in the tenant DB (in the caller's transaction when there is one) → the relay in `apps/api` claims it atomically → BullMQ `events` queue (jobId = `eventId`) → `apps/workers`. At-least-once: the relay marks a row `sent` only _after_ enqueueing, so a crash in that window redelivers rather than drops. **Every consumer must dedupe on `eventId`.**

## Entry Template (copy for new events)

```
### `domain.entity.action` (vN)
Producer: <module>
Consumers: <module list — update when adding a consumer>
Payload: { … }
Idempotency: <consumer dedupe key>
Retry: <default | override>
Failure handling: <DLQ consequence + operator action>
Introduced: <date/PR>
```
