# EVENT CATALOG

Registry of all domain events. **Every event published through the outbox MUST have an entry here in the same PR** (Guidelines §4). Names: `domain.entity.action` past tense (Doc 09 §2).

**Global rules (apply to every event unless overridden):**
- **Envelope:** `{ eventId (uuid), name, version, tenantId, branchId?, occurredAt, actorId?, traceId, payload }`.
- **Delivery:** transactional outbox → BullMQ → consumers; **at-least-once** — every consumer MUST be idempotent (dedupe on `eventId`).
- **Retry:** exponential backoff 5 attempts (1s→5m) → DLQ (alerted).
- **Versioning:** payload changes are additive; breaking change = publish `name` with `version+1` alongside old version for one deprecation cycle.
- **Payloads carry IDs + minimal denormalized display fields, never full PHI documents.**

## Seed Events (blueprint-derived; extend as implemented)

| Event (v1) | Producer | Consumers | Payload (beyond envelope) | Notes / failure handling |
|------------|----------|-----------|---------------------------|--------------------------|
| `patient.patient.registered` | patients | notifications, analytics | patientId, uhid, channel | — |
| `patient.patients.merged` | patients | all modules holding patientId refs, audit | survivorId, mergedId | consumers re-point refs; replayable |
| `appointment.appointment.booked` | appointments | notifications (confirm msg), queue, analytics | appointmentId, patientId, doctorId, slot | reminder jobs scheduled by consumer |
| `appointment.appointment.cancelled` | appointments | notifications, waitingList, billing (refund check) | appointmentId, reason, cancelledBy | waiting-list promotion is idempotent |
| `admission.admission.created` | admissions | beds, billing (charge posting starts), dietetics, analytics | admissionId, patientId, bedId, admittingDoctorId | bed allocation is transactional with admission; event is notification-only |
| `admission.patient.discharged` | admissions | billing (finalize gate), beds (release), housekeeping (bed clean), MRD (chart completion), notifications | admissionId, dischargeType | housekeeping task creation retries safely |
| `clinical.prescription.signed` | consultation | pharmacy (dispense queue), MAR (schedule build), analytics | prescriptionId, patientId, itemCount | MAR build idempotent on prescriptionId |
| `clinical.order.placed` | consultation | lab/radiology (worklist), billing (charge) | orderId, type, priority | duplicate charge prevented by orderId idempotency |
| `lab.result.approved` | lab | notifications (doctor+patient), EMR timeline, analytics | orderId, resultId, hasAbnormal, hasPanic | panic=true also triggers synchronous alert path (not only event) |
| `lab.result.panic` | lab | notifications (escalation chain) | resultId, testCode, value | acknowledgment required + audited; unacked escalates per config |
| `billing.invoice.finalized` | billing | finance (journal posting), notifications, analytics | invoiceId, netAmount, payerType | journal posting idempotent on invoiceId |
| `billing.payment.captured` | billing | finance, notifications (receipt), wallet (if wallet-paid) | paymentId, amount, mode | gateway webhooks reconciled separately; never double-post |
| `billing.payment.refunded` | billing | finance, notifications | refundId, paymentId, amount, reason | — |
| `insurance.claim.submitted` | insurance | notifications, analytics | claimId, payerId, amount | NHCX/TPA transport failures retry in integration layer, not by re-publishing |
| `insurance.claim.denied` | insurance | denial workflow, notifications | claimId, denialCode | — |
| `pharmacy.stock.dispensed` | pharmacy | inventory analytics, reorder check | saleId, items[{medicineId,batchId,qty}] | stock decrement is transactional; event is downstream-only |
| `inventory.stock.belowReorder` | inventory | notifications (store), auto-PO (if enabled) | itemId, storeId, qty, reorderLevel | auto-PO must dedupe per item+day |
| `bed.bed.statusChanged` | beds | bed board (realtime), housekeeping, analytics | bedId, from, to | realtime consumers reconcile via REST on reconnect |
| `hr.payroll.completed` | hr | finance (salary journal), notifications (payslips) | payrollRunId, period, totalNet | journal idempotent on payrollRunId |
| `platform.tenant.provisioned` | tenants (master) | connection manager cache, onboarding emails, analytics | tenantId, slug, databaseName | consumer side-effects idempotent; re-provisioning forbidden |
| `platform.subscription.changed` | subscriptions (master) | entitlement cache invalidation, notifications | tenantId, fromPlan, toPlan | cache invalidation must fan out to all pods (Redis pub/sub) |
| `platform.limit.thresholdReached` | usage metering (master) | notifications (tenant admin), sales analytics | tenantId, metric, pct (80/100) | dedupe per metric+period |

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
