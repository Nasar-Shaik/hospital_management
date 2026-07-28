/**
 * Isomorphic typed API client (ADR-0012).
 *
 * Server components, client components and the middleware all reach Express
 * through this — Next.js never fetches data any other way, and it never touches a
 * database. This file is the entire seam between the presentation tier and the API.
 *
 * ── THE HOSTNAME IS THE TENANT ───────────────────────────────────────────────
 * A browser cannot set a `Host` header, and `Host` is what selects a hospital's
 * database (ADR-0005). So the API must be reached on the SAME hostname the user is
 * browsing: someone on `apollo.paperlesstech.in` calls the API at
 * `apollo.paperlesstech.in`. In production a gateway routes `/api/*` on that host
 * to Express; in dev the API is on another PORT of the same hostname, which
 * resolves identically because the port is stripped before lookup.
 *
 * Pointing this at `localhost` while browsing a tenant host is the mistake to
 * avoid: the request would arrive claiming to be nobody and be rejected with
 * HMS-TEN-001.
 */
import type { ApiEnvelope, PageMeta } from "@medicore/types";

/**
 * The licence state the API stamps on every response (ADR-0016), for the renewal banner.
 * `EXPIRING` = active but within the warning window; `GRACE` = past expiry, still served.
 * (A hard-`EXPIRED` licence never produces a normal response — the request is refused.)
 */
export interface LicenseHeader {
  state: "ACTIVE" | "EXPIRING" | "GRACE";
  daysLeft: number | null;
}

export interface ApiClientOptions {
  /** Absolute (`http://apollo.paperlesstech.in:4000`) or same-origin (`""`). */
  baseUrl: string;
  /** Returns the in-memory access token, if the caller has one. */
  getAccessToken?: () => string | undefined;
  /** Send cookies — required for the refresh flow. */
  credentials?: RequestCredentials;
  /** Overrides the `Host` the API sees. Server-side only; browsers ignore it. */
  tenantHost?: string;
  /**
   * Returns the active branch id to act in (ADR-0015), or `undefined`/`"all"` for aggregate mode.
   * Read on EVERY request and sent as `X-Active-Branch`, so switching branch takes effect
   * immediately without rebuilding the client — the same live-read pattern as the access token.
   */
  getActiveBranch?: () => string | undefined;
  fetchImpl?: typeof fetch;
  /**
   * Called after every response with the licence state the API stamps on it (ADR-0016),
   * read from the `X-License-State` / `X-License-Days-Left` headers. `null` when the
   * response carried no licence headers (a perpetual hospital, or a non-tenant call).
   * The web app uses this to drive the renewal banner without polling.
   */
  onLicenseState?: (state: LicenseHeader | null) => void;
  /**
   * Called when a request fails with an EXPIRED/INVALID session (HMS-AUTH-002/003) — the
   * mid-session case the proactive refresh timer can miss (a laptop asleep past the token's
   * life). Return `true` if a silent refresh succeeded and the one failed request should be
   * retried; return `false` to give up (the caller then sends the user to /login). Auth
   * endpoints (login/refresh/mfa/reset) are excluded so this never recurses on the refresh call.
   */
  onUnauthorized?: () => Promise<boolean>;
}

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    public readonly traceId?: string,
  ) {
    super(message);
    this.name = "ApiClientError";
  }

  /** The session is gone — send them to /login. */
  get isUnauthenticated(): boolean {
    return this.code === "HMS-AUTH-002" || this.code === "HMS-AUTH-003";
  }

  /** Authenticated but not allowed. Do NOT bounce these to /login — it would loop forever. */
  get isForbidden(): boolean {
    return this.code === "HMS-AUTH-005" || this.code === "HMS-PLAN-002";
  }

  /** Field errors from a 400, shaped `{ field: [messages] }`. */
  get fieldErrors(): Record<string, string[]> {
    const details = this.details as { fields?: Record<string, string[]> } | undefined;
    return details?.fields ?? {};
  }
}

/* ── response types (mirrors of the API's DTOs) ───────────────────────────── */

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  roles: string[];
  branchIds: string[];
  mfaEnabled: boolean;
  mustChangePassword: boolean;
  /**
   * Returned by `/auth/me` only — for hiding UI the user cannot use.
   *
   * Never an authorization decision: the server re-checks every request, so
   * editing this array in the browser reveals a menu item and nothing behind it
   * (Constitution §3.6).
   */
  permissions?: string[];
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: AuthenticatedUser;
}

export interface MfaChallenge {
  mfaRequired: true;
  mfaToken: string;
  expiresIn: number;
}

export type LoginResult = TokenPair | MfaChallenge;

export function isMfaChallenge(result: LoginResult): result is MfaChallenge {
  return "mfaRequired" in result;
}

export interface Session {
  id: string;
  device?: string;
  ip?: string;
  userAgent?: string;
  lastSeenAt: string;
  createdAt: string;
}

export const STAFF_GENDERS = ["male", "female", "other"] as const;
export type StaffGender = (typeof STAFF_GENDERS)[number];

/**
 * Professional / HR details for a staff member. Every field optional. Dates are
 * `YYYY-MM-DD` strings on the wire. The registration form captures the fields relevant to
 * the chosen role; the shape is one flexible object so a role change never loses data.
 */
export interface StaffProfile {
  designation?: string;
  department?: string;
  specialty?: string;
  /** Doctors: OP consultation fee in PAISE. Absent = charge the hospital's consultation tariff. */
  consultationFee?: number;
  qualification?: string;
  registrationNo?: string;
  gender?: StaffGender;
  dateOfBirth?: string;
  joiningDate?: string;
  address?: string;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  /** Opt-in: feature this person (doctors only) on the hospital's public website. */
  showOnPublicSite?: boolean;
  /** Doctors: a scanned signature as a `data:image/...;base64,…` URI, printed on the OPD slip. */
  signature?: string;
}

/** One doctor as a document needs them — for the OPD slip's signature block. */
export interface DoctorCard {
  id: string;
  name: string;
  qualification?: string;
  designation?: string;
  signature?: string;
}

export interface StaffMember {
  id: string;
  email: string;
  name: string;
  status: "invited" | "active" | "locked" | "disabled" | "archived";
  phone?: string;
  employeeId?: string;
  profile?: StaffProfile;
  roles: string[];
  branchIds: string[];
  mfaEnabled: boolean;
  lastLoginAt?: string;
}

/** A doctor, as a dropdown needs them. Names only — see `listDoctors`. */
export interface DoctorRef {
  id: string;
  name: string;
}

/* ── Public site (per-hospital website) ─────────────────────────────────────── */

export interface SiteService {
  name: string;
  description?: string;
  icon?: string;
}

export interface SiteStat {
  label: string;
  value: string;
}

export interface SiteContact {
  phone?: string;
  email?: string;
  address?: string;
  emergencyPhone?: string;
  hoursText?: string;
}

export interface SiteSocial {
  website?: string;
  facebook?: string;
  instagram?: string;
  twitter?: string;
  youtube?: string;
  linkedin?: string;
}

export interface SiteAnnouncement {
  text: string;
  link?: string;
}

/** A doctor as the public website shows them — never contact/HR detail. */
export interface PublicDoctor {
  id: string;
  name: string;
  specialty?: string;
  designation?: string;
}

/** What `GET /site` returns — always fully populated (saved content over defaults). */
export interface PublicSite {
  hospitalName: string;
  displayName: string;
  accentColor: string;
  tagline: string;
  about: string;
  services: SiteService[];
  stats: SiteStat[];
  contact: SiteContact;
  social: SiteSocial;
  announcement?: SiteAnnouncement;
  metaDescription: string;
  doctors: PublicDoctor[];
  /** Whether a logo has been uploaded — fetch it from `GET /site/logo` when true. */
  hasLogo: boolean;
  published: boolean;
}

/** The saved fields, for the admin editor — blanks mean "not set". */
export interface EditableSite {
  hospitalName: string;
  displayName: string;
  accentColor: string;
  tagline: string;
  about: string;
  services: SiteService[];
  stats: SiteStat[];
  contact: SiteContact;
  social: SiteSocial;
  announcement?: SiteAnnouncement;
  metaDescription: string;
  hasLogo: boolean;
  published: boolean;
}

/** An API key's metadata (Module A9) — never its secret. */
export interface ApiKeyMeta {
  id: string;
  name: string;
  last4: string;
  createdBy: string;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
  lastUsedAt?: string;
}

/** A freshly created key — the only time the full `key` is ever returned. */
export interface CreatedApiKey extends ApiKeyMeta {
  key: string;
}

/** The admin write DTO. `announcement: null` clears the strip; omitting a field leaves it. */
export interface UpdateSiteInput {
  displayName?: string;
  accentColor?: string;
  tagline?: string;
  about?: string;
  services?: SiteService[];
  stats?: SiteStat[];
  contact?: SiteContact;
  social?: SiteSocial;
  announcement?: SiteAnnouncement | null;
  metaDescription?: string;
  published?: boolean;
}

export interface CreateStaffResult {
  user: StaffMember;
  temporaryPassword?: string;
}

export interface Role {
  id: string;
  code: string;
  name: string;
  description?: string;
  isSystem: boolean;
}

export interface Paged<T> {
  items: T[];
  meta: PageMeta;
}

/** One entry in the append-only trail (Doc 09 §9). */
export interface AuditEntry {
  id: string;
  seq: number;
  at: string;
  actorId?: string;
  actorEmail?: string;
  actorRoles?: string[];
  action: string;
  category: "phi" | "financial" | "security" | "admin" | "access";
  resource: string;
  resourceId?: string;
  outcome: "success" | "failure";
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  ip?: string;
  traceId?: string;
}

export interface AuditQuery {
  page?: number;
  limit?: number;
  category?: AuditEntry["category"];
  action?: string;
  actorId?: string;
  resource?: string;
  resourceId?: string;
  outcome?: AuditEntry["outcome"];
  from?: string;
  to?: string;
}

export interface AuditIntegrity {
  ok: boolean;
  anchors: number;
  entriesVerified: number;
  problems: { anchorIndex: number; kind: string; detail: string }[];
}

/* ── platform / operator console (Doc 02 A1) ─────────────────────────────── */

export type PlatformRole = "SUPER_ADMIN" | "SUPPORT";

/* ── patients (Doc 02 C1) ── */

export type PatientStatus = "active" | "merged";
export type Gender = "male" | "female" | "other" | "unknown";

export interface Patient {
  id: string;
  /** The number on the wristband. Tenant-scoped, permanent, never reused. */
  uhid: string;
  name: string;
  gender: Gender;
  status: PatientStatus;
  dob?: string;
  bloodGroup?: string;
  branchId?: string;
  contact: { phone?: string; email?: string };
  address?: Record<string, string | undefined>;
  /** Set when this record was merged INTO another — it is no longer the live chart. */
  mergedInto?: string;
  mergedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * The allergen catalogue the UI offers, mirrored from the API's `ALLERGENS`. An allergy is
 * recorded against a CODE from this list, never free text — a typed allergen a machine cannot
 * match is a safety check that silently never fires. Keep in step with drugSafety.ts.
 */
export const ALLERGENS: Record<string, string> = {
  penicillins: "Penicillins",
  cephalosporins: "Cephalosporins",
  sulfonamides: "Sulfonamides (sulfa drugs)",
  macrolides: "Macrolides",
  nsaids: "NSAIDs",
  salicylates: "Salicylates (aspirin)",
  opioids: "Opioids",
  paracetamol: "Paracetamol",
  ondansetron: "Ondansetron",
  latex: "Latex",
  peanuts: "Peanuts",
  eggs: "Eggs",
};

export const ALLERGY_SEVERITIES = ["mild", "moderate", "severe", "anaphylaxis"] as const;
export type AllergySeverity = (typeof ALLERGY_SEVERITIES)[number];
export type AllergyStatus = "active" | "refuted";

export interface Allergy {
  id: string;
  patientId: string;
  allergen: string;
  /** Human label for `allergen`, resolved by the API from the catalogue. */
  label: string;
  severity: AllergySeverity;
  reaction?: string;
  status: AllergyStatus;
  notedBy: string;
  notedAt: string;
  refutedBy?: string;
  refutedAt?: string;
  refutedReason?: string;
}

/* ── Branches (ADR-0015) ──────────────────────────────────────────────────────── */

export type BranchStatus = "active" | "inactive";

export interface Branch {
  id: string;
  name: string;
  code: string;
  status: BranchStatus;
  isMain: boolean;
  address?: string;
  contactPhone?: string;
  contactEmail?: string;
  timezone?: string;
  gstin?: string;
}

/** What `GET /me/branches` returns — the switcher's data. */
export interface MyBranches {
  /** The branches the signed-in user may act in. */
  branches: Branch[];
  /** Whether the user may pick "All branches" (aggregate) — true only with more than one. */
  canAggregate: boolean;
}

export interface CreateBranchInput {
  name: string;
  code: string;
  address?: string;
  contactPhone?: string;
  contactEmail?: string;
  timezone?: string;
  gstin?: string;
}

export interface UpdateBranchInput {
  name?: string;
  status?: BranchStatus;
  address?: string;
  contactPhone?: string;
  contactEmail?: string;
  timezone?: string;
  gstin?: string;
}

/* ── departments (B2/B3) ── */

export type DepartmentKind =
  "clinical" | "diagnostic" | "nursing" | "pharmacy" | "support" | "administrative";
export type DepartmentStatus = "active" | "inactive";

export interface Department {
  id: string;
  name: string;
  code: string;
  kind: DepartmentKind;
  status: DepartmentStatus;
  /** The parent unit, when this is a sub-department. Absent means a top-level department. */
  parentId?: string;
  /** The department head — a staff user id. */
  headStaffId?: string;
  description?: string;
  /** The parent's name, denormalized for the tree view. */
  parentName?: string;
}

export interface CreateDepartmentInput {
  name: string;
  code: string;
  kind: DepartmentKind;
  parentId?: string;
  headStaffId?: string;
  description?: string;
}

export interface UpdateDepartmentInput {
  name?: string;
  kind?: DepartmentKind;
  status?: DepartmentStatus;
  /** `null` detaches the parent/head; omit to leave unchanged. */
  parentId?: string | null;
  headStaffId?: string | null;
  description?: string;
}

/* ── operation theatres (B5) ── */

export type TheatreKind = "major_ot" | "minor_ot" | "cath_lab" | "endoscopy" | "labor_room";
export type TheatreStatus = "active" | "inactive";
export type OtBookingStatus = "scheduled" | "in_progress" | "completed" | "cancelled";

export interface Theatre {
  id: string;
  name: string;
  code: string;
  kind: TheatreKind;
  status: TheatreStatus;
  branchId?: string;
}

export interface CreateTheatreInput {
  name: string;
  code: string;
  kind: TheatreKind;
}

export interface UpdateTheatreInput {
  name?: string;
  kind?: TheatreKind;
  status?: TheatreStatus;
}

/** A procedure booked on a theatre, with the patient named for the board. */
export interface OtBooking {
  id: string;
  theatreId: string;
  theatreName: string;
  theatreCode: string;
  patientId: string;
  patientName: string;
  uhid: string;
  surgeonId: string;
  encounterId?: string;
  procedureName: string;
  /** ISO timestamps. */
  scheduledStart: string;
  scheduledEnd: string;
  status: OtBookingStatus;
  notes?: string;
  branchId?: string;
}

export interface CreateBookingInput {
  theatreId: string;
  patientId: string;
  surgeonId: string;
  encounterId?: string;
  procedureName: string;
  /** ISO timestamps or anything `new Date()` accepts. */
  scheduledStart: string;
  scheduledEnd: string;
}

export interface ListBookingsQuery {
  from?: string;
  to?: string;
  theatreId?: string;
  status?: OtBookingStatus;
}

/* ── ambulance fleet (B6) ── */

export type AmbulanceKind =
  "basic_life_support" | "advanced_life_support" | "patient_transport" | "mortuary_van";
export type AmbulanceStatus = "active" | "inactive";
export type AmbulanceTripStatus = "dispatched" | "in_progress" | "completed" | "cancelled";
export type AmbulanceTripPurpose =
  "emergency" | "transfer" | "discharge" | "body_transport" | "standby";

export interface Ambulance {
  id: string;
  name: string;
  code: string;
  registrationNumber?: string;
  kind: AmbulanceKind;
  status: AmbulanceStatus;
  branchId?: string;
}

export interface CreateAmbulanceInput {
  name: string;
  code: string;
  registrationNumber?: string;
  kind: AmbulanceKind;
}

export interface UpdateAmbulanceInput {
  name?: string;
  registrationNumber?: string;
  kind?: AmbulanceKind;
  status?: AmbulanceStatus;
}

/** A trip dispatched on a vehicle. The patient is named only when the trip is linked to one. */
export interface AmbulanceTrip {
  id: string;
  ambulanceId: string;
  ambulanceName: string;
  ambulanceCode: string;
  patientId?: string;
  patientName?: string;
  uhid?: string;
  encounterId?: string;
  driverId?: string;
  purpose: AmbulanceTripPurpose;
  pickup?: string;
  dropoff?: string;
  contactPhone?: string;
  /** ISO timestamps. */
  scheduledStart: string;
  scheduledEnd: string;
  status: AmbulanceTripStatus;
  notes?: string;
  branchId?: string;
}

export interface CreateTripInput {
  ambulanceId: string;
  patientId?: string;
  encounterId?: string;
  driverId?: string;
  purpose: AmbulanceTripPurpose;
  pickup?: string;
  dropoff?: string;
  contactPhone?: string;
  /** ISO timestamps or anything `new Date()` accepts. */
  scheduledStart: string;
  scheduledEnd: string;
}

export interface ListTripsQuery {
  from?: string;
  to?: string;
  ambulanceId?: string;
  status?: AmbulanceTripStatus;
}

/* ── hospital profile (B1) ── */

export type OwnershipType = "government" | "private" | "trust" | "charitable" | "corporate";

/** The hospital's own official identity — a singleton per hospital. Every field is optional. */
export interface HospitalProfile {
  legalName?: string;
  registrationNumber?: string;
  taxId?: string;
  accreditations?: string[];
  establishedYear?: number;
  ownershipType?: OwnershipType;
  licensedBeds?: number;
  address?: string;
  officialEmail?: string;
  officialPhone?: string;
  website?: string;
  headName?: string;
  headTitle?: string;
}

/* ── Vitals ─────────────────────────────────────────────────────────────────── */

export const TRIAGE_LEVELS = ["routine", "urgent", "critical"] as const;
export type TriageLevel = (typeof TRIAGE_LEVELS)[number];

/** The measurable fields of a reading, in the order a chart reads them. */
export const VITAL_FIELDS = [
  "systolic",
  "diastolic",
  "pulse",
  "respiratoryRate",
  "temperature",
  "spo2",
  "weightKg",
  "heightCm",
  "painScore",
] as const;
export type VitalField = (typeof VITAL_FIELDS)[number];

/** Where a measurement sits against its ADULT reference range. Advisory only — never blocking. */
export type VitalFlag = "low" | "normal" | "high";

/** What the caller sends. Every measurement is optional; at least one must be present. */
export interface RecordVitalsInput extends Partial<Record<VitalField, number>> {
  triageLevel?: TriageLevel;
  notes?: string;
  /** ISO date-time. Omit for "now"; supply it to catch a paper chart up. */
  recordedAt?: string;
}

/**
 * One charted set of observations, with the API's assessment of it.
 *
 * Units are fixed: temperature °C, weight kg, height cm, BP mmHg. `flags` and `bmi` are DERIVED
 * by the API so the ranges live in exactly one place — never re-implement them in a client.
 */
export interface VitalsReading extends Partial<Record<VitalField, number>> {
  id: string;
  encounterId: string;
  patientId: string;
  triageLevel?: TriageLevel;
  notes?: string;
  recordedBy: string;
  recordedAt: string;
  flags: Partial<Record<VitalField, VitalFlag>>;
  /** True when any recorded value is outside its adult reference range. */
  abnormal: boolean;
  bmi?: number;
}

/** A diagnostic report file's metadata (never its bytes). */
export interface ReportMeta {
  id: string;
  orderId: string;
  encounterId: string;
  patientId: string;
  episodeId: string;
  category: string;
  testName: string;
  visitDate: string;
  filename: string;
  contentType: string;
  size: number;
  uploadedBy: string;
  uploadedAt: string;
}

/** How a patient document is filed (Module A7). */
export type DocumentCategory =
  | "id_proof"
  | "consent"
  | "insurance"
  | "referral"
  | "discharge"
  | "clinical_image"
  | "external_record"
  | "other";

/** A patient document's metadata (never its bytes). */
export interface DocumentMeta {
  id: string;
  patientId: string;
  encounterId?: string;
  category: DocumentCategory;
  title: string;
  filename: string;
  contentType: string;
  size: number;
  uploadedBy: string;
  uploadedAt: string;
}

export interface RegisterPatientInput {
  name: string;
  gender?: Gender;
  dob?: string;
  bloodGroup?: string;
  branchId?: string;
  contact?: { phone?: string; email?: string };
  address?: Record<string, string | undefined>;
  /** Overrides a duplicate warning. Requires `patient:merge` server-side. */
  force?: boolean;
}

/** One record the MPI thinks might be the same person, and why (mpi.ts). */
export interface DuplicateCandidate {
  patient: Patient;
  /** 0–100. At or above 60 the API refuses to register without `force`. */
  score: number;
  /** "phone", "name", "date of birth", "gender" — shown to the clerk, never hidden. */
  matchedOn: string[];
}

export interface RegisterPatientResult {
  patient: Patient;
  /** Near-misses BELOW the block threshold. Shown as a hint, not enforced. */
  possibleDuplicates: DuplicateCandidate[];
}

/* ── appointments (Doc 02 E1) ── */

export type AppointmentStatus =
  | "requested"
  | "confirmed"
  | "checked_in"
  | "in_consultation"
  | "completed"
  | "cancelled"
  | "no_show"
  | "rescheduled";

export interface Appointment {
  id: string;
  patientId: string;
  doctorId: string;
  branchId?: string;
  startAt: string;
  endAt: string;
  status: AppointmentStatus;
  reason?: string;
  /** Assigned at CHECK-IN, in arrival order — not at booking. */
  /**
   * The Encounter this appointment became at check-in (ADR-0013). The TOKEN lives on
   * the encounter — a walk-in has a token and no appointment.
   */
  encounterId?: string;
  /** Set on the retired appointment when it was rescheduled. */
  rescheduledTo?: string;
  createdAt: string;
}

/** A bookable slot. Computed per day from the doctor's weekly template — never stored. */
export interface Slot {
  startAt: string;
  endAt: string;
}

export interface DoctorSchedule {
  id: string;
  doctorId: string;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  /** Minutes from local midnight. 540 = 09:00. */
  startMinute: number;
  endMinute: number;
  slotMinutes: number;
  active: boolean;
}

/* ── encounters (ADR-0013) — THE CENTRAL CLINICAL OBJECT ──────────────────── */

export type EncounterStatus =
  | "planned"
  | "arrived"
  | "in_queue"
  | "in_progress"
  | "awaiting_results"
  | "closed"
  | "cancelled"
  | "left_without_being_seen"
  | "admitted";

export type EncounterOrigin =
  | "appointment"
  | "walk_in"
  | "emergency"
  | "referral"
  | "camp"
  | "telemedicine"
  | "corporate"
  | "transfer";

/**
 * One visit. Everything clinical hangs off this — notes, orders, charges.
 *
 * An Appointment is one ORIGIN of an encounter, never the other way round: a walk-in
 * has a token and no appointment, and in a government hospital that is every patient.
 */
export interface Encounter {
  id: string;
  patientId: string;
  episodeId: string;
  origin: EncounterOrigin;
  class: "OP" | "IP" | "ER" | "TELE" | "HOME";
  status: EncounterStatus;
  appointmentId?: string;
  doctorId?: string;
  departmentId?: string;
  /** The number the patient is called by. Lives HERE, not on the appointment. */
  token?: number;
  /** A paid fast-track OP visit — sorts above normal patients in the doctor's queue. */
  express?: boolean;
  reason?: string;
  /** The doctor's OP visit summary, for the OPD slip. */
  diagnosis?: string;
  advice?: string;
  branchId?: string;
  arrivedAt: string;
  closedAt?: string;
  /** Present when `class` is `IP`. The bed is RECORDED, not reserved — there is no
   * bed inventory, so nothing stops two patients being recorded in the same bed. */
  bed?: Bed;
  admittedAt?: string;
  dischargedAt?: string;
  /** How the inpatient stay ended — set with `dischargedAt` when an IP encounter closes. */
  disposition?: DischargeDisposition;
  /** The OP encounter this admission came out of. */
  admittedFrom?: string;
}

/** How an inpatient stay ended (see the admissions module). */
export type DischargeDisposition = "discharged" | "lama" | "absconded" | "deceased";
/** The three non-routine endings — everything except a routine `discharged`. */
export type TerminalOutcome = "lama" | "absconded" | "deceased";

export interface StartEncounterResult {
  encounter: Encounter;
  /** True when the patient was already here and we handed back their open visit. */
  resumed: boolean;
}

/* ── orders (ADR-0013 §3) — the spine between departments ─────────────────── */

export type OrderCategory =
  "lab" | "radiology" | "pharmacy" | "procedure" | "referral" | "admission" | "diet";

export type OrderPriority = "routine" | "urgent" | "stat" | "emergency";

export type OrderStatus =
  "placed" | "accepted" | "in_progress" | "completed" | "verified" | "released" | "cancelled";

export interface OrderResultValue {
  code: string;
  label: string;
  value: string;
  unit?: string;
  referenceRange?: string;
  flag?: string;
}

export interface Order {
  id: string;
  encounterId: string;
  patientId: string;
  episodeId: string;
  category: OrderCategory;
  code: string;
  name: string;
  priority: OrderPriority;
  status: OrderStatus;
  notes?: string;
  orderedBy: string;
  orderedAt: string;
  performedBy?: string;
  verifiedBy?: string;
  releasedAt?: string;
  result?: { summary?: string; values?: OrderResultValue[]; critical?: boolean };
  cancelReason?: string;
}

export interface PlaceOrderResult {
  order: Order;
  /** True when this `requestId` had already placed it — a retry, not a new order. */
  duplicate: boolean;
}

/* ── billing (F-group) ────────────────────────────────────────────────────── */

export type ChargeCategory =
  "consultation" | "lab" | "radiology" | "pharmacy" | "procedure" | "bed" | "other";

export type InvoiceStatus = "draft" | "finalized" | "paid" | "cancelled";

/**
 * ── EVERY AMOUNT IS AN INTEGER NUMBER OF PAISE ──────────────────────────────
 * ₹150.50 is 15050. Only the very edge of the UI divides by 100; nothing computes on
 * the divided number. Floats lose money, and a hospital that cannot reconcile its
 * takings to the rupee stops trusting the software.
 */
export interface InvoiceLine {
  code: string;
  description: string;
  category: ChargeCategory;
  quantity: number;
  /** Paise. What the care is WORTH — populated even when the patient owes nothing. */
  listPrice: number;
  /** Paise. What is OWED. Zero at a government hospital (`zero_tariff`). */
  amount: number;
}

/** One posted charge WITH its date — for the day-wise money on the IP treatment sheet. */
export interface EncounterCharge {
  id: string;
  code: string;
  description: string;
  category: ChargeCategory;
  quantity: number;
  listPrice: number;
  /** Paise owed. */
  amount: number;
  postedAt: string;
  invoiceId?: string;
  voided?: boolean;
}

export interface Invoice {
  id: string;
  encounterId: string;
  patientId: string;
  number?: string;
  status: InvoiceStatus;
  lines: InvoiceLine[];
  subtotal: number;
  discount: number;
  total: number;
  paid: number;
  payments: { amount: number; method: string; reference?: string; at: string }[];
  finalizedAt?: string;
}

/**
 * The per-batch billing picture for a visit: the pending (unbilled) charges plus every bill raised,
 * each with its own payment state. Amounts are PAISE.
 */
export interface EncounterBilling {
  pending: { lines: InvoiceLine[]; total: number };
  invoices: Invoice[];
  totalBilled: number;
  totalPaid: number;
  grandTotal: number;
  outstanding: number;
}

/** The running bill for a visit — computed from the ledger until it is finalized. */
export interface Bill {
  lines: InvoiceLine[];
  subtotal: number;
  total: number;
  /** Present once a bill has been frozen into a document. */
  invoice?: Invoice;
}

export interface ServiceItem {
  id: string;
  code: string;
  name: string;
  category: ChargeCategory;
  /** Paise. */
  price: number;
  active: boolean;
}

/* ── Patient wallet (advance balance) ──────────────────────────────────────── */

export type WalletEntryType = "deposit" | "debit" | "refund" | "reversal";

/** One movement of the patient's advance. `amount` is PAISE; `type` carries the sign. */
export interface WalletEntry {
  id: string;
  patientId: string;
  type: WalletEntryType;
  amount: number;
  /** Paise. The balance this movement left behind. */
  balanceAfter: number;
  method?: string;
  reference?: string;
  reason?: string;
  invoiceId?: string;
  encounterId?: string;
  by?: string;
  at: string;
}

/** The patient's advance balance and recent statement. `balance` is PAISE. */
export interface Wallet {
  patientId: string;
  balance: number;
  entries: WalletEntry[];
}

export interface WalletDepositInput {
  /** Paise. */
  amount: number;
  method: string;
  reference?: string;
  reason?: string;
  encounterId?: string;
}

export interface WalletRefundInput {
  /** Paise. */
  amount: number;
  method: string;
  reference?: string;
  reason?: string;
}

/**
 * What the hospital can DO — the order pad's view. No price, deliberately.
 *
 * A separate type rather than `Partial<ServiceItem>` so a screen cannot reach for a
 * price that was never sent: the field does not exist, and the compiler says so.
 */
export interface CatalogueItem {
  id: string;
  code: string;
  name: string;
  category: ChargeCategory;
}

/**
 * A tariff entry AS THE MANAGER SEES IT — with its price, and whether it is active. Distinct
 * from `CatalogueItem` (the doctor's price-free view) precisely because this one carries money:
 * it is only ever returned by the `tariff:manage` endpoints.
 */
export interface TariffItem {
  id: string;
  code: string;
  name: string;
  category: ChargeCategory;
  /** Paise. */
  price: number;
  /**
   * Consultation entries only: how many days this fee buys free revisits to the SAME doctor
   * ("OP validity"). Absent or 0 means every visit is charged.
   */
  followUpDays?: number;
  active: boolean;
}

export interface CreateTariffInput {
  code: string;
  name: string;
  category: ChargeCategory;
  /** Paise. */
  price: number;
  followUpDays?: number;
}
export interface UpdateTariffInput {
  name?: string;
  price?: number;
  followUpDays?: number;
  active?: boolean;
}

/* ── Reporting: the audit/register suite (needs report:view) ────────────────── */

/** A half-open period. `to` is the start of the day AFTER the chosen end date. */
export interface ReportRange {
  from: string;
  to: string;
}

/** A patient as a "my day" activity row shows them — enough to recognise and link to the chart. */
export interface ActivityPatientRef {
  id: string;
  uhid: string;
  name: string;
}

/** A clinician's OWN activity for a period (the dashboard "my day" panel). */
export interface MyActivity {
  patientsSeen: number;
  visits: {
    patient: ActivityPatientRef;
    encounterId: string;
    at: string;
    class: string;
    status: string;
  }[];
  tests: {
    patient: ActivityPatientRef;
    orderId: string;
    name: string;
    category: string;
    status: string;
    at: string;
  }[];
  prescriptions: {
    patient: ActivityPatientRef;
    prescriptionId: string;
    drugs: string[];
    at: string;
  }[];
}

export interface StockRegisterRow {
  medicineId: string;
  code: string;
  name: string;
  opening: number;
  received: number;
  /** Units handed out in the period, as a positive number. */
  dispensed: number;
  adjusted: number;
  closing: number;
}

export interface VisitReport {
  total: number;
  byClass: { key: string; count: number }[];
  byOrigin: { key: string; count: number }[];
  byMonth: { month: string; count: number }[];
}

export interface DoctorLoadRow {
  doctorId: string;
  doctorName: string;
  patients: number;
}

export interface DiagnosticsReport {
  total: number;
  performed: number;
  byCategory: { category: string; ordered: number; performed: number }[];
  byPerformer: { performedBy: string; performerName: string; performed: number }[];
}

export interface CollectionsReport {
  /** Paise. Direct counter collections — EXCLUDES bills settled from advance. */
  total: number;
  count: number;
  byMonth: { month: string; amount: number; count: number }[];
  byMethod: { method: string; amount: number; count: number }[];
  /** Paise. Bills settled from advance in the period — shown apart so it is not double-counted. */
  settledFromAdvance: number;
}

/** A row of the advance register broken down by how the advance was collected. */
export interface WalletMethodRow {
  method: string;
  amount: number;
  count: number;
}

/**
 * The advance (wallet) register for a period. Amounts are PAISE.
 *
 * `deposits`/`refunds` are real money movements at the counter; `utilized` is advance APPLIED to
 * bills (a transfer, not new income); `outstandingHeld` is the advance the hospital holds right
 * now across all patients — a liability, point-in-time rather than period-bound.
 */
export interface WalletRegister {
  deposits: { total: number; count: number; byMethod: WalletMethodRow[] };
  refunds: { total: number; count: number; byMethod: WalletMethodRow[] };
  utilized: { total: number; count: number };
  outstandingHeld: number;
}

/** One row of the receipts register — a bill payment or an advance deposit taken in the period. */
export interface ReceiptRow {
  kind: "bill" | "advance";
  /** The id to reprint by: an invoice id for a bill, a wallet-entry id for an advance. */
  refId: string;
  receiptNo: string;
  patientId: string;
  patientName: string;
  uhid: string;
  /** Paise received. */
  amount: number;
  method?: string;
  at: string;
}

/** How inpatient stays ended in the period — the discharge / mortality register. */
export interface DischargeRegister {
  total: number;
  byDisposition: { key: string; count: number }[];
  byMonth: { month: string; count: number }[];
}

/* ── Prescriptions & pharmacy (STATE_MACHINE_CATALOG §6) ──────────────────── */

export const DRUG_ROUTES = [
  "oral",
  "iv",
  "im",
  "sc",
  "sublingual",
  "topical",
  "inhaled",
  "rectal",
  "ophthalmic",
  "otic",
  "nasal",
] as const;
export type DrugRoute = (typeof DRUG_ROUTES)[number];

export const DRUG_FREQUENCIES = [
  "OD",
  "BD",
  "TDS",
  "QID",
  "HS",
  "SOS",
  "STAT",
  "Q4H",
  "Q6H",
  "Q8H",
  "WEEKLY",
] as const;
export type DrugFrequency = (typeof DRUG_FREQUENCIES)[number];

export type PrescriptionStatus =
  "draft" | "signed" | "partially_dispensed" | "dispensed" | "discarded" | "cancelled";

export interface PrescriptionLine {
  drugCode: string;
  drugName: string;
  dose: string;
  route: DrugRoute;
  frequency: DrugFrequency;
  durationDays?: number;
  /** How many units the doctor authorised. */
  quantity: number;
  /** How many have actually been handed over. The gap is what the pharmacy still owes. */
  dispensedQty: number;
  instructions?: string;
}

export interface Prescription {
  id: string;
  encounterId: string;
  patientId: string;
  episodeId: string;
  status: PrescriptionStatus;
  lines: PrescriptionLine[];
  prescribedBy: string;
  prescribedAt: string;
  signedBy?: string;
  signedAt?: string;
  /** The `pharmacy` order this raised. Absent when the hospital dispenses externally. */
  orderId?: string;
  version: number;
  supersedesId?: string;
  supersededById?: string;
  cancelReason?: string;
  notes?: string;
  /** Present only when the prescriber signed THROUGH a blocking safety alert. */
  safetyOverride?: {
    reason: string;
    by: string;
    at: string;
    alerts: SafetyAlert[];
  };
}

export type SafetyAlertKind = "allergy" | "cross_sensitivity" | "duplicate_therapy" | "interaction";
export type SafetyAlertSeverity = "contraindicated" | "major" | "moderate";

/** One finding from the prescribing safety screen. `contraindicated` is the only one that blocks. */
export interface SafetyAlert {
  kind: SafetyAlertKind;
  severity: SafetyAlertSeverity;
  drugCodes: string[];
  allergen?: string;
  message: string;
}

export interface PrescriptionScreening {
  prescriptionId: string;
  alerts: SafetyAlert[];
  /** True when at least one alert is a contraindication — signing needs an override reason. */
  blocking: boolean;
}

/** What the doctor types. No `dispensedQty` — only the pharmacy may move that. */
export interface PrescriptionLineInput {
  drugCode: string;
  drugName: string;
  dose: string;
  route: DrugRoute;
  frequency: DrugFrequency;
  durationDays?: number;
  quantity: number;
  instructions?: string;
}

export interface DispenseLine {
  lineIndex: number;
  drugCode: string;
  drugName: string;
  quantity: number;
}

export interface Dispense {
  id: string;
  prescriptionId: string;
  encounterId: string;
  patientId: string;
  episodeId: string;
  orderId?: string;
  lines: DispenseLine[];
  dispensedBy: string;
  dispensedAt: string;
}

export interface DispenseResult {
  dispense: Dispense;
  prescription: Prescription;
  /** True when this `requestId` had already handed the drugs over. */
  duplicate: boolean;
}

/* ── Pharmacy medicine master & stock (module.pharmacy.full) ───────────────── */

export const MEDICINE_FORMS = [
  "tablet",
  "capsule",
  "syrup",
  "injection",
  "ointment",
  "drops",
  "inhaler",
  "sachet",
  "other",
] as const;
export type MedicineForm = (typeof MEDICINE_FORMS)[number];

/** A medicine as the master holds it — the brand, what it is, how it is packed, what is left. */
export interface Medicine {
  id: string;
  code: string;
  name: string;
  manufacturer?: string;
  /** The salt / combination — what it clinically is. */
  generic?: string;
  form: MedicineForm;
  strength?: string;
  /** Tablets (or units) per strip. */
  unitsPerSheet?: number;
  /** Strips per pack. Reporting only — stock is always in base units. */
  sheetsPerPack?: number;
  /** Current balance in base units, mirrored from the stock ledger. */
  stockUnits: number;
  /** Below this the stock report calls it low. Zero means no alert. */
  reorderLevel: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/** How the stock report reads a medicine's position. */
export type StockStatus = "ok" | "low" | "out" | "reconcile";
export interface StockReportRow extends Medicine {
  status: StockStatus;
}

export type StockMovementKind = "receipt" | "dispense" | "adjustment";

/** One line of the stock ledger — a unit's worth of history. */
export interface StockMovement {
  id: string;
  medicineId: string;
  medicineCode: string;
  kind: StockMovementKind;
  /** Signed base units: + in, − out. */
  delta: number;
  balanceAfter: number;
  batchNo?: string;
  expiry?: string;
  reason?: string;
  dispenseId?: string;
  createdBy: string;
  createdAt: string;
}

export interface CreateMedicineInput {
  code: string;
  name: string;
  manufacturer?: string;
  generic?: string;
  form: MedicineForm;
  strength?: string;
  unitsPerSheet?: number;
  sheetsPerPack?: number;
  reorderLevel?: number;
}

export type UpdateMedicineInput = Partial<Omit<CreateMedicineInput, "code">> & { active?: boolean };

export interface StockMoveResult {
  medicine: Medicine;
  movement: StockMovement;
}

/* ── Admissions (ADR-0013 §4) ─────────────────────────────────────────────── */

export interface Bed {
  ward: string;
  bedCode: string;
  /** The tariff the bed-day is billed at — `BED_GEN`, `BED_ICU`. */
  tariffCode: string;
  /** The inventory bed (B4) this stay occupies, when admitted from the catalogue. */
  bedId?: string;
}

export type WardNoteType = "progress" | "discharge_summary" | "outcome_note";

export interface WardNote {
  id: string;
  encounterId: string;
  patientId: string;
  episodeId: string;
  type: WardNoteType;
  text: string;
  diagnosis?: string;
  advice?: string;
  followUpOn?: string;
  authorId: string;
  at: string;
}

export interface AdmitResult {
  /** The OP encounter, now `admitted` — terminal. */
  outpatient: Encounter;
  /** The new INPATIENT encounter, in the SAME episode. */
  inpatient: Encounter;
}

/* ── Bed inventory & board (Module B4) ─────────────────────────────────────── */

export type WardKind =
  | "general"
  | "semi_private"
  | "private"
  | "icu"
  | "nicu"
  | "picu"
  | "hdu"
  | "maternity"
  | "emergency"
  | "isolation"
  | "daycare";
export type WardStatus = "active" | "inactive";
export type BedStatus = "available" | "blocked";

export interface Ward {
  id: string;
  name: string;
  kind: WardKind;
  /** The default bed-day tariff for beds in this ward. */
  tariffCode: string;
  status: WardStatus;
  branchId?: string;
}

/** A catalogue bed, joined to its ward. `tariffCode` is the effective one (bed's, or its ward's). */
export interface InventoryBed {
  id: string;
  wardId: string;
  code: string;
  room?: string;
  tariffCode: string;
  status: BedStatus;
  blockedReason?: string;
  branchId?: string;
  wardName: string;
  wardKind: WardKind;
  wardStatus: WardStatus;
}

export interface BedBoardOccupant {
  encounterId: string;
  patientId: string;
  patientName: string;
  uhid: string;
  admittedAt?: string;
  doctorId?: string;
}

export interface BedBoardBed {
  bedId: string;
  code: string;
  room?: string;
  tariffCode: string;
  state: "free" | "occupied" | "blocked";
  blockedReason?: string;
  occupant?: BedBoardOccupant;
}

export interface BedBoardWard {
  wardId: string;
  name: string;
  kind: WardKind;
  status: WardStatus;
  tariffCode: string;
  beds: BedBoardBed[];
  counts: { total: number; free: number; occupied: number; blocked: number };
}

/** An open stay whose bed is not in the catalogue — a legacy free-text admission. */
export interface BedBoardUnlisted {
  encounterId: string;
  patientId: string;
  patientName: string;
  uhid: string;
  ward: string;
  bedCode: string;
  admittedAt?: string;
}

export interface BedBoard {
  wards: BedBoardWard[];
  totals: { total: number; free: number; occupied: number; blocked: number };
  unlisted: BedBoardUnlisted[];
}

export interface OperatorSession {
  accessToken: string;
  expiresIn: number;
  operator: {
    id: string;
    email: string;
    name: string;
    roles: PlatformRole[];
    mustChangePassword: boolean;
  };
}

/** Runtime licence state for the console (ADR-0016). */
export type LicenseRuntimeState = "ACTIVE" | "GRACE" | "EXPIRED" | "EXPIRING" | "PERPETUAL";

export interface HospitalLicense {
  state: LicenseRuntimeState;
  /** ISO expiry; absent when perpetual. */
  expiresAt?: string;
  /** ACTIVE: days to expiry. GRACE: days until access is cut. EXPIRED: 0. Perpetual: null. */
  daysRemaining: number | null;
  plan?: string;
}

export interface Hospital {
  id: string;
  slug: string;
  hospitalName: string;
  status: "provisioning" | "trial" | "active" | "suspended" | "terminated";
  planCode?: string;
  databaseName: string;
  /** Supported branches (ADR-0015). Absent ⇒ single-site (1). */
  maxBranches?: number;
  /** Custom domain (ADR-0005), when attached. */
  customDomain?: string;
  /** Tenure (ADR-0016) — perpetual when no expiry is set. */
  license: HospitalLicense;
  /** Where this hospital is reachable — assembled by the API so no UI has to guess. */
  url: string;
}

export interface HospitalDetail extends Hospital {
  usage: { metric: string; used: number; limit?: number; warning?: boolean; exceeded?: boolean }[];
  features: string[];
}

export interface Edition {
  code: string;
  name: string;
  entitlements: string[];
  limits: Record<string, number | undefined>;
}

export interface OperatorAuditEntry {
  id: string;
  at: string;
  actorEmail?: string;
  action: string;
  tenantSlug?: string;
  outcome: "success" | "failure";
  meta?: Record<string, unknown>;
  ip?: string;
}

/** Parse the licence headers off a response, or null when the response carried none. */
function readLicenseHeader(res: { headers: Headers }): LicenseHeader | null {
  const state = res.headers.get("x-license-state");
  if (state !== "ACTIVE" && state !== "EXPIRING" && state !== "GRACE") return null;
  const raw = res.headers.get("x-license-days-left");
  const days = raw != null && raw !== "" ? Number(raw) : null;
  return { state, daysLeft: Number.isFinite(days) ? days : null };
}

/* ── the client ───────────────────────────────────────────────────────────── */

export class ApiClient {
  private readonly baseUrl: string;
  private readonly getAccessToken?: () => string | undefined;
  private readonly credentials: RequestCredentials;
  private readonly tenantHost?: string;
  private readonly getActiveBranch?: () => string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly onUnauthorized?: () => Promise<boolean>;
  private readonly onLicenseState?: (state: LicenseHeader | null) => void;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.getAccessToken = options.getAccessToken;
    this.credentials = options.credentials ?? "include";
    this.tenantHost = options.tenantHost;
    this.getActiveBranch = options.getActiveBranch;
    this.onUnauthorized = options.onUnauthorized;
    this.onLicenseState = options.onLicenseState;

    /**
     * `.bind(globalThis)` is not defensive style — it is the difference between
     * this client working in a browser and not working at all.
     *
     * `fetch` stored bare and later invoked as `this.fetchImpl(...)` is called
     * with `this` = the ApiClient instance. The browser's `fetch` is a method of
     * `Window` and refuses any other receiver:
     *
     *     TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation
     *
     * The request is then NEVER SENT — no network entry, no server log, nothing
     * to find. And because a TypeError is not an ApiClientError, the UI reported
     * it as "could not reach the server", which sent us hunting through DNS,
     * ports, CORS and IPv6 for a bug that lived in this one line.
     *
     * Node's `fetch` is a plain function with no receiver requirement, so every
     * test, every curl and every server-side check passed while the browser was
     * broken 100% of the time. That asymmetry is the lesson: **a client that only
     * runs in a browser must be tested in a browser.**
     */
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * The unauthenticated auth endpoints. A 401 from these is the answer itself (bad password,
   * a dead refresh token), never a "your session expired mid-action" — so the interceptor
   * must skip them, both to avoid recursing on the refresh call and to leave the login form's
   * own error handling intact.
   */
  private isAuthEndpoint(path: string): boolean {
    return /\/api\/v1\/auth\/(login|refresh|mfa|forgot-password|reset-password)\b/.test(path);
  }

  private async send<T>(
    method: string,
    path: string,
    body?: unknown,
    retry = true,
  ): Promise<{ data: T; meta?: PageMeta }> {
    const token = this.getAccessToken?.();

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    if (this.tenantHost) headers.host = this.tenantHost;
    // The branch this request acts in (ADR-0015). Absent ⇒ the server treats it as aggregate mode.
    const activeBranch = this.getActiveBranch?.();
    if (activeBranch) headers["x-active-branch"] = activeBranch;

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      credentials: this.credentials,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });

    // Licence state rides on EVERY tenant response (ADR-0016); surface it so the UI can
    // show a renewal banner without a dedicated poll. Absent ⇒ perpetual / non-tenant call.
    if (this.onLicenseState) this.onLicenseState(readLicenseHeader(res));

    let envelope: ApiEnvelope<T>;
    try {
      envelope = (await res.json()) as ApiEnvelope<T>;
    } catch {
      // A non-JSON body means we never reached the API (wrong port, gateway,
      // proxy error page). Saying that beats "unexpected token < in JSON".
      throw new ApiClientError(
        res.status,
        "HMS-GEN-500",
        `The API did not return a valid response (HTTP ${String(res.status)}). Is it running?`,
      );
    }

    if (!res.ok || !envelope.success) {
      const err = envelope.error;
      const error = new ApiClientError(
        res.status,
        err?.code ?? "HMS-GEN-500",
        err?.message ?? "Request failed",
        err?.details,
        err?.traceId,
      );

      // Session expired mid-action: give the app one chance to refresh silently and replay
      // this request, so the user never sees a "could not load" on a screen they were using.
      if (error.isUnauthenticated && retry && this.onUnauthorized && !this.isAuthEndpoint(path)) {
        const recovered = await this.onUnauthorized();
        if (recovered) return this.send<T>(method, path, body, false);
      }

      throw error;
    }

    return { data: envelope.data as T, ...(envelope.meta ? { meta: envelope.meta } : {}) };
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await this.send<T>(method, path, body)).data;
  }

  private async paged<T>(path: string): Promise<Paged<T>> {
    const { data, meta } = await this.send<T[]>("GET", path);
    return { items: data, meta: meta ?? { page: 1, limit: data.length, total: data.length } };
  }

  health(): Promise<{ status: string; service: string; version: string; uptimeSeconds: number }> {
    return this.request("GET", "/health");
  }

  /** Readiness — dependencies reachable. Used by the admin console's status card. */
  ready(): Promise<{ status: string; service: string; checks: Record<string, string> }> {
    return this.request("GET", "/ready");
  }

  /* ── auth (ADR-0009) ── */

  login(email: string, password: string, device?: string): Promise<LoginResult> {
    return this.request<LoginResult>("POST", "/api/v1/auth/login", { email, password, device });
  }

  verifyMfa(mfaToken: string, code: string): Promise<TokenPair> {
    return this.request<TokenPair>("POST", "/api/v1/auth/mfa/verify", { mfaToken, code });
  }

  /**
   * Begins a password reset — emails a single-use link if the address belongs to an account. The
   * response is intentionally the same either way (no account enumeration), so callers must NOT
   * infer existence from it.
   */
  forgotPassword(email: string): Promise<{ message: string }> {
    return this.request<{ message: string }>("POST", "/api/v1/auth/forgot-password", { email });
  }

  /** Completes a reset from the emailed token. On success, every existing session is revoked. */
  resetPassword(token: string, newPassword: string): Promise<{ passwordReset: boolean }> {
    return this.request<{ passwordReset: boolean }>("POST", "/api/v1/auth/reset-password", {
      token,
      newPassword,
    });
  }

  /**
   * Exchanges a refresh token for a fresh access token.
   *
   * With no argument it relies on the httpOnly refresh COOKIE — the production web flow, where
   * the token is deliberately unreadable by JavaScript. When a `refreshToken` is passed it rides
   * in the BODY instead, which the API prefers over the cookie: that is the native-client path,
   * and it is also how the dev web app gives each browser TAB its own session (a cookie is shared
   * across tabs; a body token held in that tab's sessionStorage is not).
   */
  refresh(refreshToken?: string): Promise<TokenPair> {
    return this.request<TokenPair>(
      "POST",
      "/api/v1/auth/refresh",
      refreshToken ? { refreshToken } : {},
    );
  }

  logout(): Promise<{ loggedOut: boolean }> {
    return this.request("POST", "/api/v1/auth/logout", {});
  }

  me(): Promise<AuthenticatedUser> {
    return this.request<AuthenticatedUser>("GET", "/api/v1/auth/me");
  }

  changePassword(currentPassword: string, newPassword: string): Promise<unknown> {
    return this.request("POST", "/api/v1/auth/change-password", { currentPassword, newPassword });
  }

  sessions(): Promise<Session[]> {
    return this.request<Session[]>("GET", "/api/v1/auth/sessions");
  }

  revokeSession(id: string): Promise<unknown> {
    return this.request("DELETE", `/api/v1/auth/sessions/${id}`);
  }

  /* ── staff directory ── */

  listStaff(
    params: {
      page?: number;
      limit?: number;
      q?: string;
      status?: StaffMember["status"];
    } = {},
  ): Promise<Paged<StaffMember>> {
    const query = new URLSearchParams();
    if (params.page) query.set("page", String(params.page));
    if (params.limit) query.set("limit", String(params.limit));
    if (params.q) query.set("q", params.q);
    if (params.status) query.set("status", params.status);
    const qs = query.toString();
    return this.paged<StaffMember>(`/api/v1/users${qs ? `?${qs}` : ""}`);
  }

  getStaff(id: string): Promise<StaffMember> {
    return this.request<StaffMember>("GET", `/api/v1/users/${id}`);
  }

  createStaff(input: {
    email: string;
    name: string;
    phone?: string;
    employeeId?: string;
    roles?: string[];
    profile?: StaffProfile;
  }): Promise<CreateStaffResult> {
    return this.request<CreateStaffResult>("POST", "/api/v1/users", input);
  }

  updateStaff(
    id: string,
    input: { name?: string; phone?: string; employeeId?: string; profile?: StaffProfile },
  ): Promise<StaffMember> {
    return this.request<StaffMember>("PATCH", `/api/v1/users/${id}`, input);
  }

  /**
   * Sets which BRANCHES a staff member works in, for one role (ADR-0015). Needs `user:assign-role`.
   *
   * An EMPTY `branchIds` means "all branches" (a hospital-wide binding); a non-empty list confines
   * them to exactly those sites. Re-assigning the same role updates the binding, so this is how a
   * receptionist is moved from one branch to another.
   */
  assignStaffRole(userId: string, roleCode: string, branchIds: string[]): Promise<void> {
    return this.request<void>("POST", `/api/v1/users/${userId}/roles`, { roleCode, branchIds });
  }

  /**
   * Who a patient can be sent to. Needs `encounter:read`, NOT `user:read`.
   *
   * The front desk must be able to pick a doctor without being handed every
   * colleague's email and MFA status. Use this for any doctor picker; `listStaff` is
   * for the staff-administration screen and nothing else.
   */
  listDoctors(): Promise<DoctorRef[]> {
    return this.request<DoctorRef[]>("GET", "/api/v1/doctors");
  }

  /** One doctor's card (name, qualification, signature) — for the OPD slip. Needs `encounter:read`. */
  getDoctor(id: string): Promise<DoctorCard> {
    return this.request<DoctorCard>("GET", `/api/v1/doctors/${id}`);
  }

  setStaffStatus(id: string, status: "active" | "disabled"): Promise<StaffMember> {
    return this.request<StaffMember>("POST", `/api/v1/users/${id}/status`, { status });
  }

  resetStaffPassword(id: string): Promise<{ temporaryPassword?: string }> {
    return this.request("POST", `/api/v1/users/${id}/reset-password`, {});
  }

  /* ── Public site ──────────────────────────────────────────────────────────── */

  /** PUBLIC — the hospital's website content. No auth; resolved from the host. */
  getPublicSite(): Promise<PublicSite> {
    return this.request<PublicSite>("GET", "/api/v1/site");
  }

  /** Admin — the saved site fields, for the editor. Needs `branding:manage`. */
  getSiteSettings(): Promise<EditableSite> {
    return this.request<EditableSite>("GET", "/api/v1/site/settings");
  }

  /** Admin — save site edits. Needs `branding:manage`. */
  updateSiteSettings(input: UpdateSiteInput): Promise<EditableSite> {
    return this.request<EditableSite>("PATCH", "/api/v1/site/settings", input);
  }

  /** Admin — upload/replace the hospital logo (A8). Needs `branding:manage`. */
  uploadSiteLogo(input: {
    contentType: string;
    dataBase64: string;
  }): Promise<{ uploaded: boolean }> {
    return this.request("PUT", "/api/v1/site/logo", input);
  }

  /** Admin — remove the hospital logo. Needs `branding:manage`. */
  deleteSiteLogo(): Promise<{ deleted: boolean }> {
    return this.request("DELETE", "/api/v1/site/logo");
  }

  /* ── API keys (A9) — need `apikey:manage` ─────────────────────────────────── */

  listApiKeys(): Promise<ApiKeyMeta[]> {
    return this.request<ApiKeyMeta[]>("GET", "/api/v1/api-keys");
  }

  /** Creates a key. The full `key` in the result is shown ONCE — it is never returned again. */
  createApiKey(input: { name: string; expiresOn?: string }): Promise<CreatedApiKey> {
    return this.request<CreatedApiKey>("POST", "/api/v1/api-keys", input);
  }

  revokeApiKey(id: string): Promise<ApiKeyMeta> {
    return this.request<ApiKeyMeta>("DELETE", `/api/v1/api-keys/${id}`);
  }

  /**
   * PUBLIC — the hospital's logo bytes as a Blob (A8), or `null` when none is set. Fetched (not
   * plain-linked) so the tenant host header reaches the API in local dev, the same reason
   * `fetchReportBlob` exists. The caller turns it into an object URL for an `<img>`.
   */
  async fetchSiteLogoBlob(): Promise<Blob | null> {
    const headers: Record<string, string> = {};
    if (this.tenantHost) headers.host = this.tenantHost;
    const res = await this.fetchImpl(`${this.baseUrl}/api/v1/site/logo`, {
      method: "GET",
      headers,
      credentials: this.credentials,
      cache: "no-store",
    });
    if (res.status === 404) return null;
    if (!res.ok) return null;
    return res.blob();
  }

  /* ── patients (Doc 02 C1) ── */

  listPatients(
    params: { page?: number; limit?: number; q?: string; status?: PatientStatus } = {},
  ): Promise<Paged<Patient>> {
    const query = new URLSearchParams();
    if (params.page) query.set("page", String(params.page));
    if (params.limit) query.set("limit", String(params.limit));
    if (params.q) query.set("q", params.q);
    if (params.status) query.set("status", params.status);
    const qs = query.toString();
    return this.paged<Patient>(`/api/v1/patients${qs ? `?${qs}` : ""}`);
  }

  getPatient(id: string): Promise<Patient> {
    return this.request<Patient>("GET", `/api/v1/patients/${id}`);
  }

  /**
   * Registers a patient. Throws `ApiClientError` with `code === "HMS-PAT-002"`
   * when the MPI thinks this person is already here — the caller is expected to
   * show `details.candidates` and let a human decide, NOT to silently retry with
   * `force`. That is the whole reason the API refuses instead of guessing.
   */
  registerPatient(input: RegisterPatientInput): Promise<RegisterPatientResult> {
    return this.request<RegisterPatientResult>("POST", "/api/v1/patients", input);
  }

  updatePatient(id: string, input: Partial<RegisterPatientInput>): Promise<Patient> {
    return this.request<Patient>("PATCH", `/api/v1/patients/${id}`, input);
  }

  /** A patient's allergies — active and refuted. Read hospital-wide, never branch-scoped. */
  listAllergies(patientId: string): Promise<Allergy[]> {
    return this.request<Allergy[]>("GET", `/api/v1/patients/${patientId}/allergies`);
  }

  recordAllergy(
    patientId: string,
    input: { allergen: string; severity?: AllergySeverity; reaction?: string },
  ): Promise<Allergy> {
    return this.request<Allergy>("POST", `/api/v1/patients/${patientId}/allergies`, input);
  }

  /** Rules an allergy out. It stops firing the prescribing check but stays on the record. */
  refuteAllergy(id: string, reason: string): Promise<Allergy> {
    return this.request<Allergy>("POST", `/api/v1/allergies/${id}/refute`, { reason });
  }

  /* ── branches (ADR-0015) ── */

  /** The branches the signed-in user may act in, for the switcher. Self-service (no permission). */
  listMyBranches(): Promise<MyBranches> {
    return this.request<MyBranches>("GET", "/api/v1/me/branches");
  }

  /** Every branch of the hospital — the admin list. Needs `branch:manage`. */
  listBranches(): Promise<Branch[]> {
    return this.request<Branch[]>("GET", "/api/v1/branches");
  }

  /** Creates a branch (enforces the tenant's branch cap). Needs `branch:manage`. */
  createBranch(input: CreateBranchInput): Promise<Branch> {
    return this.request<Branch>("POST", "/api/v1/branches", input);
  }

  /** Edits a branch — rename, deactivate, contact details. Needs `branch:manage`. */
  updateBranch(id: string, input: UpdateBranchInput): Promise<Branch> {
    return this.request<Branch>("PATCH", `/api/v1/branches/${id}`, input);
  }

  /* ── departments (B2/B3) ── */

  /** Every department of the hospital, each with its parent's name. Needs `patient:read`. */
  listDepartments(): Promise<Department[]> {
    return this.request<Department[]>("GET", "/api/v1/departments");
  }

  /** Creates a department (optionally under a parent). Needs `department:manage`. */
  createDepartment(input: CreateDepartmentInput): Promise<Department> {
    return this.request<Department>("POST", "/api/v1/departments", input);
  }

  /** Edits a department — rename, re-parent, deactivate. Needs `department:manage`. */
  updateDepartment(id: string, input: UpdateDepartmentInput): Promise<Department> {
    return this.request<Department>("PATCH", `/api/v1/departments/${id}`, input);
  }

  /* ── operation theatres (B5) ── */

  /** The operation-theatre registry. Needs `emr:read` + the OT module. */
  listTheatres(): Promise<Theatre[]> {
    return this.request<Theatre[]>("GET", "/api/v1/theatres");
  }

  /** Registers a theatre. Needs `facility:manage` + the OT module. */
  createTheatre(input: CreateTheatreInput): Promise<Theatre> {
    return this.request<Theatre>("POST", "/api/v1/theatres", input);
  }

  /** Edits a theatre — rename, retire. Needs `facility:manage` + the OT module. */
  updateTheatre(id: string, input: UpdateTheatreInput): Promise<Theatre> {
    return this.request<Theatre>("PATCH", `/api/v1/theatres/${id}`, input);
  }

  /** The OT board — bookings intersecting a day window (defaults to today). Needs `emr:read`. */
  listOtBookings(query: ListBookingsQuery = {}): Promise<OtBooking[]> {
    const qs = new URLSearchParams(
      Object.entries(query).filter(([, v]) => v != null) as [string, string][],
    ).toString();
    return this.request<OtBooking[]>("GET", `/api/v1/ot-bookings${qs ? `?${qs}` : ""}`);
  }

  /** Books a procedure on a theatre (rejects window overlaps). Needs `ot:schedule`. */
  createOtBooking(input: CreateBookingInput): Promise<OtBooking> {
    return this.request<OtBooking>("POST", "/api/v1/ot-bookings", input);
  }

  /** Moves a booking along its lifecycle (start/complete/cancel). Needs `ot:schedule`. */
  transitionOtBooking(
    id: string,
    input: { to: OtBookingStatus; reason?: string },
  ): Promise<OtBooking> {
    return this.request<OtBooking>("POST", `/api/v1/ot-bookings/${id}/transition`, input);
  }

  /* ── hospital profile (B1) ── */

  /** The hospital's own official identity. Needs `hospital:manage`. */
  getHospitalProfile(): Promise<HospitalProfile> {
    return this.request<HospitalProfile>("GET", "/api/v1/hospital-profile");
  }

  /** Saves the hospital profile (upsert; blank fields are cleared). Needs `hospital:manage`. */
  saveHospitalProfile(input: HospitalProfile): Promise<HospitalProfile> {
    return this.request<HospitalProfile>("PUT", "/api/v1/hospital-profile", input);
  }

  /* ── ambulance fleet (B6) ── */

  /** The ambulance fleet — the vehicles a dispatch picks from. Needs `ambulance:dispatch`. */
  listAmbulances(): Promise<Ambulance[]> {
    return this.request<Ambulance[]>("GET", "/api/v1/ambulances");
  }

  /** Registers a vehicle. Needs `ambulance:manage` + the ambulance module. */
  createAmbulance(input: CreateAmbulanceInput): Promise<Ambulance> {
    return this.request<Ambulance>("POST", "/api/v1/ambulances", input);
  }

  /** Edits a vehicle — rename, re-plate, retire. Needs `ambulance:manage`. */
  updateAmbulance(id: string, input: UpdateAmbulanceInput): Promise<Ambulance> {
    return this.request<Ambulance>("PATCH", `/api/v1/ambulances/${id}`, input);
  }

  /** The dispatch board — trips intersecting a day window (defaults to today). Needs `ambulance:dispatch`. */
  listAmbulanceTrips(query: ListTripsQuery = {}): Promise<AmbulanceTrip[]> {
    const qs = new URLSearchParams(
      Object.entries(query).filter(([, v]) => v != null) as [string, string][],
    ).toString();
    return this.request<AmbulanceTrip[]>("GET", `/api/v1/ambulance-trips${qs ? `?${qs}` : ""}`);
  }

  /** Dispatches a vehicle on a trip (rejects window overlaps). Needs `ambulance:dispatch`. */
  createAmbulanceTrip(input: CreateTripInput): Promise<AmbulanceTrip> {
    return this.request<AmbulanceTrip>("POST", "/api/v1/ambulance-trips", input);
  }

  /** Moves a trip along its lifecycle (start/complete/cancel). Needs `ambulance:dispatch`. */
  transitionAmbulanceTrip(
    id: string,
    input: { to: AmbulanceTripStatus; reason?: string },
  ): Promise<AmbulanceTrip> {
    return this.request<AmbulanceTrip>("POST", `/api/v1/ambulance-trips/${id}/transition`, input);
  }

  /* ── vitals ── */

  /** Charts one set of observations against a visit. Needs `vitals:record`. */
  recordVitals(encounterId: string, input: RecordVitalsInput): Promise<VitalsReading> {
    return this.request<VitalsReading>("POST", `/api/v1/encounters/${encounterId}/vitals`, input);
  }

  /** Every reading on one visit, oldest first — the visit's chart. */
  listEncounterVitals(encounterId: string): Promise<VitalsReading[]> {
    return this.request<VitalsReading[]>("GET", `/api/v1/encounters/${encounterId}/vitals`);
  }

  /** A patient's recent readings across visits, newest first — the trend. */
  listPatientVitals(patientId: string, limit?: number): Promise<VitalsReading[]> {
    const qs = limit ? `?limit=${String(limit)}` : "";
    return this.request<VitalsReading[]>("GET", `/api/v1/patients/${patientId}/vitals${qs}`);
  }

  /* ── diagnostic reports ── */

  /** Uploads a report file against an order. `dataBase64` is the file, base64-encoded. */
  uploadReport(
    orderId: string,
    input: { filename: string; contentType: string; dataBase64: string },
  ): Promise<ReportMeta> {
    return this.request<ReportMeta>("POST", `/api/v1/orders/${orderId}/reports`, input);
  }

  /** Every report for a patient, across all their visits — the doctor's cross-visit view. */
  listReports(patientId: string): Promise<ReportMeta[]> {
    return this.request<ReportMeta[]>("GET", `/api/v1/patients/${patientId}/reports`);
  }

  /**
   * Fetches a report file's bytes, authenticated, as a Blob. The caller turns it into an
   * object URL and opens it — a plain `<a href>` cannot carry the bearer token the download
   * route requires, so the file must be fetched, not linked.
   */
  async fetchReportBlob(id: string): Promise<Blob> {
    const token = this.getAccessToken?.();
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (this.tenantHost) headers.host = this.tenantHost;

    const res = await this.fetchImpl(`${this.baseUrl}/api/v1/reports/${id}/file`, {
      method: "GET",
      headers,
      credentials: this.credentials,
      cache: "no-store",
    });
    if (!res.ok) {
      throw new ApiClientError(
        res.status,
        "HMS-GEN-500",
        `Could not load the report (HTTP ${String(res.status)}).`,
      );
    }
    return res.blob();
  }

  /* ── patient documents (A7) ── */

  /** Uploads a document against a patient. `dataBase64` is the file, base64-encoded. */
  uploadDocument(
    patientId: string,
    input: {
      category: DocumentCategory;
      title: string;
      encounterId?: string;
      filename: string;
      contentType: string;
      dataBase64: string;
    },
  ): Promise<DocumentMeta> {
    return this.request<DocumentMeta>("POST", `/api/v1/patients/${patientId}/documents`, input);
  }

  /** Every document on a patient's record, newest first. */
  listDocuments(patientId: string): Promise<DocumentMeta[]> {
    return this.request<DocumentMeta[]>("GET", `/api/v1/patients/${patientId}/documents`);
  }

  /** Removes a document (needs `file:delete`). A correction — wrong patient or wrong file. */
  deleteDocument(id: string): Promise<{ id: string; deleted: boolean }> {
    return this.request("DELETE", `/api/v1/documents/${id}`);
  }

  /** Fetches a document's bytes, authenticated, as a Blob — same reason as `fetchReportBlob`. */
  async fetchDocumentBlob(id: string): Promise<Blob> {
    const token = this.getAccessToken?.();
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (this.tenantHost) headers.host = this.tenantHost;

    const res = await this.fetchImpl(`${this.baseUrl}/api/v1/documents/${id}/file`, {
      method: "GET",
      headers,
      credentials: this.credentials,
      cache: "no-store",
    });
    if (!res.ok) {
      throw new ApiClientError(
        res.status,
        "HMS-GEN-500",
        `Could not load the document (HTTP ${String(res.status)}).`,
      );
    }
    return res.blob();
  }

  /** The as-you-type duplicate check. POST because the body carries PHI. */
  checkDuplicatePatients(input: {
    name: string;
    gender?: string;
    dob?: string;
    phone?: string;
    excludeId?: string;
  }): Promise<DuplicateCandidate[]> {
    return this.request<DuplicateCandidate[]>("POST", "/api/v1/patients/check-duplicates", input);
  }

  mergePatients(input: {
    survivorId: string;
    duplicateId: string;
    reason: string;
  }): Promise<{ survivor: Patient; merged: Patient }> {
    return this.request("POST", "/api/v1/patients/merge", input);
  }

  /* ── appointments (Doc 02 E1) ── */

  /**
   * The slots still open for a doctor on a day.
   *
   * NOT a reservation. A slot returned here can be gone a second later, which is
   * exactly why `bookAppointment` does not trust it — the server lets a unique
   * index arbitrate and answers `HMS-APT-001` with alternatives if you lose.
   */
  getAvailability(doctorId: string, date: Date): Promise<Slot[]> {
    const query = new URLSearchParams({ doctorId, date: date.toISOString() });
    return this.request<Slot[]>("GET", `/api/v1/appointments/availability?${query.toString()}`);
  }

  listAppointments(
    params: {
      page?: number;
      limit?: number;
      doctorId?: string;
      patientId?: string;
      status?: AppointmentStatus;
      from?: Date;
      to?: Date;
    } = {},
  ): Promise<Paged<Appointment>> {
    const query = new URLSearchParams();
    if (params.page) query.set("page", String(params.page));
    if (params.limit) query.set("limit", String(params.limit));
    if (params.doctorId) query.set("doctorId", params.doctorId);
    if (params.patientId) query.set("patientId", params.patientId);
    if (params.status) query.set("status", params.status);
    if (params.from) query.set("from", params.from.toISOString());
    if (params.to) query.set("to", params.to.toISOString());
    const qs = query.toString();
    return this.paged<Appointment>(`/api/v1/appointments${qs ? `?${qs}` : ""}`);
  }

  /** Throws `ApiClientError` with `code === "HMS-APT-001"` when the slot went first. */
  bookAppointment(input: {
    patientId: string;
    doctorId: string;
    startAt: Date;
    reason?: string;
  }): Promise<Appointment> {
    return this.request<Appointment>("POST", "/api/v1/appointments", {
      ...input,
      startAt: input.startAt.toISOString(),
    });
  }

  /* Lifecycle — STATE_MACHINE_CATALOG §1. The server refuses any edge not listed there. */

  confirmAppointment(id: string): Promise<Appointment> {
    return this.request<Appointment>("POST", `/api/v1/appointments/${id}/confirm`, {});
  }

  checkInAppointment(id: string): Promise<Appointment> {
    return this.request<Appointment>("POST", `/api/v1/appointments/${id}/check-in`, {});
  }

  startConsultation(id: string): Promise<Appointment> {
    return this.request<Appointment>("POST", `/api/v1/appointments/${id}/start`, {});
  }

  completeAppointment(id: string): Promise<Appointment> {
    return this.request<Appointment>("POST", `/api/v1/appointments/${id}/complete`, {});
  }

  markNoShow(id: string, reason?: string): Promise<Appointment> {
    return this.request<Appointment>("POST", `/api/v1/appointments/${id}/no-show`, { reason });
  }

  /** A reason is required — "cancelled" with no why is useless to everyone downstream. */
  cancelAppointment(id: string, reason: string): Promise<Appointment> {
    return this.request<Appointment>("POST", `/api/v1/appointments/${id}/cancel`, { reason });
  }

  /* ── doctor schedules (Doc 02 D2) ── */

  getDoctorSchedule(doctorId: string): Promise<DoctorSchedule[]> {
    return this.request<DoctorSchedule[]>("GET", `/api/v1/doctors/${doctorId}/schedule`);
  }

  setDoctorSchedule(input: {
    doctorId: string;
    weekday: number;
    startMinute: number;
    endMinute: number;
    slotMinutes: number;
  }): Promise<DoctorSchedule> {
    return this.request<DoctorSchedule>("PUT", "/api/v1/doctors/schedule", input);
  }

  /* ── encounters (ADR-0013) — the front door of the whole product ────────────
   *
   * `startEncounter` is what a walk-in IS. It needs no appointment, and in five of
   * our six target organization types that is every patient of the day.
   */

  /**
   * Starts a visit.
   *
   * Returns `resumed: true` when the patient already had an open visit — NOT an
   * error. A clerk facing a patient who has come back from the lab wants their visit
   * and their token, not a rejection they will work around with a duplicate record.
   */
  startEncounter(input: {
    patientId: string;
    origin?: EncounterOrigin;
    doctorId?: string;
    departmentId?: string;
    reason?: string;
    /** A paid fast-track OP visit — priority in the queue plus an express surcharge. */
    express?: boolean;
  }): Promise<StartEncounterResult> {
    return this.request<StartEncounterResult>("POST", "/api/v1/encounters", input);
  }

  /**
   * The register, the queue board and the doctor's list — one endpoint.
   *
   * `date` is `YYYY-MM-DD` and is resolved in the HOSPITAL's timezone by the server.
   * `queued` returns everyone waiting or being seen, in token order.
   */
  listEncounters(
    params: {
      date?: string;
      status?: EncounterStatus;
      doctorId?: string;
      departmentId?: string;
      patientId?: string;
      queued?: boolean;
      page?: number;
      limit?: number;
    } = {},
  ): Promise<Paged<Encounter>> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    const qs = query.toString();
    return this.paged<Encounter>(`/api/v1/encounters${qs ? `?${qs}` : ""}`);
  }

  getEncounter(id: string): Promise<Encounter> {
    return this.request<Encounter>("GET", `/api/v1/encounters/${id}`);
  }

  /** Every encounter in one care story, oldest first (ADR-0013 §4). */
  getEpisodeTimeline(episodeId: string): Promise<Encounter[]> {
    return this.request<Encounter[]>("GET", `/api/v1/episodes/${episodeId}/timeline`);
  }

  queueEncounter(id: string): Promise<Encounter> {
    return this.request<Encounter>("POST", `/api/v1/encounters/${id}/queue`, {});
  }

  /** The patient is called in from the waiting room. */
  startEncounterConsultation(id: string): Promise<Encounter> {
    return this.request<Encounter>("POST", `/api/v1/encounters/${id}/start`, {});
  }

  /** Sent for tests. They KEEP this encounter — that is the point of the state. */
  sendForInvestigations(id: string): Promise<Encounter> {
    return this.request<Encounter>("POST", `/api/v1/encounters/${id}/investigations`, {});
  }

  closeEncounter(id: string, reason?: string): Promise<Encounter> {
    return this.request<Encounter>("POST", `/api/v1/encounters/${id}/close`, { reason });
  }

  /**
   * Records the doctor's OP visit summary (diagnosis / advice) for the OPD slip. An empty string
   * clears the field. Needs `emr:write`.
   */
  recordVisitSummary(
    id: string,
    input: { diagnosis?: string; advice?: string },
  ): Promise<Encounter> {
    return this.request<Encounter>("POST", `/api/v1/encounters/${id}/summary`, input);
  }

  cancelEncounter(id: string, reason: string): Promise<Encounter> {
    return this.request<Encounter>("POST", `/api/v1/encounters/${id}/cancel`, { reason });
  }

  /** They waited and left. Distinct from cancelled — a rising LWBS is a slow queue. */
  markLeftWithoutBeingSeen(id: string): Promise<Encounter> {
    return this.request<Encounter>("POST", `/api/v1/encounters/${id}/left`, {});
  }

  /* ── orders (ADR-0013 §3) ── */

  /**
   * Places an order. `requestId` is optional idempotency — send one: a doctor
   * double-clicking must not draw two tubes of blood, and a retry after a timeout is
   * the case a disabled button cannot save you from.
   */
  placeOrder(input: {
    encounterId: string;
    category: OrderCategory;
    code: string;
    name: string;
    priority?: OrderPriority;
    notes?: string;
    requestId?: string;
  }): Promise<PlaceOrderResult> {
    return this.request<PlaceOrderResult>("POST", "/api/v1/orders", input);
  }

  /** `{ category: "lab", outstanding: true }` IS the lab's worklist. */
  listOrders(
    params: {
      category?: OrderCategory;
      status?: OrderStatus;
      priority?: OrderPriority;
      encounterId?: string;
      patientId?: string;
      outstanding?: boolean;
      page?: number;
      limit?: number;
    } = {},
  ): Promise<Paged<Order>> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    const qs = query.toString();
    return this.paged<Order>(`/api/v1/orders${qs ? `?${qs}` : ""}`);
  }

  getOrder(id: string): Promise<Order> {
    return this.request<Order>("GET", `/api/v1/orders/${id}`);
  }

  acceptOrder(id: string): Promise<Order> {
    return this.request<Order>("POST", `/api/v1/orders/${id}/accept`, {});
  }

  startOrder(id: string): Promise<Order> {
    return this.request<Order>("POST", `/api/v1/orders/${id}/start`, {});
  }

  /** Records the result. `critical: true` alerts the doctor SYNCHRONOUSLY. */
  completeOrder(
    id: string,
    result: { summary?: string; values?: OrderResultValue[]; critical?: boolean },
  ): Promise<Order> {
    return this.request<Order>("POST", `/api/v1/orders/${id}/complete`, result);
  }

  /** The second pair of eyes. Needs authority over the CATEGORY, not just the verb. */
  verifyOrder(id: string): Promise<Order> {
    return this.request<Order>("POST", `/api/v1/orders/${id}/verify`, {});
  }

  releaseOrder(id: string): Promise<Order> {
    return this.request<Order>("POST", `/api/v1/orders/${id}/release`, {});
  }

  cancelOrder(id: string, reason: string): Promise<Order> {
    return this.request<Order>("POST", `/api/v1/orders/${id}/cancel`, { reason });
  }

  /* ── billing (F-group) — every amount is PAISE ── */

  /** The running bill for a visit. THE endpoint every login uses. */
  getBill(encounterId: string): Promise<Bill> {
    return this.request<Bill>("GET", `/api/v1/encounters/${encounterId}/bill`);
  }

  /** The per-batch billing view — pending charges + every bill on the visit. Needs `billing:read`. */
  getEncounterBilling(encounterId: string): Promise<EncounterBilling> {
    return this.request<EncounterBilling>("GET", `/api/v1/encounters/${encounterId}/billing`);
  }

  /** Freezes the bill and assigns its number. After this the lines cannot move. */
  finalizeBill(encounterId: string): Promise<Invoice> {
    return this.request<Invoice>("POST", `/api/v1/encounters/${encounterId}/bill/finalize`, {});
  }

  /** The tariff, WITH prices. Needs `billing:read` — the counter's view. */
  listServices(params: { category?: ChargeCategory } = {}): Promise<ServiceItem[]> {
    const qs = params.category ? `?category=${params.category}` : "";
    return this.request<ServiceItem[]>("GET", `/api/v1/services${qs}`);
  }

  /**
   * What can be ordered. NO prices, and needs `order:create` — the doctor's view.
   *
   * The rate card is not the bill: a doctor should know a chest X-ray is available
   * without being shown its price while the patient is in front of them.
   */
  listCatalogue(params: { category?: ChargeCategory } = {}): Promise<CatalogueItem[]> {
    const qs = params.category ? `?category=${params.category}` : "";
    return this.request<CatalogueItem[]>("GET", `/api/v1/services/catalogue${qs}`);
  }

  /* ── Tariff management (needs tariff:manage; prices included) ─────────────── */

  listTariff(params: { category?: ChargeCategory } = {}): Promise<TariffItem[]> {
    const qs = params.category ? `?category=${params.category}` : "";
    return this.request<TariffItem[]>("GET", `/api/v1/tariff${qs}`);
  }

  createTariff(input: CreateTariffInput): Promise<TariffItem> {
    return this.request<TariffItem>("POST", "/api/v1/tariff", input);
  }

  updateTariff(id: string, patch: UpdateTariffInput): Promise<TariffItem> {
    return this.request<TariffItem>("PATCH", `/api/v1/tariff/${id}`, patch);
  }

  /* ── Reports (need report:view) ──────────────────────────────────────────── */

  /** The caller's OWN activity for a period — patients seen, tests ordered, meds prescribed. */
  myActivity(range: ReportRange): Promise<MyActivity> {
    return this.request<MyActivity>("GET", `/api/v1/reports/my-activity${rangeQs(range)}`);
  }

  /**
   * PAID / UNPAID (or `free` / `unbilled`) per order — for the lab worklist. A status flag only, so
   * it is reachable with `order:read`. `free` is a zero-tariff (government) patient who owes nothing.
   */
  orderPaymentStatus(
    orderIds: string[],
  ): Promise<Record<string, "paid" | "unpaid" | "unbilled" | "free">> {
    if (orderIds.length === 0) return Promise.resolve({});
    const qs = `?orderIds=${encodeURIComponent(orderIds.join(","))}`;
    return this.request("GET", `/api/v1/billing/order-payments${qs}`);
  }

  /**
   * PAID / UNPAID (or `free` / `unbilled`) per encounter's CONSULTATION — reception's gate for
   * "pay the OP fee before joining the doctor's queue". A status flag only (no amounts), reachable
   * with `encounter:read`. `free` is a zero-tariff (government) patient who owes nothing and queues
   * at once; `unbilled` means the consultation charge has not posted yet.
   */
  consultationPaymentStatus(
    encounterIds: string[],
  ): Promise<Record<string, "paid" | "unpaid" | "unbilled" | "free">> {
    if (encounterIds.length === 0) return Promise.resolve({});
    const qs = `?encounterIds=${encodeURIComponent(encounterIds.join(","))}`;
    return this.request("GET", `/api/v1/billing/consultation-payments${qs}`);
  }

  /**
   * Per order for the lab worklist: whether the patient is admitted, their advance balance, and this
   * test's amount — so an admitted patient's test can be settled from advance instead of paid at the
   * counter. Reachable with `order:read`.
   */
  orderSettlementInfo(
    orderIds: string[],
  ): Promise<Record<string, { admitted: boolean; advanceBalance: number; amount: number }>> {
    if (orderIds.length === 0) return Promise.resolve({});
    const qs = `?orderIds=${encodeURIComponent(orderIds.join(","))}`;
    return this.request("GET", `/api/v1/billing/order-settlement${qs}`);
  }

  /**
   * Settles one admitted-patient test from their advance — the lab tech's "proceed" action. Draws the
   * test's amount from the wallet (balance may go negative for an inpatient) and marks it paid. Needs
   * `order:perform`; refuses an OP test (that is paid at the counter).
   */
  settleOrderFromAdvance(
    orderId: string,
  ): Promise<{ orderId: string; invoiceId: string; advanceBalance: number }> {
    return this.request("POST", `/api/v1/billing/orders/${orderId}/settle-from-advance`, {});
  }

  reportPharmacyStock(range: ReportRange): Promise<StockRegisterRow[]> {
    return this.request<StockRegisterRow[]>(
      "GET",
      `/api/v1/reports/pharmacy-stock${rangeQs(range)}`,
    );
  }

  reportPatientVisits(range: ReportRange): Promise<VisitReport> {
    return this.request<VisitReport>("GET", `/api/v1/reports/patient-visits${rangeQs(range)}`);
  }

  reportDoctorLoad(range: ReportRange): Promise<DoctorLoadRow[]> {
    return this.request<DoctorLoadRow[]>("GET", `/api/v1/reports/doctor-load${rangeQs(range)}`);
  }

  reportDiagnostics(range: ReportRange): Promise<DiagnosticsReport> {
    return this.request<DiagnosticsReport>("GET", `/api/v1/reports/diagnostics${rangeQs(range)}`);
  }

  reportCollections(range: ReportRange): Promise<CollectionsReport> {
    return this.request<CollectionsReport>("GET", `/api/v1/reports/collections${rangeQs(range)}`);
  }

  /** The advance (wallet) register — admission advances in, utilised, refunded, and held. */
  reportWallet(range: ReportRange): Promise<WalletRegister> {
    return this.request<WalletRegister>("GET", `/api/v1/reports/wallet${rangeQs(range)}`);
  }

  /** The receipts register — every payment (bills + advances) taken in the period. Needs `billing:read`. */
  reportReceipts(range: ReportRange): Promise<ReceiptRow[]> {
    return this.request<ReceiptRow[]>("GET", `/api/v1/reports/receipts${rangeQs(range)}`);
  }

  reportDischargeOutcomes(range: ReportRange): Promise<DischargeRegister> {
    return this.request<DischargeRegister>(
      "GET",
      `/api/v1/reports/discharge-outcomes${rangeQs(range)}`,
    );
  }

  /**
   * A report as a CSV blob — the same data the JSON endpoints return, in the shape a spreadsheet
   * wants. `path` is a report slug, e.g. `pharmacy-stock`. Fetched WITH the auth header (not a bare
   * `<a href>`, which carries no bearer token) so the caller can turn it into a download.
   */
  async fetchReportCsv(path: string, range: ReportRange): Promise<Blob> {
    const token = this.getAccessToken?.();
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (this.tenantHost) headers.host = this.tenantHost;

    const res = await this.fetchImpl(
      `${this.baseUrl}/api/v1/reports/${path}${rangeQs(range)}&format=csv`,
      { method: "GET", headers, credentials: this.credentials, cache: "no-store" },
    );
    if (!res.ok) {
      throw new ApiClientError(
        res.status,
        "HMS-GEN-500",
        `Could not export the report (HTTP ${String(res.status)}).`,
      );
    }
    return res.blob();
  }

  postCharge(input: {
    encounterId: string;
    code: string;
    category: ChargeCategory;
    description?: string;
    quantity?: number;
    /** Paise. Overrides the tariff. */
    unitPrice?: number;
  }): Promise<unknown> {
    return this.request("POST", "/api/v1/charges", input);
  }

  /* ── Pharmacy medicine master & stock (needs pharmacy:stock) ──────────────── */

  listMedicines(
    params: { search?: string; lowStockOnly?: boolean; includeInactive?: boolean } = {},
  ): Promise<Medicine[]> {
    return this.request<Medicine[]>("GET", `/api/v1/medicines${medicineQuery(params)}`);
  }

  /** The stock report — every medicine with a plain-language position, worst first. */
  stockReport(
    params: { search?: string; lowStockOnly?: boolean; includeInactive?: boolean } = {},
  ): Promise<StockReportRow[]> {
    return this.request<StockReportRow[]>(
      "GET",
      `/api/v1/medicines/stock-report${medicineQuery(params)}`,
    );
  }

  getMedicine(id: string): Promise<Medicine> {
    return this.request<Medicine>("GET", `/api/v1/medicines/${id}`);
  }

  listStockMovements(id: string): Promise<StockMovement[]> {
    return this.request<StockMovement[]>("GET", `/api/v1/medicines/${id}/movements`);
  }

  createMedicine(input: CreateMedicineInput): Promise<Medicine> {
    return this.request<Medicine>("POST", "/api/v1/medicines", input);
  }

  updateMedicine(id: string, patch: UpdateMedicineInput): Promise<Medicine> {
    return this.request<Medicine>("PATCH", `/api/v1/medicines/${id}`, patch);
  }

  /** Books stock in — a delivery received at the counter. */
  receiveStock(
    id: string,
    input: { quantity: number; batchNo?: string; expiry?: string },
  ): Promise<StockMoveResult> {
    return this.request<StockMoveResult>("POST", `/api/v1/medicines/${id}/receive`, input);
  }

  /** A manual correction — breakage, a write-off, a stock-take. `delta` is signed. */
  adjustStock(id: string, input: { delta: number; reason: string }): Promise<StockMoveResult> {
    return this.request<StockMoveResult>("POST", `/api/v1/medicines/${id}/adjust`, input);
  }

  /* ── Admissions ───────────────────────────────────────────────────────────
   * The OP encounter closes and an IP one opens in the same Episode of Care. Two
   * encounters, one care story (ADR-0013 §4).
   */

  /**
   * Admit a patient. Prefer `bedId` — a bed picked from the inventory (B4), which fills in the
   * ward, code and tariff from the catalogue. The free-text `ward`/`bedCode`/`tariffCode` triple
   * is the legacy path for hospitals that have not built their bed inventory yet.
   */
  admitPatient(
    encounterId: string,
    input: {
      bedId?: string;
      ward?: string;
      bedCode?: string;
      tariffCode?: string;
      doctorId?: string;
      reason?: string;
    },
  ): Promise<AdmitResult> {
    return this.request<AdmitResult>("POST", `/api/v1/encounters/${encounterId}/admit`, input);
  }

  /** Everyone in a bed right now — the ward round's list. */
  listInpatients(): Promise<Encounter[]> {
    return this.request<Encounter[]>("GET", "/api/v1/inpatients");
  }

  /* ── Bed inventory & board (Module B4) ───────────────────────────────────── */

  /** The free-and-occupied bed board — the inventory joined to who is actually admitted. */
  bedBoard(): Promise<BedBoard> {
    return this.request<BedBoard>("GET", "/api/v1/bed-board");
  }

  listWards(): Promise<Ward[]> {
    return this.request<Ward[]>("GET", "/api/v1/wards");
  }

  createWard(input: { name: string; kind: WardKind; tariffCode: string }): Promise<Ward> {
    return this.request<Ward>("POST", "/api/v1/wards", input);
  }

  updateWard(
    id: string,
    patch: { name?: string; kind?: WardKind; tariffCode?: string; status?: WardStatus },
  ): Promise<Ward> {
    return this.request<Ward>("PATCH", `/api/v1/wards/${id}`, patch);
  }

  /** Every bed, or one ward's beds — each joined to its ward name and effective tariff. */
  listBeds(wardId?: string): Promise<InventoryBed[]> {
    const qs = wardId ? `?wardId=${wardId}` : "";
    return this.request<InventoryBed[]>("GET", `/api/v1/beds${qs}`);
  }

  createBed(input: {
    wardId: string;
    code: string;
    room?: string;
    tariffCode?: string;
  }): Promise<InventoryBed> {
    return this.request<InventoryBed>("POST", "/api/v1/beds", input);
  }

  updateBed(
    id: string,
    patch: {
      code?: string;
      room?: string;
      tariffCode?: string;
      status?: BedStatus;
      blockedReason?: string;
    },
  ): Promise<InventoryBed> {
    return this.request<InventoryBed>("PATCH", `/api/v1/beds/${id}`, patch);
  }

  addWardNote(encounterId: string, text: string): Promise<WardNote> {
    return this.request<WardNote>("POST", `/api/v1/encounters/${encounterId}/notes`, { text });
  }

  /**
   * Moves an admitted patient to another bed (B4). Prefer a `bedId` from the bed board; the move is
   * refused (409) if that bed is occupied. Needs `bed:allocate`.
   */
  transferBed(
    encounterId: string,
    input: { bedId?: string; ward?: string; bedCode?: string; reason?: string },
  ): Promise<{ from: { ward: string; bedCode: string }; to: { ward: string; bedCode: string } }> {
    return this.request("POST", `/api/v1/encounters/${encounterId}/transfer-bed`, input);
  }

  listWardNotes(encounterId: string, type?: WardNoteType): Promise<WardNote[]> {
    const qs = type ? `?type=${type}` : "";
    return this.request<WardNote[]>("GET", `/api/v1/encounters/${encounterId}/notes${qs}`);
  }

  /** Writes the summary AND ends the stay. There is no way to discharge without one. */
  discharge(
    encounterId: string,
    input: { text: string; diagnosis?: string; advice?: string; followUpOn?: string },
  ): Promise<{ summary: WardNote; encounterId: string }> {
    return this.request("POST", `/api/v1/encounters/${encounterId}/discharge`, input);
  }

  /**
   * Ends the stay WITHOUT a routine discharge — LAMA, absconded, or a death. Writes the
   * account of what happened (`outcome_note`) and closes the encounter with its true
   * disposition. `discharged` is not an option here — that goes through `discharge`.
   */
  recordOutcome(
    encounterId: string,
    input: { outcome: TerminalOutcome; text: string },
  ): Promise<{ note: WardNote; encounterId: string }> {
    return this.request("POST", `/api/v1/encounters/${encounterId}/outcome`, input);
  }

  /**
   * Hands the patient to another doctor. A handover, not an edit — the reason is
   * required, and it is the only thing the receiving doctor has to go on.
   */
  transferDoctor(encounterId: string, doctorId: string, reason: string): Promise<Encounter> {
    return this.request<Encounter>("POST", `/api/v1/encounters/${encounterId}/transfer`, {
      doctorId,
      reason,
    });
  }

  /* ── Prescriptions ────────────────────────────────────────────────────────
   * The doctor's half. A draft binds nobody; `sign` is what makes it an authority
   * for drugs to leave a shelf, and after that it is immutable — `amend` supersedes.
   */

  createPrescription(input: {
    encounterId: string;
    lines: PrescriptionLineInput[];
    notes?: string;
  }): Promise<Prescription> {
    return this.request<Prescription>("POST", "/api/v1/prescriptions", input);
  }

  listPrescriptions(
    params: {
      encounterId?: string;
      patientId?: string;
      status?: PrescriptionStatus;
      /** Hide superseded versions — a chart shows what is in force. */
      current?: boolean;
      page?: number;
      limit?: number;
    } = {},
  ): Promise<Prescription[]> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) query.set(key, String(value));
    }
    const qs = query.toString();
    return this.request<Prescription[]>("GET", `/api/v1/prescriptions${qs ? `?${qs}` : ""}`);
  }

  getPrescription(id: string): Promise<Prescription> {
    return this.request<Prescription>("GET", `/api/v1/prescriptions/${id}`);
  }

  /** Drafts only. A signed prescription is changed by `amendPrescription`. */
  updatePrescription(
    id: string,
    input: { lines: PrescriptionLineInput[]; notes?: string },
  ): Promise<Prescription> {
    return this.request<Prescription>("PATCH", `/api/v1/prescriptions/${id}`, input);
  }

  /** The live safety screen — allergies, interactions, duplicate therapy. Signs nothing. */
  screenPrescription(id: string): Promise<PrescriptionScreening> {
    return this.request<PrescriptionScreening>("GET", `/api/v1/prescriptions/${id}/screen`);
  }

  /**
   * The signature. The pharmacy hears about it without anyone telling them.
   *
   * `overrideReason` is required ONLY to sign through a blocking safety alert (an allergy
   * contraindication); on the ordinary path it is omitted. Signing through a block without
   * one is refused server-side with HMS-RX-001.
   */
  signPrescription(id: string, overrideReason?: string): Promise<Prescription> {
    return this.request<Prescription>(
      "POST",
      `/api/v1/prescriptions/${id}/sign`,
      overrideReason ? { overrideReason } : undefined,
    );
  }

  /** Stopping a drug. Doses already dispensed are unaffected — see §6. */
  cancelPrescription(id: string, reason: string): Promise<Prescription> {
    return this.request<Prescription>("POST", `/api/v1/prescriptions/${id}/cancel`, { reason });
  }

  discardPrescription(id: string): Promise<Prescription> {
    return this.request<Prescription>("POST", `/api/v1/prescriptions/${id}/discard`);
  }

  /** A new DRAFT superseding a signed one. The original survives as it was signed. */
  amendPrescription(id: string): Promise<Prescription> {
    return this.request<Prescription>("POST", `/api/v1/prescriptions/${id}/amend`);
  }

  /* ── Pharmacy ─────────────────────────────────────────────────────────────── */

  /**
   * Hands the drugs over.
   *
   * ALWAYS send a `requestId`. A pharmacist double-clicking must not hand over — and
   * bill for — two lots of the same drug, and a retry after a timeout must not either.
   */
  dispense(
    prescriptionId: string,
    input: {
      items: { lineIndex: number; quantity: number }[];
      requestId?: string;
      /**
       * Set only to knowingly dispense OVER an admitted patient's advance. Rejected with
       * `HMS-PHM-003` unless the caller holds `pharmacy:credit-override` (a doctor/admin).
       */
      creditOverride?: { reason: string };
    },
  ): Promise<DispenseResult> {
    return this.request<DispenseResult>(
      "POST",
      `/api/v1/prescriptions/${prescriptionId}/dispense`,
      input,
    );
  }

  /** The handover ledger — who gave what, when. */
  listDispenses(prescriptionId: string): Promise<Dispense[]> {
    return this.request<Dispense[]>("GET", `/api/v1/prescriptions/${prescriptionId}/dispenses`);
  }

  listInvoices(
    params: { status?: InvoiceStatus; patientId?: string; page?: number; limit?: number } = {},
  ): Promise<Paged<Invoice>> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    const qs = query.toString();
    return this.paged<Invoice>(`/api/v1/invoices${qs ? `?${qs}` : ""}`);
  }

  /** One bill by id — for a printable receipt. Needs `billing:read`. */
  getInvoice(invoiceId: string): Promise<Invoice> {
    return this.request<Invoice>("GET", `/api/v1/invoices/${invoiceId}`);
  }

  /** Dated charges for a visit — the day-wise money on the IP treatment sheet. Needs `billing:read`. */
  getCharges(encounterId: string): Promise<EncounterCharge[]> {
    return this.request<EncounterCharge[]>("GET", `/api/v1/encounters/${encounterId}/charges`);
  }

  /** Takes money. `amount` is PAISE. Refused on a draft; overpayment is refused. */
  recordPayment(
    invoiceId: string,
    input: { amount: number; method: string; reference?: string },
  ): Promise<Invoice> {
    return this.request<Invoice>("POST", `/api/v1/invoices/${invoiceId}/payments`, input);
  }

  /**
   * Settles a bill from the patient's ADVANCE. A convenience over `recordPayment` — it is the
   * same endpoint with `method: "wallet"`, which draws the money from the wallet atomically.
   */
  payFromWallet(invoiceId: string, amount: number): Promise<Invoice> {
    return this.request<Invoice>("POST", `/api/v1/invoices/${invoiceId}/payments`, {
      amount,
      method: "wallet",
    });
  }

  /* ── wallet (patient advance) ── */

  /** The patient's advance balance + recent statement. Needs `wallet:manage`. */
  getWallet(patientId: string): Promise<Wallet> {
    return this.request<Wallet>("GET", `/api/v1/patients/${patientId}/wallet`);
  }

  /** One wallet ledger entry by id — for reprinting an advance (deposit) receipt. Needs `wallet:manage`. */
  getWalletEntry(id: string): Promise<WalletEntry> {
    return this.request<WalletEntry>("GET", `/api/v1/wallet/entries/${id}`);
  }

  /** Takes an advance (OP or admission). `amount` is PAISE. Needs `wallet:manage`. */
  depositToWallet(patientId: string, input: WalletDepositInput): Promise<Wallet> {
    return this.request<Wallet>("POST", `/api/v1/patients/${patientId}/wallet/deposits`, input);
  }

  /** Refunds advance to the patient (leftover on discharge). `amount` is PAISE. */
  refundFromWallet(patientId: string, input: WalletRefundInput): Promise<Wallet> {
    return this.request<Wallet>("POST", `/api/v1/patients/${patientId}/wallet/refunds`, input);
  }

  /* ── rbac ── */

  listRoles(): Promise<Role[]> {
    return this.request<Role[]>("GET", "/api/v1/roles");
  }

  /* ── audit (Doc 09 §9) ── */

  listAudit(params: AuditQuery = {}): Promise<Paged<AuditEntry>> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    const qs = query.toString();
    return this.paged<AuditEntry>(`/api/v1/audit${qs ? `?${qs}` : ""}`);
  }

  /**
   * Recomputes the hash chain. Deliberately available to the hospital: tamper
   * evidence that only the vendor can check is evidence the customer has to take
   * on trust, which defeats the purpose.
   */
  auditIntegrity(): Promise<AuditIntegrity> {
    return this.request<AuditIntegrity>("GET", "/api/v1/audit/integrity");
  }

  /* ── platform / operator console (Doc 02 A1) ──────────────────────────────
   *
   * A SEPARATE prefix and a SEPARATE token type. An operator is not a hospital
   * user, and none of these calls will work with a hospital's access token — the
   * API rejects it at the door (HMS-AUTH-002). That is deliberate: the two
   * identity systems must not be interchangeable anywhere, including here.
   */

  operatorLogin(email: string, password: string): Promise<OperatorSession> {
    return this.request<OperatorSession>("POST", "/api/platform/v1/auth/login", {
      email,
      password,
    });
  }

  operatorMe(): Promise<{ id: string; email: string; roles: PlatformRole[] }> {
    return this.request("GET", "/api/platform/v1/auth/me");
  }

  operatorLogout(): Promise<unknown> {
    return this.request("POST", "/api/platform/v1/auth/logout", {});
  }

  listHospitals(): Promise<Hospital[]> {
    return this.request<Hospital[]>("GET", "/api/platform/v1/hospitals");
  }

  getHospital(id: string): Promise<HospitalDetail> {
    return this.request<HospitalDetail>("GET", `/api/platform/v1/hospitals/${id}`);
  }

  /** Creates the hospital AND its first administrator — one operation, never two. */
  createHospital(input: {
    slug: string;
    hospitalName: string;
    planCode: string;
    adminEmail: string;
    adminName?: string;
    trial?: boolean;
    /** Supported branches (ADR-0015). Absent ⇒ single-site (1). */
    maxBranches?: number;
    /** Custom domain (ADR-0005) — a bare hostname resolving to this hospital. */
    customDomain?: string;
    /** Licence (ADR-0016): give an ISO `licenseExpiresAt` OR `trialDays`; omit both for the default trial. */
    licensePlan?: string;
    licenseExpiresAt?: string;
    trialDays?: number;
    graceDays?: number;
  }): Promise<{ hospital: Hospital; admin: { email: string; temporaryPassword?: string } }> {
    return this.request("POST", "/api/platform/v1/hospitals", input);
  }

  setHospitalStatus(id: string, status: Hospital["status"]): Promise<Hospital> {
    return this.request<Hospital>("POST", `/api/platform/v1/hospitals/${id}/status`, { status });
  }

  setHospitalPlan(id: string, planCode: string): Promise<unknown> {
    return this.request("POST", `/api/platform/v1/hospitals/${id}/plan`, { planCode });
  }

  /** Raise/lower the supported-branches cap (ADR-0015). Never below 1 (the Main branch). */
  setHospitalLimits(id: string, maxBranches: number): Promise<Hospital> {
    return this.request<Hospital>("POST", `/api/platform/v1/hospitals/${id}/limits`, {
      maxBranches,
    });
  }

  /**
   * Set / renew / extend a hospital's licence (ADR-0016). `extendDays` bumps expiry from
   * the later of now / current expiry; `expiresAt` sets it outright. A renewal un-blocks
   * an expired hospital on its next request.
   */
  setHospitalLicense(
    id: string,
    patch: {
      plan?: string;
      status?: "TRIAL" | "ACTIVE" | "EXPIRED" | "CANCELLED";
      expiresAt?: string;
      graceDays?: number;
      extendDays?: number;
      notes?: string;
    },
  ): Promise<Hospital> {
    return this.request<Hospital>("POST", `/api/platform/v1/hospitals/${id}/license`, patch);
  }

  /** Attach / replace / clear a custom domain (ADR-0005). Pass null to detach. */
  setHospitalDomain(id: string, customDomain: string | null): Promise<Hospital> {
    return this.request<Hospital>("POST", `/api/platform/v1/hospitals/${id}/domain`, {
      customDomain,
    });
  }

  /** The "we're locked out" call. Returns a temporary password, shown once. */
  issueHospitalAdmin(
    id: string,
    input: { email: string; name?: string },
  ): Promise<{ email: string; temporaryPassword: string }> {
    return this.request("POST", `/api/platform/v1/hospitals/${id}/admin`, input);
  }

  listEditions(): Promise<Edition[]> {
    return this.request<Edition[]>("GET", "/api/platform/v1/editions");
  }

  operatorAudit(): Promise<OperatorAuditEntry[]> {
    return this.request<OperatorAuditEntry[]>("GET", "/api/platform/v1/audit");
  }

  /**
   * The CSV export URL. Returned rather than fetched, because the browser must
   * download it through a normal navigation — an in-memory blob would defeat the
   * whole point of a file the compliance officer can hand to an auditor.
   * The export itself is audited server-side (`audit.exported`).
   */
  auditExportUrl(params: AuditQuery = {}): string {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "" && key !== "page" && key !== "limit") {
        query.set(key, String(value));
      }
    }
    const qs = query.toString();
    return `${this.baseUrl}/api/v1/audit/export${qs ? `?${qs}` : ""}`;
  }
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  return new ApiClient(options);
}

/** The from/to query string every report shares. */
function rangeQs(range: { from: string; to: string }): string {
  return `?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
}

/** Builds the medicine-list query string, omitting anything not set. */
function medicineQuery(params: {
  search?: string;
  lowStockOnly?: boolean;
  includeInactive?: boolean;
}): string {
  const parts: string[] = [];
  if (params.search) parts.push(`search=${encodeURIComponent(params.search)}`);
  if (params.lowStockOnly) parts.push("lowStockOnly=true");
  if (params.includeInactive) parts.push("includeInactive=true");
  return parts.length ? `?${parts.join("&")}` : "";
}
