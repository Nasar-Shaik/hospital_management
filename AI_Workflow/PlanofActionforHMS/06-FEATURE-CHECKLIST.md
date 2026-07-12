# 06 — Master Feature Checklist

Exhaustive tick-list proving no hospital feature is missed. Grouped by domain; each maps to a module in [02-MODULE-CATALOG.md](./02-MODULE-CATALOG.md) and a phase in [01-PHASE-WISE-PLAN.md](./01-PHASE-WISE-PLAN.md). Use as sales-completeness proof and release gate.

Legend: ☐ planned · maps to Phase (P#).

---

## Hospital Administration
- ☐ Hospital Profile (P1) · ☐ Licenses & Accreditation (P1)
- ☐ Branch Management (P1) · ☐ Departments (P1) · ☐ Buildings (P1) · ☐ Floors (P1)
- ☐ Wards (P2) · ☐ Rooms (P2) · ☐ Beds (P2) · ☐ Bed Board / Allocation / Transfer (P2)
- ☐ Operation Theatres (P2) · ☐ ICUs (P2) · ☐ Emergency Rooms (P2)
- ☐ Ambulances + Dispatch (P2)
- ☐ Medical Equipment (P2) · ☐ Assets (P2) · ☐ Maintenance + Calibration + Work Orders (P2)
- ☐ Insurance Companies (P2) · ☐ Corporate Clients + Rate Contracts (P2)
- ☐ Vendors (P2) · ☐ Suppliers (P2)
- ☐ Inventory / Store (P4)
- ☐ Pharmacy (P4) · ☐ Laboratory (P3) · ☐ Radiology (P3) · ☐ Blood Bank (P3)
- ☐ Biomedical Waste (P3)
- ☐ Housekeeping (P2) · ☐ Laundry (P2) · ☐ Cafeteria + Diet (P2) · ☐ Parking (P2)
- ☐ Security + Incidents (P2) · ☐ Visitor Management + Passes (P2)
- ☐ Reception (P2) · ☐ Help Desk / Ticketing (P2) · ☐ Feedback + Surveys/NPS (P2) · ☐ Complaints (P2)

## Patient Management
- ☐ Patient Registration (P2) · ☐ Quick Registration (P2) · ☐ OP Registration (P2)
- ☐ IP Admission (P2) · ☐ Emergency Admission (P2)
- ☐ Patient Profile / MPI-UHID (P2) · ☐ Duplicate Merge (P2)
- ☐ Medical History (P3) · ☐ Family History (P3) · ☐ Allergies (P3) · ☐ Vitals (P3)
- ☐ Diagnosis (P3) · ☐ Treatment Plans (P3) · ☐ Follow Ups (P3) · ☐ Patient Timeline (P3)
- ☐ Medical Records (P3) · ☐ Patient Documents (P3) · ☐ Consent Forms (P3)
- ☐ Discharge Summary (P3) · ☐ Death Summary (P3)
- ☐ Referral Management (P3) · ☐ Transfer Patient (P3)
- ☐ Patient Wallet (P4) · ☐ Packages (P4) · ☐ Insurance (P4) · ☐ Corporate Billing (P4)
- ☐ Online Registration (P5) · ☐ Online Appointments (P5) · ☐ Digital Forms (P5)

## Doctor Management
- ☐ Doctor Profiles (P2) · ☐ Specializations (P2) · ☐ Availability (P2)
- ☐ Consultation Schedule (P2) · ☐ Appointment Slots (P2) · ☐ Tele Consultation (P3)
- ☐ Doctor Dashboard (P2/P3) · ☐ Daily Patients (P3) · ☐ Prescriptions (P3)
- ☐ Clinical Notes (P3) · ☐ Diagnosis (P3) · ☐ Procedures (P3) · ☐ Operations (P3) · ☐ Referrals (P3)
- ☐ Doctor Performance (P2/P6) · ☐ Revenue (P4/P6) · ☐ Doctor Leave (P2) · ☐ Doctor Attendance (P2)

## Appointment Management
- ☐ Calendar (P2) · ☐ Online Booking (P5) · ☐ Walk-in Patients (P2)
- ☐ Queue Management (P2) · ☐ Token System (P2) · ☐ Appointment Status (P2)
- ☐ Appointment Reminders (P2) · ☐ Cancellation (P2) · ☐ Rescheduling (P2) · ☐ Waiting List (P2)

## Emergency & Critical Care *(flag-gated, P3)*
- ☐ Triage (ESI/CTAS) (P3) · ☐ NEWS/MEWS Scores (P3) · ☐ ED Tracking Board (P3)
- ☐ Code Blue / Resuscitation Record (P3) · ☐ MLC Register (P3) · ☐ Disposition (admit/discharge/LAMA) (P3)
- ☐ ICU Flowsheets (P3) · ☐ Ventilator Settings (P3) · ☐ Infusion/Line Management (P3)
- ☐ APACHE-II / SOFA / GCS (P3) · ☐ NICU Growth & Feeding Charts (P3) · ☐ PICU Charting (P3)

## Specialty Services *(flag-gated, P3/P5)*
- ☐ Dialysis Sessions + Machine Scheduling + Adequacy (P3) · ☐ Vascular Access Tracking (P3)
- ☐ Physiotherapy Assessment/Plans/Sessions (P3) · ☐ Exercise Library + Home Programs (P3/P5)
- ☐ Clinical Dietetics — Nutrition Assessment + Diet Prescription (P3)
- ☐ Dental Tooth Charting (P3, template) · ☐ Ophthalmology Visual Acuity/Refraction (P3, template) · ☐ ENT Audiometry (P3, template)
- ☐ Home Healthcare Field Visits (P5) · ☐ Occupational Health / Corporate Exams (P5)

## Support Departments *(flag-gated, P3)*
- ☐ CSSD — Sets, Cycles, Release, Recall (P3) · ☐ Mortuary — Admission/Storage/Release (P3)
- ☐ MRD — Chart Tracking (P3) · ☐ Coding Worklist ICD-10/11 (P3) · ☐ Record Deficiency Tracking (P3) · ☐ Statutory Registers (P3)

## Nursing
- ☐ Nursing Dashboard (P3) · ☐ Ward Management (P3) · ☐ Vitals (P3)
- ☐ Medication Administration / MAR (P3) · ☐ Nursing Notes (P3) · ☐ Care Plans (P3)
- ☐ Shift Management (P3) · ☐ Handover (P3) · ☐ Patient Monitoring (P3) · ☐ Intake/Output (P3)

## Electronic Medical Records (EMR)
- ☐ SOAP Notes (P3) · ☐ Diagnosis (P3) · ☐ ICD Codes (P3) · ☐ SNOMED/LOINC (P3)
- ☐ Procedures (P3) · ☐ Treatment Plans (P3) · ☐ Clinical Notes (P3)
- ☐ Lab Reports (P3) · ☐ Radiology Reports (P3) · ☐ Prescription History (P3)
- ☐ Attachments (P3) · ☐ Digital Signature (P3) · ☐ Version History (P3) · ☐ Clinical Templates (P3)

## Laboratory Management
- ☐ Lab Tests / Panels (P3) · ☐ Sample Collection (P3) · ☐ Sample Tracking (P3) · ☐ Barcode (P3)
- ☐ Machine Integration (P7) · ☐ Result Entry (P3) · ☐ Result Approval (P3)
- ☐ Reference Ranges (P3) · ☐ Patient Reports (P3)

## Radiology
- ☐ X-Ray (P3) · ☐ MRI (P3) · ☐ CT Scan (P3) · ☐ Ultrasound (P3) · ☐ ECG (P3)
- ☐ Image Uploads / DICOM (P3) · ☐ Radiology Reports + Sign-off (P3) · ☐ PACS Integration (P7)

## Operation Theatre
- ☐ OT Scheduling (P3) · ☐ Pre Operation (P3) · ☐ Anesthesia Record (P3)
- ☐ Operation Notes (P3) · ☐ Post Operation (P3) · ☐ Surgical Team (P3)
- ☐ Equipment (P3) · ☐ Consumables (P3) · ☐ OT Reports (P3)

## Pharmacy
- ☐ Medicine Master (P4) · ☐ Inventory (P4) · ☐ Expiry (P4) · ☐ Batch Management (P4)
- ☐ Purchase (P4) · ☐ Sales/POS (P4) · ☐ Returns (P4) · ☐ Prescription Integration (P3/P4)
- ☐ Billing (P4) · ☐ Stock Reports (P4/P6) · ☐ Supplier Management (P4) · ☐ Dispensing (P4)

## Inventory Management
- ☐ Medical Supplies (P4) · ☐ Consumables (P4) · ☐ Stock (P4)
- ☐ Purchase Orders (P4) · ☐ Goods Receipt/GRN (P4) · ☐ Vendor Management (P2/P4)
- ☐ Indent (P4) · ☐ Issue (P4) · ☐ Transfers (P4) · ☐ Returns (P4) · ☐ Stock Audit (P4)

## Billing
- ☐ OP Billing (P4) · ☐ IP Billing (P4) · ☐ Pharmacy Billing (P4) · ☐ Lab Billing (P4)
- ☐ Radiology Billing (P4) · ☐ Package Billing (P4) · ☐ Insurance Billing (P4) · ☐ Corporate Billing (P4)
- ☐ Discounts (P4) · ☐ Refunds (P4) · ☐ Advance Payments (P4) · ☐ Payment History (P4)
- ☐ Multiple Payment Modes (P4) · ☐ GST/Tax (P4) · ☐ Invoices (P4) · ☐ Receipts (P4)

## Finance
- ☐ Income (P4) · ☐ Expenses (P4) · ☐ Accounts / Chart of Accounts (P4) · ☐ Ledger (P4)
- ☐ Day Book (P4) · ☐ Cash Book (P4) · ☐ Bank (P4) · ☐ Tax (P4) · ☐ Profit / P&L Reports (P4/P6)

## Human Resources
- ☐ Employees (P4) · ☐ Attendance (P4) · ☐ Biometric (P4) · ☐ Leave (P4)
- ☐ Payroll (P4) · ☐ Payslips (P4) · ☐ Recruitment (P4) · ☐ Training (P4)
- ☐ Performance (P4) · ☐ Shift Planning (P4)

## Patient Mobile App
- ☐ Appointments (P5) · ☐ Medical Records (P5) · ☐ Prescriptions (P5) · ☐ Lab Reports (P5)
- ☐ Radiology Reports (P5) · ☐ Bills (P5) · ☐ Payments (P5) · ☐ Notifications (P5)
- ☐ Tele Consultation (P5) · ☐ Chat (P5) · ☐ Feedback (P5) · ☐ Family/Dependents (P5) · ☐ Wallet (P5)

## Doctor Mobile App
- ☐ Appointments (P5) · ☐ Patient Queue (P5) · ☐ Consultation (P5) · ☐ Prescription (P5)
- ☐ Lab Reports (P5) · ☐ Radiology (P5) · ☐ Patient History (P5) · ☐ Notifications (P5) · ☐ Telemedicine (P5)

## Staff Mobile App
- ☐ Attendance (P5) · ☐ Tasks (P5) · ☐ Patient Monitoring (P5)
- ☐ Nursing (P5) · ☐ Approvals (P5) · ☐ Notifications (P5)

## Communication
- ☐ Internal Chat (P5) · ☐ Doctor-Patient Chat (P5) · ☐ Announcements (P5)
- ☐ SMS (P7) · ☐ Email (P1/P7) · ☐ WhatsApp (P7) · ☐ Push Notifications (P5)
- ☐ Video Consultation (P5) · ☐ Voice Calling (P5)

## Reports
- ☐ Clinical Reports (P6) · ☐ Financial Reports (P6) · ☐ Operational Reports (P6)
- ☐ Management Dashboard (P6) · ☐ Doctor Reports (P6) · ☐ Patient Reports (P6)
- ☐ Inventory Reports (P6) · ☐ Pharmacy Reports (P6) · ☐ Insurance Reports (P6) · ☐ Government/Statutory Reports (P6)

## AI Features
- ☐ AI Appointment Assistant (P8) · ☐ AI Symptom Checker (P8) · ☐ AI Prescription Suggestions (P8)
- ☐ AI Analytics (P8) · ☐ AI Bed Prediction (P8) · ☐ AI Revenue Forecasting (P8)
- ☐ AI Inventory Prediction (P8) · ☐ AI Chat Assistant (P8) · ☐ Medical Document OCR (P8) · ☐ Voice to Clinical Notes (P8)

## Security
- ☐ Role Based Access (P1) · ☐ Permission Management (P1) · ☐ Audit Logs (P1) · ☐ Activity Logs (P1)
- ☐ Encryption (P1/P9) · ☐ Backups (P9) · ☐ Disaster Recovery (P9)
- ☐ Session Management (P1) · ☐ API Security (P1/P9)

## SaaS Features
- ☐ Tenant Management (P1) · ☐ Subscription Plans (P1) · ☐ SaaS Billing (P1)
- ☐ Usage Tracking (P1) · ☐ Feature Flags (P1) · ☐ Custom Branding (P1)
- ☐ Custom Domains (P1) · ☐ Branch-Wise Permissions (P1) · ☐ Storage Limits (P1) · ☐ API Keys (P1)

## Integrations
- ☐ HL7 v2 (P7) · ☐ FHIR R4 (P7) · ☐ DICOM/PACS (P7) · ☐ ABDM/NDHM (P7)
- ☐ Lab/Radiology Machines (P7) · ☐ Payment Gateways (P7) · ☐ SMS/Email/WhatsApp/Push (P7)
- ☐ Insurance/TPA/Gov portals (P7) · ☐ Accounting/ERP connectors (P7) · ☐ SSO/OIDC/SAML (P7)
- ☐ Webhooks + Public API (P7) · ☐ e-Sign / eKYC (P7)

## Compliance & Standards
- ☐ HIPAA controls mapped (P9) · ☐ GDPR (P9) · ☐ India DPDP (P9)
- ☐ NABH operational alignment (P3–P9) · ☐ NABL (lab QC/EQAS evidence) (P3/P7) · ☐ JCI alignment (P9)
- ☐ FHIR R4 (P7) · ☐ HL7 v2 (P7) · ☐ DICOM (P7) · ☐ LOINC (P3/P7) · ☐ SNOMED CT (P3/P7)
- ☐ ICD-10 (P3) · ☐ ICD-11 (P3/P7, per-tenant coding-system config) · ☐ ABDM/ABHA (P7) · ☐ NHCX e-claims (P7)
- ☐ Consent Management (P3/P9) · ☐ Retention Policies + Legal Hold (P9) · ☐ Audit Evidence Packs (P1/P9)
- ☐ Encryption at rest + in transit + field-level PHI (P1/P9)

## Production / Platform
- ☐ CI/CD (P0/P9) · ☐ Docker (P0/P9) · ☐ PM2 (P9) · ☐ Kubernetes (P9)
- ☐ Redis (P1) · ☐ Queue Processing (P1/P9) · ☐ Observability (P9)
- ☐ Load/Perf testing (P9) · ☐ Data Residency (P9) · ☐ DSR/Erasure (P9)
- ☐ Product Editions enforcement (limits/flags per Doc 07) (P1/P2) · ☐ Dedicated DB/Cluster upgrade path (P9)

---

## Completeness Verification (self-review)

> **Scope note:** this verification asserts *blueprint completeness* (every feature is specified and traceable), **not build status**. Build status lives in [00-PROGRESS-TRACKER.md](./00-PROGRESS-TRACKER.md) and is the single source of truth for "what is actually implemented."

The blueprint was cross-checked against the user's exhaustive feature list. Confirmations:

1. **Every listed administration, patient, doctor, appointment, nursing, EMR, lab, radiology, OT, pharmacy, inventory, billing, finance, HR, mobile, communication, reports, AI, security and SaaS item** appears above and traces to a module (Doc 02) and a phase (Doc 01). ✅
2. **Multi-tenancy, RBAC + permission-based access, JWT + refresh tokens, file uploads, audit logs, notifications, realtime, push, Docker, CI/CD, PM2, Redis, queues** — all designed as first-class concerns (Docs 01, 03, 04). ✅
3. **All target segments** (clinic → chain → diagnostics → medical college → specialty) are addressed via feature flags, plan tiers, configurable clinical templates and branch/multi-entity modeling (README §2, Doc 02 A2/A8). ✅
4. **Enterprise-grade concerns not explicitly requested but required for commercial sale** were added: transactional integrity/outbox, idempotency, standards (HL7/FHIR/ICD/SNOMED/LOINC/DICOM/ABDM), compliance & DSR, DR/RPO-RTO, observability, scaling/sharding, white-label mobile, denial management, biomedical waste, diet/cafeteria, reference-data strategy. ✅
5. **Clinical safety & regulatory posture** — allergy/interaction checks, immutable audit, digital signatures, versioned records, human-in-the-loop AI, NABH/JCI/HIPAA alignment. ✅
6. **Database design** — ~180 tenant-scoped collections with relationships, compound indexes leading with `tenantId`, sharding, TTL, transactions and archival (Doc 03). ✅
7. **Architecture deliverables** — folder structures (backend, web, admin, RN), API structure, repository (monorepo), Docker, CI/CD (Doc 04). ✅
8. **Delivery** — roadmap, sprint plan, priority matrix, testing strategy, production checklist, scaling strategy (Doc 05). ✅

### Verdict
**Suitable for an ERP-grade, multi-tenant commercial Hospital Management SaaS platform.** The design is modular, monetizable, standards-based, secure, auditable, horizontally scalable, and sequenced so that a sellable increment ships at the end of Phase 2, a full HIS at Phase 4, and enterprise GA at Phase 9. No feature from the requested scope was skipped; additional enterprise-critical capabilities were incorporated to meet the bar set by Epic, Cerner, Athenahealth, Practo and MediBuddy.
