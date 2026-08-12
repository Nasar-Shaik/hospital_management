# 02 — Complete Module Catalog

Every module specified with the same template:

> **Module Name · Purpose · Pages (with purpose) · Database Collections · REST APIs · Permissions · Dependencies · Reports · Mobile Support · Future Enhancements**

Modules are grouped by domain. APIs are under `/api/v1`, tenant- and branch-scoped. Permissions use `resource:action[:scope]`.

---

# DOMAIN A — SaaS & Platform

## A1. Tenant Management

**Purpose:** Provision, configure, suspend, export and terminate hospital tenants with full data isolation and lifecycle control. Runs against the **master database `paperlesstech_master`**; provisioning creates the tenant's **dedicated database `hms_<slug>`** (create DB → run migrations → seed roles/permissions → invite admin). The registry maps `tenantId, hospitalName, slug, databaseName, dbUri?, customDomain, subscription, status`; the Connection Manager resolves requests to the right DB by subdomain or custom domain.
**Pages:**

- _Tenant List_ — browse/search all tenants (super-admin).
- _Tenant Provisioning_ — create a tenant, assign plan, region, initial admin.
- _Tenant Detail_ — configuration, status, usage, lifecycle actions.
- _Impersonation_ — support login-as with audit.
- _Data Residency_ — pin region, view compliance posture.

**Collections:** [MASTER] `tenants` (registry), `licenses`, `supportTickets`, `globalSettings`, `impersonationLogs`; [tenant DB] `tenantSettings`.
**REST APIs:** `GET/POST/PATCH/DELETE /tenants`, `POST /tenants/:id/suspend|activate|export|terminate`, `POST /tenants/:id/impersonate`.
**Permissions:** `superadmin:tenant:manage`, `tenant:impersonate`, `tenant:export`.
**Dependencies:** None (root).
**Reports:** Tenant growth, churn, per-tenant usage, provisioning audit.
**Mobile:** No (super-admin web only).
**Future:** Self-serve signup + automated onboarding, tenant health scoring, usage-based auto-tiering.

## A2. Subscription & Plans

**Purpose:** Define plans, entitlements, metered usage and SaaS billing/dunning.
**Pages:** Plan Catalog, Plan Editor, Subscription Detail, Usage & Limits, Invoices & Dunning, Feature-Flag Matrix.
**Collections:** `plans`, `subscriptions`, `entitlements`, `usageCounters`, `saasInvoices`, `featureFlags`.
**REST APIs:** `CRUD /plans`, `CRUD /subscriptions`, `GET /usage`, `POST /subscriptions/:id/upgrade|downgrade|cancel`, `GET/PATCH /feature-flags`.
**Permissions:** `subscription:manage`, `featureflag:manage`, `plan:manage`.
**Dependencies:** A1.
**Reports:** MRR/ARR, plan mix, feature adoption, overage.
**Mobile:** No.
**Future:** Usage-based billing, add-on marketplace, trial automation, proration engine.

## A3. Identity & Authentication

**Purpose:** Secure authentication with JWT access + rotating refresh, MFA, SSO, password policy and session management.
**Pages:** Login, Register Tenant, Forgot/Reset Password, MFA Setup/Challenge, SSO Callback, Accept Invitation, Active Sessions.
**Collections:** `users`, `credentials`, `sessions`, `refreshTokens`, `mfaSecrets`, `passwordHistory`, `loginAttempts`.
**REST APIs:** `POST /auth/login|refresh|logout`, `POST /auth/change-password`, `POST /auth/mfa/setup|activate|verify|disable`, `POST /auth/forgot-password|reset-password`, `GET /auth/me`, `GET /auth/sessions`, `DELETE /auth/sessions/:id`.
**Implementation note (Phase 1B):** identity is split across three code modules to keep the graph acyclic — `users` (the `users` collection; depends on nothing), `auth` (every secret: credentials, sessions, refresh tokens, MFA), and `rbac` (A4). Both `auth` and `rbac` depend on `users`; nothing depends on `auth`. `forgot/reset-password` is the one endpoint above not yet built: it needs an email channel, so it lands with A6 (Notifications) rather than shipping a password-reset flow that cannot deliver a reset.
**Permissions:** public (auth), `session:revoke`, `user:read`.
**Dependencies:** A1.
**Reports:** Login audit, failed-login/anomaly, active sessions.
**Mobile:** Yes (all apps authenticate here; biometric unlock + secure token storage).
**Future:** Passkeys/WebAuthn, adaptive/risk-based auth, device trust.

## A4. RBAC & Permission Management

**Purpose:** Fine-grained authorization: roles, permission catalog, bindings, branch scoping.
**Pages:** Roles List, Role Editor (permission matrix), Permission Catalog, User-Role Assignment, Branch Scope Assignment.
**Collections:** `roles`, `permissions`, `rolePermissions`, `userRoles`, `permissionScopes`.
**REST APIs:** `CRUD /roles`, `GET /permissions`, `POST /roles/:id/permissions`, `POST /users/:id/roles`, `POST /users/:id/scopes`.
**Permissions:** `role:manage`, `permission:view`, `user:assign-role`.
**Dependencies:** A1, A3.
**Reports:** Role assignment matrix, permission usage, privilege-escalation audit.
**Mobile:** Consumed (permissions gate app features).
**Future:** ABAC/policy-as-code, time-bound roles, approval workflows for privileged grants.

## A5. Audit & Activity Logging

**Purpose:** Immutable audit trail of every PHI/financial mutation + user activity stream.
**Pages:** Audit Log Explorer, Activity Feed, Record History/Diff, Compliance Export.
**Collections:** `auditLogs` (append-only), `activityLogs`, `recordVersions`.
**REST APIs:** `GET /audit-logs`, `GET /activity-logs`, `GET /:resource/:id/history`, `POST /audit-logs/export`.
**Permissions:** `audit:view`, `audit:export`.
**Dependencies:** A1, A3; hooks into all modules.
**Reports:** Access reports, change history, compliance evidence packs.
**Mobile:** Actions are logged; viewer is web.
**Future:** Tamper-evident hash-chaining/WORM storage, SIEM streaming, anomaly detection.

## A6. Notification System

**Purpose:** Unified multi-channel notifications (in-app, email, SMS, WhatsApp, push) with templates and preferences.
**Pages:** Notification Center, Template Manager, Channel Settings, Delivery Log, Preferences.
**Collections:** `notifications`, `notificationTemplates`, `notificationPreferences`, `notificationDeliveries`, `pushTokens`.
**REST APIs:** `GET /notifications`, `POST /notifications/mark-read`, `CRUD /notification-templates`, `GET /notifications/deliveries`, `POST /push/register`.
**Permissions:** `notification:manage`, `notification:send`.
**Dependencies:** A1; integrates Phase 7 providers.
**Reports:** Delivery success/failure, channel performance, opt-out rates.
**Mobile:** Yes (push + in-app).
**Future:** Journey/automation builder, smart send-time, localization per recipient.

## A7. File & Document Service

**Purpose:** Secure uploads, signed URLs, quotas, virus scanning, versioning for all attachments and medical documents.
**Pages:** Document Library, Upload, Storage Usage, Trash/Retention.
**Collections:** `files`, `fileVersions`, `storageQuotas`, `fileScans`.
**REST APIs:** `POST /files` (signed), `GET /files/:id`, `DELETE /files/:id`, `GET /storage/usage`.
**Permissions:** `file:upload|read|delete`.
**Dependencies:** A1; used by every clinical/financial module.
**Reports:** Storage by module/tenant, largest files, retention compliance.
**Mobile:** Yes (capture/upload documents, images).
**Future:** Client-side encryption, CDN delivery, automatic OCR indexing.

## A8. White-Label, Branding & Custom Domains

**Purpose:** Per-tenant branding, themes, logos, custom domains for commercial resale.
**Pages:** Branding Studio, Theme Editor, Domain Settings (DNS/SSL), Email Branding.
**Collections:** `brandingConfigs`, `customDomains`, `themes`.
**REST APIs:** `GET/PATCH /branding`, `CRUD /custom-domains`, `POST /custom-domains/:id/verify`.
**Permissions:** `branding:manage`, `domain:manage`.
**Dependencies:** A1.
**Reports:** Domain verification status.
**Mobile:** Branding reflected in app (theme/logo per tenant).
**Future:** Full white-label mobile app builds, per-branch branding.

## A9. API Keys & Developer Platform

**Purpose:** Programmatic access with scoped keys, rate limits, webhooks.
**Pages:** API Keys, API Explorer/Docs, Webhook Manager, Usage & Limits.
**Collections:** `apiKeys`, `apiRateLimits`, `webhooks`, `webhookDeliveries`.
**REST APIs:** `CRUD /api-keys`, `CRUD /webhooks`, `GET /api-usage`.
**Permissions:** `apikey:manage`, `webhook:manage`.
**Dependencies:** A1, A3.
**Reports:** API usage, error rates, webhook delivery.
**Mobile:** No.
**Future:** GraphQL gateway, SDKs, sandbox environments.

---

# DOMAIN B — Hospital Administration

## B1. Hospital Profile & Organization

**Purpose:** Define the legal entity, licenses, accreditation, contacts and global settings.
**Pages:** Hospital Profile, Licenses & Accreditation, Contact & Legal, Global Settings.
**Collections:** `hospitalProfile`, `licenses`, `accreditations`.
**REST APIs:** `GET/PATCH /hospital-profile`, `CRUD /licenses`, `CRUD /accreditations`.
**Permissions:** `hospital:manage`.
**Dependencies:** A1.
**Reports:** License expiry, accreditation status.
**Mobile:** Read-only in apps (about/contact).
**Future:** Multi-entity groups, compliance calendar.

## B2. Branch Management

**Purpose:** Model multiple branches/locations with independent operations and consolidated reporting.
**Pages:** Branch List, Branch Editor, Branch Settings, Inter-Branch Config.
**Collections:** `branches`, `branchSettings`.
**REST APIs:** `CRUD /branches`, `PATCH /branches/:id/settings`.
**Permissions:** `branch:manage`.
**Dependencies:** A1, B1.
**Reports:** Per-branch KPIs, consolidated group reports.
**Mobile:** Branch switcher in staff/doctor apps.
**Future:** Franchise model, branch-level P&L autonomy.

## B3. Departments, Buildings, Floors

**Purpose:** Model organizational and physical structure for routing, scheduling and reporting.
**Pages:** Department List/Editor, Building Setup, Floor Setup, Org Chart.
**Collections:** `departments`, `buildings`, `floors`.
**REST APIs:** `CRUD /departments|/buildings|/floors`.
**Permissions:** `department:manage`, `facility:manage`.
**Dependencies:** B2.
**Reports:** Department utilization, department P&L.
**Mobile:** Consumed in routing/wayfinding.
**Future:** Indoor wayfinding maps, capacity planning.

## B4. Wards, Rooms, Beds & Bed Management

**Purpose:** Manage inpatient physical capacity and real-time bed availability/allocation.
**Pages:** Ward Setup, Room Setup, Bed Setup, **Bed Board** (real-time), Bed Allocation, Transfer, Housekeeping status.
**Collections:** `wards`, `rooms`, `beds`, `bedAllocations`, `bedStatusHistory`.
**REST APIs:** `CRUD /wards|/rooms|/beds`, `GET /beds/board`, `POST /beds/:id/allocate|release|transfer|block`.
**Permissions:** `bed:manage|allocate`.
**Dependencies:** B3.
**Reports:** Occupancy %, ALOS, bed turnover, ward census.
**Mobile:** Bed board view (staff app).
**Future:** AI bed prediction (Phase 8), automated bed assignment, RTLS integration.

## B5. Operation Theatres, ICUs, Emergency Rooms

**Purpose:** Register and manage critical-care and surgical spaces with utilization tracking.
**Pages:** OT Registry, ICU Registry, ER Registry, OT/ICU Utilization Board.
**Collections:** `operationTheatres`, `icuUnits`, `emergencyRooms`.
**REST APIs:** `CRUD /ot|/icu|/er`, `GET /ot/utilization`.
**Permissions:** `facility:manage`, `ot:schedule`.
**Dependencies:** B3, B4.
**Reports:** OT utilization, ICU occupancy, ER throughput.
**Mobile:** Status boards.
**Future:** Predictive OT scheduling, ER triage board.

## B6. Ambulance Management

**Purpose:** Fleet registry, dispatch, tracking and trip billing.
**Pages:** Ambulance Registry, Dispatch Console, Trip Log, Maintenance.
**Collections:** `ambulances`, `ambulanceDispatches`, `ambulanceTrips`.
**REST APIs:** `CRUD /ambulances`, `POST /ambulances/:id/dispatch`, `CRUD /ambulance-trips`.
**Permissions:** `ambulance:manage|dispatch`.
**Dependencies:** B2.
**Reports:** Trip counts, response time, fleet utilization.
**Mobile:** Driver app view (dispatch, navigation).
**Future:** GPS live tracking, emergency SOS integration, route optimization.

## B7. Medical Equipment, Assets & Maintenance

**Purpose:** Asset lifecycle, calibration, preventive maintenance and downtime tracking.

> **Normalization (ruling N2, see Doc 10):** one `assets` collection with `assetType: medical-equipment | it | furniture | vehicle`; biomedical-specific fields (calibration, AERB/PNDT license) live in a sub-document. `equipment` is a filtered view of `assets`, not a separate collection.
> **Pages:** Equipment Registry, Asset Registry, Maintenance Schedule, Work Orders, Calibration Log, Depreciation.
> **Collections:** `equipment`, `assets`, `maintenanceRecords`, `calibrations`, `workOrders`.
> **REST APIs:** `CRUD /equipment|/assets|/maintenance|/work-orders`, `POST /maintenance/:id/complete`.
> **Permissions:** `asset:manage`, `maintenance:manage`.
> **Dependencies:** B3.
> **Reports:** Downtime, maintenance cost, calibration due, asset register/depreciation.
> **Mobile:** Technician work-order app.
> **Future:** IoT/biomedical telemetry, predictive maintenance (Phase 8), QR asset tags.

## B8. Insurance Companies, Corporate Clients, Vendors & Suppliers (Masters)

**Purpose:** Maintain business partner master data used across billing, claims and procurement.

> **Normalization (ruling N1, see Doc 10):** every party you procure from is a **`vendors`** document with `categories[]` (pharma, consumables, equipment, services…). `suppliers` and `pharmacySuppliers` are deprecated aliases — same collection, filtered by category — never separate collections. This prevents split spend/payables data.
> **Pages:** Insurance Company List/Editor, Corporate Client List/Editor (rate contracts), Vendor/Supplier List/Editor.
> **Collections:** `insuranceCompanies`, `corporateClients`, `rateContracts`, `vendors`, `suppliers`.
> **REST APIs:** `CRUD /insurance-companies|/corporate-clients|/vendors|/suppliers|/rate-contracts`.
> **Permissions:** `master:manage`.
> **Dependencies:** A1.
> **Reports:** Partner-wise revenue/spend, contract expiry, outstanding.
> **Mobile:** Reference only.
> **Future:** Partner portals, automated contract renewal, e-procurement.

## B9. Facility Operations — Housekeeping, Laundry, Cafeteria, Parking, Security, Visitor Mgmt, Reception, Help Desk

**Purpose:** Non-clinical operational services that keep the facility running and safe.
**Pages:** Housekeeping Task Board, Laundry Register, Cafeteria/Diet Orders, Parking Register, Security/Incident Log, Visitor Check-in/Pass, Reception Console, Help Desk/Ticketing.
**Collections:** `housekeepingTasks`, `laundryRecords`, `cafeteriaOrders`, `dietOrders`, `parkingRecords`, `securityIncidents`, `visitors`, `visitorPasses`, `helpdeskTickets`.
**REST APIs:** `CRUD /housekeeping|/laundry|/cafeteria|/parking|/security-incidents|/visitors|/helpdesk`, `POST /visitors/:id/checkout`.
**Permissions:** `facilityops:manage`, `visitor:manage`, `helpdesk:manage`.
**Dependencies:** B3, B4.
**Reports:** Task SLA, visitor logs, incident reports, cafeteria/diet consumption.
**Mobile:** Housekeeping/security task apps, visitor QR pass.
**Future:** Kiosk self-check-in, RFID visitor badges, IoT sensor cleaning triggers.

## B10. Feedback & Complaints

**Purpose:** Capture patient/visitor feedback and manage complaint resolution with SLAs.
**Pages:** Feedback Inbox, Survey Builder, Complaint Tracker, Resolution Workflow, NPS Dashboard.
**Collections:** `feedback`, `surveys`, `complaints`, `complaintActions`.
**REST APIs:** `CRUD /feedback|/complaints|/surveys`, `POST /complaints/:id/assign|resolve`.
**Permissions:** `feedback:manage`, `complaint:manage`.
**Dependencies:** A1, Patients.
**Reports:** NPS/CSAT, complaint TAT, category trends.
**Mobile:** Patient app feedback/survey.
**Future:** Sentiment analysis (AI), auto-routing, closed-loop follow-up.

## B11. Biomedical Waste Management

**Purpose:** Track segregation, collection, disposal and statutory compliance of biomedical waste.
**Pages:** Waste Log, Segregation Config, Disposal Records, Compliance Reports.
**Collections:** `biomedicalWaste`, `wasteCategories`, `wasteDisposals`.
**REST APIs:** `CRUD /biomedical-waste`, `POST /waste/:id/dispose`.
**Permissions:** `waste:manage`.
**Dependencies:** B3.
**Reports:** Waste by category/weight, statutory disposal certificates.
**Mobile:** Collection staff logging.
**Future:** Barcode/weighbridge integration, regulator e-reporting.

## B12. CSSD — Central Sterile Supply Department _(flag: `module.support.cssd`)_

**Purpose:** Track instrument sets through cleaning, sterilization, storage and issue so every OT/procedure uses a traceable, released set.
**Pages:** Instrument Set Master, Sterilization Cycle Log (autoclave/plasma), Batch Release, Set Issue/Return, Recall Console.
**Collections:** `instrumentSets`, `sterilizationCycles`, `setIssues`, `sterilizationRecalls`.
**REST APIs:** `CRUD /cssd/sets|/cssd/cycles|/cssd/issues`, `POST /cssd/cycles/:id/release`, `POST /cssd/recall`.
**Permissions:** `cssd:manage|release`.
**Dependencies:** B5 (OT), D8 (OT bookings consume sets), B7 (autoclaves as assets).
**Reports:** Cycle success rate, set turnaround, recall traceability (NABH evidence).
**Mobile:** Barcode scan on issue/return.
**Future:** Biological-indicator device integration, RFID set tracking.

## B13. Mortuary Management _(flag: `module.support.mortuary`)_

**Purpose:** Manage body admission, cold-storage assignment, release/handover with legal documentation and post-mortem linkage.
**Pages:** Body Admission, Storage Unit Board, Release/Handover (with e-sign), Post-Mortem Register.
**Collections:** `mortuaryRecords`, `mortuaryUnits`, `bodyReleases`, `postMortemRecords`.
**REST APIs:** `CRUD /mortuary`, `POST /mortuary/:id/release`, `CRUD /post-mortem`.
**Permissions:** `mortuary:manage|release`.
**Dependencies:** C3 (death summary), B3.
**Reports:** Occupancy, average stay, statutory mortuary register.
**Mobile:** No.
**Future:** Police/medico-legal case (MLC) workflow integration.

---

# DOMAIN C — Patient Management

## C1. Patient Registration & Master Patient Index (MPI/UHID)

**Purpose:** Register patients once, deduplicate, and maintain a single UHID across visits, branches and channels.
**Pages:**

- _Quick Registration_ — minimal fields for rapid intake.
- _OP Registration_ — outpatient visit registration + billing link.
- _IP Admission_ — inpatient admission with bed, deposit, admitting doctor.
- _Emergency Registration_ — unknown/critical patients, later reconciled.
- _Patient Search / MPI_ — global patient lookup with dedup.
- _Patient Profile (360°)_ — demographics, history, visits, docs.
- _Duplicate Merge_ — reconcile duplicate records.

**Collections:** `patients`, `patientIdentifiers`, `patientContacts`, `emergencyContacts`, `admissions`, `visits`, `patientMergeLogs`.
**REST APIs:** `CRUD /patients`, `POST /patients/quick|emergency`, `POST /patients/:id/admit|discharge`, `GET /patients/search`, `POST /patients/merge`, `GET /patients/:id/timeline`.
**Permissions:** `patient:register|read|update|merge`, `admission:create|discharge`.
**Dependencies:** B (branches/beds/doctors).
**Reports:** Registration volume, new vs repeat, demographics, admission/discharge census.
**Mobile:** Patient self-registration (Phase 5), staff registration app.
**Future:** ABHA/eKYC auto-fill, facial/biometric patient ID, deduplication ML.

## C2. Patient Clinical Profile — History, Allergies, Vitals, Diagnosis, Treatment Plans, Follow-ups, Timeline

**Purpose:** Maintain the longitudinal clinical picture of the patient.
**Pages:** Medical History, Family History, Allergy List, Vitals Chart, Diagnosis/Problem List, Treatment Plan, Follow-ups, Patient Timeline.
**Collections:** `medicalHistory`, `familyHistory`, `allergies`, `vitals`, `diagnoses`, `problemList`, `treatmentPlans`, `followUps`.
**REST APIs:** `CRUD /patients/:id/history|allergies|vitals|diagnoses|treatment-plans|follow-ups`, `GET /patients/:id/timeline`.
**Permissions:** `emr:read|write`, `vitals:record`, `allergy:manage`.
**Dependencies:** C1, EMR (D1).
**Reports:** Chronic disease registry, allergy prevalence, follow-up compliance.
**Mobile:** Patient app (view records), doctor app (edit).
**Future:** Wearable/vitals device sync, risk-scoring dashboards.

## C3. Medical Records, Documents, Consent, Discharge & Death Summary

**Purpose:** Manage structured and unstructured clinical documentation and legal forms.
**Pages:** Medical Records, Patient Documents, Consent Form Builder & Sign, Discharge Summary, Death Summary.
**Collections:** `medicalRecords`, `patientDocuments`, `consents`, `dischargeSummaries`, `deathSummaries`, `documentSignatures`.
**REST APIs:** `CRUD /medical-records|/patient-documents|/consents`, `POST /discharge-summaries|/death-summaries`, `POST /documents/:id/sign`.
**Permissions:** `record:read|write`, `consent:manage`, `discharge:create`.
**Dependencies:** C1, A7 (files), D1 (EMR).
**Reports:** Discharge summary TAT, consent compliance, mortality register.
**Mobile:** Patient app (download records/summaries).
**Future:** Auto-generated discharge summaries (AI), e-sign regulatory workflows.

## C4. Referral & Transfer Management

**Purpose:** Manage internal/external referrals and inter-department/inter-branch patient transfers.
**Pages:** Referral In/Out, Transfer Request, Transfer Board, Referral Network.
**Collections:** `referrals`, `transfers`, `referralPartners`.
**REST APIs:** `CRUD /referrals|/transfers`, `POST /transfers/:id/accept|complete`.
**Permissions:** `referral:manage`, `transfer:manage`.
**Dependencies:** C1, B (departments/branches).
**Reports:** Referral in/out volume, transfer TAT, network performance.
**Mobile:** Doctor app referral.
**Future:** Referral marketplace, e-referral interoperability (FHIR).

## C5. Patient Wallet, Packages, Insurance & Corporate Billing (patient-side)

**Purpose:** Manage patient prepaid balance, health packages, and payer linkage.
**Pages:** Wallet Ledger, Package Enrollment, Insurance Policy Link, Corporate Employee Link.
**Collections:** `wallets`, `walletTransactions`, `packageEnrollments`, `insurancePolicies`, `corporateMemberships`.
**REST APIs:** `GET/POST /patients/:id/wallet`, `POST /patients/:id/enroll-package`, `CRUD /patients/:id/insurance`.
**Permissions:** `wallet:manage`, `package:enroll`, `insurance:link`.
**Dependencies:** C1, Finance (F).
**Reports:** Wallet liability, package utilization, payer mix.
**Mobile:** Patient app wallet/top-up.
**Future:** Auto-recharge, loyalty points, family shared wallet.

## C6. Online Registration, Appointments & Digital Forms (patient-facing)

**Purpose:** Let patients self-register, book and fill intake/consent forms digitally.
**Pages:** Public Booking Portal, Online Registration, Digital Form Filler, e-Consent.
**Collections:** `onlineBookings`, `patientAppUsers`, `dependents`, `digitalForms`, `formSubmissions`.
**REST APIs:** `POST /public/register|bookings`, `CRUD /digital-forms`, `POST /forms/:id/submit`.
**Permissions:** `booking:public`, `form:design`, `self:manage`.
**Dependencies:** C1, Appointments (E1).
**Reports:** Online vs walk-in ratio, form completion, no-show by channel.
**Mobile:** Core patient app flows.
**Future:** Conversational booking (AI), pre-visit questionnaires, insurance pre-check.

## C7. MRD / Health Information Management _(flag: `module.support.mrd`)_

**Purpose:** Govern the medical record itself — physical/digital chart tracking, coding worklist, record deficiency management, statutory registers (birth/death/MLC/notifiable disease).
**Pages:** Chart Tracking (check-out/in), Coding Worklist (ICD-10/11 assignment & review), Deficiency Tracker (incomplete records chase), Statutory Registers, Record Retention Console.
**Collections:** `chartTracking`, `codingWorklist`, `recordDeficiencies`, `statutoryRegisters`.
**REST APIs:** `CRUD /mrd/chart-tracking|/mrd/coding|/mrd/deficiencies`, `GET /mrd/registers/:type`.
**Permissions:** `mrd:manage`, `mrd:code`, `mrd:register:view`.
**Dependencies:** C3, D1, A5 (audit), K1 (retention policies).
**Reports:** Coding backlog, record completion TAT, statutory register extracts (NABH/government evidence).
**Mobile:** No.
**Future:** AI coding assist feed (Phase 8 `ai:suggest/icd` reviews land in this worklist).

---

# DOMAIN D — Doctor & Clinical

## D1. Electronic Medical Records (EMR)

**Purpose:** The structured clinical record — SOAP notes, diagnoses/ICD, procedures, notes, attachments, digital signatures, versioning.
**Pages:** Clinical Chart/Timeline, SOAP Note Editor, Diagnosis/ICD Picker, Procedure Entry, Problem List, Clinical Notes, Attachments, e-Sign, Version History, Clinical Template Manager.
**Collections:** `emrRecords`, `soapNotes`, `diagnoses`, `icdCodes`, `snomedCodes`, `procedures`, `clinicalNotes`, `problemList`, `clinicalTemplates`, `documentSignatures`, `recordVersions`.
**REST APIs:** `CRUD /emr`, `CRUD /soap-notes`, `GET /icd/search`, `GET /snomed/search`, `CRUD /procedures|/clinical-notes`, `POST /emr/:id/sign`, `GET /emr/:id/history`.
**Permissions:** `emr:read|write|sign`, `template:manage`.
**Dependencies:** C1, A7.
**Reports:** Diagnosis frequency, procedure volume, documentation completeness.
**Mobile:** Doctor app (read/write), patient app (read subset).
**Future:** Ambient AI scribe (Phase 8), FHIR-native records, specialty templates library.

## D2. Doctor Management

**Purpose:** Manage doctor profiles, specializations, availability, schedules, performance and leave/attendance.
**Pages:** Doctor Directory, Doctor Profile, Specialization Master, Availability Editor, Consultation Schedule, Slot Configuration, Doctor Dashboard, Performance & Revenue, Leave, Attendance.
**Collections:** `doctors`, `specializations`, `doctorSchedules`, `doctorAvailability`, `appointmentSlots`, `doctorPerformance`, `doctorLeaves`, `doctorAttendance`.
**REST APIs:** `CRUD /doctors|/specializations|/doctor-schedules`, `GET /doctors/:id/availability|performance`, `CRUD /doctor-leaves|/doctor-attendance`.
**Permissions:** `doctor:manage`, `doctor:self-manage`, `schedule:manage`, `doctor:performance:view`.
**Permission split:** `doctor:manage` is roster administration over everybody, and it alone sets
clinic HOURS (the clock pattern slots are generated from) — a contractual matter. `doctor:self-manage`
is a doctor's own sessions and leave, via `/doctors/me/*`, where the doctor id is read from the token
and is absent from the request body. Marking yourself away must not require finding an administrator
at 07:00, or it does not happen and patients travel to an empty clinic.
**Dependencies:** A3 (users), B (departments).
**Reports:** Doctor productivity, revenue per doctor, utilization, leave.
**Mobile:** Doctor app (schedule, availability toggle, dashboard).
**Future:** Credentialing/privileging workflow, panel/roster optimization.

## D3. Doctor Consultation Workspace

**Purpose:** The doctor's daily cockpit — patient queue, consultation, prescription, orders, referrals, follow-ups.
**Pages:** Daily Patient List, Consultation Workspace, Prescription Composer, Order Entry (lab/radiology/procedure), Referral Form, Follow-up Scheduler.
**Collections:** `consultations`, `prescriptions`, `prescriptionItems`, `orders`, `referrals`, `followUps`.
**REST APIs:** `CRUD /consultations`, `CRUD /prescriptions`, `POST /prescriptions/:id/sign`, `POST /orders`, `GET /drug-interactions`.
**Permissions:** `consultation:manage`, `prescription:create|sign`, `order:create`.
**Dependencies:** D1, D2, C1, E (appointments), Lab/Radiology (D6/D7), Pharmacy (F4).
**Reports:** Consultations/day, prescriptions, orders per doctor.
**Mobile:** Full doctor app workflow (incl. teleconsult).
**Future:** AI prescription suggestions (guarded), voice-driven consult, decision support.

## D4. Tele-Consultation / Telemedicine

**Purpose:** Remote consultations via secure video/voice with integrated EMR and e-prescription.
**Pages:** Teleconsult Scheduler, Waiting Room, Consult Room (video), e-Prescription, Session Notes.
**Collections:** `teleconsultSessions`, `videoSessions`.
**REST APIs:** `POST /teleconsult/session`, `POST /video/token`, `GET /teleconsult/:id`.
**Permissions:** `teleconsult:host|join`.
**Dependencies:** D3, E1, Communication (I), Payments.
**Reports:** Teleconsult volume, duration, revenue, satisfaction.
**Mobile:** Patient + doctor apps (core).
**Future:** Remote monitoring integration, multi-party (specialist) calls, AI transcription.

## D5. Nursing

**Purpose:** Ward-based nursing care: vitals, medication administration, notes, care plans, shift handover, monitoring.
**Pages:** Nursing Dashboard, Ward Console, Vitals Entry, Medication Administration Record (MAR), Nursing Notes, Care Plans, Shift Management, Handover, Patient Monitoring Board, Intake/Output.
**Collections:** `nursingNotes`, `medicationAdministration`, `carePlans`, `shiftHandovers`, `intakeOutput`, `nursingAssignments`, `vitals`.
**REST APIs:** `CRUD /nursing-notes|/care-plans|/handovers|/intake-output`, `CRUD /mar`, `POST /mar/:id/administer`, `POST /vitals`.
**Permissions:** `nursing:manage`, `mar:administer`, `vitals:record`.
**Dependencies:** C1, B4 (wards/beds), D3 (medication orders).
**Reports:** Medication compliance, nursing workload, vitals trends, fall/pressure-ulcer risk.
**Mobile:** Staff app (core nursing workflows, offline-capable).
**Future:** Barcode medication administration (BCMA), early-warning scores (NEWS/MEWS), smart-bed integration.

## D6. Laboratory Information System (LIS)

**Purpose:** End-to-end lab workflow — test master, ordering, sample collection/tracking, barcode, analyzer integration, result entry/approval, reports.
**Pages:** Test Catalog, Order Worklist, Sample Collection, Sample Tracking (barcode), Analyzer Worklist, Result Entry, Result Approval, Report Viewer/Print, Reference Ranges.
**Collections:** `labTests`, `labPanels`, `labOrders`, `samples`, `labResults`, `labResultApprovals`, `analyzers`, `referenceRanges`.
**REST APIs:** `CRUD /lab-tests|/lab-orders`, `POST /samples/collect`, `POST /samples/:id/track`, `POST /lab-results`, `POST /lab-results/:id/approve`, `GET /lab-orders/:id/report`.
**Permissions:** `lab:order|collect|result|approve`.
**Dependencies:** D3 (orders), C1, B, Billing (F1), Integrations (machines).
**Reports:** TAT, test volume, abnormal-result rate, revenue, workload.
**Mobile:** Patient app (view reports), phlebotomist collection app.
**Future:** Auto-verification rules, delta checks, reflex testing, full HL7/ASTM bidirectional.

## D7. Radiology (RIS / PACS-lite)

**Purpose:** Imaging order management, modality worklist, image/DICOM handling, reporting and sign-off.
**Pages:** Modality Worklist, Order Detail, Image Upload/DICOM Viewer, Report Editor, Report Sign-off, Templates.
**Collections:** `radiologyOrders`, `radiologyReports`, `dicomStudies`, `radiologyTemplates`.
**REST APIs:** `CRUD /radiology-orders`, `POST /radiology/:id/upload`, `CRUD /radiology-reports`, `POST /radiology-reports/:id/sign`, `GET /dicom/:studyId`.
**Permissions:** `radiology:order|report|sign`.
**Dependencies:** D3, C1, Billing, Integrations (PACS/DICOM).
**Reports:** Modality utilization, report TAT, imaging volume, revenue.
**Mobile:** Patient app (view reports/images), doctor app.
**Future:** Full PACS, AI image triage (Phase 8), structured reporting, teleradiology.

## D8. Operation Theatre (OT) Management

**Purpose:** Surgical scheduling and documentation — pre/intra/post-op, team, consumables, reports.
**Pages:** OT Schedule Board, Booking, Pre-op Checklist, Anesthesia Record, Intra-op Notes, Post-op/Recovery, Surgical Team, Consumable Log, OT Report.
**Collections:** `otSchedules`, `otBookings`, `preOpRecords`, `anesthesiaRecords`, `intraOpNotes`, `postOpRecords`, `surgicalTeams`, `otConsumables`.
**REST APIs:** `CRUD /ot-bookings|/pre-op|/intra-op|/post-op|/anesthesia`, `POST /ot-consumables`, `GET /ot-schedules/board`.
**Permissions:** `ot:schedule|record`.
**Dependencies:** B5 (OT rooms), C1, D2 (surgeons), Inventory/Pharmacy (consumables), Billing.
**Reports:** OT utilization, surgery volume, on-time starts, complication/consumable cost.
**Mobile:** Surgeon/anesthetist review, checklist app.
**Future:** WHO surgical safety checklist automation, implant tracking, video capture.

## D9. Blood Bank

**Purpose:** Manage donors, blood inventory, cross-match, issue and transfusion records.
**Pages:** Donor Registry, Donation Camp, Blood Inventory, Cross-match, Issue/Request, Transfusion Record, Discard Log.
**Collections:** `bloodDonors`, `donations`, `bloodInventory`, `crossMatches`, `bloodIssues`, `transfusions`, `bloodDiscards`.
**REST APIs:** `CRUD /blood-donors|/donations|/blood-inventory|/cross-matches|/blood-issues|/transfusions`.
**Permissions:** `bloodbank:manage|issue`.
**Dependencies:** C1, D6 (compatibility tests), Billing.
**Reports:** Stock by group, expiry/discard, donation vs issue, transfusion reactions.
**Mobile:** Donor app (eligibility, camps), staff issue app.
**Future:** Donor engagement/CRM, regional blood-network sharing, cold-chain IoT.

## D10. Emergency Department & Triage _(flag: `module.clinical.emergency`)_

**Purpose:** Run the ED as a clinical workflow, not just a room registry — triage, tracking board, resuscitation documentation, disposition.
**Pages:** Triage Console (ESI/CTAS level, chief complaint, NEWS/MEWS auto-score), ED Tracking Board (realtime: waiting→triage→treatment→disposition), Code Blue/Resuscitation Record, MLC Register, Disposition (admit/discharge/transfer/LAMA).
**Collections:** `triageRecords`, `edTrackingBoard`, `codeBlueRecords`, `mlcRecords`.
**REST APIs:** `POST /triage`, `GET /ed/board`, `PATCH /ed/board/:id/move`, `POST /code-blue`, `CRUD /mlc`.
**Permissions:** `triage:perform`, `ed:board:manage`, `mlc:manage`.
**Dependencies:** C1 (emergency registration), B5 (ER rooms), D1 (EMR), D5 (nursing), B4 (beds for admission).
**Reports:** Door-to-doctor time, triage-level mix, LWBS (left without being seen) rate, ED length of stay.
**Mobile:** ED board on staff app.
**Future:** Ambulance pre-arrival notification, AI triage assist (Phase 8), sepsis screening alerts.

## D11. Critical Care — ICU / NICU / PICU _(flag: `module.clinical.criticalCare`)_

**Purpose:** High-frequency clinical charting for intensive care: flowsheets, devices, scores.
**Pages:** ICU Flowsheet (hourly vitals/infusions/ventilator grid), Ventilator Settings Log, Infusion & Line Management, Severity Scores (APACHE-II, SOFA, GCS), NICU Growth & Feeding Charts, ICU Census Board.
**Collections:** `icuFlowsheets`, `ventilatorSettings`, `infusionRecords`, `criticalScores`, `nicuCharts`.
**REST APIs:** `CRUD /icu-flowsheets|/ventilator-settings|/infusions`, `POST /critical-scores`, `CRUD /nicu-charts`.
**Permissions:** `icu:chart`, `icu:score`, `icu:board:view`.
**Dependencies:** B5 (ICU units), D5 (nursing), D1 (EMR), B4 (bed allocation).
**Reports:** ICU mortality/severity-adjusted outcomes, ventilator days, device-associated infection surveillance, bed utilization.
**Mobile:** Flowsheet entry on staff app (offline-tolerant).
**Future:** Monitor/ventilator device integration (HL7/MQTT), early-deterioration AI.

## D12. Dialysis Management _(flag: `module.clinical.dialysis`)_

**Purpose:** Run a dialysis unit — schedules, sessions, machines, access, adequacy. Serves standalone dialysis centers and hospital units.
**Pages:** Dialysis Schedule (machine × slot grid), Session Record (pre/intra/post vitals, heparin, complications), Machine & Reprocessing Log, Vascular Access Tracker, Adequacy (Kt/V, URR) Trends.
**Collections:** `dialysisSessions`, `dialysisSchedules`, `dialysisMachines`, `vascularAccess`, `dialyzerReuse`.
**REST APIs:** `CRUD /dialysis-sessions|/dialysis-schedules|/dialysis-machines|/vascular-access`.
**Permissions:** `dialysis:manage|schedule|record`.
**Dependencies:** C1, D1, D6 (labs for adequacy), F1 (session billing/packages), B7 (machines as assets).
**Reports:** Sessions per machine, adequacy compliance, complication rate, package utilization.
**Mobile:** Patient app (schedule/reminders), technician session entry.
**Future:** Machine data integration, transplant workup tracking, home-PD remote monitoring.

## D13. Physiotherapy & Rehabilitation _(flag: `module.clinical.physiotherapy`)_

**Purpose:** Assessment→plan→session→outcome workflow for physio/rehab; serves standalone physio clinics and hospital departments.
**Pages:** Physio Assessment (ROM, strength, pain scales), Treatment Plan, Session Scheduler & Log, Exercise Library/Home Program, Outcome Measures Trend.
**Collections:** `physioAssessments`, `physioTreatmentPlans`, `physioSessions`, `exerciseLibrary`, `homePrograms`.
**REST APIs:** `CRUD /physio-assessments|/physio-plans|/physio-sessions|/exercise-library|/home-programs`.
**Permissions:** `physio:manage|assess|treat`.
**Dependencies:** C1, D1, E1 (session appointments), F1 (session/package billing).
**Reports:** Sessions per therapist, outcome improvement, package consumption, no-shows.
**Mobile:** Patient app home-exercise program with adherence tracking; therapist session app.
**Future:** Video exercise guides, wearable ROM sensors, tele-rehab.

## D14. Clinical Dietetics _(flag: `module.clinical.dietetics`)_

**Purpose:** Nutrition assessment and therapeutic diet prescription for inpatients (kitchen fulfillment remains in B9 facility ops — ruling N3).
**Pages:** Nutrition Screening/Assessment (MUST/SGA), Therapeutic Diet Prescription, Ward Diet Sheet (feeds kitchen), NPO/allergy flags, Dietitian Consult Notes.
**Collections:** `nutritionAssessments`, `dietPrescriptions`, `dietitianNotes`.
**REST APIs:** `CRUD /nutrition-assessments|/diet-prescriptions|/dietitian-notes`, `GET /diet-sheet/:wardId`.
**Permissions:** `diet:assess|prescribe`.
**Dependencies:** C1, D1 (allergies/diagnoses), B9 (kitchen fulfillment), B4 (ward census).
**Reports:** Malnutrition screening compliance, therapeutic diet mix, dietitian workload.
**Mobile:** Dietitian rounds app.
**Future:** Calorie/macro computation engine, meal-ordering by patient (bedside app).

---

# DOMAIN E — Appointments & Scheduling

## E0. Encounter & Patient Journey — **THE ENTRY POINT** (ADR-0013)

**Purpose:** The central clinical object. Every patient contact — booked, walk-in, emergency, referral, camp, telemedicine — becomes an **Encounter**, and every note, order, result and charge hangs on exactly one. This module, **not E1**, is where a patient journey begins.

**Why it is not part of E1:** only ONE of our six target organization types (the private hospital) is appointment-first. A government hospital, a small clinic and a diagnostic centre are walk-in-first. Modelling the walk-in as an "exception" to the appointment — which the blueprint previously did — makes the majority journey a special case of the minority one, and forces a hospital that never books anything to enable an appointment book just to see a patient.

**Pages:** Registration/Intake (walk-in), Arrival & Check-in, **Queue Board**, Token Display, Encounter Timeline, Episode View (OP history + admission in one story), Transfer/Refer.
**Collections:** `encounters`, `episodesOfCare`. (`workItems` lives in E2.)
**REST APIs:** `POST /encounters` (walk-in/emergency), `POST /appointments/:id/checkin` → creates the encounter, `POST /encounters/:id/transition`, `GET /encounters/:id/timeline`, `GET /episodes/:id`.
**Permissions:** `encounter:create|read|update|close`, `encounter:transfer`.
**Dependencies:** C1 (patients). **E1 is an OPTIONAL origin, not a dependency.**
**Feature flag:** `module.ops.opd` — **independent of `module.ops.appointments`**, so OPD can be bought without the appointment book.
**Policy:** `encounterPolicy` (entry, tokenIssuedAt, routing, billingMode, pharmacy) — seeded from the tenant's `organizationType` preset. **`if (organizationType === "government")` is forbidden in code (ADR-0013 §6).**
**Mobile:** doctor app (my waiting patients), staff (intake/queue), patient app (my visit status).

## E2. Work Queue Engine — **PLATFORM MODULE** (ADR-0014)

**Purpose:** One queue engine consumed by every department — doctor, lab, radiology, pharmacy, billing, admission, insurance — with different queue types, priorities, permissions and routing rules.

**It is a PROJECTION, never a source of truth.** `workItems` is a read model built by outbox consumers from `order.placed` / `encounter.started`, idempotent on `(sourceType, sourceId)` and rebuildable from the domain at any time. An authoritative queue table would be a dual write to two systems that cannot commit together — the exact failure the outbox exists to prevent, reintroduced where a dropped write means a blood test nobody performs.

**Rule P1 (PLATFORM_STRATEGY):** zero clinical vocabulary. It routes _work items_ to _targets_ by _priority_. School ERP inherits it for admission approvals and fee escalations, unchanged.

**Collections:** `workItems`, `queueDefinitions`, `routingRules`.
**REST APIs:** `GET /queues/:type`, `POST /work-items/:id/claim|release|complete`, `POST /queues/rebuild` (operator).
**Permissions:** `queue:read|claim|manage`, scoped per queue type.
**Dependencies:** the outbox (A5b). Consumed by D1, E0, F1, lab, radiology, pharmacy.

## E1. Appointment Management — an encounter ORIGIN, not an entry point

**Purpose:** Scheduling — calendar, online booking, reminders, reschedule/cancel, waiting list. **An appointment is a promise of a future Encounter (ADR-0013).** `checked_in` keeps the promise: it creates the Encounter and hands the patient to E0.

**Queue, tokens and walk-in intake MOVED OUT of this module** to E0/E2. A token is a queue concern, not a scheduling concern — a walk-in has a token and no appointment, and in a government hospital that is the normal case.

**Pages:** Calendar (day/week/month/resource), Book Appointment, Online Booking Manager, Reminders Config, Reschedule/Cancel, Appointment Status.
**Collections:** `appointments`, `appointmentSlots`, `waitingList`, `appointmentReminders`.
**REST APIs:** `CRUD /appointments`, `POST /appointments/:id/checkin|reschedule|cancel|noshow`, `GET /appointments/calendar`, `CRUD /waiting-list`.
**Permissions:** `appointment:create|read|update|cancel`.
**Dependencies:** C1, E0 (check-in creates the encounter), D2 (doctor schedules), Notifications.
**Feature flag:** `module.ops.appointments` — a hospital may run OPD (E0) without it.
**Reports:** Bookings, no-show %, wait time, utilization, channel mix.
**Mobile:** Patient app (book/manage), doctor app (schedule).
**Future:** AI slot optimization + no-show prediction (Phase 8), overbooking rules, group/recurring appts.

**Implemented (2026-07-14):** the double-booking unique partial index and the appointment state machine are live and **survive this change untouched** — only `tokenNumber` moves to the Encounter.

---

# DOMAIN F — Financial

## F1. Billing (OP/IP/Pharmacy/Lab/Radiology/Package/Insurance/Corporate)

**Purpose:** Unified revenue-cycle billing across all service lines with discounts, refunds, advances, multi-mode payments, tax and documents.
**Pages:** OP Bill, IP Interim/Final Bill, Consolidated Bill, Pharmacy/Lab/Radiology Bill, Package Bill, Payment Collection, Advance/Deposit, Refund, Discount Approval, Invoice/Receipt Print, Bill Audit, Daily Collection.
**Collections:** `bills`, `billItems`, `payments`, `paymentAllocations`, `refunds`, `advances`, `discounts`, `invoices`, `receipts`, `taxConfigs`.
**REST APIs:** `CRUD /bills`, `POST /bills/:id/finalize`, `POST /payments|/refunds|/advances`, `POST /discounts/approve`, `GET /invoices/:id/pdf`, `GET /collections/daily`.
**Permissions:** `billing:create|finalize|discount|refund|read`, `payment:collect`.
**Dependencies:** Service catalog/tariffs (B8), clinical orders (D), packages/wallet (C5), Payments integration.
**Reports:** Daily collection, revenue by service/dept/doctor, outstanding/AR, discount audit, GST.
**Mobile:** Patient app (view/pay bills).
**Future:** Real-time IP running bill, price transparency estimates, self-service kiosk billing.

## F2. Insurance, TPA & Claims

**Purpose:** Manage payer eligibility, pre-authorization, claim submission/tracking and reconciliation.
**Pages:** Pre-Authorization, Claim Submission, Claim Tracking, Eligibility Check, TPA Reconciliation, Denial Management.
**Collections:** `preAuthorizations`, `claims`, `claimItems`, `claimStatusHistory`, `denials`, `reconciliations`.
**REST APIs:** `CRUD /pre-auth|/claims`, `POST /claims/:id/submit|resubmit`, `GET /insurance/eligibility`, `POST /reconciliations`.
**Permissions:** `insurance:preauth|claim|reconcile`.
**Dependencies:** F1, B8, C5, Integrations (TPA/insurer).
**Reports:** Claim aging, denial rate, realization %, payer-wise TAT.
**Mobile:** Status view.
**Future:** Automated eligibility/adjudication, e-claims (NHCX/insurer APIs), denial-prediction AI.

## F3. Corporate Billing & Packages

**Purpose:** Bill corporate clients and manage health/procedure packages with entitlement tracking.
**Pages:** Corporate Ledger, Corporate Invoice, Package Catalog, Package Consumption, Rate Contracts.
**Collections:** `corporateLedgers`, `corporateInvoices`, `packages`, `packageEnrollments`, `rateContracts`.
**REST APIs:** `CRUD /packages`, `GET /corporate-ledgers/:id`, `POST /corporate-invoices`, `POST /packages/enroll`.
**Permissions:** `corporate:bill`, `package:manage`.
**Dependencies:** B8, F1, C5.
**Reports:** Corporate outstanding, package profitability, contract utilization.
**Mobile:** Corporate portal (future).
**Future:** Corporate self-service portal, bulk employee onboarding.

## F4. Pharmacy (Commercial)

**Purpose:** Retail/inpatient pharmacy — medicine master, inventory, batch/expiry, purchase, sales/POS, returns, supplier management, stock reports.
**Pages:** Medicine Master, Stock/Inventory, Batch & Expiry, Purchase Order, GRN, Sales/POS, Returns, Supplier, Reorder, Stock/Expiry/Movement Reports.
**Collections:** `medicines`, `pharmacyStock`, `batches`, `pharmacyPurchases`, `pharmacySales`, `pharmacyReturns`, `pharmacySuppliers`, `reorderRules`.
**REST APIs:** `CRUD /medicines`, `CRUD /pharmacy/purchases|sales|returns`, `GET /pharmacy/stock|expiry`, `POST /pharmacy/dispense`.
**Permissions:** `pharmacy:sell|purchase|stock|dispense`.
**Dependencies:** D3 (prescriptions), F1 (billing), B8 (suppliers).
**Reports:** Stock valuation, expiry, fast/slow movers, sales, GP margin, supplier performance.
**Mobile:** Dispensing/scan app; patient app (medicine orders/refill).
**Future:** e-Pharmacy/home delivery, drug interaction engine, narcotics register compliance.

## F5. Inventory / Store Management

**Purpose:** General medical/non-medical store — items, indent, PO, GRN, issue, transfers, returns, stock audit.
**Pages:** Item Master, Indent, Purchase Order, GRN, Issue, Inter-store Transfer, Returns, Stock Ledger, Stock Audit/Reconciliation, Reorder.
**Collections:** `inventoryItems`, `stock`, `indents`, `purchaseOrders`, `goodsReceipts`, `stockIssues`, `stockTransfers`, `stockReturns`, `stockAudits`.
**REST APIs:** `CRUD /inventory/items|/indents|/purchase-orders|/grn|/issues|/transfers|/returns`, `POST /stock/audit`.
**Permissions:** `inventory:manage|issue|audit|purchase`.
**Dependencies:** B8 (vendors), Finance (F6).
**Reports:** Stock valuation, consumption, reorder, ABC/VED analysis, audit variance.
**Mobile:** Store issue/receive app, barcode scanning.
**Future:** Consignment stock, auto-PO, RFID inventory, demand forecasting (AI).

## F6. Finance & Accounting

**Purpose:** Core financial accounting — income, expenses, chart of accounts, ledgers, day/cash/bank books, tax, P&L.
**Pages:** Chart of Accounts, Journal/Ledger, Day Book, Cash Book, Bank Book, Expense Entry, Income Entry, Tax/GST, Trial Balance, P&L, Balance Sheet.
**Collections:** `chartOfAccounts`, `journalEntries`, `ledgers`, `expenses`, `incomes`, `bankAccounts`, `bankTransactions`, `taxFilings`.
**REST APIs:** `CRUD /accounts|/journal-entries|/expenses|/incomes|/bank-accounts`, `GET /reports/daybook|cashbook|pnl|trial-balance|balance-sheet`.
**Permissions:** `finance:ledger|expense|income|report|close`.
**Dependencies:** F1 (billing feeds revenue), F4/F5 (procurement feeds payables), HR (payroll).
**Reports:** P&L, balance sheet, cash flow, day/cash/bank book, tax filings, dept costing.
**Mobile:** Approvals (expense).
**Future:** Full double-entry with cost centers, budgeting, Tally/ERP sync, auto bank reconciliation.

## F7. Human Resources & Payroll

**Purpose:** Manage the workforce — employees, attendance/biometric, leave, payroll, recruitment, training, performance, shifts.
**Pages:** Employee Directory, Attendance/Biometric, Leave Requests/Approvals/Balances, Payroll Run, Payslip, Salary Structure, Recruitment/ATS, Training, Performance Review, Shift Roster.
**Collections:** `employees`, `attendance`, `biometricLogs`, `leaves`, `leaveBalances`, `payrollRuns`, `payslips`, `salaryStructures`, `recruitments`, `candidates`, `trainings`, `performanceReviews`, `shiftRosters`.
**REST APIs:** `CRUD /employees|/leaves|/salary-structures|/recruitments|/trainings|/performance|/shifts`, `POST /attendance`, `POST /payroll/run`, `GET /payslips/:id`.
**Permissions:** `hr:employee|attendance|leave|payroll|recruit`, `payroll:approve`.
**Dependencies:** A3 (users), Finance (F6).
**Reports:** Headcount, attendance/absenteeism, payroll cost, leave liability, attrition, training compliance.
**Mobile:** Staff app (attendance/geo/biometric, leave, payslip, tasks).
**Future:** Full HRMS (onboarding/offboarding), roster optimization, self-service portal, statutory filings (PF/ESI/TDS).

---

# DOMAIN G — Mobile Applications

## G1. Patient Mobile App / Portal

**Purpose:** Patient engagement — appointments, records, prescriptions, reports, bills, payments, teleconsult, chat, feedback.
**Screens:** Home, Book Appointment, My Appointments, Health Records, Prescriptions, Lab Reports, Radiology, Bills & Payments, Wallet, Teleconsult, Chat, Notifications, Feedback, Family/Dependents, Digital Forms, Profile.
**Collections:** (reuses) + `patientAppUsers`, `dependents`, `pushTokens`, `deviceSessions`.
**REST APIs:** `GET /me/*`, `POST /me/appointments|payments`, `CRUD /me/dependents`, chat/teleconsult APIs.
**Permissions:** `self:*` (patient-scoped).
**Dependencies:** C, D, E, F.
**Reports:** App engagement, booking conversion, payment via app.
**Mobile:** Native (this IS the mobile module).
**Future:** Health tracking/wearables, medication reminders, care programs, loyalty.

## G2. Doctor Mobile App

**Purpose:** Doctor productivity on the go — schedule, queue, consultation, prescription, reports, history, telemedicine.
**Screens:** Today's Schedule, Patient Queue, Consultation, e-Prescription, Order Entry, Reports Viewer, Patient History, Teleconsult, Notifications, Availability.
**Collections:** (reuses clinical collections).
**REST APIs:** doctor consultation/EMR APIs scoped to app.
**Permissions:** `doctor:app`, clinical permissions.
**Dependencies:** D1–D4, E1, D6/D7.
**Reports:** Personal productivity/revenue.
**Mobile:** Native.
**Future:** Offline consult drafting, AI scribe, voice prescription.

## G3. Staff Mobile App

**Purpose:** Field/ward staff — attendance, tasks, patient monitoring, nursing, approvals, notifications.
**Screens:** Attendance (geo/biometric), Task List, Assigned Patients, Vitals/MAR, Nursing Notes, Approvals, Handover, Notifications.
**Collections:** (reuses HR + nursing collections).
**REST APIs:** attendance, nursing, task, approval APIs.
**Permissions:** `staff:app`, nursing/HR permissions.
**Dependencies:** D5, F7, B9.
**Reports:** Task completion, attendance compliance.
**Mobile:** Native (offline-first).
**Future:** Push-to-talk, panic/SOS, wearable integration for staff.

---

# DOMAIN H — Communication

## H1. Communication Suite

**Purpose:** All internal/external messaging — internal chat, doctor-patient chat, announcements, SMS/Email/WhatsApp, push, video/voice.
**Pages:** Chat Console, Doctor-Patient Chat, Announcement Composer, Channel/Provider Settings, Broadcast Campaigns, Video/Voice Room.
**Collections:** `chatThreads`, `chatMessages`, `announcements`, `broadcasts`, `videoSessions`, `callLogs`, `pushTokens`.
**REST APIs:** `CRUD /chat/threads`, `POST /chat/messages`, `CRUD /announcements|/broadcasts`, `POST /video/session`, WebSocket `chat:*`, `presence:*`.
**Permissions:** `chat:send`, `announcement:manage`, `broadcast:send`, `video:host`.
**Dependencies:** A6 (notifications), Integrations (SMS/Email/WhatsApp/FCM).
**Reports:** Message volume, response time, campaign delivery/open, call minutes.
**Mobile:** Core in all apps.
**Future:** Chatbot triage, unified inbox, WhatsApp appointment flows, co-browsing.

---

# DOMAIN I — Analytics & Reporting

## I1. Reporting Engine & Report Catalog

**Purpose:** Parameterized, scheduled, exportable reports across every domain + self-service builder.
**Pages:** Report Catalog, Report Runner, Scheduled Reports, Custom Report Builder, Export Center.
**Collections:** `reportDefinitions`, `reportSchedules`, `reportRuns`, `savedReports`, `exportJobs`.
**REST APIs:** `CRUD /reports/definitions|/schedules`, `POST /reports/:id/run|export`.
**Permissions:** `report:<domain>:view`, `report:build|schedule|export`.
**Dependencies:** All operational modules.
**Reports:** (this module produces them) — Clinical, Financial, Operational, Doctor, Patient, Inventory, Pharmacy, Insurance, Government/Statutory.
**Mobile:** Key reports/dashboards in apps.
**Future:** Natural-language querying (AI), embedded analytics, data export API.

## I2. Dashboards (Executive / Management)

**Purpose:** Role-based KPI dashboards for operational and executive decision-making.
**Pages:** Executive Dashboard, Revenue Dashboard, Occupancy/Bed Utilization, Doctor Performance, Patient Flow, Department P&L.
**Collections:** `dashboards`, `dashboardWidgets`, `kpiSnapshots`, `analyticsAggregates`.
**REST APIs:** `GET /dashboards/:key`, `CRUD /dashboards`, `GET /kpis`.
**Permissions:** `dashboard:view`, `dashboard:manage`.
**Dependencies:** I1, read models.
**Reports:** Live KPIs.
**Mobile:** Executive app dashboards.
**Future:** Predictive KPIs, alerting on thresholds, drill-to-detail everywhere.

---

# DOMAIN J — AI (see Phase 8 for build detail)

## J1. AI Feature Suite

**Purpose:** Advisory intelligence: appointment assistant, symptom checker, prescription suggestions, analytics/forecasting (bed/revenue/inventory), chat assistant, OCR, voice-to-notes.
**Pages:** AI Assistant Panel, Symptom Checker, Voice Scribe, OCR Intake, Forecasting Dashboards, No-Show Insights, AI Settings & Guardrails, Suggestion Review Queue, AI Audit Log.
**Collections:** `aiJobs`, `aiSuggestions`, `aiFeedback`, `aiAuditLogs`, `embeddings`, `knowledgeBase`, `ocrExtractions`, `voiceTranscripts`, `forecasts`, `modelConfigs`, `promptTemplates`.
**REST APIs:** `POST /ai/triage|prescription-suggest|voice-to-note|ocr|chat|suggest/icd`, `GET /ai/forecast/:type`, `CRUD /ai/knowledge-base`, `GET /ai/audit`.
**Permissions:** `ai:use|triage|scribe|ocr|forecast:view|configure|review-suggestions`.
**Dependencies:** D (clinical data), F (financial/inventory), I (analytics), Integrations (LLM provider — latest Claude models).
**Reports:** AI usage, suggestion acceptance, forecast accuracy, model audit.
**Mobile:** Symptom checker, chat, scribe, patient FAQ bot.
**Future:** Fine-tuned/specialty models, imaging AI, RPM anomaly detection, autonomous documentation with human sign-off.

---

# DOMAIN K — Security & Compliance (see Phase 9)

## K1. Security & Compliance Center

**Purpose:** Centralize RBAC oversight, audit, encryption, backups, DR, sessions, API security, compliance & data-subject requests.
**Pages:** Security Center, Audit Explorer, Session Management, Encryption/Key Management, Backup/DR Console, Compliance/Consent Center, Data Subject Requests, Retention Policies.
**Collections:** `securityScans`, `backups`, `restorePoints`, `drDrills`, `retentionPolicies`, `dataSubjectRequests`, `dataExports`, `incidents`.
**REST APIs:** `GET /security/*`, `POST /backups/run`, `POST /restore`, `POST /dsr`, `CRUD /retention-policies|/incidents`.
**Permissions:** `security:manage`, `backup:manage`, `compliance:manage`, `dsr:process`.
**Dependencies:** A1–A5, all modules (data).
**Reports:** Access reviews, backup status, DR drill results, compliance evidence, incident log.
**Mobile:** MFA/session controls surface in apps.
**Future:** Continuous compliance monitoring, zero-trust, automated evidence collection.

---

## Module → Phase Traceability

| Module                                                    | Phase                                     |
| --------------------------------------------------------- | ----------------------------------------- |
| A1–A9 Platform/SaaS                                       | P1 (A2/A8/A9 features extend through P9)  |
| B1–B3 Org structure                                       | P1/P2                                     |
| B4–B11 Facilities/Masters/Ops                             | P2                                        |
| B12 CSSD, B13 Mortuary                                    | P3 (flag-gated)                           |
| C1–C6 Patient                                             | P2 (C2/C3 clinical parts in P3), C6 in P5 |
| C7 MRD / HIM                                              | P3 (flag-gated)                           |
| D1–D9 Clinical                                            | P3                                        |
| D10–D14 Emergency/Critical Care/Dialysis/Physio/Dietetics | P3 (flag-gated, after D1–D9)              |
| E1 Appointments                                           | P2                                        |
| F1–F7 Financial                                           | P4                                        |
| G1–G3 Mobile apps                                         | P5                                        |
| Home Healthcare, Occupational Health                      | P5 (flag-gated)                           |
| H1 Communication                                          | P5                                        |
| I1–I2 Analytics                                           | P6                                        |
| J1 AI                                                     | P8                                        |
| K1 Security/Compliance                                    | P9 (foundations in P1)                    |
| Integrations                                              | P7                                        |

> **Ruling N6 (Doc 10):** every module declares a feature-flag key `module.<domain>.<name>`. Editions (Doc 07) are compositions of these flags plus limits — org types are never served by forked code.
