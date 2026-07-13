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
 */

export const PERMISSION_SCOPES = ["own", "branch", "tenant", "global"] as const;
export type PermissionScope = (typeof PERMISSION_SCOPES)[number];

export interface PermissionDefinition {
  /** `resource:action` — the stable identifier stored in the database. */
  code: string;
  resource: string;
  action: string;
  /** Widest scope this permission may be granted at. */
  scope?: PermissionScope;
  description: string;
}

function p(
  code: string,
  description: string,
  scope: PermissionScope = "tenant",
): PermissionDefinition {
  const [resource = "", action = ""] = code.split(":");
  return { code, resource, action, scope, description };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Platform & administration (Doc 02 A1–A9)
 * ──────────────────────────────────────────────────────────────────────────── */

const PLATFORM = {
  TENANT_MANAGE: p("tenant:manage", "Configure this organization"),
  SUBSCRIPTION_MANAGE: p("subscription:manage", "Change plan and billing"),
  FEATUREFLAG_MANAGE: p("featureflag:manage", "Toggle features for this organization"),
  PLAN_MANAGE: p("plan:manage", "Manage product plans", "global"),

  USER_CREATE: p("user:create", "Invite a user"),
  USER_READ: p("user:read", "View users"),
  USER_UPDATE: p("user:update", "Edit a user"),
  USER_DEACTIVATE: p("user:deactivate", "Disable a user"),
  USER_ASSIGN_ROLE: p("user:assign-role", "Grant or revoke a user's roles"),

  ROLE_MANAGE: p("role:manage", "Create and edit roles"),
  PERMISSION_VIEW: p("permission:view", "View the permission catalog"),
  SESSION_REVOKE: p("session:revoke", "Sign another user out"),

  AUDIT_VIEW: p("audit:view", "Read the audit trail"),
  AUDIT_EXPORT: p("audit:export", "Export the audit trail"),

  NOTIFICATION_MANAGE: p("notification:manage", "Manage templates and channels"),
  NOTIFICATION_SEND: p("notification:send", "Send notifications"),

  FILE_UPLOAD: p("file:upload", "Upload documents"),
  FILE_READ: p("file:read", "Read documents"),
  FILE_DELETE: p("file:delete", "Delete documents"),

  BRANDING_MANAGE: p("branding:manage", "Edit branding and theme"),
  DOMAIN_MANAGE: p("domain:manage", "Manage custom domains"),
  APIKEY_MANAGE: p("apikey:manage", "Manage API keys"),
  WEBHOOK_MANAGE: p("webhook:manage", "Manage webhooks"),
} as const;

/** SaaS-operator only. Never granted to a hospital role — these live in the master realm. */
const SUPERADMIN = {
  SUPERADMIN_TENANT_MANAGE: p("superadmin:tenant:manage", "Provision and manage tenants", "global"),
  TENANT_IMPERSONATE: p("tenant:impersonate", "Impersonate a tenant user (audited)", "global"),
  TENANT_EXPORT: p("tenant:export", "Export a tenant's data", "global"),
} as const;

/* ────────────────────────────────────────────────────────────────────────────
 * Organization & facilities (Doc 02 B1–B13)
 * ──────────────────────────────────────────────────────────────────────────── */

const ORGANIZATION = {
  HOSPITAL_MANAGE: p("hospital:manage", "Edit the hospital profile"),
  BRANCH_MANAGE: p("branch:manage", "Manage branches"),
  DEPARTMENT_MANAGE: p("department:manage", "Manage departments"),
  FACILITY_MANAGE: p("facility:manage", "Manage buildings, floors, theatres, ICUs"),

  BED_MANAGE: p("bed:manage", "Configure wards, rooms and beds", "branch"),
  BED_ALLOCATE: p("bed:allocate", "Allocate and transfer beds", "branch"),
  OT_SCHEDULE: p("ot:schedule", "Schedule operation theatres", "branch"),

  AMBULANCE_MANAGE: p("ambulance:manage", "Manage the ambulance fleet"),
  AMBULANCE_DISPATCH: p("ambulance:dispatch", "Dispatch an ambulance", "branch"),
  ASSET_MANAGE: p("asset:manage", "Manage assets and maintenance"),
  VENDOR_MANAGE: p("vendor:manage", "Manage vendors and insurers"),

  FACILITYOPS_MANAGE: p(
    "facilityops:manage",
    "Housekeeping, laundry, cafeteria, parking",
    "branch",
  ),
  VISITOR_MANAGE: p("visitor:manage", "Visitor check-in and passes", "branch"),
  HELPDESK_MANAGE: p("helpdesk:manage", "The hospital's own help desk", "branch"),
  FEEDBACK_MANAGE: p("feedback:manage", "Feedback and surveys"),
  COMPLAINT_MANAGE: p("complaint:manage", "Complaints and resolution"),
  WASTE_MANAGE: p("waste:manage", "Biomedical waste"),
  CSSD_MANAGE: p("cssd:manage", "Sterile supply"),
  CSSD_RELEASE: p("cssd:release", "Release a sterilized batch"),
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

  RECORD_READ: p("record:read", "Read medical records", "branch"),
  RECORD_WRITE: p("record:write", "Write medical records", "branch"),
  CONSENT_MANAGE: p("consent:manage", "Capture consent", "branch"),
  DISCHARGE_CREATE: p("discharge:create", "Write a discharge summary", "branch"),
  REFERRAL_MANAGE: p("referral:manage", "Referrals in and out", "branch"),
  TRANSFER_MANAGE: p("transfer:manage", "Patient transfers", "branch"),

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
  EMR_SIGN: p("emr:sign", "Sign a clinical record (licensed)", "branch"),
  TEMPLATE_MANAGE: p("template:manage", "Clinical templates"),

  VITALS_RECORD: p("vitals:record", "Record vitals", "branch"),
  ALLERGY_MANAGE: p("allergy:manage", "Maintain the allergy list", "branch"),

  DOCTOR_MANAGE: p("doctor:manage", "Manage doctors"),
  SCHEDULE_MANAGE: p("schedule:manage", "Manage doctor schedules", "branch"),
  DOCTOR_PERFORMANCE_VIEW: p("doctor:performance:view", "Doctor performance and revenue"),

  CONSULTATION_MANAGE: p("consultation:manage", "Conduct consultations", "own"),
  PRESCRIPTION_CREATE: p("prescription:create", "Compose a prescription", "own"),
  PRESCRIPTION_SIGN: p("prescription:sign", "Sign a prescription (licensed)", "own"),
  ORDER_CREATE: p("order:create", "Order labs, imaging, procedures", "branch"),

  TELECONSULT_HOST: p("teleconsult:host", "Host a video consultation", "own"),
  TELECONSULT_JOIN: p("teleconsult:join", "Join a video consultation", "own"),

  NURSING_MANAGE: p("nursing:manage", "Nursing care plans and notes", "branch"),
  MAR_ADMINISTER: p("mar:administer", "Administer medication (MAR)", "branch"),

  LAB_ORDER: p("lab:order", "Order a lab test", "branch"),
  LAB_COLLECT: p("lab:collect", "Collect a sample", "branch"),
  LAB_RESULT: p("lab:result", "Enter a lab result", "branch"),
  LAB_APPROVE: p("lab:approve", "Approve a lab result (pathologist)", "branch"),

  RADIOLOGY_ORDER: p("radiology:order", "Order imaging", "branch"),
  RADIOLOGY_REPORT: p("radiology:report", "Report on imaging", "branch"),
  RADIOLOGY_SIGN: p("radiology:sign", "Sign a radiology report", "branch"),

  OT_RECORD: p("ot:record", "Record a surgery", "branch"),
  BLOODBANK_MANAGE: p("bloodbank:manage", "Blood bank stock"),
  BLOODBANK_ISSUE: p("bloodbank:issue", "Issue blood", "branch"),

  TRIAGE_PERFORM: p("triage:perform", "Triage an emergency patient", "branch"),
  ED_BOARD_MANAGE: p("ed:board:manage", "Emergency board", "branch"),
  MLC_MANAGE: p("mlc:manage", "Medico-legal cases", "branch"),

  ICU_CHART: p("icu:chart", "Critical-care charting", "branch"),
  ICU_SCORE: p("icu:score", "Critical-care scoring", "branch"),
  ICU_BOARD_VIEW: p("icu:board:view", "ICU board", "branch"),

  DIALYSIS_MANAGE: p("dialysis:manage", "Dialysis unit"),
  DIALYSIS_SCHEDULE: p("dialysis:schedule", "Schedule dialysis", "branch"),
  DIALYSIS_RECORD: p("dialysis:record", "Record a dialysis session", "branch"),

  PHYSIO_MANAGE: p("physio:manage", "Physiotherapy unit"),
  PHYSIO_ASSESS: p("physio:assess", "Physiotherapy assessment", "branch"),
  PHYSIO_TREAT: p("physio:treat", "Physiotherapy treatment", "branch"),

  DIET_ASSESS: p("diet:assess", "Nutrition assessment", "branch"),
  DIET_PRESCRIBE: p("diet:prescribe", "Prescribe a therapeutic diet", "branch"),
} as const;

/* ────────────────────────────────────────────────────────────────────────────
 * Operations & money (Doc 02 E1, F-series)
 * ──────────────────────────────────────────────────────────────────────────── */

const OPERATIONS = {
  APPOINTMENT_CREATE: p("appointment:create", "Book an appointment", "branch"),
  APPOINTMENT_READ: p("appointment:read", "View appointments", "branch"),
  APPOINTMENT_UPDATE: p("appointment:update", "Reschedule an appointment", "branch"),
  APPOINTMENT_CANCEL: p("appointment:cancel", "Cancel an appointment", "branch"),
  QUEUE_MANAGE: p("queue:manage", "Manage the queue and tokens", "branch"),
} as const;

const FINANCE = {
  BILLING_CREATE: p("billing:create", "Create a bill", "branch"),
  BILLING_READ: p("billing:read", "View bills", "branch"),
  BILLING_FINALIZE: p("billing:finalize", "Finalize a bill", "branch"),
  BILLING_DISCOUNT: p("billing:discount", "Apply a discount"),
  BILLING_REFUND: p("billing:refund", "Issue a refund"),
  PAYMENT_COLLECT: p("payment:collect", "Collect a payment", "branch"),

  INSURANCE_PREAUTH: p("insurance:preauth", "Request pre-authorization"),
  INSURANCE_CLAIM: p("insurance:claim", "File a claim"),
  INSURANCE_RECONCILE: p("insurance:reconcile", "Reconcile a settlement"),
  CORPORATE_BILL: p("corporate:bill", "Bill a corporate client"),
  PACKAGE_MANAGE: p("package:manage", "Manage care packages"),

  PHARMACY_SELL: p("pharmacy:sell", "Sell at the pharmacy counter", "branch"),
  PHARMACY_DISPENSE: p("pharmacy:dispense", "Dispense against a prescription", "branch"),
  PHARMACY_STOCK: p("pharmacy:stock", "Pharmacy stock"),
  PHARMACY_PURCHASE: p("pharmacy:purchase", "Pharmacy purchasing"),

  INVENTORY_MANAGE: p("inventory:manage", "Manage inventory"),
  INVENTORY_ISSUE: p("inventory:issue", "Issue stock", "branch"),
  INVENTORY_AUDIT: p("inventory:audit", "Stock audit"),
  INVENTORY_PURCHASE: p("inventory:purchase", "Purchasing"),

  FINANCE_LEDGER: p("finance:ledger", "General ledger"),
  FINANCE_EXPENSE: p("finance:expense", "Expenses"),
  FINANCE_INCOME: p("finance:income", "Income"),
  FINANCE_REPORT: p("finance:report", "Financial reports"),
  FINANCE_CLOSE: p("finance:close", "Close a financial period"),

  HR_EMPLOYEE: p("hr:employee", "Employee records"),
  HR_ATTENDANCE: p("hr:attendance", "Attendance"),
  HR_LEAVE: p("hr:leave", "Leave"),
  HR_PAYROLL: p("hr:payroll", "Run payroll"),
  PAYROLL_APPROVE: p("payroll:approve", "Approve payroll"),
  HR_RECRUIT: p("hr:recruit", "Recruitment"),
} as const;

/** Patient-portal identity. `own` scope only — a patient sees exactly their own record. */
const SELF = {
  SELF_MANAGE: p("self:manage", "Manage my own profile and bookings", "own"),
  BOOKING_PUBLIC: p("booking:public", "Book an appointment online", "own"),
  FORM_DESIGN: p("form:design", "Design digital forms"),
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
  SUPPORT_MORTUARY: "module.support.mortuary",
  SUPPORT_MRD: "module.support.mrd",

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
  F.PHARMACY_FULL,
  F.FINANCE_IP_BILLING,
  F.FINANCE_INSURANCE,
  F.SUPPORT_MRD,
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
      PATIENT.RECORD_READ,
      PATIENT.RECORD_WRITE,
      PATIENT.DISCHARGE_CREATE,
      PATIENT.REFERRAL_MANAGE,
      CLINICAL.EMR_READ,
      CLINICAL.EMR_WRITE,
      CLINICAL.EMR_SIGN,
      CLINICAL.ALLERGY_MANAGE,
      CLINICAL.CONSULTATION_MANAGE,
      CLINICAL.PRESCRIPTION_CREATE,
      CLINICAL.PRESCRIPTION_SIGN,
      CLINICAL.ORDER_CREATE,
      CLINICAL.TELECONSULT_HOST,
      CLINICAL.LAB_ORDER,
      CLINICAL.RADIOLOGY_ORDER,
      CLINICAL.OT_RECORD,
      OPERATIONS.APPOINTMENT_READ,
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
      PATIENT.RECORD_READ,
      CLINICAL.EMR_READ,
      CLINICAL.VITALS_RECORD,
      CLINICAL.ALLERGY_MANAGE,
      CLINICAL.NURSING_MANAGE,
      CLINICAL.MAR_ADMINISTER,
      CLINICAL.LAB_COLLECT,
      ORGANIZATION.BED_ALLOCATE,
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
      OPERATIONS.APPOINTMENT_CREATE,
      OPERATIONS.APPOINTMENT_READ,
      OPERATIONS.APPOINTMENT_UPDATE,
      OPERATIONS.APPOINTMENT_CANCEL,
      OPERATIONS.QUEUE_MANAGE,
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
      OPERATIONS.APPOINTMENT_READ,
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
      CLINICAL.EMR_READ,
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
      CLINICAL.LAB_APPROVE,
      CLINICAL.EMR_READ,
    ),
  },
  {
    code: "RADIOLOGIST",
    name: "Radiologist",
    description: "Reports and signs imaging studies.",
    permissions: codes(
      PATIENT.PATIENT_READ,
      CLINICAL.RADIOLOGY_REPORT,
      CLINICAL.RADIOLOGY_SIGN,
      CLINICAL.EMR_READ,
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
