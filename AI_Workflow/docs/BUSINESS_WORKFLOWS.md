# BUSINESS WORKFLOWS

End-to-end business processes, written so an AI agent can implement or verify a flow without guessing. Each workflow: trigger → steps (actor: action → system effect) → outcome → exceptions. States reference `STATE_MACHINE_CATALOG.md`; events reference `EVENT_CATALOG.md`. Update in the same PR when a flow changes (Guidelines §4).

---

## 1. Patient Registration (OP)
**Trigger:** new patient at reception / online self-registration.
1. Front desk: search MPI (phone/name/ABHA) → if found, use existing UHID (no duplicate).
2. If new: capture demographics → system assigns UHID (`counters`) → optional ABHA link (ABDM).
3. System creates `patients` + visit (type OP) → registration fee charge posted (config-dependent).
4. Event `patient.patient.registered` → welcome message.
**Exceptions:** duplicate detected post-facto → Duplicate Merge flow (`patient.patients.merged`); emergency unknown patient → temp UHID, reconcile later.

## 2. Appointment Booking → Consultation
**Trigger:** patient app / reception / walk-in.
1. Select doctor+slot (availability from `doctorSchedules`+`appointmentSlots`) → `appointment: requested→confirmed` → `appointment.appointment.booked` → confirmation + reminder jobs.
2. Arrival: check-in → token issued → queue position (realtime queue board).
3. Doctor: opens Consultation Workspace → SOAP note, diagnoses (ICD), orders, prescription (sign → `clinical.prescription.signed`).
4. Close consultation → `appointment: completed` → follow-up scheduled if prescribed → OP bill assembled from posted charges.
**Exceptions:** no-show (auto after grace → waiting-list promotion); walk-in without appointment (queue-only token); teleconsult variant (video room instead of check-in; e-prescription delivery).

## 3. IP Admission
**Trigger:** admission order from OPD/ED consultation, or planned admission.
1. Staff: select ward/class → bed picked from Bed Board (`bed: available→reserved`).
2. Capture admitting doctor, diagnosis, expected stay; collect advance (per tariff class policy).
3. Confirm → transaction: `admission: admitted` + `bed: occupied` + advance receipt → `admission.admission.created`.
4. Nursing assessment, care plan, diet prescription initiated.
**Exceptions:** no bed in class → waiting/transfer to another class with price-difference consent; ED admission bypasses steps 1–2 ordering (bed first, paperwork follows, reconciled within 24h).

## 4. Discharge
**Trigger:** doctor writes discharge order.
1. `admission: discharge_initiated` → checklist opens: pending orders returned/cancelled, pharmacy returns, final MAR entries.
2. Billing assembles final bill (room charges to date, pending charges) → payer settlement (self/insurance/corporate) → invoice finalized.
3. Doctor signs discharge summary (immutable) → nurse completes discharge instructions/medication counseling.
4. `admission: discharged` → `admission.patient.discharged` → bed → `vacated_dirty` → housekeeping task → MRD chart-completion deficiency tracking.
**Exceptions:** LAMA (consent + risk documentation, bill still settles); death (death summary → mortuary flow); insurance settlement pending → discharge-against-approval per hospital policy flag.

## 5. Billing & Payment (unified)
**Trigger:** any charge-generating service (consult, lab, radiology, pharmacy, bed-days, OT, packages).
1. Service module posts charge (`billItems`) to the open bill for the visit/admission — always via the charge-posting engine, never direct inserts.
2. Payer resolution: self / insurance (covered items flagged, pre-auth checked) / corporate (rate contract) / package (consumption decrement) / wallet.
3. Cashier finalizes (`invoice: finalized`, number from `counters`) → payment capture (`payment: captured`, multi-mode split allowed) → `billing.invoice.finalized`, `billing.payment.captured` → journal postings.
**Exceptions:** discount above threshold → approval workflow; disputed items → bill audit trail; day-end: cashier session reconciliation report.

## 6. Refund
**Trigger:** cancelled service, overpayment, deposit balance at discharge.
1. Request with reason → linked to source payment/bill → approval per amount matrix (`billing:refund` / `billing:refund:approve`).
2. Execute: gateway reversal or cash voucher → `payment: refunded` → `billing.payment.refunded` → reversal journal entry.
**Rules:** refunds never exceed source payment; mode follows source (card→card) unless overridden with approval; all refunds appear in day-end reconciliation.

## 7. Insurance (Pre-auth → Claim → Settlement)
1. Eligibility check (policy/coverage) at registration or admission.
2. Pre-auth: clinical estimate + documents → payer/TPA (NHCX where available) → `claim: pre_auth_approved` (amount capped).
3. During care: covered vs excluded items tracked on the bill; enhancement requests if estimate exceeded.
4. Discharge: claim assembled (bill + summary + documents) → `claim: submitted` → queries answered → `approved → settled`; shortfall billed to patient per policy.
**Exceptions:** denial → denial management (appeal/write-off/convert to self-pay); reconciliation matches payer remittance to claims.

## 8. Laboratory (order → report)
1. Order placed (`clinical.order.placed`) → charge posted → sample collection worklist.
2. Phlebotomist collects → barcode printed → `labOrder: collected` → received in lab (rejection possible: hemolyzed etc. → recollect).
3. Analyzer/manual results → `resulted` → technologist verify → pathologist approve (`lab.result.approved`).
4. Report published (portal/app/print) — panic values trigger immediate escalation (`lab.result.panic`) with acknowledgment audit.

## 9. Radiology (order → signed report)
1. Order → appointment/slot on modality → charge → modality worklist (DICOM MWL when integrated).
2. Technician performs study → images to DICOM store → radiologist reports (template-based) → sign (`radiology-report: signed`, immutable).
3. Report + key images published; critical findings follow the panic/critical communication path.

## 10. Pharmacy (prescription → dispense / retail sale)
1. Signed prescription enters dispense queue → pharmacist reviews (interaction/allergy warnings surfaced — override requires reason).
2. Batch-aware picking (FEFO) → dispense (`pharmacy.stock.dispensed`) → stock decrement + charge posting in one transaction → counseling note.
3. Retail/OTC sale variant: POS flow without prescription (schedule-drug rules enforced by medicine schedule flags).
**Exceptions:** partial stock → partial dispense + backorder; returns per return policy (saleable/damaged split); narcotics register entries for scheduled drugs.

## 11. Inventory Procurement (indent → GRN → issue)
1. Department indent → store review → issue from stock or convert to PO (vendor per rate contract).
2. PO approval matrix → vendor delivery → GRN (qty/quality check, batch/expiry capture) → stock in.
3. Issues to departments decrement store stock; `inventory.stock.belowReorder` drives replenishment.
4. Periodic stock audit → variance reconciliation with approval.

## 12. HR & Payroll (monthly)
1. Attendance accumulates (biometric/geo/manual with approval) → exceptions resolved by month-end.
2. Leave requests → approval chain → balances updated.
3. Payroll run: attendance + salary structure + statutory rules → draft → HR review → approve (`hr.payroll.completed`) → payslips published + salary journal posted.
**Exceptions:** off-cycle payments (advance/final settlement) follow the same approve-then-post rule.

## 13. Tenant Onboarding (SaaS, master)
1. Sales/self-serve signup → `tenant: provisioning` → create `hms_<slug>` DB → migrations → seed (roles, permissions, service catalog starter, notification templates).
2. Edition assigned (flags+limits live) → admin invited → onboarding wizard (branches, departments, doctors, tariffs).
3. Optional data import (patients/masters via import tooling) → go-live checklist → `tenant: active` → `platform.tenant.provisioned`.
