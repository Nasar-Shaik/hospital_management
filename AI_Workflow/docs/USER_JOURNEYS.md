# USER JOURNEYS

Day-in-the-life journeys per persona — what each user does, in what order, on which surface. UI/UX and module work must serve these paths; if an implementation makes a journey step slower or adds clicks, that's a regression to justify. Workflows referenced from `BUSINESS_WORKFLOWS.md` (W#).

---

## 1. Receptionist / Front Desk (web, high-volume, keyboard-first)

Morning: open Reception Console → today's appointment list + walk-in queue.
Per patient (60–90 s target): search MPI → register if new (W1) → check-in appointment / issue walk-in token (W2) → collect consult fee → direct to queue.
Interleaved: phone bookings, reschedules/cancellations, visitor passes, answering "how long?" (queue board).
End of day: cashier session reconciliation.
**Critical needs:** instant patient search (<300 ms), zero-mouse flows, duplicate warnings inline, queue visibility.

## 2. Doctor (web + doctor app)

Morning: today's schedule + ward list (if IP duties) on app.
OPD session: queue → open patient → 360° chart (history, allergies, last visits) → SOAP → orders → e-prescription (sign) → follow-up (W2). Target: chart review < 30 s, prescription < 60 s.
Ward rounds: patient list by ward → review vitals/MAR/results since yesterday → progress note → modify orders.
Interleaved: panic-value alerts (acknowledge → act), teleconsults, referrals in, result sign-offs.
**Critical needs:** longitudinal timeline that loads fast, order sets/favorites, mobile parity for rounds, minimal typing (templates, voice later).

## 3. Nurse (staff app + ward console, offline-tolerant)

Shift start: handover (incoming) → assigned patients list → pending tasks (vitals due, MAR due).
Hourly loop: vitals entry → MAR administration (verify patient-drug-dose-route-time; overdue flags) → intake/output → nursing notes.
Events: new admission assessment (W3), pre-op checklist, discharge instructions (W4), early-warning score alerts.
Shift end: handover (outgoing) with auto-compiled summary.
**Critical needs:** worklist-driven UI (never hunting), offline capture with sync, barcode scanning path (future BCMA), one-tap escalation.

## 4. Lab Technician (web + collection app)

Queue: collection worklist → collect + barcode (W8) → receive-in-lab.
Bench: analyzer worklist → results flow in (interfaced) or manual entry → flag review → verify → send to pathologist approval queue.
Interleaved: sample rejections (recollect), urgent/STAT ordering, panic-value phone-call documentation.
**Critical needs:** barcode-first operations, TAT timers visible, rejection reasons one-tap, zero re-typing from analyzers.

## 5. Pharmacist (web POS + dispense queue)

Dispense loop: prescription queue → review interactions/allergy warnings → batch-aware pick (FEFO prompts) → dispense + bill (W10).
Retail: walk-in POS sales, returns.
Daily: expiry alerts, reorder review, GRN receipt of purchases.
**Critical needs:** fast queue triage, warning fatigue control (severity-ranked), stock truth (no negative stock ever), schedule-drug compliance prompts.

## 6. Hospital Admin (web)

Weekly: user/role management, new doctor onboarding (profile→schedule→fees), tariff updates, department settings.
Monthly: subscription/usage review (limits), branch performance dashboards, feedback/complaint SLAs, license/accreditation expiry calendar.
Occasional: branding, notification templates, integration settings.
**Critical needs:** guardrails (can't break RBAC in ways that lock out care), audit visibility, sensible defaults.

## 7. HR Manager (web)

Daily: attendance exceptions, leave approvals.
Monthly cycle: roster publication → payroll run → review variances → approve → payslips (W12).
Quarterly: appraisals, training compliance, statutory filings export.
**Critical needs:** exception-driven screens (not row-scanning), approval chains that work on mobile, payroll dry-run diffs.

## 8. Finance / Billing Manager (web)

Daily: day book, cashier reconciliations, discount audit, refunds approval (W6).
Weekly: AR aging (insurance/corporate outstanding), claim status review (W7), denial worklist.
Monthly: P&L, department revenue, GST filings export, corporate invoicing.
**Critical needs:** drill-down from every number to source transactions, immutable trails, export everything.

## 9. Patient (patient app / portal)

Discover→book: find doctor → slot → pay/confirm (W2) → reminders.
Visit day: directions/token status → consult → e-prescription + invoice in app.
Ongoing: lab/radiology reports (with explanation of flagged values), medication reminders, follow-up booking, family/dependents management, teleconsult, bill payment/history, feedback.
IP episode: admission info, daily bill running view, discharge summary access.
**Critical needs:** zero-training UX, vernacular language support, report access the moment it's approved, no dead ends (every screen has a next action).

---

**Coverage rule:** every journey step must map to a module page (Doc 02). When adding a persona (e.g., dialysis technician, CSSD supervisor), add the journey here first — it drives the page list.
