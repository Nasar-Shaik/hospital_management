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

## 2. The OP Encounter — ONE flow, every organization type (ADR-0013)

**This section previously described "Appointment Booking → Consultation" and listed the walk-in as an _exception_.** That was backwards. Only ONE of our six target organization types (the private hospital) is appointment-first; the government hospital, the small clinic and the diagnostic centre are walk-in-first. **The Encounter is the flow. The appointment is one way of starting it.**

**Trigger:** any encounter origin — `appointment | walk_in | emergency | referral | camp | telemedicine | corporate`.

1. **Arrival.** The patient is identified (existing UHID) or registered (§1 → new UHID). An **Encounter opens** (`arrived`) → `encounter.encounter.started`.
   - Origin `walk_in` (clinic, government): the encounter is created **directly**. There is no appointment and none is fabricated.
   - Origin `appointment`: `checked_in` on the appointment **creates** the encounter. The promise is kept.
2. **Token & queue.** A token is issued against the **Encounter** (not the appointment) and a doctor work item appears on the queue board. When it is issued is policy — `encounterPolicy.tokenIssuedAt`: at registration (government, clinic) or at check-in (private).
3. **Routing.** To a named doctor (private, clinic) or to a **department / OP room** (government) — `encounterPolicy.routing`. The doctor logs in and simply **sees their waiting patients**; nobody hands them a list.
4. **Consultation.** `in_progress` → SOAP note, diagnoses (ICD), **orders**, prescription (sign → `clinical.prescription.signed`).
5. **Investigations.** Each order → `order.order.placed` → **the work item appears in the lab/radiology queue automatically.** No paper, no hand-off. The encounter moves to `awaiting_results` — **the patient keeps the SAME encounter while they go to the lab.**
6. **Reports return.** Technician performs → pathologist/radiologist **verifies** → `released` → `order.result.released` → the report is available to the ordering doctor and the encounter becomes actionable again.
   > **Step 6 is why `awaiting_results` exists.** Without it, hospitals re-register the returning patient and fragment one visit into two — the commonest data-quality disaster in an OPD. It double-counts the census and splits the bill.
7. **Decision.** Prescribe · refer · **admit** (→ §3) · schedule follow-up.
8. **Close.** `encounter: closed` → `encounter.encounter.closed` → OP bill assembled from posted charges.
   - `billingMode: prepaid` (private) — payment gates the consultation.
   - `billingMode: postpaid` (clinic) — pay on the way out.
   - `billingMode: zero_tariff` (government) — **charges are still posted, at ₹0.** Billing is never skipped: a government hospital must still report drug consumption, per-patient cost and NHM utilisation, and that data cannot be reconstructed later. A zero-rupee invoice is a record; a missing invoice is a hole (ADR-0013 §6).

**Exceptions:** no-show (auto after grace → waiting-list promotion); `left_without_being_seen` (queued, never called); teleconsult variant (video room instead of physical arrival).

### The three canonical journeys are ONE graph plus five policy switches

No workflow engine, no per-tenant graph, no branching on `organizationType` (ADR-0013 §5–6).

| Policy          | Private hospital | Small clinic | Government hospital  |
| --------------- | ---------------- | ------------ | -------------------- |
| `entry`         | appointment      | walk-in      | walk-in              |
| `tokenIssuedAt` | check-in         | registration | registration         |
| `routing`       | named doctor     | the doctor   | department / OP room |
| `billingMode`   | prepaid          | postpaid     | zero_tariff          |
| `pharmacy`      | in-house         | external     | in-house             |

## 3. IP Admission — a LINKED encounter, not a continuation (ADR-0013 §4)

**Trigger:** an **admission order** from the OP/ED encounter, or a planned admission.

**The OP encounter CLOSES (`admitted`) and an INPATIENT encounter OPENS in the SAME Episode of Care.** The admission therefore inherits the whole story — the OP consultation notes, every investigation, every report, every prescription — because they all hang on encounters that belong to that episode. The doctor sees one unbroken timeline; the system keeps two billable, countable encounters.

> Extending the OP encounter through the admission was rejected: OP and IP tariffs differ, bed charges accrue per day, and census/ALOS/NABH all count encounters. Two encounters can always be joined into a timeline; one encounter can never be split back apart once notes and charges have accumulated. **Continuity is a read concern; separation is a billing and statutory concern.**

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
