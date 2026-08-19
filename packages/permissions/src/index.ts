/**
 * THE AUTHORIZATION CATALOG (ADR-0010, Doc 09 §2).
 *
 * The code-defined vocabulary of everything a user may be allowed to do, and
 * everything an edition may switch on. Roles are *data* (tenants edit them);
 * permissions and feature flags are *code* (only a release changes them).
 *
 * Shared by the API and the web apps: the server enforces, the UI merely hides.
 *
 * ── RULES ────────────────────────────────────────────────────────────────────
 * • Routes reference `PERMISSIONS.X.code`, NEVER a string literal (Guidelines
 *   Never-rule 7). A typo in a literal is a silent security hole; a typo in a
 *   constant does not compile.
 * • Codes are `resource:action`, taken from Doc 02 (the module catalog). Never
 *   invent one here that isn't in that document — add it there first.
 * • Codes are permanent. Renaming one silently un-grants it from every role that
 *   holds it in every hospital's database.
 *
 * ── WHY PERMISSIONS EXIST BEFORE THEIR ROUTES ────────────────────────────────
 * The catalog covers modules that are not built yet. That is deliberate and safe:
 * a permission with no route grants nothing, while a route with no permission is
 * a hole. Defining them up front means a future module wires authorization by
 * referencing a constant instead of redesigning RBAC.
 *
 * ── AND WHY THAT NEEDED A LEDGER (see `lifecycle` below) ─────────────────────
 * "Safe" was doing a lot of work in that paragraph. A permission with no route
 * grants nothing — but it is also INDISTINGUISHABLE from a shipped feature whose
 * route nobody wired, and the roles page shows both to an administrator as a
 * capability their staff have. That is not hypothetical: `nursing:manage` was
 * granted to NURSE, had a complete backend route, and had no client caller for
 * two milestones; a nurse could not write a note and the permission said she
 * could. `lab:collect` looks identical from here and is genuinely M6 work.
 *
 * The two cases cannot be told apart by counting routes, so they are DECLARED.
 * Anything without a `lifecycle` is asserted to be live now, and the gate in
 * `apps/api/src/permissionLifecycle.test.ts` proves it against the shipped app.
 */

export const PERMISSION_SCOPES = ["own", "branch", "tenant", "global"] as const;
export type PermissionScope = (typeof PERMISSION_SCOPES)[number];

/**
 * Why a permission is not enforced by a route.
 *
 * `future`     — reserved for a module that is not built. Grants nothing today, and MUST NOT
 *                have a route: if it acquires one, the declaration is stale and the gate says so.
 * `superseded` — the capability shipped under a DIFFERENT permission. The code stays because
 *                codes are permanent (renaming un-grants it from every hospital's database), but
 *                nothing should wire it. `reason` names the permission that replaced it.
 * `service`    — enforced, but NOT by `authorize()` on a router: a service-layer check against
 *                `ctx.permissions`, or a lookup table. Real authorization that a route census
 *                cannot see. The gate verifies the claim rather than believing it.
 */
export type PermissionStatus = "future" | "superseded" | "service";

export interface PermissionLifecycle {
  status: PermissionStatus;
  /** The owning module or milestone — "D6 LIS (M6)", "C4 Referral & Transfer". Never blank. */
  module: string;
  /**
   * Why, in a sentence another engineer can act on. For `superseded`, name the replacing
   * permission code; for `service`, name where the check lives.
   */
  reason: string;
}

export interface PermissionDefinition {
  /** `resource:action` — the stable identifier stored in the database. */
  code: string;
  resource: string;
  action: string;
  /** Widest scope this permission may be granted at. */
  scope?: PermissionScope;
  description: string;
  /**
   * Absent means ACTIVE: this permission is enforced by a route on the shipped app, and the gate
   * fails if it is not. Present means it is deliberately not, for the declared reason.
   */
  lifecycle?: PermissionLifecycle;
}

function p(
  code: string,
  description: string,
  scope: PermissionScope = "tenant",
  lifecycle?: PermissionLifecycle,
): PermissionDefinition {
  const [resource = "", action = ""] = code.split(":");
  return { code, resource, action, scope, description, ...(lifecycle ? { lifecycle } : {}) };
}

/** Reserved for a module that has not been built. */
const future = (module: string, reason: string): PermissionLifecycle => ({
  status: "future",
  module,
  reason,
});

/** The capability shipped under `replacedBy`. The code stays; nothing should wire it. */
const supersededBy = (module: string, replacedBy: string, reason: string): PermissionLifecycle => ({
  status: "superseded",
  module,
  reason: `superseded by \`${replacedBy}\` — ${reason}`,
});

/** Enforced somewhere other than a router. `where` must name the file that checks it. */
const enforcedIn = (module: string, where: string, reason: string): PermissionLifecycle => ({
  status: "service",
  module,
  reason: `checked in ${where} — ${reason}`,
});

/* ────────────────────────────────────────────────────────────────────────────
 * Platform & administration (Doc 02 A1–A9)
 * ──────────────────────────────────────────────────────────────────────────── */

const PLATFORM = {
  TENANT_MANAGE: p(
    "tenant:manage",
    "Configure this organization",
    "tenant",
    supersededBy(
      "A1 Organization",
      "hospital:manage",
      "the hospital profile is what a tenant admin actually configures",
    ),
  ),
  /**
   * VIEW the subscription and usage. Named `manage` for historical reasons
   * (Doc 02 A2) — it does NOT let a hospital change what it pays for.
   */
  SUBSCRIPTION_MANAGE: p("subscription:manage", "View plan, limits and usage"),

  USER_CREATE: p("user:create", "Invite a user"),
  USER_READ: p("user:read", "View users"),
  USER_UPDATE: p("user:update", "Edit a user"),
  USER_DEACTIVATE: p("user:deactivate", "Disable a user"),
  USER_ASSIGN_ROLE: p("user:assign-role", "Grant or revoke a user's roles"),

  ROLE_MANAGE: p("role:manage", "Create and edit roles"),
  PERMISSION_VIEW: p("permission:view", "View the permission catalog"),
  SESSION_REVOKE: p(
    "session:revoke",
    "Sign another user out",
    "tenant",
    future(
      "A3 Users & Sessions",
      "signing another user out of their sessions is not implemented; today a role change invalidates their permission cache instead",
    ),
  ),

  AUDIT_VIEW: p("audit:view", "Read the audit trail"),
  AUDIT_EXPORT: p("audit:export", "Export the audit trail"),

  /**
   * Read the operational + financial reports (the audit/register suite): stock, visits, doctor
   * load, diagnostics, collections. Tenant-scoped — a report is a hospital-wide picture, and it
   * is the administrator's/auditor's view, deliberately apart from the counter permissions that
   * only touch one record at a time.
   */
  REPORT_VIEW: p("report:view", "View operational and financial reports"),

  NOTIFICATION_MANAGE: p("notification:manage", "Manage templates and channels"),
  NOTIFICATION_SEND: p(
    "notification:send",
    "Send notifications",
    "tenant",
    supersededBy(
      "A6 Notifications",
      "notification:manage",
      "one permission covers templates and dispatch",
    ),
  ),

  FILE_UPLOAD: p("file:upload", "Upload documents"),
  FILE_READ: p("file:read", "Read documents"),
  FILE_DELETE: p("file:delete", "Delete documents"),

  BRANDING_MANAGE: p("branding:manage", "Edit branding and theme"),
  DOMAIN_MANAGE: p(
    "domain:manage",
    "Manage custom domains",
    "tenant",
    future("A1 Organization", "custom domains are DNS/TLS provisioning work that has not started"),
  ),
  APIKEY_MANAGE: p("apikey:manage", "Manage API keys"),
  WEBHOOK_MANAGE: p(
    "webhook:manage",
    "Manage webhooks",
    "tenant",
    future("A9 Integrations", "outbound webhooks have no delivery, retry or signing machinery yet"),
  ),
} as const;

/**
 * SaaS-operator only. **Never** granted to a hospital role — `DEFAULT_ROLES`
 * subtracts this whole group from TENANT_ADMIN, and that subtraction is the only
 * thing standing between a hospital and the rest of the platform.
 *
 * `PLAN_MANAGE` and `FEATUREFLAG_MANAGE` live here, not with the other platform
 * permissions, and the reason is commercial rather than technical: they decide
 * what a hospital PAYS FOR. A tenant administrator who could grant themselves
 * `plan:manage` could upgrade to the top edition for free, and one who could
 * toggle a feature flag could switch on a module they never bought. Editions are
 * only worth something if the customer cannot edit their own.
 *
 * (This was a real bug, caught in testing: `plan:manage` was originally grouped
 * with the ordinary platform permissions, so TENANT_ADMIN inherited it and the
 * demo hospital cheerfully upgraded itself to Enterprise.)
 */
const SUPERADMIN = {
  SUPERADMIN_TENANT_MANAGE: p(
    "superadmin:tenant:manage",
    "Provision and manage tenants",
    "global",
    future(
      "A0 Platform",
      "the operator console provisions tenants through its own surface; no tenant-facing route exists",
    ),
  ),
  TENANT_IMPERSONATE: p(
    "tenant:impersonate",
    "Impersonate a tenant user (audited)",
    "global",
    future(
      "A0 Platform",
      "support impersonation needs an audited session-mint flow that is not built",
    ),
  ),
  TENANT_EXPORT: p(
    "tenant:export",
    "Export a tenant's data",
    "global",
    future("A0 Platform", "whole-tenant export is a data-portability feature that has not started"),
  ),
  PLAN_MANAGE: p("plan:manage", "Change which edition a hospital is on", "global"),
  FEATUREFLAG_MANAGE: p("featureflag:manage", "Override a hospital's feature flags", "global"),
} as const;

/* ────────────────────────────────────────────────────────────────────────────
 * Organization & facilities (Doc 02 B1–B13)
 * ──────────────────────────────────────────────────────────────────────────── */

const ORGANIZATION = {
  HOSPITAL_MANAGE: p("hospital:manage", "Edit the hospital profile"),
  APIKEY_MANAGE: p("apikey:manage", "Issue and revoke API keys"),
  BRANCH_MANAGE: p("branch:manage", "Manage branches"),
  DEPARTMENT_MANAGE: p("department:manage", "Manage departments"),
  FACILITY_MANAGE: p("facility:manage", "Manage buildings, floors, theatres, ICUs"),

  BED_MANAGE: p("bed:manage", "Configure wards, rooms and beds", "branch"),
  BED_ALLOCATE: p("bed:allocate", "Allocate and transfer beds", "branch"),
  OT_SCHEDULE: p("ot:schedule", "Schedule operation theatres", "branch"),

  AMBULANCE_MANAGE: p("ambulance:manage", "Manage the ambulance fleet"),
  AMBULANCE_DISPATCH: p("ambulance:dispatch", "Dispatch an ambulance", "branch"),
  ASSET_MANAGE: p("asset:manage", "Manage assets and maintenance"),
  /**
   * The supplier master — who the hospital buys from. Live since General Stores v1; it gates
   * `/suppliers`.
   *
   * Named `vendor:` rather than `supplier:` because the code is permanent and this is the code the
   * catalogue has always carried. It reads the SUPPLIER list, which is the only master it has: the
   * insurer master the old description promised is `insurance:link`'s territory and was never
   * built here.
   */
  VENDOR_MANAGE: p("vendor:manage", "Manage suppliers", "tenant"),

  FACILITYOPS_MANAGE: p(
    "facilityops:manage",
    "Housekeeping, laundry, cafeteria, parking",
    "branch",
    future("G5 Facility Operations", "housekeeping, laundry, cafeteria and parking are not built"),
  ),
  VISITOR_MANAGE: p(
    "visitor:manage",
    "Visitor check-in and passes",
    "branch",
    future("G6 Front Office", "visitor check-in and passes are not built"),
  ),
  HELPDESK_MANAGE: p(
    "helpdesk:manage",
    "The hospital's own help desk",
    "branch",
    future(
      "G6 Front Office",
      "the internal help desk is separate from patient feedback (complaint:manage) and is not built",
    ),
  ),
  FEEDBACK_MANAGE: p("feedback:manage", "Feedback and surveys"),
  COMPLAINT_MANAGE: p("complaint:manage", "Complaints and resolution"),
  WASTE_MANAGE: p(
    "waste:manage",
    "Biomedical waste",
    "tenant",
    future("G7 Biomedical Waste", "waste tracking is not built"),
  ),
  CSSD_MANAGE: p(
    "cssd:manage",
    "Sterile supply",
    "tenant",
    future("G8 CSSD", "sterile supply is not built"),
  ),
  CSSD_RELEASE: p(
    "cssd:release",
    "Release a sterilized batch",
    "tenant",
    future("G8 CSSD", "sterile supply is not built"),
  ),
  MORTUARY_MANAGE: p("mortuary:manage", "Mortuary register"),
  MORTUARY_RELEASE: p("mortuary:release", "Release a body"),
} as const;

/* ────────────────────────────────────────────────────────────────────────────
 * Patients & clinical (Doc 02 C1–C7, D1–D14)
 * ──────────────────────────────────────────────────────────────────────────── */

const PATIENT = {
  PATIENT_REGISTER: p("patient:register", "Register a patient", "branch"),
  PATIENT_READ: p("patient:read", "View patient records", "branch"),
  PATIENT_UPDATE: p("patient:update", "Edit patient demographics", "branch"),
  PATIENT_MERGE: p("patient:merge", "Merge duplicate patients"),

  ADMISSION_CREATE: p("admission:create", "Admit a patient", "branch"),
  ADMISSION_DISCHARGE: p("admission:discharge", "Discharge a patient", "branch"),

  RECORD_READ: p(
    "record:read",
    "Read medical records",
    "branch",
    supersededBy(
      "C3 Medical Records",
      "emr:read",
      "clinical notes are emr:read; uploaded documents are file:read",
    ),
  ),
  RECORD_WRITE: p(
    "record:write",
    "Write medical records",
    "branch",
    supersededBy(
      "C3 Medical Records",
      "emr:write",
      "clinical notes are emr:write; uploaded documents are file:upload",
    ),
  ),
  CONSENT_MANAGE: p("consent:manage", "Capture consent", "branch"),
  DEATH_CERTIFY: p("death:certify", "Certify a death (licensed)", "branch"),
  DISCHARGE_CREATE: p(
    "discharge:create",
    "Write a discharge summary",
    "branch",
    supersededBy(
      "C3 Medical Records",
      "admission:discharge",
      "the summary is written by the act that ends the stay, as a ward note",
    ),
  ),
  REFERRAL_MANAGE: p(
    "referral:manage",
    "Referrals in and out",
    "branch",
    future(
      "C4 Referral & Transfer",
      "the referral register is not built; a referral is only an Order category today",
    ),
  ),
  TRANSFER_MANAGE: p(
    "transfer:manage",
    "Patient transfers",
    "branch",
    future(
      "C4 Referral & Transfer",
      "inter-department and inter-branch transfers are not built; only bed transfer within a stay exists (bed:allocate)",
    ),
  ),

  WALLET_MANAGE: p("wallet:manage", "Patient wallet", "branch"),
  PACKAGE_ENROLL: p("package:enroll", "Enrol a patient in a package", "branch"),
  INSURANCE_LINK: p("insurance:link", "Link an insurance policy", "branch"),

  MRD_MANAGE: p("mrd:manage", "Medical records department"),
  MRD_CODE: p("mrd:code", "Assign ICD codes"),
  MRD_REGISTER_VIEW: p("mrd:register:view", "Statutory registers"),
} as const;

const CLINICAL = {
  EMR_READ: p("emr:read", "Read the clinical chart", "branch"),
  EMR_WRITE: p("emr:write", "Write clinical notes", "branch"),
  EMR_SIGN: p(
    "emr:sign",
    "Sign a clinical record (licensed)",
    "branch",
    future(
      "D1 EMR",
      "countersigning a clinical note is not implemented; only prescriptions are signed (prescription:sign)",
    ),
  ),
  TEMPLATE_MANAGE: p(
    "template:manage",
    "Clinical templates",
    "tenant",
    future("D1 EMR", "clinical note templates are not built"),
  ),

  VITALS_RECORD: p("vitals:record", "Record vitals", "branch"),
  /**
   * Read the observations charted ON A VISIT — split out of `emr:read`.
   *
   * `emr:read` means "read the clinical chart", and it still gates the patient's vitals TREND
   * across visits, which is clinical history. This is the narrower thing: the readings taken on
   * the visit in front of you. It exists because the front desk now takes height, weight, BP and
   * temperature at registration, and a desk that may WRITE a measurement but not read it back
   * cannot print it on the OP slip it hands the patient — while granting the desk `emr:read` to
   * fix that would open every consultation note in the hospital.
   */
  VITALS_READ: p("vitals:read", "Read charted observations", "branch"),
  /**
   * Reading a patient's allergies is TENANT-wide, not branch-scoped — and the difference
   * is a safety property, not a preference. An allergy recorded when the patient was seen
   * at one branch must be visible when they are prescribed for at another, or the check
   * that exists to stop a fatal dose silently sees an empty list. The repository keys these
   * reads on the patient and never on the branch (see allergy.repository.ts); the scope here
   * says so out loud rather than leaving a `branch` label the repo quietly disobeys.
   */
  ALLERGY_READ: p("allergy:read", "Read the allergy list", "tenant"),
  ALLERGY_MANAGE: p("allergy:manage", "Maintain the allergy list", "branch"),

  DOCTOR_MANAGE: p("doctor:manage", "Manage doctors"),
  /**
   * A doctor's own roster: which sessions they sit, and when they are away.
   *
   * ── WHY THIS IS A SECOND PERMISSION AND NOT A WIDER GRANT OF `doctor:manage` ─
   * `doctor:manage` is roster ADMINISTRATION over everybody — it also sets clinic HOURS, which
   * are a contractual matter and stay with an administrator. But "I am off sick tomorrow" is not
   * an administrative act, and routing it through one at 07:00 means it does not happen: the
   * doctor simply does not turn up, reception books into slots nobody will sit, and patients
   * travel to an empty clinic. That failure is the reason this exists.
   *
   * ── AND WHY THE SCOPE IS `branch`, NOT `own` ────────────────────────────────
   * `own` looks like the obvious fit and is a trap this codebase has already been bitten by (see
   * the prescription note below): row scope is published ONCE per request and every repository
   * read in that request obeys it, so `own` would rewrite unrelated lookups to `createdBy = me` —
   * including the upsert that finds an existing availability row, which would then miss and write
   * a duplicate.
   *
   * Ownership here is not a filter, it is an INPUT: the routes take the doctor id from the token
   * and never from the body, so there is no id to tamper with. `branch` then means the same thing
   * it means for every appointment permission — the roster is per site.
   */
  DOCTOR_SELF_MANAGE: p("doctor:self-manage", "Manage own availability and leave", "branch"),
  SCHEDULE_MANAGE: p(
    "schedule:manage",
    "Manage doctor schedules",
    "branch",
    supersededBy(
      "D2 Doctor Management",
      "doctor:manage",
      "clinic hours and sessions are managed on the doctor, with doctor:self-manage for their own",
    ),
  ),
  DOCTOR_PERFORMANCE_VIEW: p(
    "doctor:performance:view",
    "Doctor performance and revenue",
    "tenant",
    future("D2 Doctor Management", "per-doctor revenue and performance reporting is not built"),
  ),

  CONSULTATION_MANAGE: p(
    "consultation:manage",
    "Conduct consultations",
    "own",
    supersededBy(
      "D3 Consultation Workspace",
      "emr:write",
      "the consultation note is an EMR write; the queue is encounter:update",
    ),
  ),
  /**
   * ── `branch`, NOT `own` — AND THE DIFFERENCE IS NOT COSMETIC ────────────────
   * These were `own`, matching the intuition "a doctor sees the prescriptions they
   * wrote". That intuition is right about prescriptions and wrong about everything else
   * in the request, because ROW SCOPE IS PER-REQUEST, NOT PER-COLLECTION: `authorize`
   * publishes ONE scope, taken from the route's permission, and every repository read in
   * that request obeys it (`middleware/authorize.ts`, `scopeFilter`).
   *
   * So under `own`, composing a prescription looked up the encounter with
   * `{ createdBy: <the doctor> }` — and the encounter was created by RECEPTION. Every
   * doctor in the country got "Encounter not found". The permission that was supposed to
   * protect prescriptions made it impossible to write one.
   *
   * `branch` is also what `order:create` has always been, and a prescription is the same
   * kind of act: a clinical decision taken inside a branch. Own-ness is not what protects
   * it — a doctor covering a colleague's list must be able to see the drugs their patient
   * is already on, and `own` would hide exactly that from exactly them.
   */
  PRESCRIPTION_CREATE: p("prescription:create", "Compose a prescription", "branch"),
  PRESCRIPTION_SIGN: p("prescription:sign", "Sign a prescription (licensed)", "branch"),
  /**
   * The Order lifecycle (ADR-0013 §3, STATE_MACHINE_CATALOG §15).
   *
   * ONE polymorphic object carries work between departments — lab, radiology,
   * pharmacy, procedure, referral, admission, diet — so these verbs are generic.
   * They are NOT per-category duplicates of each other, because the lifecycle does
   * not differ by category; only the destination does.
   *
   * ── WHY `verify` IS NOT `perform` ───────────────────────────────────────────
   * A technician performs the test; a pathologist SIGNS IT OFF. Collapsing the two
   * lets an unverified result reach the doctor who will act on it, and that is a
   * patient-safety failure, not a workflow shortcut.
   *
   * ── WHY GENERIC VERBS ARE NOT ENOUGH ON THEIR OWN ───────────────────────────
   * A generic `order:verify` would let a PATHOLOGIST sign off a RADIOLOGY scan.
   * Authority over a category is therefore checked separately, against the
   * category-specific permission that already exists (`lab:approve`,
   * `radiology:sign`) — see `orders/order.authority.ts`. Generic verb, specific
   * authority; no new RBAC machinery.
   */
  ORDER_CREATE: p("order:create", "Order labs, imaging, procedures", "branch"),
  ORDER_READ: p("order:read", "View orders and department worklists", "branch"),
  ORDER_PERFORM: p("order:perform", "Accept and perform an ordered item", "branch"),
  ORDER_VERIFY: p("order:verify", "Verify a completed result (sign-off)", "branch"),
  ORDER_RELEASE: p("order:release", "Release a verified result to the ordering doctor", "branch"),
  ORDER_CANCEL: p("order:cancel", "Cancel an order", "branch"),

  TELECONSULT_HOST: p(
    "teleconsult:host",
    "Host a video consultation",
    "own",
    future("D4 Tele-consultation", "video consultation is not built"),
  ),
  TELECONSULT_JOIN: p(
    "teleconsult:join",
    "Join a video consultation",
    "own",
    future("D4 Tele-consultation", "video consultation is not built"),
  ),

  NURSING_MANAGE: p("nursing:manage", "Nursing care plans and notes", "branch"),
  MAR_ADMINISTER: p("mar:administer", "Administer medication (MAR)", "branch"),

  LAB_ORDER: p(
    "lab:order",
    "Order a lab test",
    "branch",
    supersededBy(
      "D6 LIS",
      "order:create",
      "ADR-0013 makes the Order polymorphic — ordering is one permission across every category",
    ),
  ),
  LAB_COLLECT: p(
    "lab:collect",
    "Collect a sample",
    "branch",
    future(
      "D6 LIS (M6)",
      "specimen collection — STATE_MACHINE_CATALOG §7 is written and explicitly not implemented; there is no specimen entity",
    ),
  ),
  LAB_RESULT: p(
    "lab:result",
    "Enter a lab result",
    "branch",
    future(
      "D6 LIS (M6)",
      "structured lab result entry arrives with the LIS; today a technician enters results through the order worklist under order:perform",
    ),
  ),
  LAB_APPROVE: p("lab:approve", "Approve a lab result (pathologist)", "branch"),

  RADIOLOGY_ORDER: p(
    "radiology:order",
    "Order imaging",
    "branch",
    supersededBy(
      "D7 Radiology",
      "order:create",
      "ADR-0013 makes the Order polymorphic — ordering is one permission across every category",
    ),
  ),
  RADIOLOGY_REPORT: p(
    "radiology:report",
    "Report on imaging",
    "branch",
    future(
      "D7 Radiology (M6)",
      "the radiology report arrives with the module; today results ride on the order worklist under order:perform",
    ),
  ),
  /**
   * ── THIS IS COMPETENCE IN A CATEGORY, NOT SENIORITY ───────────────────────
   * Read `order.authority.ts`: the extra permission required to verify an order is "the one that
   * says they are competent in THIS category". That is what this code means, and it is why a
   * RADIOLOGY_TECHNICIAN holds it in a hospital with no radiologist on staff — a radiographer is
   * competent in imaging and is not competent in haematology, which is precisely the distinction
   * the check exists to make.
   *
   * It was described as "sign a radiology report" while only RADIOLOGIST held it, and that reading
   * had a consequence nobody intended: a hospital without a consultant radiologist could not get a
   * chest X-ray past `completed`, so the film was taken, the report was typed, and the ordering
   * doctor never saw either. Requiring a specialist the hospital does not employ is not a safety
   * control; it is an outage.
   *
   * A hospital that DOES employ radiologists gets the two-person model by granting this and
   * `order:verify` to the radiologist and withholding them from the technician. That is a role
   * edit, not a code change — see `AI_Workflow/docs/RADIOLOGY.md`.
   */
  RADIOLOGY_SIGN: p(
    "radiology:sign",
    "Authority over imaging results — verify and release a radiology study",
    "branch",
    enforcedIn(
      "D7 Radiology",
      "orders/order.authority.ts",
      "verifying a radiology order needs order:verify AND this, so whoever signs off a scan is competent in imaging rather than merely holding the generic verb",
    ),
  ),

  /**
   * Writes the operation record onto a completed booking — what was done, by whom, what was found.
   * Live since Theatre v1; it gates `POST /ot-bookings/:id/operative-note`.
   *
   * Deliberately NOT `ot:schedule`. Running the surgical list and stating what was found inside a
   * patient are different acts by different people, and one permission covering both would let the
   * OT coordinator author a clinical record.
   */
  OT_RECORD: p("ot:record", "Record a surgery", "branch"),
  BLOODBANK_MANAGE: p(
    "bloodbank:manage",
    "Blood bank stock",
    "tenant",
    future("D9 Blood Bank", "blood bank is not built"),
  ),
  BLOODBANK_ISSUE: p(
    "bloodbank:issue",
    "Issue blood",
    "branch",
    future("D9 Blood Bank", "blood bank is not built"),
  ),

  /**
   * Assess how sick an emergency patient is. Live since Emergency v1 — it gates
   * `POST /emergency/triage`.
   *
   * Its own permission rather than `encounter:update` because triage is a clinical judgement, not
   * queue management: the registration desk moves patients along and must not be able to declare
   * one `non_urgent`.
   */
  TRIAGE_PERFORM: p("triage:perform", "Triage an emergency patient", "branch"),
  ED_BOARD_MANAGE: p(
    "ed:board:manage",
    "Manage the emergency board",
    "branch",
    /**
     * Still unbuilt, and the reason had to be REWRITTEN when the board shipped — the ledger test
     * can see that a `future` permission has acquired a route, but it cannot see a reason that has
     * quietly become untrue.
     *
     * READING the board needs no permission of its own: it is the queue, filtered and ranked, and
     * everyone who reads it already holds `encounter:read` for the same patients. What this code
     * is reserved for is MANAGING it — assigning a patient to a bay, pinning a row, overriding the
     * triage order by hand — none of which exists, because v1's board is a ranked list a person
     * reads rather than a thing a person arranges.
     */
    future(
      "D10 Emergency",
      "the board is read-only in v1 (`encounter:read`); bay assignment and manual re-ordering are not built",
    ),
  ),
  MLC_MANAGE: p(
    "mlc:manage",
    "Medico-legal cases",
    "branch",
    future(
      "D10 Emergency",
      "the medico-legal CASE register is not built; the medicolegal module today covers consent and death certification",
    ),
  ),

  ICU_CHART: p(
    "icu:chart",
    "Critical-care charting",
    "branch",
    future("D11 Critical Care", "critical care is not built"),
  ),
  ICU_SCORE: p(
    "icu:score",
    "Critical-care scoring",
    "branch",
    future("D11 Critical Care", "critical care is not built"),
  ),
  ICU_BOARD_VIEW: p(
    "icu:board:view",
    "ICU board",
    "branch",
    future("D11 Critical Care", "critical care is not built"),
  ),

  DIALYSIS_MANAGE: p(
    "dialysis:manage",
    "Dialysis unit",
    "tenant",
    future("D12 Dialysis", "dialysis is not built"),
  ),
  DIALYSIS_SCHEDULE: p(
    "dialysis:schedule",
    "Schedule dialysis",
    "branch",
    future("D12 Dialysis", "dialysis is not built"),
  ),
  DIALYSIS_RECORD: p(
    "dialysis:record",
    "Record a dialysis session",
    "branch",
    future("D12 Dialysis", "dialysis is not built"),
  ),

  PHYSIO_MANAGE: p(
    "physio:manage",
    "Physiotherapy unit",
    "tenant",
    future("D13 Physiotherapy", "physiotherapy is not built"),
  ),
  PHYSIO_ASSESS: p(
    "physio:assess",
    "Physiotherapy assessment",
    "branch",
    future("D13 Physiotherapy", "physiotherapy is not built"),
  ),
  PHYSIO_TREAT: p(
    "physio:treat",
    "Physiotherapy treatment",
    "branch",
    future("D13 Physiotherapy", "physiotherapy is not built"),
  ),

  DIET_ASSESS: p(
    "diet:assess",
    "Nutrition assessment",
    "branch",
    future(
      "D14 Dietetics",
      "nutrition assessment is not built; a diet Order carries the instruction today",
    ),
  ),
  DIET_PRESCRIBE: p(
    "diet:prescribe",
    "Prescribe a therapeutic diet",
    "branch",
    future(
      "D14 Dietetics",
      "therapeutic diet prescribing is not built; a diet Order carries the instruction today",
    ),
  ),
} as const;

/* ────────────────────────────────────────────────────────────────────────────
 * Operations & money (Doc 02 E1, F-series)
 * ──────────────────────────────────────────────────────────────────────────── */

const OPERATIONS = {
  /**
   * The patient journey (ADR-0013). `encounter:create` is the front desk's core
   * verb — it is what a walk-in registration IS, and it is deliberately separate
   * from `appointment:create`: a government hospital books nothing and still admits
   * hundreds of patients a day through this permission.
   */
  ENCOUNTER_CREATE: p("encounter:create", "Start a patient visit", "branch"),
  ENCOUNTER_READ: p("encounter:read", "View patient visits and the queue", "branch"),
  ENCOUNTER_UPDATE: p("encounter:update", "Move a visit through its stages", "branch"),
  /** Closing ends the visit and freezes what can be billed against it. */
  ENCOUNTER_CLOSE: p("encounter:close", "Close a patient visit", "branch"),

  APPOINTMENT_CREATE: p("appointment:create", "Book an appointment", "branch"),
  APPOINTMENT_READ: p("appointment:read", "View appointments", "branch"),
  APPOINTMENT_UPDATE: p("appointment:update", "Reschedule an appointment", "branch"),
  APPOINTMENT_CANCEL: p("appointment:cancel", "Cancel an appointment", "branch"),
  QUEUE_MANAGE: p(
    "queue:manage",
    "Manage the queue and tokens",
    "branch",
    supersededBy(
      "E1 Appointments & Queue",
      "encounter:update",
      "the token queue is a state of the encounter, not a separate object",
    ),
  ),
} as const;

const FINANCE = {
  BILLING_CREATE: p("billing:create", "Create a bill", "branch"),
  BILLING_READ: p("billing:read", "View bills", "branch"),
  BILLING_FINALIZE: p("billing:finalize", "Finalize a bill", "branch"),
  BILLING_DISCOUNT: p("billing:discount", "Apply a discount"),
  BILLING_REFUND: p("billing:refund", "Issue a refund"),
  PAYMENT_COLLECT: p("payment:collect", "Collect a payment", "branch"),
  /**
   * Maintain the service tariff — the hospital's price list. Tenant-scoped: a price applies to
   * the whole hospital, not one branch, and it is the administrator's lever, kept apart from the
   * counter permissions (`billing:read/create`) that only USE the prices it sets.
   */
  TARIFF_MANAGE: p("tariff:manage", "Manage the service tariff"),

  INSURANCE_PREAUTH: p(
    "insurance:preauth",
    "Request pre-authorization",
    "tenant",
    future(
      "F3 Insurance",
      "a dedicated pre-authorization request flow is not split out — insurance.routes.ts says so; preauth is a claim TYPE today",
    ),
  ),
  INSURANCE_CLAIM: p("insurance:claim", "File a claim"),
  INSURANCE_RECONCILE: p("insurance:reconcile", "Reconcile a settlement"),
  CORPORATE_BILL: p(
    "corporate:bill",
    "Bill a corporate client",
    "tenant",
    future("F3 Insurance", "corporate/TPA billing is not built"),
  ),
  PACKAGE_MANAGE: p(
    "package:manage",
    "Manage care packages",
    "tenant",
    supersededBy(
      "F2 Billing",
      "tariff:manage",
      "a care package is priced from the tariff and administered with it",
    ),
  ),

  PHARMACY_SELL: p(
    "pharmacy:sell",
    "Sell at the pharmacy counter",
    "branch",
    future(
      "F4 Pharmacy",
      "over-the-counter retail sale is not built; dispensing against a prescription is pharmacy:dispense",
    ),
  ),
  PHARMACY_DISPENSE: p("pharmacy:dispense", "Dispense against a prescription", "branch"),
  /**
   * Authorise dispensing on credit when an admitted patient's advance is exhausted — the
   * "doctor sign-off" on an over-budget dispense. Held by clinicians and admins, NOT by a
   * counter pharmacist: the point is that someone with the authority to commit the hospital
   * to the credit says yes, and it is recorded against them.
   */
  PHARMACY_CREDIT_OVERRIDE: p(
    "pharmacy:credit-override",
    "Authorise an over-budget dispense (dispense on credit)",
    "branch",
    enforcedIn(
      "F4 Pharmacy",
      "pharmacy/pharmacy.service.ts",
      "an over-budget dispense is refused (HMS-PHM-003) unless the acknowledgement comes from a holder — it cannot gate the ROUTE, because the pharmacist who calls it is not the one authorising",
    ),
  ),
  PHARMACY_STOCK: p("pharmacy:stock", "Pharmacy stock"),
  PHARMACY_PURCHASE: p(
    "pharmacy:purchase",
    "Pharmacy purchasing",
    "tenant",
    future(
      "F4 Pharmacy",
      "the pharmacy has stock (migration 0052) but buys it from nowhere: a receipt names no supplier, cost or invoice. The supplier master now exists under `vendor:manage` — wiring the drug shelf to it is a pharmacy change and the pharmacy is frozen",
    ),
  ),

  /**
   * ── THE FOUR ACTS OF A STORE, AND WHY THEY ARE FOUR ─────────────────────────
   * All live since General Stores v1. They are not seniority tiers — they are different jobs, and
   * a hospital that wants one person doing all of them grants all four (STORE_KEEPER does).
   *
   *   manage   — the item master AND the shelf as a whole. It is the BASELINE: every store route
   *              that only READS is gated on it, because a person who may not see what is on the
   *              shelf cannot do any of the other three either.
   *   purchase — book a delivery IN, against a supplier. The money-facing act.
   *   issue    — hand stock OUT to a department. The one that runs all day.
   *   audit    — correct the count against a physical stock-take. Deliberately separate from
   *              `issue`: a clerk who can both take stock out AND rewrite the number to match has
   *              no shortfall anyone can see.
   *
   * There is no `inventory:read`. It would be a fifth code whose only holder is everybody who
   * already holds `manage`, and the catalogue has enough permissions nobody holds.
   */
  /**
   * ── AND ALL FOUR ARE `branch`, WHICH IS NOT COSMETIC ────────────────────────
   * The scope declared here IS the row-scoping level: `authorize` publishes it as
   * `scope.level`, and `scopeFilter()` only narrows to the caller's branches when it reads
   * `"branch"`. Three of these were `"tenant"` when this module was written — copied from the
   * catalogue entries that predated it — and the store's own integration suite caught it
   * immediately: a keeper bound to the annexe, sending no branch header, was answered with the
   * SUM of both sites' shelves. The permission looked confining and confined nothing.
   *
   * `vendor:manage` stays `"tenant"` on purpose: `suppliers` carries no `branchId` at all, so
   * there is nothing for a branch filter to narrow and declaring one would be a lie in the other
   * direction.
   */
  INVENTORY_MANAGE: p("inventory:manage", "The store's item master and its shelf", "branch"),
  INVENTORY_ISSUE: p("inventory:issue", "Issue stock to a department", "branch"),
  INVENTORY_AUDIT: p("inventory:audit", "Correct the count after a stock-take", "branch"),
  INVENTORY_PURCHASE: p("inventory:purchase", "Receive a delivery from a supplier", "branch"),

  FINANCE_LEDGER: p(
    "finance:ledger",
    "General ledger",
    "tenant",
    future(
      "G2 Finance",
      "the general ledger is not built; billing is charges, invoices and payments only",
    ),
  ),
  FINANCE_EXPENSE: p(
    "finance:expense",
    "Expenses",
    "tenant",
    future("G2 Finance", "expense management is not built"),
  ),
  FINANCE_INCOME: p(
    "finance:income",
    "Income",
    "tenant",
    future("G2 Finance", "income accounting is not built"),
  ),
  FINANCE_REPORT: p(
    "finance:report",
    "Financial reports",
    "tenant",
    future("G2 Finance", "financial reporting beyond the daily collection report is not built"),
  ),
  FINANCE_CLOSE: p(
    "finance:close",
    "Close a financial period",
    "tenant",
    future("G2 Finance", "period close is not built"),
  ),

  HR_EMPLOYEE: p(
    "hr:employee",
    "Employee records",
    "tenant",
    future("G4 HR", "HR is not built; clinical staff are users, not employees"),
  ),
  HR_ATTENDANCE: p(
    "hr:attendance",
    "Attendance",
    "tenant",
    future("G4 HR", "staff attendance and rostering are not built; HR is a later milestone"),
  ),
  HR_LEAVE: p(
    "hr:leave",
    "Leave",
    "tenant",
    future("G4 HR", "HR is not built; a doctor's own leave is doctor:self-manage"),
  ),
  HR_PAYROLL: p("hr:payroll", "Run payroll", "tenant", future("G4 HR", "payroll is not built")),
  PAYROLL_APPROVE: p(
    "payroll:approve",
    "Approve payroll",
    "tenant",
    future("G4 HR", "payroll is not built"),
  ),
  HR_RECRUIT: p("hr:recruit", "Recruitment", "tenant", future("G4 HR", "recruitment is not built")),
} as const;

/** Patient-portal identity. `own` scope only — a patient sees exactly their own record. */
const SELF = {
  SELF_MANAGE: p(
    "self:manage",
    "Manage my own profile and bookings",
    "own",
    future(
      "H1 Patient Portal",
      "the patient portal is not built; PATIENT is a seeded role with no surface yet",
    ),
  ),
  BOOKING_PUBLIC: p(
    "booking:public",
    "Book an appointment online",
    "own",
    future("H1 Patient Portal", "public online booking is not built; the public site is read-only"),
  ),
  FORM_DESIGN: p(
    "form:design",
    "Design digital forms",
    "tenant",
    future("A8 Forms", "the digital form designer is not built"),
  ),
} as const;

export const PERMISSIONS = {
  ...PLATFORM,
  ...SUPERADMIN,
  ...ORGANIZATION,
  ...PATIENT,
  ...CLINICAL,
  ...OPERATIONS,
  ...FINANCE,
  ...SELF,
} as const satisfies Record<string, PermissionDefinition>;

export type PermissionKey = keyof typeof PERMISSIONS;

/** Every permission, for seeding the tenant catalog. */
export const ALL_PERMISSIONS: PermissionDefinition[] = Object.values(PERMISSIONS);

/** Codes only — the shape stored on a role and checked by `authorize`. */
export const ALL_PERMISSION_CODES: string[] = ALL_PERMISSIONS.map((x) => x.code);

/* ────────────────────────────────────────────────────────────────────────────
 * Feature flags (Doc 07) — layer 1 of authorization
 *
 * A permission says "this USER may do X". A flag says "this HOSPITAL bought X".
 * Both must be true. They are different questions and must never be conflated:
 * granting a nurse `dialysis:record` at a clinic that never bought the dialysis
 * module must still fail.
 * ──────────────────────────────────────────────────────────────────────────── */

export const FEATURE_FLAGS = {
  // Operations
  /**
   * The patient journey: encounters, the queue, tokens (ADR-0013).
   *
   * DELIBERATELY INDEPENDENT of `module.ops.appointments`. A government hospital
   * buys OPD and never books an appointment in its life; a diagnostic centre takes
   * walk-ins with a prescription from elsewhere. Bundling the two would force them
   * to enable an appointment book they will never open, and would make the majority
   * journey a special case of the minority one — which is the exact bug ADR-0013
   * exists to close.
   *
   * Every edition has it. A hospital that cannot admit a patient to a queue is not
   * a cheaper product, it is a broken one.
   */
  OPS_OPD: "module.ops.opd",
  OPS_APPOINTMENTS: "module.ops.appointments",
  OPS_IPD: "module.ops.ipd",
  OPS_INTER_BRANCH: "module.ops.interBranch",

  // Clinical
  CLINICAL_EMR_BASIC: "module.clinical.emr",
  CLINICAL_NURSING: "module.clinical.nursing",
  CLINICAL_LIS: "module.clinical.lis",
  CLINICAL_RIS: "module.clinical.ris",
  CLINICAL_OT: "module.clinical.ot",
  CLINICAL_BLOODBANK: "module.clinical.bloodbank",
  CLINICAL_EMERGENCY: "module.clinical.emergency",
  CLINICAL_CRITICAL_CARE: "module.clinical.criticalCare",
  CLINICAL_DIALYSIS: "module.clinical.dialysis",
  CLINICAL_PHYSIOTHERAPY: "module.clinical.physiotherapy",
  CLINICAL_TELECONSULT: "module.clinical.teleconsult",
  CLINICAL_HOME_HEALTHCARE: "module.clinical.homeHealthcare",
  CLINICAL_OCCUPATIONAL_HEALTH: "module.clinical.occupationalHealth",

  // Support
  SUPPORT_CSSD: "module.support.cssd",
  /**
   * The general store — non-drug consumables, their shelf and who they were issued to.
   *
   * DELIBERATELY SEPARATE from `module.pharmacy.full`, which is the drug shelf. They are two
   * rooms with two keepers: a clinic that bought dispensing has no store keeper, and a hospital
   * that runs a store still buys its drugs through the pharmacy. Folding them together would
   * either sell a clinic a store room it does not have or hand every dispensing hospital a
   * general store for free.
   */
  SUPPORT_INVENTORY: "module.support.inventory",
  SUPPORT_MORTUARY: "module.support.mortuary",
  SUPPORT_MRD: "module.support.mrd",
  SUPPORT_AMBULANCE: "module.support.ambulance",
  SUPPORT_ASSETS: "module.support.assets",

  // Pharmacy & finance
  PHARMACY_DISPENSING: "module.pharmacy.dispensing",
  PHARMACY_FULL: "module.pharmacy.full",
  FINANCE_OP_BILLING: "module.finance.opBilling",
  FINANCE_IP_BILLING: "module.finance.ipBilling",
  FINANCE_PACKAGES: "module.finance.packages",
  FINANCE_PREAUTH: "module.finance.preAuth",
  FINANCE_INSURANCE: "module.finance.insurance",

  // Platform
  PORTAL_PATIENT: "portal.patient",
  PLATFORM_MULTI_ENTITY: "module.platform.multiEntity",
  PLATFORM_DEDICATED_DB: "platform.dedicatedDb",
  ANALYTICS_GROUP_DASHBOARDS: "module.analytics.groupDashboards",
} as const;

export type FeatureFlag = (typeof FEATURE_FLAGS)[keyof typeof FEATURE_FLAGS];

/* ────────────────────────────────────────────────────────────────────────────
 * Editions (Doc 07) — what a hospital gets when it buys a plan.
 *
 * This is the "one codebase, 25 organization types" mechanism: an edition is
 * DATA (a list of switches), never a fork of the code.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface EditionDefinition {
  code: string;
  name: string;
  flags: FeatureFlag[];
  limits: {
    maxUsers?: number;
    maxDoctors?: number;
    maxBranches?: number;
    maxBeds?: number;
    maxPatients?: number;
    storageGb?: number;
  };
}

const F = FEATURE_FLAGS;

const CLINIC_FLAGS: FeatureFlag[] = [
  // The entry point. Every edition has it — see FEATURE_FLAGS.OPS_OPD.
  F.OPS_OPD,
  F.OPS_APPOINTMENTS,
  F.CLINICAL_EMR_BASIC,
  F.FINANCE_OP_BILLING,
  F.PORTAL_PATIENT,
];

const HOSPITAL_FLAGS: FeatureFlag[] = [
  ...CLINIC_FLAGS,
  F.OPS_IPD,
  F.CLINICAL_NURSING,
  F.CLINICAL_LIS,
  F.CLINICAL_RIS,
  F.CLINICAL_OT,
  F.CLINICAL_EMERGENCY,
  /**
   * BOTH pharmacy flags, and the pair is not redundant.
   *
   * `PHARMACY_FULL` is the department — stock, batches, expiry, purchasing. `DISPENSING`
   * is the counter: handing drugs to a patient against a prescription. A hospital that
   * bought the full pharmacy and could not dispense from it would be a product with a
   * warehouse and no shop, so the edition grants both.
   *
   * They stay SEPARATE FLAGS because Clinic Plus buys exactly one of them: it dispenses
   * against prescriptions and keeps no inventory. Collapsing them would either force a
   * clinic to buy a stock system it will never open, or hand every dispensing hospital an
   * inventory module for free. The routes gate on the narrower one it needs.
   */
  F.PHARMACY_DISPENSING,
  F.PHARMACY_FULL,
  F.FINANCE_IP_BILLING,
  F.FINANCE_INSURANCE,
  F.SUPPORT_MRD,
  // A full hospital runs a fleet: emergency pickups, inter-facility transfers, discharge drops.
  F.SUPPORT_AMBULANCE,
  // A hospital owns equipment that must be serviced on a cycle — the asset register + maintenance log.
  F.SUPPORT_ASSETS,
  // Gloves, syringes, IV sets, sutures. A hospital consumes them by the crate and a clinic does not.
  F.SUPPORT_INVENTORY,
];

export const EDITIONS = {
  PLAN_CLINIC: {
    code: "PLAN_CLINIC",
    name: "Clinic",
    flags: CLINIC_FLAGS,
    limits: { maxUsers: 10, maxDoctors: 3, maxBranches: 1, maxBeds: 0, storageGb: 10 },
  },
  PLAN_CLINIC_PLUS: {
    code: "PLAN_CLINIC_PLUS",
    name: "Clinic Plus",
    flags: [
      ...CLINIC_FLAGS,
      F.CLINICAL_TELECONSULT,
      F.CLINICAL_PHYSIOTHERAPY,
      F.PHARMACY_DISPENSING,
    ],
    limits: { maxUsers: 25, maxDoctors: 10, maxBranches: 2, maxBeds: 0, storageGb: 25 },
  },
  PLAN_DIAGNOSTIC: {
    code: "PLAN_DIAGNOSTIC",
    name: "Diagnostic Centre",
    flags: [...CLINIC_FLAGS, F.CLINICAL_LIS, F.CLINICAL_RIS],
    limits: { maxUsers: 25, maxBranches: 3, storageGb: 50 },
  },
  PLAN_DAY_CARE: {
    code: "PLAN_DAY_CARE",
    name: "Day Care",
    flags: [
      ...CLINIC_FLAGS,
      F.CLINICAL_OT,
      F.CLINICAL_DIALYSIS,
      F.FINANCE_PACKAGES,
      F.FINANCE_PREAUTH,
    ],
    limits: { maxUsers: 40, maxBeds: 20, maxBranches: 2, storageGb: 50 },
  },
  PLAN_HOSPITAL: {
    code: "PLAN_HOSPITAL",
    name: "Hospital",
    flags: HOSPITAL_FLAGS,
    limits: { maxUsers: 250, maxDoctors: 100, maxBranches: 3, maxBeds: 300, storageGb: 250 },
  },
  PLAN_HOSPITAL_PLUS: {
    code: "PLAN_HOSPITAL_PLUS",
    name: "Hospital Plus",
    flags: [
      ...HOSPITAL_FLAGS,
      F.CLINICAL_CRITICAL_CARE,
      F.CLINICAL_BLOODBANK,
      F.SUPPORT_CSSD,
      F.SUPPORT_MORTUARY,
      F.FINANCE_PACKAGES,
      F.FINANCE_PREAUTH,
    ],
    limits: { maxUsers: 600, maxDoctors: 250, maxBranches: 5, maxBeds: 800, storageGb: 500 },
  },
  PLAN_ENTERPRISE: {
    code: "PLAN_ENTERPRISE",
    name: "Enterprise Network",
    flags: [
      ...HOSPITAL_FLAGS,
      F.CLINICAL_CRITICAL_CARE,
      F.CLINICAL_BLOODBANK,
      F.CLINICAL_DIALYSIS,
      F.SUPPORT_CSSD,
      F.SUPPORT_MORTUARY,
      F.FINANCE_PACKAGES,
      F.FINANCE_PREAUTH,
      F.OPS_INTER_BRANCH,
      F.PLATFORM_MULTI_ENTITY,
      F.ANALYTICS_GROUP_DASHBOARDS,
      F.PLATFORM_DEDICATED_DB,
    ],
    limits: { storageGb: 2000 }, // unlimited seats — contract-governed
  },
} as const satisfies Record<string, EditionDefinition>;

export type EditionCode = keyof typeof EDITIONS;

export function getEdition(code: string | undefined): EditionDefinition | undefined {
  if (!code) return undefined;
  return (EDITIONS as Record<string, EditionDefinition>)[code];
}

/* ────────────────────────────────────────────────────────────────────────────
 * Default role grants — the roles seeded into every new hospital.
 *
 * These are DEFAULTS, not law: a hospital may edit them, and many will. What we
 * ship is a sane starting point that reflects who actually does what in a
 * hospital, so nobody has to build "Receptionist" from an empty list.
 *
 * `TENANT_ADMIN` is granted everything EXCEPT the superadmin permissions — a
 * hospital administrator must never be able to reach another hospital, and that
 * is enforced by simply never granting those codes here.
 * ──────────────────────────────────────────────────────────────────────────── */

const SUPERADMIN_CODES = new Set(Object.values(SUPERADMIN).map((x) => x.code));

export interface RoleDefinition {
  code: string;
  name: string;
  description: string;
  permissions: string[];
}

const codes = (...defs: PermissionDefinition[]): string[] => defs.map((d) => d.code);

export const DEFAULT_ROLES = [
  {
    code: "TENANT_ADMIN",
    name: "Administrator",
    description: "Full administrative access to this hospital.",
    permissions: ALL_PERMISSION_CODES.filter((c) => !SUPERADMIN_CODES.has(c)),
  },
  {
    code: "DOCTOR",
    name: "Doctor",
    description: "Consults, prescribes, orders and signs clinical records.",
    permissions: codes(
      PATIENT.PATIENT_READ,
      // Sees their waiting patients, calls them in, and closes the visit. NOT
      // `encounter:create` — starting a visit is the front desk's job, and a doctor
      // who can conjure one can bypass registration (and therefore the UHID, the
      // queue and the bill).
      OPERATIONS.ENCOUNTER_READ,
      OPERATIONS.ENCOUNTER_UPDATE,
      OPERATIONS.ENCOUNTER_CLOSE,
      /**
       * ── ADMITTING AND DISCHARGING ARE CLINICAL DECISIONS ────────────────────
       * These were held by NOBODY — not the doctor, not the nurse, not the front desk.
       * Every admit route would have answered 403 to every human in the building, which
       * is the third time a permission defined in the catalog was never granted to the
       * person whose job it is (see `user:read` for the receptionist, and
       * `prescription:create`'s scope). **A permission nobody holds is a feature nobody
       * has.**
       *
       * They belong to the DOCTOR because deciding a patient needs a bed — and deciding
       * they are well enough to leave — is a clinical judgement, not paperwork. The ward
       * clerk does the paperwork; the nurse allocates the bed (`bed:allocate`); neither
       * of them decides.
       */
      PATIENT.ADMISSION_CREATE,
      PATIENT.ADMISSION_DISCHARGE,
      PATIENT.RECORD_READ,
      PATIENT.RECORD_WRITE,
      PATIENT.DISCHARGE_CREATE,
      // Explaining the risks and taking the consent is the treating doctor's act; certifying a
      // death is a licensed one only they can make. These sat in the catalog held by NOBODY (the
      // "a permission nobody holds is a feature nobody has" trap the admit permissions fell into) —
      // consent is captured by the nurse too, death is certified by the doctor alone.
      PATIENT.CONSENT_MANAGE,
      PATIENT.DEATH_CERTIFY,
      // Assigning the ICD-10 code to the visit's diagnosis. In practice the treating doctor codes
      // their own case; a dedicated records coder (a role a hospital can add) would also hold this.
      PATIENT.MRD_CODE,
      PATIENT.REFERRAL_MANAGE,
      CLINICAL.EMR_READ,
      CLINICAL.VITALS_READ,
      CLINICAL.EMR_WRITE,
      CLINICAL.EMR_SIGN,
      CLINICAL.ALLERGY_READ,
      CLINICAL.ALLERGY_MANAGE,
      CLINICAL.CONSULTATION_MANAGE,
      CLINICAL.PRESCRIPTION_CREATE,
      CLINICAL.PRESCRIPTION_SIGN,
      // Authorises dispensing on credit when an admitted patient's advance is spent — a
      // clinical/commercial call the counter pharmacist cannot make alone. The pharmacist
      // holds `pharmacy:dispense`; the sign-off to overrun the advance sits with the doctor.
      FINANCE.PHARMACY_CREDIT_OVERRIDE,
      // Places the order and follows it. NOT `order:perform` and NOT `order:verify`
      // — a doctor who could sign off their own lab result would be the only pair of
      // eyes on it, which is precisely the check the second signature exists to be.
      CLINICAL.ORDER_CREATE,
      CLINICAL.ORDER_READ,
      CLINICAL.ORDER_CANCEL,
      CLINICAL.TELECONSULT_HOST,
      CLINICAL.LAB_ORDER,
      CLINICAL.RADIOLOGY_ORDER,
      // An ED doctor re-assesses the patient in front of them. A hospital with no triage nurse on
      // the night shift still has to be able to sort its waiting room.
      CLINICAL.TRIAGE_PERFORM,
      CLINICAL.OT_RECORD,
      /**
       * ── THE SURGEON BOOKS THE THEATRE ──────────────────────────────────────
       * `ot:schedule` was held by TENANT_ADMIN and nobody else, so the only person in the
       * building who could put a patient on the surgical list was the hospital administrator.
       * That is the "a permission nobody holds is a feature nobody has" trap again — this time
       * on an entire module: theatres, bookings, the collision rule and the OT screen all
       * shipped, and no clinician could reach any of it.
       *
       * The surgeon decides the patient needs an operation and when; the theatre is the resource
       * that decision consumes. It is `branch`-scoped, so it reaches only their own site's list.
       */
      ORGANIZATION.OT_SCHEDULE,
      OPERATIONS.APPOINTMENT_READ,
      /**
       * Their OWN sessions and leave — never anybody else's, and never the clinic HOURS that
       * generate bookable slots. The routes it opens live under `/doctors/me/…` and take the
       * doctor id from the token, so this grants no reach over a colleague's roster.
       *
       * Without it, a doctor could see the appointment book and had no way to say they were not
       * going to be there — the roster was administrable only by someone holding `doctor:manage`,
       * which is TENANT_ADMIN alone.
       */
      CLINICAL.DOCTOR_SELF_MANAGE,
      PLATFORM.FILE_READ,
      PLATFORM.FILE_UPLOAD,
    ),
  },
  {
    code: "NURSE",
    name: "Nurse",
    description: "Vitals, medication administration, nursing notes, bed care.",
    permissions: codes(
      PATIENT.PATIENT_READ,
      // Triage and moving patients along the queue. A nurse does not CLOSE a visit:
      // closing it freezes what can be billed and asserts the consultation happened.
      OPERATIONS.ENCOUNTER_READ,
      OPERATIONS.ENCOUNTER_UPDATE,
      PATIENT.RECORD_READ,
      // The nurse at the bedside witnesses and records the consent the doctor explained.
      PATIENT.CONSENT_MANAGE,
      CLINICAL.EMR_READ,
      CLINICAL.VITALS_READ,
      CLINICAL.VITALS_RECORD,
      CLINICAL.ALLERGY_READ,
      CLINICAL.ALLERGY_MANAGE,
      CLINICAL.NURSING_MANAGE,
      CLINICAL.MAR_ADMINISTER,
      /**
       * ── THE TRIAGE NURSE ────────────────────────────────────────────────────
       * The person at the emergency door deciding who is seen next. It is a clinical judgement,
       * which is why it is not `encounter:update` (the desk holds that one and moves patients
       * along a queue without assessing them).
       */
      CLINICAL.TRIAGE_PERFORM,
      CLINICAL.LAB_COLLECT,
      // Nurses work the ward's worklist: they carry out procedures and diet orders.
      CLINICAL.ORDER_READ,
      CLINICAL.ORDER_PERFORM,
      ORGANIZATION.BED_ALLOCATE,
      /**
       * The OT nurse runs the board. In every hospital this product is sold to, the person who
       * marks a procedure started and completed is the circulating nurse, not the surgeon — who
       * is scrubbed in and nowhere near a keyboard for the hours in between. Without this the
       * schedule would sit on `scheduled` all day and the record would be written from memory.
       *
       * It grants the OT LIST and nothing else: booking a theatre window and moving it along its
       * own state machine. It emphatically does not grant `ot:record` — the operation record is
       * the surgeon's statement, and it stays theirs.
       */
      ORGANIZATION.OT_SCHEDULE,
      // The mortuary. Receiving a body into custody and handing it over is ward/mortuary work — the
      // nurse does it. These sat in the catalog held by NOBODY (the "a permission nobody holds is a
      // feature nobody has" trap); a hospital that adds a dedicated mortuary attendant role would
      // give it these too. Release still refuses a medico-legal body without a police clearance,
      // whoever holds the permission.
      ORGANIZATION.MORTUARY_MANAGE,
      ORGANIZATION.MORTUARY_RELEASE,
      OPERATIONS.APPOINTMENT_READ,
      PLATFORM.FILE_READ,
    ),
  },
  {
    code: "RECEPTIONIST",
    name: "Receptionist",
    description: "Front desk: registration, appointments, queue.",
    permissions: codes(
      PATIENT.PATIENT_REGISTER,
      PATIENT.PATIENT_READ,
      PATIENT.PATIENT_UPDATE,
      // The walk-in desk. In a government hospital or a clinic this — not the
      // appointment book — is the front door of the whole product.
      OPERATIONS.ENCOUNTER_CREATE,
      OPERATIONS.ENCOUNTER_READ,
      OPERATIONS.ENCOUNTER_UPDATE,
      OPERATIONS.APPOINTMENT_CREATE,
      OPERATIONS.APPOINTMENT_READ,
      OPERATIONS.APPOINTMENT_UPDATE,
      OPERATIONS.APPOINTMENT_CANCEL,
      OPERATIONS.QUEUE_MANAGE,
      /**
       * ── THE DESK MEASURES THE PATIENT ───────────────────────────────────────
       * Height, weight, BP and temperature are taken at registration, so the doctor meets a
       * patient they already know something about and the OP slip carries a BMI.
       *
       * This is a policy decision, and it was made deliberately: the previous comment on
       * `vitals.routes.ts` said "the desk books and takes money, it does not measure patients"
       * and left the grant alone. In an Indian OPD the desk does measure patients — the weighing
       * scale is next to the counter — and the alternative was that nothing was measured at all,
       * because the NURSE role was the only holder and there is no nurse at the front door.
       *
       * `vitals:read` and NOT `emr:read`: the desk sees the observations it took on today's
       * visit, never the consultation note or the patient's history. The flags those readings
       * carry are adult reference ranges and advisory only (see the vitals service) — nothing
       * here makes the desk a clinical decision-maker.
       */
      CLINICAL.VITALS_RECORD,
      CLINICAL.VITALS_READ,
      ORGANIZATION.VISITOR_MANAGE,
      ORGANIZATION.HELPDESK_MANAGE,
      FINANCE.BILLING_READ,
      PLATFORM.FILE_UPLOAD,
    ),
  },
  {
    code: "CASHIER",
    name: "Cashier / Billing",
    description: "Bills and payments. Cannot discount or refund without approval.",
    permissions: codes(
      PATIENT.PATIENT_READ,
      FINANCE.BILLING_CREATE,
      FINANCE.BILLING_READ,
      FINANCE.BILLING_FINALIZE,
      FINANCE.PAYMENT_COLLECT,
      PATIENT.WALLET_MANAGE,
      // Enrolling a visit in a care package posts its fixed price — a billing act.
      PATIENT.PACKAGE_ENROLL,
      OPERATIONS.APPOINTMENT_READ,
    ),
  },
  {
    /**
     * The small-hospital reality: ONE person at the front desk both registers the patient AND
     * takes the OP fee. Rather than make an admin staple two roles together, this is that job as a
     * single named role — the union of RECEPTIONIST and CASHIER. It is not a new privilege level;
     * every permission here already belongs to one of those two roles, so nothing is invented, and
     * a hospital that separates the desk from the cash counter simply grants the two roles instead.
     */
    code: "FRONT_OFFICE",
    name: "Front Office (Reception + Cash)",
    description: "Registers patients, manages the queue, AND bills and collects payment.",
    permissions: codes(
      // Reception
      PATIENT.PATIENT_REGISTER,
      PATIENT.PATIENT_READ,
      PATIENT.PATIENT_UPDATE,
      OPERATIONS.ENCOUNTER_CREATE,
      OPERATIONS.ENCOUNTER_READ,
      OPERATIONS.ENCOUNTER_UPDATE,
      OPERATIONS.APPOINTMENT_CREATE,
      OPERATIONS.APPOINTMENT_READ,
      OPERATIONS.APPOINTMENT_UPDATE,
      OPERATIONS.APPOINTMENT_CANCEL,
      OPERATIONS.QUEUE_MANAGE,
      // The desk measures the patient — see RECEPTIONIST, whose grant this role is the union of.
      CLINICAL.VITALS_RECORD,
      CLINICAL.VITALS_READ,
      ORGANIZATION.VISITOR_MANAGE,
      ORGANIZATION.HELPDESK_MANAGE,
      PLATFORM.FILE_UPLOAD,
      // Cash
      FINANCE.BILLING_CREATE,
      FINANCE.BILLING_READ,
      FINANCE.BILLING_FINALIZE,
      FINANCE.PAYMENT_COLLECT,
      PATIENT.WALLET_MANAGE,
      PATIENT.PACKAGE_ENROLL,
    ),
  },
  {
    code: "PHARMACIST",
    name: "Pharmacist",
    description: "Dispensing and pharmacy stock.",
    permissions: codes(
      PATIENT.PATIENT_READ,
      FINANCE.PHARMACY_SELL,
      FINANCE.PHARMACY_DISPENSE,
      FINANCE.PHARMACY_STOCK,
      FINANCE.PHARMACY_PURCHASE,
      // The pharmacy's worklist is the same object as the lab's — that is the whole
      // claim of ADR-0013 §3, and this line is where it either holds or does not.
      CLINICAL.ORDER_READ,
      CLINICAL.ORDER_PERFORM,
      // A pharmacy counter hands over drugs AND takes the money for them. Without
      // `billing:read` the pharmacist cannot answer "what do I owe?" — which is the
      // question every single patient asks them.
      FINANCE.BILLING_READ,
      FINANCE.PAYMENT_COLLECT,
      CLINICAL.EMR_READ,
      CLINICAL.VITALS_READ,
      // A pharmacist about to hand over a drug is the LAST person who can catch an
      // allergy the prescriber missed. They read the list; they do not edit it.
      CLINICAL.ALLERGY_READ,
    ),
  },
  /**
   * ── THE PERSON THIS MODULE IS FOR ───────────────────────────────────────────
   * A store keeper is not a pharmacist and not an administrator. Before this role the four
   * `inventory:*` codes and `vendor:manage` were held by TENANT_ADMIN alone — which is the
   * "a permission nobody holds is a feature nobody has" trap this codebase has fallen into five
   * times now (`user:read` for the receptionist, the admit pair, `nursing:manage`, `ot:schedule`).
   * Shipping a store room whose only key is the hospital administrator's would have been the
   * sixth.
   *
   * ── AND IT TOUCHES NO PATIENT ───────────────────────────────────────────────
   * No `patient:read`, no `emr:read`, nothing clinical. Every other operational role in this list
   * carries `patient:read` because their work is ABOUT a person; a store keeper's work is about a
   * box of gloves. Granting them the patient list "so the screen works" is exactly the broad-grant
   * mistake the catalogue exists to avoid — and nothing in the store screens asks for it.
   */
  {
    code: "STORE_KEEPER",
    name: "Store Keeper",
    description: "The general store: item master, deliveries in, issues out, stock corrections.",
    permissions: codes(
      // The baseline — the master and the shelf. Every read in the module is gated on this.
      FINANCE.INVENTORY_MANAGE,
      FINANCE.INVENTORY_PURCHASE,
      FINANCE.INVENTORY_ISSUE,
      FINANCE.INVENTORY_AUDIT,
      // Who the deliveries come from. A receipt that cannot name a supplier is a receipt that
      // cannot answer "what did we buy and from whom", which is half the reason to record it.
      ORGANIZATION.VENDOR_MANAGE,
    ),
  },
  {
    code: "LAB_TECHNICIAN",
    name: "Lab Technician",
    description: "Sample collection and result entry. Cannot approve results.",
    permissions: codes(
      PATIENT.PATIENT_READ,
      CLINICAL.LAB_COLLECT,
      CLINICAL.LAB_RESULT,
      // Works the lab's worklist: accepts the order, runs it, enters the result.
      // Emphatically NOT `order:verify` — the whole point of the technician /
      // pathologist split is that the person who ran the test is not the person who
      // certifies it.
      CLINICAL.ORDER_READ,
      CLINICAL.ORDER_PERFORM,
      PLATFORM.FILE_UPLOAD,
    ),
  },
  {
    code: "PATHOLOGIST",
    name: "Pathologist",
    description: "Approves and signs off laboratory results.",
    permissions: codes(
      PATIENT.PATIENT_READ,
      CLINICAL.LAB_RESULT,
      // `lab:approve` is what gives this role AUTHORITY OVER THE LAB CATEGORY. A
      // pathologist holds `order:verify` like a radiologist does, but only one of
      // them can sign off a blood test — see orders/order.authority.ts.
      CLINICAL.LAB_APPROVE,
      CLINICAL.ORDER_READ,
      CLINICAL.ORDER_VERIFY,
      CLINICAL.ORDER_RELEASE,
      CLINICAL.EMR_READ,
      CLINICAL.VITALS_READ,
    ),
  },
  /**
   * ── THE ROLE THAT MAKES RADIOLOGY WORK WITHOUT A RADIOLOGIST ──────────────
   * Modelled on LAB_TECHNICIAN, with ONE deliberate difference: it also holds `order:verify`,
   * `order:release` and `radiology:sign`, so it can carry a study all the way to the doctor.
   *
   * That difference is not an oversight and it is not a weakening of the lab's rule. The lab's
   * two-person split is a real safety property: the person who ran the assay must not be the one
   * who certifies the number, because the check is on the MEASUREMENT. Imaging is not that. In a
   * hospital with no radiologist — which is most hospitals this product is sold to — the person
   * who takes the film writes "AP chest, no focal consolidation, film attached" and the treating
   * doctor reads the image. There is no second reader to be had, and inventing a requirement for
   * one means the report never reaches anybody.
   *
   * What it deliberately does NOT hold is `emr:read`. It can see its own worklist (`order:read`),
   * attach a film (`file:upload` + `order:perform`) and read the metadata of reports on orders it
   * is working (`GET /reports?orderIds=`, `order:read`) — but the report BYTES and the patient's
   * chart stay behind `emr:read`, exactly as they do for the lab technician. Granting the chart to
   * make a worklist work is the mistake this product has made before.
   */
  {
    code: "RADIOLOGY_TECHNICIAN",
    name: "Radiology Technician",
    description: "Performs imaging studies and reports them. No radiologist required.",
    permissions: codes(
      PATIENT.PATIENT_READ,
      // Works the imaging worklist: accepts the study, performs it, records the report.
      CLINICAL.ORDER_READ,
      CLINICAL.ORDER_PERFORM,
      /**
       * And carries it to the doctor. `radiology:sign` confines that authority to IMAGING — this
       * role still cannot certify a blood result, which is the property `order.authority.ts`
       * exists to hold and which a plain `order:verify` grant would have thrown away.
       */
      CLINICAL.ORDER_VERIFY,
      CLINICAL.ORDER_RELEASE,
      CLINICAL.RADIOLOGY_SIGN,
      PLATFORM.FILE_UPLOAD,
    ),
  },
  {
    code: "RADIOLOGIST",
    name: "Radiologist",
    description: "Reports and signs imaging studies. Optional — see RADIOLOGY_TECHNICIAN.",
    permissions: codes(
      PATIENT.PATIENT_READ,
      CLINICAL.RADIOLOGY_REPORT,
      // Authority over the RADIOLOGY category, and only that one.
      CLINICAL.RADIOLOGY_SIGN,
      CLINICAL.ORDER_READ,
      CLINICAL.ORDER_PERFORM,
      CLINICAL.ORDER_VERIFY,
      CLINICAL.ORDER_RELEASE,
      CLINICAL.EMR_READ,
      CLINICAL.VITALS_READ,
      PLATFORM.FILE_UPLOAD,
    ),
  },
  {
    code: "AUDITOR",
    name: "Auditor",
    description: "Read-only compliance access. Cannot change anything.",
    permissions: codes(
      PLATFORM.AUDIT_VIEW,
      PLATFORM.AUDIT_EXPORT,
      PLATFORM.USER_READ,
      PATIENT.MRD_REGISTER_VIEW,
      // Bills are what an auditor actually reads. READ only — this role is defined by
      // what it cannot do, and it cannot post, finalize, discount or take a payment.
      FINANCE.BILLING_READ,
    ),
  },
  {
    code: "PATIENT",
    name: "Patient",
    description: "Patient-portal identity. Sees only their own record.",
    permissions: codes(SELF.SELF_MANAGE, SELF.BOOKING_PUBLIC),
  },
] as const satisfies readonly RoleDefinition[];

export type DefaultRoleCode = (typeof DEFAULT_ROLES)[number]["code"];

/**
 * Organization types + their policy presets (ADR-0013 §6).
 *
 * `organizationType` selects a preset at provisioning and is DESCRIPTIVE thereafter.
 * Code asks the POLICY ("is billingMode zero_tariff?"), never the TYPE
 * ("is this a government hospital?") — see organizations.ts for why that
 * distinction decides whether a customer is sellable.
 */
export * from "./organizations.js";
