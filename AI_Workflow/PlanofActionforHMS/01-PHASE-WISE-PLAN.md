# 01 — Phase-Wise Development Plan

Nine phases, each delivering shippable, sellable increments. Every phase lists **Objectives · Modules · Pages · Database Collections · Backend APIs · Permissions · Dependencies · Estimated Development Order**.

> **Permission naming convention:** `resource:action[:scope]` e.g. `patient:create`, `billing:refund:approve`, `report:financial:view`. Scopes: `own`, `branch`, `tenant`, `global`. Every API is guarded by RBAC → permission → tenant/branch scope → row-level filter.

> **API convention:** All routes are prefixed `/api/v1`. All are tenant-scoped via JWT + `X-Branch-Id`. Standard verbs: `GET` (list/read), `POST` (create), `PATCH` (partial update), `PUT` (replace), `DELETE` (soft delete). List endpoints support `?page&limit&sort&q&filter[...]&from&to`.

---

## Phase 0 — Program Setup (pre-development, ~1 sprint)

Repository scaffolding, monorepo tooling (pnpm workspaces / Turborepo), shared ESLint/Prettier/tsconfig, CI skeleton, Docker Compose (Mongo, Redis, MinIO, Mailhog), commit hooks, environment/secrets strategy, base design system (Tailwind tokens + Shadcn), and the API contract/OpenAPI baseline. Not a product phase but a gate for all others.

---

## Phase 1 — Foundation

### Objectives

Stand up the multi-tenant SaaS backbone: identity, tenancy, RBAC/permissions, auditing, notifications, file storage, and the shell UI. Nothing clinical yet — but everything else depends on this being correct and secure.

### Modules

1. **Tenant Management** (provisioning, lifecycle, data residency)
2. **Subscription & Plans** (plans, entitlements, feature flags, usage metering, SaaS billing)
3. **Identity & Auth** (registration, login, JWT + refresh rotation, MFA, SSO/OIDC, password policy, sessions)
4. **RBAC & Permissions** (roles, permission catalog, role-permission binding, branch scoping)
5. **User & Staff Directory** (users, profiles, invitations, deactivation)
6. **Organization Setup** (hospital profile, branch management, departments, buildings, floors)
7. **Audit & Activity Logging**
8. **Notification System** (in-app, email, SMS, WhatsApp, push — channel abstraction)
9. **File & Document Service** (uploads, signed URLs, virus scan hook, storage quota)
10. **Feature Flags & Config** (per-tenant/per-plan/per-branch)
11. **Admin Console / Super-Admin** (SaaS operator surface)
12. **Application Shell** (layout, navigation, theming, branding, i18n)

### Pages

- Super-Admin: Tenant List, Tenant Detail/Provisioning, Plan Catalog, Feature-Flag Matrix, Global Usage Dashboard, Platform Health, Impersonation.
- Auth: Login, Register Tenant, Forgot/Reset Password, MFA Setup/Challenge, SSO Callback, Accept Invitation.
- Tenant Admin: Onboarding Wizard, Hospital Profile, Branch List/Editor, Department List, Building/Floor Setup, Roles List, Role Editor (permission matrix), User List, User/Staff Editor, Subscription & Billing, Branding/White-Label, Domain Settings, API Keys, Storage & Usage, Audit Log Viewer, Notification Templates & Channels, Global Search.

### Database Collections

- **Master DB `paperlesstech_master`:** `tenants` (registry: hospitalName, slug, databaseName, dbUri?, customDomain, subscription, status), `plans`, `subscriptions`, `entitlements`, `featureFlags`, `usageCounters`, `saasInvoices`, `licenses`, `supportTickets`, `globalSettings`, `customDomains`, `superAdminUsers`, `impersonationLogs`.
- **Per-tenant DB `hms_<slug>`:** `branches`, `departments`, `buildings`, `floors`, `users`, `roles`, `permissions`, `rolePermissions`, `userRoles`, `invitations`, `sessions`, `refreshTokens`, `apiKeys`, `auditLogs`, `activityLogs`, `notifications`, `notificationTemplates`, `notificationPreferences`, `files`, `configSettings`, `outboxEvents`, `idempotencyKeys`, `counters`.

### Backend APIs (representative)

- `POST /auth/register-tenant`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `POST /auth/mfa/setup`, `POST /auth/mfa/verify`, `POST /auth/forgot-password`, `POST /auth/reset-password`, `GET /auth/me`
- `GET/POST/PATCH/DELETE /tenants` (super-admin), `POST /tenants/:id/suspend|activate|export`
- `GET/POST/PATCH/DELETE /branches`, `/departments`, `/buildings`, `/floors`
- `GET/POST/PATCH/DELETE /plans`, `GET/POST /subscriptions`, `GET /usage`, `GET/PATCH /feature-flags`
- `GET/POST/PATCH/DELETE /roles`, `GET /permissions`, `POST /roles/:id/permissions`
- `GET/POST/PATCH/DELETE /users`, `POST /users/invite`, `POST /users/:id/deactivate`
- `GET /audit-logs`, `GET /activity-logs`
- `GET /notifications`, `POST /notifications/mark-read`, `CRUD /notification-templates`
- `POST /files` (signed upload), `GET /files/:id`, `DELETE /files/:id`
- `CRUD /api-keys`, `GET/PATCH /settings`, `PATCH /branding`

### Permissions (seed catalog examples)

`tenant:manage`, `branch:manage`, `department:manage`, `role:manage`, `permission:view`, `user:create|read|update|deactivate`, `subscription:manage`, `featureflag:manage`, `audit:view`, `notification:manage`, `file:upload|delete`, `apikey:manage`, `branding:manage`, `superadmin:*`.

### Dependencies

None (foundational). Everything in Phases 2–9 depends on Phase 1.

### Estimated Development Order

1. Master DB + tenant registry + provisioning (create `hms_<slug>` DB → migrate → seed) + **Connection Manager** (subdomain/custom-domain resolution, connection caching) → 1b. Auth + JWT/refresh → 2. RBAC/Permissions + tenant-context middleware (ALS) → 3. Org setup (hospital/branch/dept) → 4. Audit + Activity logs → 5. File service → 6. Notification abstraction → 7. Feature flags + subscription/plans → 8. Admin console → 9. App shell + branding + i18n.

---

## Phase 2 — Core Modules (Hospital Operations & Front Office)

### Objectives

Enable a clinic/hospital to run day-to-day front-office and administrative operations: patients in the door, doctors scheduled, appointments booked, and the physical/asset backbone modeled.

### Modules

1. **Patient Registration** (Quick, OP, IP admission, Emergency admission)
2. **Patient Profile & Master Index (MPI/UHID)**
3. **Doctor Management** (profiles, specializations, availability, schedules)
4. **Appointment Management** (calendar, online booking, walk-in, queue, tokens, reminders, reschedule/cancel, waiting list)
5. **Reception & Help Desk**
6. **Ward / Room / Bed Management** (wards, rooms, beds, OT, ICU, ER, bed board)
7. **Facility & Asset Backbone** (ambulances, medical equipment, assets, maintenance)
8. **Master Data Management** (insurance companies, corporate clients, vendors, suppliers, service catalog, tariffs)
9. **Visitor Management, Security, Parking**
10. **Feedback & Complaints, Housekeeping, Laundry, Cafeteria** (facility ops)

### Pages

- Registration: Quick Register, OP Registration, IP Admission, Emergency Registration, Patient Search/MPI, Patient Profile (360°), Duplicate-Merge.
- Doctor: Doctor Directory, Doctor Profile, Specialization Master, Availability/Schedule Editor, Slot Configuration, Leave/Attendance.
- Appointments: Calendar (day/week/month/resource), Book Appointment, Online Booking Manager, Walk-in Intake, Queue Board, Token Display, Waiting List, Reminders Config, Reschedule/Cancel.
- Facilities: Bed Board / Bed Management, Ward Setup, Room Setup, Bed Setup, OT/ICU/ER Registry, Ambulance Registry & Dispatch, Equipment Registry, Asset Registry, Maintenance Schedule/Log.
- Masters: Insurance Company List/Editor, Corporate Client List/Editor, Vendor/Supplier List/Editor, Service/Tariff Catalog, Housekeeping/Laundry/Cafeteria/Parking/Visitor/Security consoles, Feedback Inbox, Complaint Tracker.

### Database Collections

`patients`, `patientIdentifiers` (UHID/ABHA/MRN), `patientContacts`, `emergencyContacts`, `admissions`, `doctors`, `specializations`, `doctorSchedules`, `doctorAvailability`, `appointmentSlots`, `appointments`, `queues`, `tokens`, `wards`, `rooms`, `beds`, `bedAllocations`, `operationTheatres`, `icuUnits`, `emergencyRooms`, `ambulances`, `ambulanceDispatches`, `equipment`, `assets`, `maintenanceRecords`, `insuranceCompanies`, `corporateClients`, `vendors`, `suppliers`, `serviceCatalog`, `tariffs`, `visitors`, `parkingRecords`, `housekeepingTasks`, `laundryRecords`, `cafeteriaOrders`, `feedback`, `complaints`.

### Backend APIs (representative)

- `CRUD /patients`, `POST /patients/quick`, `POST /patients/:id/admit`, `POST /patients/emergency`, `GET /patients/search`, `POST /patients/merge`
- `CRUD /doctors`, `CRUD /specializations`, `CRUD /doctor-schedules`, `GET /doctors/:id/availability`
- `CRUD /appointments`, `POST /appointments/:id/reschedule|cancel|checkin`, `GET /appointments/calendar`, `CRUD /queues`, `POST /tokens/next`
- `CRUD /wards|/rooms|/beds`, `GET /beds/board`, `POST /beds/:id/allocate|release|transfer`
- `CRUD /ot|/icu|/er|/ambulances`, `POST /ambulances/:id/dispatch`
- `CRUD /equipment|/assets|/maintenance`
- `CRUD /insurance-companies|/corporate-clients|/vendors|/suppliers|/services|/tariffs`
- `CRUD /visitors|/feedback|/complaints|/housekeeping|/laundry|/cafeteria`

### Permissions

`patient:register|read|update|merge`, `admission:create|discharge`, `doctor:manage`, `schedule:manage`, `appointment:create|read|update|cancel`, `queue:manage`, `bed:manage|allocate`, `facility:manage`, `master:manage`, `visitor:manage`, `feedback:manage`, `complaint:manage`.

### Dependencies

Phase 1 (tenant, RBAC, users, files, notifications).

### Estimated Development Order

1. Master data (services, tariffs, insurance, corporate, vendors) → 2. Patient registration + MPI → 3. Doctor + schedules → 4. Appointments + queue/token → 5. Ward/bed backbone + bed board → 6. Facilities/assets/ambulance → 7. Reception/visitor/feedback/complaint + facility ops.

---

## Phase 3 — Clinical Modules

### Objectives

Deliver the clinical core: EMR, doctor consultation workflow, nursing, laboratory, radiology, operation theatre, blood bank, and pharmacy dispensing — the modules that make it a true HIS.

### Modules

1. **Electronic Medical Records (EMR)** — SOAP notes, diagnosis/ICD, procedures, clinical notes, attachments, digital signature, versioning
2. **Doctor Consultation** — dashboard, daily patients, prescriptions, clinical notes, diagnosis, procedures, referrals
3. **Medical History** — history, family history, allergies, vitals, treatment plans, follow-ups, patient timeline
4. **Nursing** — dashboard, ward management, vitals, medication administration (MAR), nursing notes, care plans, shift/handover, monitoring
5. **Laboratory (LIS)** — test master, order, sample collection/tracking, barcode, machine integration, result entry/approval, reports
6. **Radiology (RIS/PACS-lite)** — modality orders (X-Ray/MRI/CT/USG/ECG), image upload/DICOM, reporting
7. **Operation Theatre (OT)** — scheduling, pre/intra/post-op, surgical team, consumables, OT notes/reports
8. **Blood Bank** — donors, inventory, cross-match, issue, transfusion records
9. **Pharmacy (clinical link)** — e-prescription integration, dispensing, drug interaction/allergy checks
10. **Consent, Discharge & Death Summary, Referral & Transfer**
11. **Biomedical Waste Management**
12. **Tele-Consultation (clinical)**
13. **Emergency Department & Triage** — triage levels (ESI/CTAS), NEWS/MEWS early-warning scores, ED tracking board, code-blue/resuscitation record _(flag: `module.clinical.emergency`)_
14. **Critical Care (ICU / NICU / PICU)** — ICU flowsheets, hourly charting, ventilator settings, infusion tracking, APACHE-II/SOFA scores, NICU growth & feeding charts _(flag: `module.clinical.criticalCare`)_
15. **Dialysis** — sessions, machine/slot scheduling, HD/PD records, adequacy (Kt/V), vascular access tracking _(flag: `module.clinical.dialysis`)_
16. **Physiotherapy & Rehabilitation** — assessment, treatment plans, session logging, exercise library, progress outcomes _(flag: `module.clinical.physiotherapy`)_
17. **Clinical Dietetics** — nutrition assessment, therapeutic diet prescription (kitchen fulfillment stays in facility ops) _(flag: `module.clinical.dietetics`)_
18. **CSSD (Sterilization)** — instrument sets, sterilization cycles, batch/lot release, OT issue tracking _(flag: `module.support.cssd`)_
19. **Mortuary** — body admission, cold-storage assignment, release/handover, post-mortem linkage _(flag: `module.support.mortuary`)_
20. **MRD / Health Information Management** — physical chart tracking, coding worklist (ICD-10/11), deficiency management, statutory registers _(flag: `module.support.mrd`)_
21. **Specialty Charting Templates** — dental (tooth chart), ophthalmology (visual acuity/refraction), ENT (audiometry), OBG (partograph/ANC) — delivered as EMR clinical templates gated per specialty flag, **never as forked code** _(flags: `specialty.dental|eye|ent|obg`)_

### Pages

- EMR: Patient Clinical Chart (timeline), SOAP Note Editor, Diagnosis/ICD Picker, Procedure Entry, Problem List, Allergy List, Vitals Chart, Treatment Plan, Attachments, e-Sign, Version History.
- Doctor: Consultation Workspace, Daily Patient List, Prescription Composer, Order Entry (labs/radiology/procedures), Referral Form, Follow-up Scheduler, Teleconsult Room.
- Nursing: Nursing Dashboard, Ward Console, Vitals Entry, Medication Administration Record, Nursing Notes, Care Plan, Shift Handover, Patient Monitoring Board, Intake/Output Chart.
- Lab: Test Catalog, Order Worklist, Sample Collection, Sample Tracking/Barcode, Analyzer Worklist, Result Entry, Result Approval, Report Viewer/Print.
- Radiology: Modality Worklist, Order Detail, Image Upload/DICOM Viewer, Report Editor, Report Sign-off.
- OT: OT Schedule Board, Booking, Pre-op Checklist, Anesthesia Record, Intra-op Notes, Post-op/Recovery, Consumable Log, OT Report.
- Blood Bank: Donor Registry, Blood Inventory, Cross-match, Issue/Request, Transfusion Record.
- Clinical docs: Consent Form Builder/Sign, Discharge Summary, Death Summary, Referral, Transfer, Biomedical Waste Log.

### Database Collections

`emrRecords`, `soapNotes`, `diagnoses`, `icdCodes`, `snomedCodes`, `procedures`, `problemList`, `allergies`, `vitals`, `treatmentPlans`, `followUps`, `clinicalNotes`, `prescriptions`, `prescriptionItems`, `medicationOrders`, `medicationAdministration`, `nursingNotes`, `carePlans`, `shiftHandovers`, `intakeOutput`, `labTests`, `labOrders`, `samples`, `labResults`, `labResultApprovals`, `analyzers`, `radiologyOrders`, `radiologyReports`, `dicomStudies`, `otSchedules`, `otBookings`, `preOpRecords`, `anesthesiaRecords`, `intraOpNotes`, `postOpRecords`, `surgicalTeams`, `otConsumables`, `bloodDonors`, `bloodInventory`, `crossMatches`, `bloodIssues`, `transfusions`, `consents`, `dischargeSummaries`, `deathSummaries`, `referrals`, `transfers`, `biomedicalWaste`, `teleconsultSessions`, `documentSignatures`, `clinicalTemplates`, `triageRecords`, `edTrackingBoard`, `codeBlueRecords`, `icuFlowsheets`, `ventilatorSettings`, `criticalScores`, `dialysisSessions`, `dialysisMachines`, `vascularAccess`, `physioAssessments`, `physioSessions`, `exerciseLibrary`, `nutritionAssessments`, `dietPrescriptions`, `instrumentSets`, `sterilizationCycles`, `mortuaryRecords`, `chartTracking`, `codingWorklist`.

### Backend APIs (representative)

- `CRUD /emr`, `CRUD /soap-notes`, `CRUD /diagnoses`, `GET /icd/search`, `CRUD /procedures`, `CRUD /allergies`, `CRUD /vitals`, `CRUD /treatment-plans`, `CRUD /follow-ups`
- `CRUD /prescriptions`, `POST /prescriptions/:id/sign`, `GET /drug-interactions`, `POST /orders` (unified order entry)
- `CRUD /nursing-notes`, `CRUD /mar`, `POST /mar/:id/administer`, `CRUD /care-plans`, `CRUD /handovers`
- `CRUD /lab-tests`, `CRUD /lab-orders`, `POST /samples/collect`, `POST /samples/:id/track`, `POST /lab-results`, `POST /lab-results/:id/approve`
- `CRUD /radiology-orders`, `POST /radiology/:id/upload`, `CRUD /radiology-reports`, `POST /radiology-reports/:id/sign`
- `CRUD /ot-schedules|/ot-bookings`, `CRUD /pre-op|/intra-op|/post-op`, `CRUD /ot-consumables`
- `CRUD /blood-donors|/blood-inventory|/cross-matches|/blood-issues|/transfusions`
- `CRUD /consents`, `POST /discharge-summaries`, `POST /death-summaries`, `CRUD /referrals|/transfers`, `CRUD /biomedical-waste`
- `POST /teleconsult/session`, `POST /documents/:id/sign`
- `POST /triage`, `GET /ed/board`, `POST /code-blue`, `CRUD /icu-flowsheets|/ventilator-settings`, `POST /critical-scores`
- `CRUD /dialysis-sessions|/dialysis-machines|/vascular-access`, `CRUD /physio-assessments|/physio-sessions`
- `CRUD /nutrition-assessments|/diet-prescriptions`, `CRUD /cssd/sets|/cssd/cycles`, `CRUD /mortuary`, `CRUD /mrd/chart-tracking|/mrd/coding`

### Permissions

`emr:read|write|sign`, `diagnosis:manage`, `prescription:create|sign`, `order:create`, `vitals:record`, `nursing:manage`, `mar:administer`, `lab:order|collect|result|approve`, `radiology:order|report|sign`, `ot:schedule|record`, `bloodbank:manage|issue`, `consent:manage`, `discharge:create`, `referral:manage`, `teleconsult:host`, `triage:perform`, `icu:chart`, `dialysis:manage`, `physio:manage`, `diet:prescribe`, `cssd:manage`, `mortuary:manage`, `mrd:manage`.

### Dependencies

Phase 1 + Phase 2 (patients, doctors, admissions, beds, service catalog, files).

### Estimated Development Order

1. EMR core (SOAP, diagnosis/ICD, allergies, vitals, timeline) → 2. Doctor consultation + prescription + order entry → 3. Nursing (vitals/MAR/notes/handover) → 4. Lab (order→sample→result→approve) → 5. Radiology (order→image→report) → 6. OT → 7. Blood bank → 8. Consent/discharge/death/referral/transfer + biomedical waste → 9. Teleconsult → 10. Emergency & triage + critical care flowsheets → 11. Dialysis + physiotherapy + clinical dietetics → 12. CSSD + mortuary + MRD → 13. Specialty charting templates (dental/eye/ENT/OBG). Items 10–13 are flag-gated; ship them only for editions that enable them (see 07-PRODUCT-EDITIONS.md) — they do not block the Hospital-ready milestone.

---

## Phase 4 — Financial Modules

### Objectives

Full revenue cycle and finance: billing across all service lines, payments, insurance/corporate claims, pharmacy/inventory procurement, HR/payroll, and core accounting.

### Modules

1. **Billing** — OP, IP, pharmacy, lab, radiology, package, insurance, corporate; discounts, refunds, advances, multi-mode payments, GST/tax, invoices, receipts
2. **Insurance & TPA** — pre-auth, claims, eligibility, corporate billing, package billing
3. **Patient Wallet & Packages**
4. **Pharmacy (commercial)** — medicine master, inventory, batch/expiry, purchase, sales, returns, stock reports, supplier management
5. **Inventory / Store** — medical supplies, consumables, stock, purchase orders, GRN, indent, issue, transfers, returns, stock audit
6. **Finance & Accounting** — income, expenses, chart of accounts, ledger, day book, cash book, bank, tax, P&L
7. **Human Resources & Payroll** — employees, attendance/biometric, leave, payroll, payslips, recruitment, training, performance, shift planning

### Pages

- Billing: OP Bill, IP Interim/Final Bill, Consolidated Bill, Pharmacy Bill, Lab/Radiology Bill, Package Bill, Payment Collection, Advance/Deposit, Refund, Discount Approval, Invoice/Receipt Print, Bill Audit, Daily Collection.
- Insurance: Pre-Authorization, Claim Submission, Claim Tracking, Eligibility Check, Corporate Ledger, TPA Reconciliation.
- Wallet/Package: Wallet Ledger, Top-up, Package Catalog, Package Enrollment/Consumption.
- Pharmacy: Medicine Master, Stock/Inventory, Batch & Expiry, Purchase Order, GRN, Sales/POS, Returns, Supplier, Stock/Expiry/Movement Reports, Reorder.
- Inventory: Item Master, Indent, Purchase Order, GRN, Issue, Inter-store Transfer, Returns, Stock Ledger, Stock Audit/Reconciliation, Reorder.
- Finance: Chart of Accounts, Journal/Ledger, Day Book, Cash Book, Bank Book, Expense Entry, Income Entry, Tax/GST Filing, Trial Balance, P&L, Balance Sheet.
- HR: Employee Directory, Attendance/Biometric, Leave Requests/Approvals, Leave Balances, Payroll Run, Payslip, Salary Structure, Recruitment/ATS, Training, Performance Review, Shift Roster.

### Database Collections

`bills`, `billItems`, `payments`, `paymentAllocations`, `refunds`, `advances`, `discounts`, `invoices`, `receipts`, `taxConfigs`, `packages`, `packageEnrollments`, `wallets`, `walletTransactions`, `insurancePolicies`, `preAuthorizations`, `claims`, `claimItems`, `corporateLedgers`, `medicines`, `pharmacyStock`, `batches`, `pharmacyPurchases`, `pharmacySales`, `pharmacyReturns`, `inventoryItems`, `stock`, `indents`, `purchaseOrders`, `goodsReceipts`, `stockIssues`, `stockTransfers`, `stockReturns`, `stockAudits`, `chartOfAccounts`, `journalEntries`, `ledgers`, `expenses`, `incomes`, `bankAccounts`, `bankTransactions`, `employees`, `attendance`, `biometricLogs`, `leaves`, `leaveBalances`, `payrollRuns`, `payslips`, `salaryStructures`, `recruitments`, `candidates`, `trainings`, `performanceReviews`, `shiftRosters`.

### Backend APIs (representative)

- `CRUD /bills`, `POST /bills/:id/finalize`, `POST /payments`, `POST /refunds`, `POST /advances`, `POST /discounts/approve`, `GET /invoices/:id/pdf`, `GET /collections/daily`
- `CRUD /pre-auth|/claims`, `POST /claims/:id/submit`, `GET /insurance/eligibility`, `GET /corporate-ledgers/:id`
- `CRUD /packages`, `POST /packages/enroll`, `GET/POST /wallets/:patientId/transactions`
- `CRUD /medicines`, `CRUD /pharmacy/purchases|sales|returns`, `GET /pharmacy/stock`, `GET /pharmacy/expiry`
- `CRUD /inventory/items`, `CRUD /indents|/purchase-orders|/grn|/issues|/transfers|/returns`, `POST /stock/audit`
- `CRUD /accounts`, `POST /journal-entries`, `GET /ledgers/:id`, `GET /reports/daybook|cashbook|pnl|trial-balance`
- `CRUD /employees`, `POST /attendance`, `CRUD /leaves`, `POST /payroll/run`, `GET /payslips/:id`, `CRUD /recruitments|/trainings|/performance|/shifts`

### Permissions

`billing:create|finalize|discount|refund|read`, `payment:collect`, `insurance:preauth|claim`, `corporate:bill`, `wallet:manage`, `package:manage`, `pharmacy:sell|purchase|stock`, `inventory:manage|issue|audit`, `finance:ledger|expense|report`, `hr:employee|attendance|leave|payroll`, `payroll:approve`.

### Dependencies

Phase 2 (patients, services, tariffs, insurance/corporate masters, vendors), Phase 3 (clinical orders that generate charges), Phase 1 (users for HR).

### Estimated Development Order

1. Service/tariff → charge posting engine → 2. OP/IP billing + payments/refunds/advances → 3. Pharmacy master + inventory + purchase/sales → 4. General store inventory → 5. Insurance/corporate/package/wallet → 6. Finance/accounting → 7. HR/payroll.

---

## Phase 5 — Patient & Staff Applications (Mobile + Portals)

### Objectives

Ship the customer-facing and field apps: Patient App/Portal, Doctor App, Staff App, plus online registration/appointments and digital forms — the growth and engagement surface.

### Modules

1. **Patient App / Portal** — appointments, medical records, prescriptions, lab/radiology reports, bills, payments, notifications, teleconsult, chat, feedback, digital forms, family/dependents
2. **Doctor App** — appointments, patient queue, consultation, prescription, lab/radiology, patient history, notifications, telemedicine
3. **Staff App** — attendance, tasks, patient monitoring, nursing, approvals, notifications
4. **Online Registration & Appointments** (public booking, digital intake forms, e-consent)
5. **Communication** — internal chat, doctor-patient chat, announcements, push notifications, video/voice
6. **Realtime layer** — sockets for queue, chat, notifications, bed board, monitoring
7. **Home Healthcare** — field-visit scheduling, care-at-home task lists, geo check-in, offline vitals capture, visit billing _(flag: `module.clinical.homeHealthcare`; serves the Home Healthcare org type)_
8. **Occupational Health** — corporate employee health packages, pre-employment/periodic exams, fitness certificates, corporate health dashboards _(flag: `module.clinical.occupationalHealth`; composes existing packages + corporate billing)_

### Pages / Screens

- Patient App: Home, Book Appointment, My Appointments, Health Records, Prescriptions, Lab Reports, Radiology, Bills & Payments, Wallet, Teleconsult, Chat, Notifications, Feedback, Family Members, Digital Forms, Profile.
- Doctor App: Today's Schedule, Patient Queue, Consultation, e-Prescription, Order Entry, Reports Viewer, Patient History, Teleconsult, Notifications, Availability toggle.
- Staff App: Attendance (geo/biometric), Task List, Assigned Patients, Vitals/MAR, Nursing Notes, Approvals, Handover, Notifications.
- Web additions: Public Booking Portal, Digital Form Designer, Announcement Composer, Chat Console.

### Database Collections

(reuses clinical/billing collections) + `chatThreads`, `chatMessages`, `announcements`, `pushTokens`, `videoSessions`, `digitalForms`, `formSubmissions`, `onlineBookings`, `patientAppUsers`, `dependents`, `appConfigs`, `deviceSessions`.

### Backend APIs (representative)

- `GET /me/appointments|records|prescriptions|reports|bills`, `POST /me/appointments`, `POST /me/payments`, `CRUD /me/dependents`
- `CRUD /chat/threads`, `POST /chat/messages`, WebSocket `chat:*`, `queue:*`, `notification:*`
- `CRUD /announcements`, `POST /push/register`, `POST /video/session`
- `CRUD /digital-forms`, `POST /forms/:id/submit`, `POST /public/bookings`, `POST /public/register`

### Permissions

`self:read` (patient-scoped), `doctor:app`, `staff:app`, `chat:send`, `announcement:manage`, `form:design`, `booking:public`. Patient endpoints enforce `own` scope via patient identity binding.

### Dependencies

Phases 1–4 (all data the apps surface). Realtime infra from Phase 1 notifications.

### Estimated Development Order

1. Realtime + push infra → 2. Patient App (records/appointments/bills/pay) → 3. Doctor App → 4. Staff App → 5. Chat + announcements + video → 6. Public booking + digital forms.

---

## Phase 6 — Analytics & Reporting

### Objectives

Turn operational data into decisions: reporting engine, role dashboards, and the full report catalog (clinical, financial, operational, inventory, pharmacy, insurance, government/statutory).

### Modules

1. **Reporting Engine** (parameterized, scheduled, exportable PDF/Excel/CSV, drill-down)
2. **Management / Executive Dashboards** (KPIs, occupancy, revenue, throughput)
3. **Clinical Reports**, **Financial Reports**, **Operational Reports**, **Doctor Reports**, **Patient Reports**, **Inventory Reports**, **Pharmacy Reports**, **Insurance Reports**, **Government/Statutory Reports**
4. **Data warehouse / read models** (materialized aggregates, ETL jobs)
5. **Custom Report Builder** (self-service)

### Pages

Executive Dashboard, Revenue Dashboard, Occupancy/Bed Utilization, Doctor Performance, Patient Flow, Department P&L, Report Catalog, Report Runner, Scheduled Reports, Custom Report Builder, Export Center, Government Report Templates (e.g., birth/death, notifiable diseases, drug schedules).

### Database Collections

`reportDefinitions`, `reportSchedules`, `reportRuns`, `dashboards`, `dashboardWidgets`, `kpiSnapshots`, `analyticsAggregates` (materialized), `savedReports`, `exportJobs`.

### Backend APIs

`CRUD /reports/definitions`, `POST /reports/:id/run`, `CRUD /reports/schedules`, `GET /dashboards/:key`, `CRUD /dashboards`, `POST /reports/export`, `GET /kpis`. Heavy aggregation runs via BullMQ workers against read models.

### Permissions

`report:clinical|financial|operational|inventory|pharmacy|insurance|government:view`, `dashboard:view`, `report:build|schedule|export`.

### Dependencies

Phases 2–4 primarily (data sources). Read models built via change streams/ETL.

### Estimated Development Order

1. Reporting engine + export → 2. Read-model/ETL pipeline → 3. Executive + financial dashboards → 4. Clinical/operational/inventory/pharmacy reports → 5. Insurance + government/statutory → 6. Custom report builder.

---

## Phase 7 — Integrations

### Objectives

Connect to the external healthcare and business ecosystem so the platform is deployable in real institutions.

### Modules

1. **Health Interoperability** — HL7 v2, FHIR R4, ABDM/NDHM (ABHA linking, consent, health records), **NHCX** (National Health Claims Exchange — e-claims), DICOM/PACS, terminology services (ICD-10 **and ICD-11**, SNOMED CT, LOINC)
2. **Lab/Radiology Machine Integration** (ASTM/HL7 analyzers, modality worklist)
3. **Payment Gateways** (Razorpay/Stripe/PayU, UPI, cards, netbanking)
4. **Communication Providers** (SMS, Email/SMTP, WhatsApp Business API, push FCM/APNS)
5. **Insurance/TPA & Government portals**
6. **Accounting/ERP connectors** (Tally/Zoho/QuickBooks/SAP export)
7. **Identity/SSO** (OIDC, SAML, Google/Microsoft)
8. **Webhooks & Public API** (developer platform, API keys, rate limits)
9. **e-Sign / e-Prescription regulatory, Aadhaar/eKYC (region-specific)**

### Pages

Integration Marketplace/Settings, Connection Configs, HL7/FHIR Endpoint Manager, Machine Interface Console, Payment Gateway Settings, Communication Provider Settings, Webhook Manager, API Explorer/Docs, ABDM Consent Manager.

### Database Collections

`integrations`, `integrationCredentials` (encrypted), `hl7Messages`, `fhirResources`, `machineInterfaces`, `webhooks`, `webhookDeliveries`, `paymentGatewayConfigs`, `externalTransactions`, `abdmLinks`, `abdmConsents`, `ssoProviders`, `apiRateLimits`.

### Backend APIs

`CRUD /integrations`, `POST /hl7/inbound`, `GET/POST /fhir/:resource`, `POST /machines/:id/message`, `CRUD /webhooks`, `POST /payments/webhook`, `CRUD /sso-providers`, `POST /abdm/link|consent`. All external calls run through a resilient integration layer (retry, circuit breaker, dead-letter).

### Permissions

`integration:manage`, `webhook:manage`, `fhir:read|write`, `payment:config`, `sso:config`, `abdm:manage`.

### Dependencies

Phases 1–4 (data to exchange), Phase 5 (payments used by patient app), Phase 3 (lab/radiology machines).

### Estimated Development Order

1. Payment + communication providers (revenue/engagement critical) → 2. Lab/radiology machine interfaces → 3. HL7/FHIR + DICOM → 4. ABDM/government → 5. SSO → 6. Accounting connectors → 7. Public API + webhooks + developer portal.

---

## Phase 8 — AI Features

### Objectives

Layer intelligent assistance on top of the clean, structured data — differentiators that command premium tiers. All AI is advisory, auditable, human-in-the-loop, and never auto-acts on clinical decisions.

### Modules

1. **AI Appointment Assistant** (smart scheduling, no-show prediction, slot optimization)
2. **AI Symptom Checker / Triage**
3. **AI Prescription Suggestions** (with interaction/allergy guardrails — advisory only)
4. **AI Clinical Documentation** — Voice-to-Clinical-Notes (ambient scribe), Medical Document OCR
5. **AI Analytics & Forecasting** — bed occupancy prediction, revenue forecasting, inventory/demand prediction
6. **AI Chat Assistant** (staff copilot + patient FAQ bot, RAG over tenant knowledge base)
7. **AI Coding Assist** (ICD/procedure code suggestion), **AI Report Summarization**

### Pages

AI Assistant Panel (contextual), Symptom Checker (patient app), Voice Scribe (doctor app/web), OCR Intake, Forecasting Dashboards (bed/revenue/inventory), No-Show Insights, AI Settings & Guardrails, Model/Prompt Audit Log, Suggestion Review Queue.

### Database Collections

`aiJobs`, `aiSuggestions`, `aiFeedback`, `aiAuditLogs`, `embeddings` (vector), `knowledgeBase`, `ocrExtractions`, `voiceTranscripts`, `forecasts`, `modelConfigs`, `promptTemplates`.

### Backend APIs

`POST /ai/triage`, `POST /ai/prescription-suggest`, `POST /ai/voice-to-note`, `POST /ai/ocr`, `POST /ai/chat`, `GET /ai/forecast/:type`, `POST /ai/suggest/icd`, `CRUD /ai/knowledge-base`, `GET /ai/audit`. All requests carry tenant context; PHI is redacted/handled per data-processing agreements; outputs are logged with model + prompt version.

### Permissions

`ai:use`, `ai:triage`, `ai:scribe`, `ai:ocr`, `ai:forecast:view`, `ai:configure`, `ai:review-suggestions`. Clinical AI outputs require a licensed user to accept/sign.

### Dependencies

Phases 3 (clinical data), 4 (financial/inventory data), 6 (analytics/read models), 7 (LLM/provider integration). Uses the latest Claude models via the integration layer.

### Estimated Development Order

1. AI infra (job queue, provider abstraction, guardrails, audit, vector store) → 2. OCR + Voice-to-Notes → 3. Chat assistant (RAG) → 4. Forecasting (bed/revenue/inventory) → 5. Appointment assistant/no-show → 6. Symptom checker → 7. Prescription/ICD suggestion (most-guarded, last).

---

## Phase 9 — Production, Hardening & Launch

### Objectives

Make it enterprise-deployable and operable: security hardening, compliance, performance, DR, observability, multi-region, and go-live operations.

### Modules

1. **Security Hardening** — pen-test remediation, SAST/DAST, dependency scanning, secrets management, WAF, field-level PHI encryption, session/API security
2. **Compliance** — HIPAA/GDPR/DPDP/ABDM controls, DPA templates, consent & data-subject request tooling, retention policies
3. **Backups & Disaster Recovery** — automated backups, PITR, cross-region replication, DR drills
4. **Observability & SRE** — metrics, tracing, logging, alerting, SLOs, runbooks, on-call
5. **Performance & Scaling** — load testing, sharding, caching, read replicas, autoscaling
6. **Deployment** — blue-green/canary, IaC, environment promotion, PM2/K8s, rollback
7. **Tenant Operations** — onboarding automation, migration tools, data import, white-label go-live, billing/dunning
8. **Documentation & Enablement** — admin/user/API docs, training, support playbooks, status page

### Pages

Platform Health & SLO Dashboard, Backup/DR Console, Security Center, Compliance/Consent Center, Data Subject Requests, Audit Explorer, Deployment/Release Console, Tenant Migration/Import Wizard, Status Page, Support/Incident Console.

### Database Collections

`backups`, `restorePoints`, `drDrills`, `securityScans`, `incidents`, `slaMetrics`, `dataSubjectRequests`, `retentionPolicies`, `dataExports`, `migrationJobs`, `releaseRecords`.

### Backend APIs

`POST /backups/run`, `POST /restore`, `GET /health`, `GET /ready`, `GET /metrics`, `CRUD /incidents`, `POST /dsr` (data subject request), `CRUD /retention-policies`, `POST /tenants/:id/migrate`, `POST /import`.

### Permissions

`platform:operate`, `backup:manage`, `security:manage`, `compliance:manage`, `dsr:process`, `release:deploy`, `migration:run`.

### Dependencies

All prior phases. This phase gates general availability (GA).

### Estimated Development Order

1. Observability + health/readiness → 2. Backups + DR + PITR → 3. Security hardening + scanning → 4. Compliance + consent + DSR tooling → 5. Load/perf + scaling → 6. Blue-green/canary deploy + IaC → 7. Tenant onboarding/migration/import → 8. Docs + support + GA launch.

---

## Cross-Phase Dependency Graph (summary)

```
P1 Foundation ─┬─> P2 Core Ops ─┬─> P3 Clinical ─┬─> P4 Financial ─┬─> P6 Analytics
               │                │                │                 │
               │                └────────────────┼──> P5 Apps ─────┤
               │                                  │                 │
               └──────────────────────────────────┴──> P7 Integrations ──> P8 AI
                                                                          │
   All ───────────────────────────────────────────────────────────────> P9 Production
```

Rule of thumb: **P1 → P2 → P3 → P4** are strictly sequential foundations; **P5, P6, P7** can partly parallelize once P4 is stable; **P8** needs P3/P4/P6/P7; **P9** runs continuously but gates GA.
