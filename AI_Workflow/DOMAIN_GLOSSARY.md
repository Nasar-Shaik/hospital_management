# DOMAIN GLOSSARY

The **single vocabulary** of this project. Code, docs, UI copy, and AI output use these terms exactly; synonyms listed are **forbidden** in identifiers. New terms are added here *before* first use in code. (Constitution §9; Guidelines Never-rule 13.)

Format: **Term** — definition. *(Use, not: forbidden synonyms)* `code identifier`

---

## Identity & Registration

- **Tenant** — one customer organization (a hospital/clinic/group) with its own dedicated database `hms_<slug>`. *(not: client, account, org)* `tenant`
- **Branch** — a physical location of a tenant. *(not: site, facility, center)* `branch`
- **UHID** — Unique Hospital Identifier: the tenant-scoped permanent patient number issued at first registration; stable across visits and branches. `uhid`
- **MPI** — Master Patient Index: the dedup/search layer that guarantees one patient = one UHID. `mpi`
- **ABHA** — Ayushman Bharat Health Account: India's national health ID, linkable to a patient via ABDM. `abha`
- **MRN** — Medical Record Number: legacy/external record identifier mapped in `patientIdentifiers`. `mrn`
- **Patient** — a person receiving care. *(not: customer, client)* `patient`
- **Dependent** — a family member linked to a patient-app account. `dependent`

## Encounters & Care Settings

- **Visit** — one patient–provider interaction episode; typed `OP | IP | ER | TELE | HOME`. The umbrella unit clinical activity hangs on. *(not: encounter — FHIR mapping note: a Visit maps to FHIR `Encounter`)* `visit`
- **OPD / OP** — Outpatient Department / outpatient context: care without admission. `op`
- **IPD / IP** — Inpatient Department / inpatient context: care under admission. `ip`
- **Admission** — the act+record of taking a patient inpatient (bed, admitting doctor, deposit) until **Discharge**. *(not: hospitalization)* `admission`
- **Discharge** — formal end of an admission, producing a **Discharge Summary**. `discharge`
- **LAMA** — Left Against Medical Advice: a discharge disposition. `lama`
- **Triage** — ED severity classification (ESI/CTAS level) performed before treatment. `triage`
- **Appointment** — a scheduled future visit slot with a doctor/resource. *(not: booking — except public "online booking" flows)* `appointment`
- **Token** — the queue sequence number issued for a same-day consultation. `token`
- **Referral** — directing a patient to another doctor/department/facility. `referral`
- **Transfer** — moving an admitted patient between beds/wards/branches. `transfer`
- **Teleconsultation** — remote video/voice consultation. *(not: telemedicine session)* `teleconsult`

## Clinical Documentation

- **EMR** — Electronic Medical Record: the structured clinical record system (module D1). `emr`
- **SOAP** — Subjective/Objective/Assessment/Plan: the standard consultation note structure. `soapNote`
- **Diagnosis** — a coded clinical determination (ICD-10/11), provisional or final. `diagnosis`
- **Problem List** — the patient's active/resolved long-term conditions. `problemList`
- **Vitals** — physiological measurements (BP, HR, SpO₂, temp…). `vitals`
- **Allergy** — recorded hypersensitivity with severity; drives safety checks. `allergy`
- **Prescription** — a doctor's signed medication order set. *(not: script, Rx in identifiers)* `prescription`
- **Order** — a doctor's request for a service (lab/radiology/procedure). *(not: request, requisition)* `order`
- **Consent** — recorded patient permission (procedure, data, teleconsult), signed. `consent`
- **Clinical Template** — specialty-specific structured charting form (dental chart, refraction…). `clinicalTemplate`
- **e-Sign / Digital Signature** — cryptographic sign-off making a document immutable. `documentSignature`

## Nursing & Wards

- **Ward → Room → Bed** — the inpatient physical hierarchy. `ward` `room` `bed`
- **Bed Board** — realtime bed status/allocation view. `bedBoard`
- **MAR** — Medication Administration Record: scheduled vs administered doses per patient. `mar` / `medicationAdministration`
- **Care Plan** — nursing plan of care for an admission. `carePlan`
- **Handover** — shift-to-shift transfer of patient responsibility. *(not: handoff)* `shiftHandover`
- **Intake/Output** — fluid balance charting. `intakeOutput`
- **NEWS/MEWS** — (Modified) Early Warning Score computed from vitals. `earlyWarningScore`
- **Flowsheet** — hourly ICU charting grid. `icuFlowsheet`

## Diagnostics

- **LIS** — Laboratory Information System (module D6). `lis`
- **Sample** — collected specimen, barcoded, tracked. *(not: specimen)* `sample`
- **Result** — measured test value; flagged against **Reference Range**; **panic/critical value** triggers alerts. `labResult`
- **RIS** — Radiology Information System (module D7). `ris`
- **Modality** — imaging equipment class (X-Ray, CT, MRI, USG). `modality`
- **DICOM** — imaging file/exchange standard; studies stored via PACS/DICOM store. `dicomStudy`
- **TAT** — Turnaround Time (order → result/report). `tat`

## Pharmacy & Inventory

- **Medicine** — a drug product in the formulary (composition, form, schedule). *(not: drug in identifiers)* `medicine`
- **Batch** — a lot of stock with number + expiry; dispensing is batch-aware (FEFO). `batch`
- **Dispense** — pharmacy issuing medication against a prescription. `dispense`
- **Indent** — an internal department stock request. `indent`
- **GRN** — Goods Receipt Note: recording received purchased stock. `goodsReceipt`
- **PO** — Purchase Order to a **Vendor** *(ruling N1: never "supplier")*. `purchaseOrder` `vendor`
- **Asset** — owned physical item; `assetType` distinguishes medical equipment etc. *(ruling N2: never a separate "equipment" collection)* `asset`

## Financial

- **Bill** — accumulating charge document for a visit/admission; **finalized** to an **Invoice**. `bill` → `invoice`
- **Charge** — one priced service line posted to a bill. *(not: fee, item in identifiers)* `billItem`
- **Tariff** — price of a service per class/branch/payer contract. `tariff`
- **Advance** — deposit paid before/during care, adjusted at billing. `advance`
- **Refund** — money returned; always references its source payment/bill. `refund`
- **Payer** — who pays: self, insurance company, corporate, government scheme. `payer`
- **Pre-authorization** — payer approval before a covered service. `preAuthorization`
- **Claim** — post-service reimbursement request to a payer; may be **denied** → **Denial** workflow. `claim`
- **TPA** — Third-Party Administrator processing insurance claims. `tpa`
- **NHCX** — National Health Claims Exchange (India): standard e-claims rail. `nhcx`
- **Package** — fixed-price bundle of services (e.g., delivery package). `package`
- **Wallet** — patient prepaid balance ledger. `wallet`
- **GL / Ledger** — general ledger; journal entries are append-only. `journalEntry`

## Interoperability & Coding Standards

- **HL7 v2** — message standard for machine/system interfaces (ADT, ORM, ORU). `hl7`
- **FHIR (R4)** — modern REST resource standard for health data exchange. `fhir`
- **ABDM** — Ayushman Bharat Digital Mission: India's health-data network (ABHA linking, consent). `abdm`
- **ICD-10 / ICD-11** — WHO diagnosis coding systems; per-tenant configurable (ruling N7). `icdCode`
- **SNOMED CT** — clinical terminology ontology. `snomedCode`
- **LOINC** — lab test/observation coding. `loincCode`
- **ASTM** — analyzer interface protocol (lab machines). `astm`

## Platform & SaaS

- **Edition** — a sellable plan preset (flags + limits), Doc 07. *(not: tier, package)* `plan` / edition
- **Feature Flag** — per-tenant capability switch `module.<domain>.<name>`. `featureFlag`
- **Entitlement** — resolved capability+limit for a tenant (plan ∘ overrides). `entitlement`
- **Master DB** — `paperlesstech_master`; platform data only. |
- **Connection Manager** — resolves request → tenant DB connection (Doc 04 §2.2.1). `connectionManager`
- **Outbox Event** — transactional domain event record → queue (Doc 03 §5.2). `outboxEvent`
- **Read Model** — materialized projection for dashboards/reports. `analyticsAggregate`
- **Support Ticket** — SaaS-vendor ticket in master DB — distinct from the hospital's own **Helpdesk Ticket** (tenant DB). `supportTicket` vs `helpdeskTicket`
- **DSR** — Data Subject Request (GDPR/DPDP export/erasure). `dataSubjectRequest`

## Compliance

- **PHI** — Protected Health Information; never in logs/prompts/URLs (Constitution §3.2).
- **NABH / NABL** — Indian accreditation bodies (hospitals / labs); workflows must produce their evidence.
- **HIPAA / GDPR / DPDP** — US/EU/India data-protection regimes; controls mapped in Doc 05 §5.
- **MLC** — Medico-Legal Case: police-reportable case with special registers. `mlcRecord`
- **Legal Hold** — freeze on deletion/retention override during litigation. `legalHold`
