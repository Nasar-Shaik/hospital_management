# 03 — MongoDB Database Design

Complete data model: tenancy strategy, collection catalog, key schemas, relationships, and indexing strategy for an enterprise multi-tenant HMS.

---

## 1. Tenancy & Isolation Strategy — Master DB + Database-per-Tenant

### 1.1 Model

- **Master database `paperlesstech_master`** (one, global): stores **platform-level data only** — tenants, subscription plans, feature flags, SaaS billing, usage counters, license management, SaaS support tickets, global settings. It never stores PHI or hospital operational data.
- **One dedicated MongoDB database per hospital (tenant):** named `hms_<slug>` (e.g., `hms_apollo`, `hms_sunshine`). All clinical, financial, operational and HR collections live here with an **identical schema across all tenant databases**.
- **Physical isolation is the default** — a tenant's data cannot leak to another tenant because it does not share a database. This also gives per-tenant backup/restore, per-tenant retention/erasure, and clean data-residency pinning.
- **Scaling path with zero code change:** tenant DBs start co-located on a shared MongoDB cluster; a heavy tenant's database is moved to its own server/cluster by changing its `dbUri` in the master registry — the Connection Manager (§1.2) resolves per-tenant URIs, so the application never changes.
- **Branch scope:** Operational documents carry `branchId`; users are scoped to one or more branches via RBAC (branches live inside the tenant DB).

**Master registry document (`paperlesstech_master.tenants`):**

```ts
{
  _id: ObjectId,             // tenantId
  hospitalName: string,
  slug: string,              // unique — subdomain: <slug>.paperlesstech.in
  databaseName: string,      // "hms_apollo"
  dbUri?: string,            // optional override → dedicated server/cluster; defaults to shared cluster URI
  customDomain?: string,     // "hms.apollohospital.com" (verified)
  subscription: { planId, status, period, seats },
  status: "active" | "trial" | "suspended" | "terminated",
  region?: string,           // data-residency pin
  createdAt, updatedAt
}
```

### 1.2 Tenant resolution & Connection Manager (every request)

1. **Resolve tenant** from the request — by subdomain (`apollo.paperlesstech.in` → slug `apollo`) or custom domain (`hms.apollohospital.com` → domain map), falling back to the JWT `tenantId` claim; host-derived tenant **must match** the JWT claim or the request is rejected (403).
2. **Look up the tenant registry** in `paperlesstech_master` (Redis-cached, `tenant:{slugOrDomain}` TTL 5 min; cache invalidated on registry change). Suspended/terminated tenants are rejected at this step.
3. **Connection Manager** returns the Mongoose connection for `databaseName`:
   - Maintains an LRU pool of open connections (`Map<tenantId, Connection>`); creates on first use via `mongoose.createConnection(dbUri).useDb(databaseName, { useCache: true })`.
   - Same-cluster tenants share the underlying connection pool via `useDb` (cheap); dedicated-cluster tenants get their own connection.
   - Evicts idle connections after N minutes; hard cap with LRU eviction protects against connection exhaustion.
4. The resolved `{tenantId, connection, branchIds, userId, roles, permissions}` is stored in **AsyncLocalStorage** request context; repositories obtain models **only** from the context connection — there is no default/global connection for tenant data.

### 1.3 Defense in depth (kept even with physical isolation)

1. `tenantId` **remains a required field on every document** — belt-and-braces against a mis-resolved connection, and it keeps future DB-consolidation or cross-check tooling possible.
2. **Mongoose plugin (`tenantScopePlugin`)** still stamps and verifies `tenantId` on save/query; a mismatch between document `tenantId` and context throws.
3. **Repository layer** never accepts raw connections/filters from controllers; models come from the request-context connection only.
4. Unique constraints no longer need the `tenantId` prefix for correctness (each tenant has its own DB) but **retain it for consistency and consolidation-safety** (e.g., `{tenantId, uhid}` unique).

### 1.4 Common fields (on every collection)

```ts
{
  _id: ObjectId,
  tenantId: ObjectId,        // required, indexed, leads every index
  branchId?: ObjectId,       // on operational docs
  createdAt: Date,
  updatedAt: Date,
  createdBy: ObjectId,       // userId
  updatedBy?: ObjectId,
  isDeleted: boolean,        // soft delete
  deletedAt?: Date,
  version: number,           // optimistic concurrency
  schemaVersion: number,     // document shape version — enables lazy per-document migrations over the product's lifetime
}
```

### 1.5 Scaling & placement (replaces cross-tenant sharding)

With database-per-tenant, **horizontal scale is achieved by placing tenant databases**, not by sharding collections across tenants:

- **Tier 1 (default):** many small tenant DBs co-located on a shared replica-set cluster.
- **Tier 2:** heavy tenant's DB moved to a dedicated server/replica set — change `dbUri` in the master registry; Connection Manager picks it up on next cache refresh. Zero application code change.
- **Tier 3:** a single very large hospital that outgrows one replica set shards **within its own database** (shard key `{ branchId: 1, _id: 1 }` or collection-appropriate keys on `vitals`, `auditLogs`, `labResults`).
- The **master DB stays small** (registry + billing + flags) — a single replica set, aggressively cached in Redis; it must never become a per-request bottleneck (cache-first reads).
- **Migration playbook (Tier 1→2):** `mongodump`/`mongorestore` or cluster-to-cluster sync → verify counts/checksums → flip `dbUri` + invalidate cache → old DB retained read-only for rollback window.

### 1.6 Time-series workloads

`vitals` and future device/IoT streams (`iotReadings`, monitor feeds from D11 Critical Care) are declared as **MongoDB time-series collections** (`timeField: recordedAt`, `metaField: {tenantId, patientId, type}`, `granularity: minutes`). ICU monitors can emit per-minute readings; bucketed storage cuts size and index cost by an order of magnitude vs one-document-per-reading. Retention: hot 90 days in the time-series collection, then downsample + archive (§8).

---

## 2. Collection Catalog (by domain)

> ~180+ collections. `PK` = `_id`. `FK` fields reference `_id` of the named collection. All FKs are tenant-scoped.
>
> **Placement rule:** collections marked **[MASTER]** live in `paperlesstech_master` only; everything else lives in **each tenant's dedicated database** (`hms_<slug>`) with identical schema across tenants.

### Master database `paperlesstech_master` — platform-level only

| Collection                       | Key fields                                                                              | Notes                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `tenants` **[MASTER]**           | hospitalName, slug, databaseName, dbUri?, customDomain?, subscription{}, status, region | the tenant registry (§1.1)                                                    |
| `plans` **[MASTER]**             | code, name, price, entitlements[], limits{}                                             | product editions (Doc 07)                                                     |
| `subscriptions` **[MASTER]**     | tenantId, planId, status, period, seats                                                 |                                                                               |
| `entitlements` **[MASTER]**      | tenantId, feature, enabled, limit                                                       | resolved+cached at login                                                      |
| `featureFlags` **[MASTER]**      | tenantId, flag, enabled, branchId?                                                      |                                                                               |
| `saasInvoices` **[MASTER]**      | tenantId, amount, status, dueDate                                                       | SaaS billing/dunning                                                          |
| `usageCounters` **[MASTER]**     | tenantId, metric, period, value                                                         | limit enforcement                                                             |
| `licenses` **[MASTER]**          | tenantId, licenseKey, edition, validFrom/To, seats, status                              | license management                                                            |
| `supportTickets` **[MASTER]**    | tenantId, subject, priority, status, assignee                                           | SaaS-vendor support desk (distinct from the hospital's own `helpdeskTickets`) |
| `globalSettings` **[MASTER]**    | key, value, scope                                                                       | platform-wide config                                                          |
| `customDomains` **[MASTER]**     | tenantId, domain, verified, sslStatus                                                   | domain → tenant resolution                                                    |
| `impersonationLogs` **[MASTER]** | actorId, tenantId, reason, at                                                           | super-admin audit                                                             |
| `superAdminUsers` **[MASTER]**   | email, roles                                                                            | SaaS operators (separate from hospital users)                                 |

### Tenant database `hms_<slug>` — Platform / per-hospital

| Collection                | Key fields                                                   | Notable FKs                  |
| ------------------------- | ------------------------------------------------------------ | ---------------------------- |
| `tenantSettings`          | key, value                                                   | hospital-local settings      |
| `users`                   | email, name, status, employeeId?, patientId?                 | —                            |
| `credentials`             | userId, passwordHash, algo                                   | userId→users                 |
| `roles`                   | name, code, isSystem                                         | —                            |
| `permissions`             | code, resource, action, description                          | —                            |
| `rolePermissions`         | roleId, permissionId                                         | roleId, permissionId         |
| `userRoles`               | userId, roleId, branchIds[]                                  | userId, roleId               |
| `sessions`                | userId, device, ip, lastSeen                                 | userId                       |
| `refreshTokens`           | userId, tokenHash, family, expiresAt, revoked                | userId                       |
| `mfaSecrets`              | userId, secret(enc), type                                    | userId                       |
| `invitations`             | email, roleId, token, status                                 | —                            |
| `apiKeys`                 | name, hashedKey, scopes[], rateLimit                         | —                            |
| `auditLogs`               | actorId, action, resource, resourceId, before, after, ip, at | —                            |
| `activityLogs`            | userId, action, meta, at                                     | —                            |
| `notifications`           | recipientId, type, title, body, read, channels[]             | —                            |
| `notificationTemplates`   | code, channel, subject, body, locale                         | —                            |
| `notificationPreferences` | userId, channel, categories{}                                | —                            |
| `files`                   | key, name, mime, size, module, refId, checksum               | —                            |
| `brandingConfigs`         | logo, colors{}, favicon                                      | —                            |
| `configSettings`          | scope, key, value                                            | —                            |
| `outboxEvents`            | type, payload, status, attempts                              | — (transactional outbox)     |
| `idempotencyKeys`         | key, requestHash, response, expiresAt                        | —                            |
| `counters`                | _id (scoped key), seq                                        | — (business numbering, §5.1) |

### Organization & Facilities

| Collection                                                                 | Key fields                                                                                                                                                                              |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hospitalProfile`                                                          | tenantId, legalName, licenses[], accreditations[]                                                                                                                                       |
| `branches`                                                                 | name, code, address, contact, timezone, currency                                                                                                                                        |
| `departments`                                                              | name, code, branchId, type (clinical/support)                                                                                                                                           |
| `buildings`, `floors`                                                      | name, code, parent refs                                                                                                                                                                 |
| `wards`                                                                    | name, type, branchId, floorId, gender, class                                                                                                                                            |
| `rooms`                                                                    | wardId, number, class, tariffId                                                                                                                                                         |
| `beds`                                                                     | roomId, number, status, currentAllocationId                                                                                                                                             |
| `bedAllocations`                                                           | bedId, patientId, admissionId, from, to, status                                                                                                                                         |
| `operationTheatres`, `icuUnits`, `emergencyRooms`                          | name, branchId, capacity                                                                                                                                                                |
| `ambulances`                                                               | code, type, status, driverId                                                                                                                                                            |
| `ambulanceDispatches`                                                      | ambulanceId, patientId?, from, to, status                                                                                                                                               |
| `assets`                                                                   | name, serial, assetType(medical-equipment/it/furniture/vehicle), biomedical{calibration…}, location, status, value — **`equipment` is a filtered view of `assets` (ruling N2, Doc 10)** |
| `maintenanceRecords`, `calibrations`, `workOrders`                         | assetId, type, dueDate, status                                                                                                                                                          |
| `insuranceCompanies`, `corporateClients`                                   | name, code, terms                                                                                                                                                                       |
| `rateContracts`                                                            | partyId, partyType, tariffId, rate, validFrom/To                                                                                                                                        |
| `vendors`                                                                  | name, gstin, contact, categories[] — **single procurement-party master; `suppliers`/`pharmacySuppliers` are deprecated aliases (ruling N1, Doc 10), not collections**                   |
| `serviceCatalog`                                                           | code, name, department, category, taxable                                                                                                                                               |
| `tariffs`                                                                  | serviceId, class, price, branchId, effectiveFrom                                                                                                                                        |
| `visitors`, `visitorPasses`, `parkingRecords`, `securityIncidents`         | —                                                                                                                                                                                       |
| `housekeepingTasks`, `laundryRecords`, `cafeteriaOrders`, `dietOrders`     | —                                                                                                                                                                                       |
| `helpdeskTickets`, `feedback`, `surveys`, `complaints`, `complaintActions` | —                                                                                                                                                                                       |
| `biomedicalWaste`, `wasteCategories`, `wasteDisposals`                     | —                                                                                                                                                                                       |

### Patient & Clinical

| Collection                                                                                                           | Key fields                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `patients`                                                                                                           | uhid, name, dob, gender, blood, contact{}, address{}                                                                                                                                                      |
| `patientIdentifiers`                                                                                                 | patientId, type(UHID/ABHA/MRN), value                                                                                                                                                                     |
| `emergencyContacts`                                                                                                  | patientId, name, relation, phone                                                                                                                                                                          |
| `admissions`                                                                                                         | patientId, branchId, type, admittingDoctorId, bedId, admittedAt, dischargedAt, status                                                                                                                     |
| `episodesOfCare`                                                                                                     | patientId, status, startedAt, closedAt — links the OP encounter, its investigations and the admission that followed into ONE care story (ADR-0013 §4)                                                     |
| `encounters`                                                                                                         | patientId, episodeId, **origin**(appointment/walk_in/emergency/referral/camp/tele/corporate), class(OP/IP/ER/TELE/HOME), departmentId, doctorId, **token**, status, arrivedAt, closedAt                   |
| `orders`                                                                                                             | encounterId, patientId, **category**(lab/radiology/pharmacy/procedure/referral/admission/diet), priority, status, orderedBy, targetId — ONE polymorphic object, placed against an ENCOUNTER, never a note |
| `results`                                                                                                            | orderId, encounterId, verifiedBy, releasedAt, hasAbnormal, hasPanic                                                                                                                                       |
| `workItems`                                                                                                          | queueType, targetKind, targetId, priority, status, claimedBy, claimedAt, sourceType, sourceId, encounterId — **a PROJECTION of orders/encounters, rebuildable; never a source of truth** (ADR-0014)       |
| `medicalHistory`, `familyHistory`                                                                                    | patientId, conditions[]                                                                                                                                                                                   |
| `allergies`                                                                                                          | patientId, allergen, reaction, severity                                                                                                                                                                   |
| `vitals`                                                                                                             | patientId, visitId, type, value, unit, recordedAt, recordedBy                                                                                                                                             |
| `emrRecords`                                                                                                         | patientId, visitId, doctorId, status, signedBy, version                                                                                                                                                   |
| `soapNotes`                                                                                                          | emrId, subjective, objective, assessment, plan                                                                                                                                                            |
| `diagnoses`                                                                                                          | emrId, icdCode, description, type(provisional/final)                                                                                                                                                      |
| `icdCodes`, `snomedCodes`, `loincCodes`                                                                              | code, term (reference/global)                                                                                                                                                                             |
| `procedures`                                                                                                         | emrId, code, name, performedBy, date                                                                                                                                                                      |
| `problemList`                                                                                                        | patientId, problem, status, onset                                                                                                                                                                         |
| `clinicalNotes`, `treatmentPlans`, `followUps`                                                                       | patientId/emrId refs                                                                                                                                                                                      |
| `consultations`                                                                                                      | appointmentId, doctorId, patientId, notes, status                                                                                                                                                         |
| `prescriptions`                                                                                                      | consultationId, patientId, doctorId, signedAt                                                                                                                                                             |
| `prescriptionItems`                                                                                                  | prescriptionId, drugId, dose, frequency, duration                                                                                                                                                         |
| `orders`                                                                                                             | patientId, type(lab/radiology/procedure), refId, status                                                                                                                                                   |
| `nursingNotes`, `carePlans`, `shiftHandovers`, `intakeOutput`                                                        | patientId, wardId, shift                                                                                                                                                                                  |
| `medicationAdministration` (MAR)                                                                                     | orderId, patientId, scheduledAt, administeredAt, nurseId, status                                                                                                                                          |
| `labTests`, `labPanels`, `referenceRanges`                                                                           | code, name, sample, unit, ranges                                                                                                                                                                          |
| `labOrders`                                                                                                          | patientId, tests[], priority, status                                                                                                                                                                      |
| `samples`                                                                                                            | orderId, barcode, type, collectedAt, status                                                                                                                                                               |
| `labResults`                                                                                                         | orderId, testId, value, flag, verifiedBy                                                                                                                                                                  |
| `labResultApprovals`                                                                                                 | resultId, approverId, at                                                                                                                                                                                  |
| `analyzers`                                                                                                          | name, protocol, interface                                                                                                                                                                                 |
| `radiologyOrders`, `radiologyReports`, `radiologyTemplates`                                                          | patientId, modality, findings, impression                                                                                                                                                                 |
| `dicomStudies`                                                                                                       | orderId, studyUID, series[], storageRef                                                                                                                                                                   |
| `otBookings`, `preOpRecords`, `anesthesiaRecords`, `intraOpNotes`, `postOpRecords`, `surgicalTeams`, `otConsumables` | admissionId/patientId refs                                                                                                                                                                                |
| `otSchedules`                                                                                                        | otId, date, slots[]                                                                                                                                                                                       |
| `bloodDonors`, `donations`, `bloodInventory`, `crossMatches`, `bloodIssues`, `transfusions`, `bloodDiscards`         | group, component, expiry                                                                                                                                                                                  |
| `consents`, `dischargeSummaries`, `deathSummaries`, `documentSignatures`                                             | patientId, admissionId                                                                                                                                                                                    |
| `referrals`, `transfers`, `referralPartners`                                                                         | patientId, from, to, status                                                                                                                                                                               |
| `teleconsultSessions`, `videoSessions`                                                                               | appointmentId, participants[], status                                                                                                                                                                     |
| `clinicalTemplates`                                                                                                  | specialty, type, fields[]                                                                                                                                                                                 |
| `triageRecords`                                                                                                      | patientId, visitId, level(ESI/CTAS), complaint, news2Score, triagedBy, at                                                                                                                                 |
| `edTrackingBoard`                                                                                                    | visitId, stage(waiting/triage/treatment/disposition), assignedTo, since                                                                                                                                   |
| `codeBlueRecords`, `mlcRecords`                                                                                      | patientId, location, team[], outcome / mlcNo, police station                                                                                                                                              |
| `icuFlowsheets`                                                                                                      | admissionId, hour, vitals{}, infusions[], ventilator{}, nurseId                                                                                                                                           |
| `ventilatorSettings`, `infusionRecords`, `criticalScores`, `nicuCharts`                                              | admissionId, type(APACHE/SOFA/GCS), value / weight, feeds                                                                                                                                                 |
| `dialysisSessions`, `dialysisSchedules`, `dialysisMachines`, `vascularAccess`, `dialyzerReuse`                       | patientId, machineId, slot, ktv, accessType                                                                                                                                                               |
| `physioAssessments`, `physioTreatmentPlans`, `physioSessions`, `exerciseLibrary`, `homePrograms`                     | patientId, therapistId, outcomes{}                                                                                                                                                                        |
| `nutritionAssessments`, `dietPrescriptions`, `dietitianNotes`                                                        | patientId, screenScore, dietType, restrictions[]                                                                                                                                                          |
| `instrumentSets`, `sterilizationCycles`, `setIssues`, `sterilizationRecalls`                                         | setId, cycleNo, indicator, releasedBy                                                                                                                                                                     |
| `mortuaryRecords`, `mortuaryUnits`, `bodyReleases`, `postMortemRecords`                                              | patientId?, unitId, admittedAt, releasedTo                                                                                                                                                                |
| `chartTracking`, `codingWorklist`, `recordDeficiencies`, `statutoryRegisters`                                        | recordId, location/coderId, icdVersion, status                                                                                                                                                            |

### Appointments

| Collection             | Key fields                                            |
| ---------------------- | ----------------------------------------------------- |
| `appointmentSlots`     | doctorId, branchId, date, start, end, capacity        |
| `appointments`         | patientId, doctorId, slotId, status, channel, tokenNo |
| `queues`               | branchId, departmentId, doctorId, date                |
| `tokens`               | queueId, appointmentId, number, status                |
| `waitingList`          | patientId, doctorId, preference, priority             |
| `appointmentReminders` | appointmentId, channel, sendAt, status                |

### Financial

| Collection                                                                                                   | Key fields                                                                             |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `bills`                                                                                                      | patientId, visitId/admissionId, type, gross, discount, tax, net, paid, balance, status |
| `billItems`                                                                                                  | billId, serviceId/drugId, qty, rate, amount, taxRate                                   |
| `payments`                                                                                                   | billId?, patientId, amount, mode, txnRef, status                                       |
| `paymentAllocations`                                                                                         | paymentId, billId, amount                                                              |
| `refunds`, `advances`, `discounts`                                                                           | billId/patientId, amount, approvedBy                                                   |
| `invoices`, `receipts`                                                                                       | billId, number, pdfRef                                                                 |
| `taxConfigs`, `taxFilings`                                                                                   | code, rate, jurisdiction                                                               |
| `wallets`, `walletTransactions`                                                                              | patientId, balance, type, amount                                                       |
| `packages`, `packageEnrollments`                                                                             | services[], price, validity, consumed[]                                                |
| `insurancePolicies`, `corporateMemberships`                                                                  | patientId, payerId, policyNo, coverage                                                 |
| `preAuthorizations`, `claims`, `claimItems`, `claimStatusHistory`, `denials`, `reconciliations`              | payer, amount, status                                                                  |
| `corporateLedgers`, `corporateInvoices`                                                                      | clientId, amount, status                                                               |
| `medicines`                                                                                                  | name, composition, form, schedule, hsn                                                 |
| `pharmacyStock`, `batches`                                                                                   | medicineId, batchNo, expiry, qty, mrp                                                  |
| `pharmacyPurchases`, `pharmacySales`, `pharmacyReturns`                                                      | items[], party, amount                                                                 |
| `inventoryItems`, `stock`                                                                                    | code, name, uom, category / itemId, storeId, qty                                       |
| `indents`, `purchaseOrders`, `goodsReceipts`, `stockIssues`, `stockTransfers`, `stockReturns`, `stockAudits` | items[], status                                                                        |
| `reorderRules`                                                                                               | itemId, min, max, reorderQty                                                           |
| `chartOfAccounts`, `journalEntries`, `ledgers`, `expenses`, `incomes`, `bankAccounts`, `bankTransactions`    | account, debit, credit                                                                 |

### HR / Payroll

| Collection                                                                      | Key fields                                 |
| ------------------------------------------------------------------------------- | ------------------------------------------ |
| `employees`                                                                     | userId, code, department, designation, doj |
| `attendance`, `biometricLogs`                                                   | employeeId, date, in, out, source          |
| `leaves`, `leaveBalances`                                                       | employeeId, type, from, to, status         |
| `salaryStructures`, `payrollRuns`, `payslips`                                   | employeeId, components[], net              |
| `recruitments`, `candidates`, `trainings`, `performanceReviews`, `shiftRosters` | —                                          |

### Communication / Realtime

| Collection                     | Key fields                                        |
| ------------------------------ | ------------------------------------------------- |
| `chatThreads`                  | type, participants[], lastMessageAt               |
| `chatMessages`                 | threadId, senderId, body, attachments[], readBy[] |
| `announcements`, `broadcasts`  | audience, channel, body, schedule                 |
| `pushTokens`, `deviceSessions` | userId, token, platform                           |
| `callLogs`                     | from, to, duration, type                          |

### Analytics

| Collection                                                                         | Key fields               |
| ---------------------------------------------------------------------------------- | ------------------------ |
| `reportDefinitions`, `reportSchedules`, `reportRuns`, `savedReports`, `exportJobs` | query, params, output    |
| `dashboards`, `dashboardWidgets`, `kpiSnapshots`, `analyticsAggregates`            | materialized read models |

### AI

| Collection                                                                                            | Key fields                                                      |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `aiJobs`, `aiSuggestions`, `aiFeedback`, `aiAuditLogs`                                                | type, input(redacted), output, model, promptVersion, acceptedBy |
| `embeddings`                                                                                          | refType, refId, vector, chunk (vector index)                    |
| `knowledgeBase`, `ocrExtractions`, `voiceTranscripts`, `forecasts`, `modelConfigs`, `promptTemplates` | —                                                               |

### Security / Compliance

| Collection                                                                                   | Key fields |
| -------------------------------------------------------------------------------------------- | ---------- |
| `securityScans`, `incidents`, `slaMetrics`                                                   | —          |
| `backups`, `restorePoints`, `drDrills`                                                       | —          |
| `retentionPolicies`, `dataSubjectRequests`, `dataExports`, `migrationJobs`, `releaseRecords` | —          |

---

## 3. Key Relationships (ER overview)

```
tenants 1───* branches 1───* departments
branches 1───* wards 1───* rooms 1───* beds
patients 1───* episodesOfCare 1───* encounters ──1 doctors/departments
appointments ──1 encounters            (an appointment ORIGINATES an encounter; it is not one)
encounters 1───* admissions 1───* bedAllocations *───1 beds
encounters 1───* emrRecords 1───* soapNotes / diagnoses / procedures
encounters 1───* orders ──* workItems  (orders route work; workItems are a PROJECTION)
orders 1───* results ; labOrders 1───* samples 1───* labResults
encounters 1───1 prescriptions 1───* prescriptionItems ──1 medicines
prescriptionItems ──* medicationAdministration (MAR)
encounters 1───* bills 1───* billItems ; bills 1───* payments
patients 1───1 wallets 1───* walletTransactions
patients ──* claims ──1 insuranceCompanies
users 1───1 employees 1───* attendance / payslips
users *───* roles (userRoles) ; roles *───* permissions (rolePermissions)
```

**Relationship modeling rules**

- **Embed** when data is bounded, owned, and read together (e.g., `soapNotes` inside `emrRecords` is optional — kept separate here for versioning; `address` embedded in `patients`; `billItems` can be embedded for small bills but is referenced here for reporting/aggregation scale).
- **Reference** across aggregates and for anything queried independently or high-cardinality (patients↔bills, orders↔results).
- **Denormalize** read-heavy display fields (e.g., `patientName`, `uhid` cached on `appointments`/`bills`) with change-stream reconciliation.
- **No cross-tenant references ever.**

---

## 4. Indexing Strategy

**Global rules**

1. Every index leads with `tenantId` (then `branchId` where relevant).
2. Add a **partial filter** `{ isDeleted: false }` on hot indexes to skip soft-deleted docs.
3. TTL indexes for ephemeral data (`sessions`, `refreshTokens`, `idempotencyKeys`, `notifications` older than N days, `otpCodes`).
4. **Text/`$search`** indexes for patient/doctor global search; consider Atlas Search for typo-tolerant MPI.
5. **Vector index** on `embeddings.vector` for AI RAG.

**Representative indexes**

```js
// Tenant isolation + uniqueness
tenants.createIndex({ slug: 1 }, { unique: true });
users.createIndex({ tenantId: 1, email: 1 }, { unique: true });
patients.createIndex({ tenantId: 1, uhid: 1 }, { unique: true });
patientIdentifiers.createIndex({ tenantId: 1, type: 1, value: 1 }, { unique: true });

// Search & lookups
patients.createIndex({ tenantId: 1, name: "text", "contact.phone": 1 });
patients.createIndex({ tenantId: 1, "contact.phone": 1 });
appointments.createIndex({ tenantId: 1, branchId: 1, doctorId: 1, "slot.date": 1 });
appointments.createIndex({ tenantId: 1, patientId: 1, status: 1, createdAt: -1 });
beds.createIndex({ tenantId: 1, branchId: 1, status: 1 });
admissions.createIndex({ tenantId: 1, branchId: 1, status: 1, admittedAt: -1 });

// Clinical (high volume)
vitals.createIndex({ tenantId: 1, patientId: 1, recordedAt: -1 });
emrRecords.createIndex({ tenantId: 1, patientId: 1, createdAt: -1 });
labOrders.createIndex({ tenantId: 1, branchId: 1, status: 1, createdAt: -1 });
labResults.createIndex({ tenantId: 1, orderId: 1 });
medicationAdministration.createIndex({ tenantId: 1, patientId: 1, scheduledAt: 1, status: 1 });

// Financial
bills.createIndex({ tenantId: 1, branchId: 1, status: 1, createdAt: -1 });
bills.createIndex({ tenantId: 1, patientId: 1 });
payments.createIndex({ tenantId: 1, branchId: 1, createdAt: -1 });
claims.createIndex({ tenantId: 1, payerId: 1, status: 1 });
batches.createIndex({ tenantId: 1, medicineId: 1, expiry: 1 });
stock.createIndex({ tenantId: 1, storeId: 1, itemId: 1 }, { unique: true });

// Audit / logs / TTL
auditLogs.createIndex({ tenantId: 1, resource: 1, resourceId: 1, at: -1 });
auditLogs.createIndex({ tenantId: 1, actorId: 1, at: -1 });
sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
refreshTokens.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
idempotencyKeys.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
notifications.createIndex({ tenantId: 1, recipientId: 1, read: 1, createdAt: -1 });

// AI
embeddings.createIndex({ tenantId: 1, refType: 1 });
// embeddings.vector -> Atlas Vector Search index (cosine, dims per model)
```

---

## 5. Data Integrity & Transactions

### 5.1 Sequences & business numbering (`counters`)

MongoDB has no auto-increment. All human-facing numbers (UHID, invoice/receipt numbers, token numbers, GRN/PO numbers, MLC numbers) come from a dedicated **`counters`** collection:

```ts
{ _id: "invoice:{tenantId}:{branchId}:{fiscalYear}", seq: number }
// next number: findOneAndUpdate({_id}, {$inc:{seq:1}}, {upsert:true, returnDocument:"after"})
```

Rules: atomic `$inc` only (never read-then-write); scope keys per tenant + branch (+ fiscal year for statutory series like invoices, per GST rules); format applied in the service layer (`INV/2026-27/000123`); **never reuse or backfill gaps** in financial series — gaps are auditable, duplicates are a statutory violation. Token counters may live in Redis (`queue:{queueId}:token`) for speed, with the day's final state persisted.

### 5.2 Transactions & integrity mechanisms

- **Multi-document transactions** (Mongo sessions) for billing/payment/inventory operations that must be atomic (e.g., dispense → decrement batch → post charge → allocate payment).
- **Transactional outbox** (`outboxEvents`) for reliable event publishing to queues/webhooks/integrations (avoids dual-write inconsistency).
- **Optimistic concurrency** via `version` field + `findOneAndUpdate` with version guard.
- **Idempotency keys** on all money-moving and externally-triggered POSTs.
- **Soft deletes** everywhere (`isDeleted`); hard delete only via compliant DSR/erasure workflow.
- **Immutability:** `auditLogs`, `documentSignatures`, finalized `invoices`, signed `emrRecords` versions are append-only; corrections create new versions.

---

## 6. Reference / Global Data

`icdCodes`, `snomedCodes`, `loincCodes`, `medicines` (base formulary), `countryStateCity`, `currencies`, `timezones` live in a third database class: a **shared reference database `paperlesstech_reference`** (read-only, not tenant-scoped) cached in Redis, while tenant-specific overrides live inside each tenant DB. Database classes are therefore: **master** (1) · **reference** (1) · **tenant** (N).

---

## 7. Caching & Redis Keyspace

| Purpose                                                                | Key pattern                              | TTL                                                |
| ---------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------- |
| Tenant registry (slug/domain → tenant record incl. databaseName/dbUri) | `tenant:{slug}` , `tenant:domain:{host}` | 5 min (+ explicit invalidation on registry change) |
| Session/permission cache                                               | `sess:{userId}` , `perm:{userId}`        | login TTL                                          |
| Feature flags                                                          | `ff:{tenantId}`                          | 5 min                                              |
| Tariff/service lookups                                                 | `tariff:{tenantId}:{serviceId}`          | 10 min                                             |
| Queue/token counters                                                   | `queue:{queueId}:token`                  | day                                                |
| Rate limiting                                                          | `rl:{apiKey                              | ip}`                                               | window |
| Realtime pub/sub                                                       | `channel:{tenantId}:{room}`              | —                                                  |
| Idempotency                                                            | `idem:{key}`                             | 24h                                                |
| Report cache                                                           | `report:{tenantId}:{hash}`               | configurable                                       |

---

## 8. Retention, Archival & Compliance

- **Hot tier:** MongoDB (operational, ~24 months).
- **Cold/archive:** older `auditLogs`, closed `bills`, historical `vitals`/`labResults` archived to object storage / data lake with query-on-demand.
- **Legal hold & retention policies** per `retentionPolicies` collection; medical records retained per statutory minimums (e.g., adult 3–8 yrs, minors till majority + N — configurable per jurisdiction).
- **Right to erasure (DSR):** pseudonymize PHI while preserving financial/audit integrity (irreversible tokenization of identifiers).

---

## 9. CQRS & Event Sourcing — Where (and Where Not) to Apply

Pragmatic rulings so squads don't over- or under-engineer:

| Area                                             | Pattern                                                                                              | Rationale                                                                                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboards / analytics / reports                 | **CQRS-lite** — change streams feed materialized read models (`analyticsAggregates`, `kpiSnapshots`) | Keeps OLTP untouched; read models are rebuildable from source collections, so no event-store complexity                                         |
| Financial ledger (`journalEntries`)              | **Event-sourced by nature** — append-only journal; balances are projections                          | Accounting is already an event log; never update a posted entry, post reversals                                                                 |
| Audit trail (`auditLogs`)                        | Append-only + periodic hash-chaining                                                                 | Tamper evidence for compliance without WORM infrastructure on day one                                                                           |
| Inventory stock levels                           | Ledger of movements (`stockIssues`/`goodsReceipts`…) + cached `stock.qty` maintained transactionally | Movement history is the truth; the quantity is a projection that can be re-derived in audits                                                    |
| Clinical documents (EMR, prescriptions, reports) | **Versioned snapshots, NOT event sourcing**                                                          | Medico-legal norm is "the signed document as seen at time T"; snapshot versions (`recordVersions`) satisfy this directly, event replay does not |
| Everything else                                  | Plain documents + outbox events                                                                      | Default; add patterns only when a concrete need appears                                                                                         |

**Integration seam:** the transactional outbox (`outboxEvents`) is the single event-publishing mechanism. Domain events published today (for notifications, webhooks, read models) are the same seam used later if a module is extracted into a service (see Doc 04 §2.6).
