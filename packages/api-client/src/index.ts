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

/**
 * Per-call options — things that belong to ONE request rather than to the client.
 *
 * ── `idempotencyKey`, AND WHY IT IS THE CALLER'S JOB ────────────────────────
 * A retryable mutation is not safe because the client retried carefully; it is safe because the
 * server can recognise the second attempt as the same intent. That recognition needs a name, and
 * the only layer that knows which HTTP calls are one intent is the one that formed the intent:
 * the payment form, the offline mutation queue, the row the user tapped.
 *
 * So the rule is: mint the key once when the user commits to the action, PERSIST it alongside the
 * pending mutation, reuse it for every retry of that action, and mint a fresh one for the next
 * action. A second part-payment on the same bill is not a duplicate — it is more money, and it
 * must get a new key and go through.
 *
 * The server honours it on the operations `docs/IDEMPOTENCY.md` lists (money, stock, and the
 * clinical writes where a repeat creates a second real thing). A replayed answer is byte-identical
 * to the first and carries `Idempotency-Replayed: true`. The same key with a DIFFERENT body is
 * refused with `HMS-REQ-002` rather than silently replayed, so a key-reuse bug surfaces as an
 * error instead of as a payment that never happened.
 *
 * Mobile: `crypto.randomUUID()` under Expo, stored in the queue row — nothing here needs a
 * browser, a Node builtin, or a live connection to produce a key.
 */
export interface RequestOptions {
  /** 8–128 chars of `[A-Za-z0-9_.:@+-]`. A UUID per user intent is the intended shape. */
  idempotencyKey?: string;
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
   * Called with the operation's retirement notice when a response carries `Deprecation`/`Sunset`,
   * plus the path that produced it. Nothing is deprecated today, so this never fires — it is here
   * so a mobile build that ships BEFORE the first deprecation can still hear about it, which is
   * the only ordering that helps a phone nobody will update.
   */
  onDeprecation?: (notice: DeprecationNotice, path: string) => void;
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
  /**
   * The MODULE FLAGS this hospital's edition includes — `/auth/me` only (ADR-0010 layer 1).
   *
   * A permission answers "may this user"; a feature answers "did this hospital buy it". A client
   * that can see only the first advertises modules that will always refuse: a clinic administrator
   * holds every permission and was shown Theatres, Emergency, Ward and Ambulance, each of which
   * opened onto `HMS-PLAN-002` (D20). Values are the `module.*` flags from `@medicore/permissions`.
   *
   * A hint for drawing a menu, never a grant. `HMS-PLAN-002` from a route remains the
   * authoritative answer, and is what a client should react to when it has one.
   */
  features?: string[];
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
  userId: string;
  /** The rotation family — every refresh of one login shares it. Revoking one revokes the line. */
  family: string;
  device?: string;
  ip?: string;
  userAgent?: string;
  lastSeenAt: string;
  expiresAt: string;
  /** Set once the session has been ended — by logout, by revocation, or by a reuse detection. */
  revokedAt?: string;
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
  /** Set when this login belongs to a PATIENT rather than a member of staff. */
  patientId?: string;
  /** Set while a run of failed sign-ins has the account locked out. */
  lockedUntil?: string;
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

/**
 * One role WITH its permission codes — what `getRole` answers.
 *
 * Separate from `Role` because the list endpoint does not carry the codes, and typing both as
 * `Role` is how the role editor came to be unable to read the permissions it exists to edit.
 */
/**
 * A user's effective authorization after a role change: the roles they hold, the branches they are
 * confined to (empty = hospital-wide), and the permission codes those add up to.
 */
export interface UserRoles {
  roles: string[];
  branchIds: string[];
  permissions: string[];
}

/** What `setRolePermissions` answers with: the role's id and the codes as stored. */
export interface RolePermissions {
  roleId: string;
  permissions: string[];
}

export interface RoleDetail extends Role {
  permissions: string[];
}

/* ── contract types added to close the coverage gap (API Contract Stabilization) ──────────── */

/** One entry of the permission catalogue (`GET /permissions`). */
export interface Permission {
  id: string;
  code: string;
  resource: string;
  action: string;
  scope: string;
  description: string;
}

/** An edition a hospital can be on. */
export interface Plan {
  code: string;
  name: string;
  entitlements: string[];
  limits: Record<string, number | null>;
  priceMinor?: number;
  currency?: string;
}

/** One metered limit and how close the hospital is to it. `null` limit = unlimited. */
export interface UsageLine {
  metric: string;
  label: string;
  used: number;
  limit: number | null;
  ratio: number | null;
  /** True from 80% — the nudge, not the wall. */
  warning: boolean;
  /** True at 100% — the next creation will be refused, IF this metric is enforced. */
  exceeded: boolean;
  /**
   * Does the API actually refuse the next one? False means the figure is COUNTED FOR GUIDANCE —
   * no creation point stops you at it. A client must not draw it as a wall: a progress bar with
   * a limit under it is read as one.
   */
  enforced: boolean;
  /**
   * False when the plan allows NONE of this (`limit: 0` — beds on a clinic edition). Distinct
   * from "used it all up": nothing was consumed, the plan simply does not sell it.
   */
  included: boolean;
}

/**
 * Everything an edition can grant. Absent means "not capped by this edition".
 *
 * NOT every entry has a live counter behind it, and the difference matters to a UI: `usage`
 * carries the metered ones, and what is only here (storage) is an ALLOWANCE the plan grants,
 * with nothing measuring consumption. Rendering it as a meter would show "0 GB used" over a
 * hospital with a full disk.
 */
export interface EditionLimits {
  maxUsers?: number;
  maxDoctors?: number;
  maxBranches?: number;
  maxBeds?: number;
  /** Never set by any edition — patients are people who walk in, not a thing a hospital buys. */
  maxPatients?: number;
  storageGb?: number;
}

export interface SubscriptionView {
  planCode: string | null;
  planName: string | null;
  features: string[];
  limits: EditionLimits;
  usage: UsageLine[];
}

/**
 * One outbound message, as the delivery ledger recorded it. Named `NotificationRecord` rather
 * than `Notification` because the DOM already owns that name, and a web or mobile consumer
 * importing both would silently get whichever won.
 */
export interface NotificationRecord {
  id: string;
  templateKey: string;
  channel: string;
  to?: string;
  recipientName?: string;
  recipientType?: string;
  recipientId?: string;
  subject?: string;
  body: string;
  dedupeKey: string;
  status: "pending" | "sent" | "failed" | "unreachable" | "suppressed";
  attempts: number;
  sentAt?: string;
  error?: string;
  eventId?: string;
  /** When the recipient opened it in their inbox. Absent means unread. */
  readAt?: string;
  createdAt: string;
  /** The site this belongs to (ADR-0015). Absent on pre-branch rows. */
  branchId?: string;
}

/**
 * One message as its RECIPIENT sees it — a deliberately smaller thing than `NotificationRecord`.
 *
 * The ledger record answers an operator's question ("did it go, what did SMTP say?"). This
 * answers the reader's ("what do I need to know, and have I seen it?"). They are served by
 * different routes with different authorization, and keeping the types apart is what stops the
 * unpermissioned one from quietly inheriting a field added to the other.
 */
export interface InboxMessage {
  id: string;
  /** Which template rendered it — how the client decides where the message points. */
  templateKey: string;
  subject?: string;
  body: string;
  /** The site the message was raised at (ADR-0015). Shown, never used as a filter. */
  branchId?: string;
  /** Absent means unread. */
  readAt?: string;
  createdAt: string;
}

/** One lot on the shelf. `state` is computed by the server, never stored — it cannot go stale. */
export interface MedicineBatch {
  id: string;
  batchNo: string;
  expiry: string;
  remaining: number;
  state: "expired" | "near_expiry" | "ok";
}

/**
 * What the pharmacy could hand over today.
 *
 * INFORMATION, not permission: nothing consumes this to refuse a prescription, and nothing
 * should. A doctor prescribes what the patient needs; if the hospital is out, the patient buys
 * it outside and the prescription is what they take to the shop.
 */
export interface MedicineAvailability {
  code: string;
  units: number;
  nearestExpiry?: string;
  /** False when the figure is the master's running total rather than counted lots. */
  batched: boolean;
}

export interface NotificationTemplate {
  id: string;
  key: string;
  channel: string;
  description?: string;
  subject?: string;
  body: string;
  enabled: boolean;
  isDefault: boolean;
  updatedAt: string;
}

/** A line on the encounter's bill. Money is an integer number of paise, never a float. */
export interface Charge {
  id: string;
  encounterId: string;
  patientId: string;
  episodeId: string;
  code: string;
  description: string;
  category: string;
  quantity: number;
  listPrice: number;
  amount: number;
  source: string;
  sourceId?: string;
  /** Consultation charges: whose consultation it was. Drives the free-follow-up lookup. */
  doctorId?: string;
  postedBy?: string;
  postedAt: string;
  /** Set once the charge has been put on a bill. */
  invoiceId?: string;
  voided?: boolean;
  voidReason?: string;
  /** The site this belongs to (ADR-0015). Absent on pre-branch rows. */
  branchId?: string;
}

/**
 * A newly issued login and its ONE-TIME password.
 *
 * Returned by the two endpoints that mint a credential — a new operator, and a hospital's first
 * administrator. The password appears on this response and nowhere else: the server keeps only a
 * hash, so a console that fails to show it has locked somebody out.
 */
export interface CreatedCredential {
  email: string;
  temporaryPassword: string;
}

/** A platform OPERATOR — our staff, not a hospital's. A different population entirely. */
export interface PlatformOperator {
  id: string;
  email: string;
  name: string;
  roles: string[];
  status: string;
  mfaEnabled: boolean;
  mustChangePassword: boolean;
  lastLoginAt?: string;
}

/** The TOTP enrolment secret. Shown once, then never again. */
export interface MfaSetupResult {
  otpauthUrl: string;
  secret: string;
}

/** Recovery codes, returned once when MFA is activated. */
export interface MfaActivationResult {
  recoveryCodes: string[];
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
  /** The site this belongs to (ADR-0015). Absent on pre-branch rows. */
  branchId?: string;
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

/**
 * The operation record — what was actually done, written once after the procedure.
 * Absent until the surgeon writes it.
 */
export interface OperativeNote {
  procedurePerformed: string;
  surgeonId: string;
  /** ISO timestamp. */
  performedAt: string;
  findings?: string;
  notes?: string;
  recordedBy?: string;
  recordedAt: string;
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
  operativeNote?: OperativeNote;
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
  /** The pre-op line for the OT list — "bring 2 units", "diabetic, first on the list". */
  notes?: string;
}

export interface RecordOperativeNoteInput {
  procedurePerformed: string;
  surgeonId: string;
  /** ISO timestamp. */
  performedAt: string;
  findings?: string;
  notes?: string;
}

export interface ListBookingsQuery {
  from?: string;
  to?: string;
  /** Names a patient → their whole surgical history, not one day's board. */
  patientId?: string;
  theatreId?: string;
  status?: OtBookingStatus;
}

/* ── emergency department (D10) ── */

export type TriagePriority = "critical" | "urgent" | "non_urgent";

/** The triage judgement on one ED visit. `priority` is absent until somebody assesses them. */
export interface EdTriage {
  encounterId: string;
  patientId: string;
  priority?: TriagePriority;
  chiefComplaint?: string;
  triagedAt?: string;
  triagedBy?: string;
  transferredTo?: string;
  transferNote?: string;
  transferredAt?: string;
}

/** One line on the emergency board. */
export interface EdBoardRow {
  encounterId: string;
  patientId: string;
  patientName: string;
  uhid: string;
  arrivedAt: string;
  /** Whole minutes since arrival, on the SERVER's clock — never the browser's. */
  waitingMinutes: number;
  priority?: TriagePriority;
  chiefComplaint?: string;
  triagedAt?: string;
  status: string;
  doctorId?: string;
  token?: number;
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

/* ── assets & maintenance (B7) ── */

export type AssetCategory =
  | "biomedical"
  | "imaging"
  | "it_equipment"
  | "furniture"
  | "vehicle"
  | "hvac"
  | "electrical"
  | "other";
export type AssetStatus = "in_service" | "under_maintenance" | "retired";
export type MaintenanceType = "preventive" | "repair" | "inspection" | "calibration";

/** A piece of equipment on the register. Money fields are PAISE. Dates are `YYYY-MM-DD`. */
export interface Asset {
  id: string;
  assetTag: string;
  name: string;
  category: AssetCategory;
  status: AssetStatus;
  location?: string;
  manufacturer?: string;
  modelNumber?: string;
  serialNumber?: string;
  purchaseDate?: string;
  purchaseCost?: number;
  warrantyExpiry?: string;
  serviceIntervalDays?: number;
  nextServiceDue?: string;
  lastServicedOn?: string;
  notes?: string;
  branchId?: string;
}

/** One service done on an asset. `cost` is PAISE; dates are `YYYY-MM-DD`. */
export interface AssetMaintenance {
  id: string;
  assetId: string;
  type: MaintenanceType;
  performedOn: string;
  performedBy?: string;
  cost?: number;
  notes?: string;
  nextServiceDue?: string;
  branchId?: string;
}

/* ── feedback & complaints (B10) ── */

export type FeedbackKind = "feedback" | "complaint";
export type FeedbackCategory =
  | "service"
  | "staff"
  | "billing"
  | "cleanliness"
  | "food"
  | "waiting_time"
  | "clinical"
  | "facilities"
  | "other";
export type FeedbackChannel = "in_person" | "phone" | "email" | "web" | "suggestion_box" | "other";
export type ComplaintSeverity = "low" | "medium" | "high";
export type FeedbackStatus = "open" | "in_progress" | "resolved" | "closed";

export interface FeedbackStatusChange {
  from: FeedbackStatus;
  to: FeedbackStatus;
  at: string;
  by?: string;
  note?: string;
}

/** A compliment or grievance on the register, with its lifecycle history. */
export interface FeedbackTicket {
  id: string;
  kind: FeedbackKind;
  category: FeedbackCategory;
  channel: FeedbackChannel;
  subject: string;
  description: string;
  patientId?: string;
  reporterName?: string;
  reporterPhone?: string;
  rating?: number;
  severity?: ComplaintSeverity;
  status: FeedbackStatus;
  assignedTo?: string;
  resolutionNote?: string;
  statusHistory: FeedbackStatusChange[];
  branchId?: string;
  createdAt: string;
  updatedAt: string;
}

/* ── lab test catalogue (D6 / LIS depth) ── */

/** One measured parameter of a test. Numeric bounds drive auto-flagging; `refText` prints. */
export interface Analyte {
  code: string;
  label: string;
  unit?: string;
  refLow?: number;
  refHigh?: number;
  refText?: string;
}

/** A catalogue test — defined once, with its analytes and ranges. */
export interface LabTest {
  id: string;
  code: string;
  name: string;
  specimenType?: string;
  analytes: Analyte[];
  active: boolean;
  branchId?: string;
}

/* ── medico-legal records (C3): consent + death record ── */

export type ConsentType =
  | "general"
  | "admission"
  | "surgical"
  | "anaesthesia"
  | "procedure"
  | "blood_transfusion"
  | "high_risk"
  | "hiv_test"
  | "dnr"
  | "research";

export type ConsentSigner = "patient" | "guardian" | "spouse" | "parent" | "next_of_kin";
export type ConsentStatus = "active" | "withdrawn";

/** A structured informed consent — the facts on the form, not a scan of it. Withdrawable. */
export interface Consent {
  id: string;
  patientId: string;
  encounterId?: string;
  type: ConsentType;
  procedure: string;
  risksExplained?: string;
  signedBy: ConsentSigner;
  signerName: string;
  relationship?: string;
  language?: string;
  witnessName?: string;
  explainedBy?: string;
  signedAt: string;
  status: ConsentStatus;
  withdrawnAt?: string;
  withdrawalReason?: string;
  createdAt: string;
}

export type MannerOfDeath =
  "natural" | "accident" | "suicide" | "homicide" | "pending" | "undetermined";

/** The statutory death record — cause-of-death chain, manner, medico-legal flag. One per stay. */
export interface DeathRecord {
  id: string;
  patientId: string;
  encounterId: string;
  diedAt: string;
  pronouncedAt?: string;
  immediateCause: string;
  antecedentCause?: string;
  underlyingCause?: string;
  contributingConditions?: string;
  manner: MannerOfDeath;
  medicoLegal: boolean;
  postmortemRequired: boolean;
  certifiedBy?: string;
  bodyHandedTo?: string;
  bodyHandedRelationship?: string;
  remarks?: string;
  createdAt: string;
}

/* ── MRD: ICD-10 coding + disease register ── */

export interface IcdCode {
  id: string;
  code: string;
  title: string;
  chapter?: string;
  active: boolean;
}

export interface CodedDiagnosis {
  code: string;
  title: string;
  primary: boolean;
}

/** The coded diagnoses on one visit — one coding per encounter. */
export interface EncounterCoding {
  encounterId: string;
  patientId: string;
  codes: CodedDiagnosis[];
  codedBy?: string;
  codedAt: string;
}

export interface DiseaseRegisterRow {
  code: string;
  title: string;
  cases: number;
}

/* ── mortuary: body custody register ── */

export type MortuaryStatus = "in_storage" | "released";

export interface MortuaryEntry {
  id: string;
  patientId: string;
  encounterId: string;
  deathRecordId?: string;
  deceasedName: string;
  receivedAt: string;
  receivedBy?: string;
  tagNumber: string;
  storageUnit?: string;
  medicoLegal: boolean;
  status: MortuaryStatus;
  releasedAt?: string;
  releasedBy?: string;
  releasedTo?: string;
  releasedRelationship?: string;
  clearanceRef?: string;
  remarks?: string;
  createdAt: string;
}

/* ── consultation note (D3 / EMR depth) ── */

export type DiagnosisType = "provisional" | "final";

export interface Diagnosis {
  text: string;
  code?: string;
  type: DiagnosisType;
}

/** The structured note for one visit — one per encounter. */
export interface ConsultationNote {
  encounterId: string;
  patientId: string;
  doctorId?: string;
  chiefComplaint?: string;
  history?: string;
  examination?: string;
  diagnoses: Diagnosis[];
  plan?: string;
  followUpDays?: number;
  branchId?: string;
  updatedAt: string;
}

/* ── MAR — medication administration (D5 / nursing) ── */

export type MarStatus = "given" | "held" | "refused" | "not_available";

/**
 * One line of the ward worklist — a nurse's triage view of an admitted patient.
 *
 * Every number here is the SERVER's. `dosesDue` and `dosesOverdue` are resolved in the branch's
 * timezone against real administration rows; never recompute them from a local clock, and never
 * infer "missed" from a handset's idea of the time.
 */
export interface WorklistRow {
  encounterId: string;
  patientId: string;
  ward?: string;
  bedCode?: string;
  admittedAt?: string;
  status: string;
  /** Active allergen CODES. Empty means none RECORDED — which is not the same as none. */
  allergens: string[];
  severeAllergy: boolean;
  dosesDue: number;
  /** A subset of `dosesDue`, never additional to it. */
  dosesOverdue: number;
  /**
   * When observations were last charted on this stay; absent means none on this admission.
   *
   * There is no "obs overdue" counterpart, and that is deliberate: nothing in the product records
   * how often a given patient should be observed, so any lateness a client computed would be a
   * protocol it invented. Show the time; let the nurse judge it.
   */
  latestVitalsAt?: string;
  /** The SERVER's assessment of that reading. Never re-derive it from the values. */
  vitalsAbnormal: boolean;
}

/** One dose given (or held/refused) to an inpatient against a signed prescription line. */
export interface MedicationAdministration {
  id: string;
  encounterId: string;
  patientId: string;
  prescriptionId: string;
  /** Which line of the prescription. Absent on rows charted before dose slots existed. */
  lineIndex?: number;
  drugCode: string;
  drugName: string;
  dose: string;
  route: string;
  status: MarStatus;
  /** The dose slot this answers. Absent for PRN, which has no slots and is repeatable. */
  scheduledFor?: string;
  administeredAt: string;
  reason?: string;
  note?: string;
  administeredBy?: string;
}

/**
 * What a scheduled dose is showing.
 *
 * The four `MarStatus` values are recorded facts. `due` and `overdue` are derived BY THE SERVER
 * from the ward's clock — never compute them locally, or a phone in the wrong timezone decides
 * whether a patient's antibiotic is late.
 */
export type DoseState = MarStatus | "due" | "overdue";

/** One dose the prescription says is expected today, and what happened to it. */
export interface DoseSlot {
  prescriptionId: string;
  lineIndex: number;
  drugCode: string;
  drugName: string;
  dose: string;
  route: string;
  frequency: string;
  /** The instant the dose is due, ISO. Render it in the BRANCH's zone. */
  scheduledFor: string;
  state: DoseState;
  administrationId?: string;
  administeredAt?: string;
  administeredBy?: string;
  reason?: string;
}

/**
 * One patient on the ward's medication round, with every dose expected of them that day.
 *
 * ── THE ROUND IS A NAVIGATOR, NOT A SECOND SOURCE OF TRUTH ──────────────────
 * `slots` is the SAME `DoseSlot` the per-encounter schedule returns, derived by the same
 * server-side function. Take a slot's `prescriptionId` + `lineIndex` + `scheduledFor` and hand
 * that identity to the confirmation screen; do NOT carry `state`, the drug name or the dose across
 * as fact, and never chart a dose straight from a row on this list. By the time a finger lands on
 * it, another nurse may have answered it.
 */
export interface MedicationRoundRow {
  encounterId: string;
  patientId: string;
  /** Resolved server-side. Unlike `WorklistRow`, a round row always identifies its patient. */
  patientName: string;
  uhid: string;
  ward?: string;
  bedCode?: string;
  /** Active allergen CODES, hospital-wide. Empty means none RECORDED — never "no allergies". */
  allergens: string[];
  severeAllergy: boolean;
  /** Every dose on the chosen ward day, earliest first, answered or not. */
  slots: DoseSlot[];
  /** Outstanding doses among `slots`, counted by the server in the ward's timezone. */
  dosesDue: number;
  /** A subset of `dosesDue`, never additional to it. */
  dosesOverdue: number;
}

/**
 * What `HMS-MAR-001` carries — "somebody already answered this dose slot".
 *
 * ── THIS IS AN ANSWER, NOT A FAILURE, AND THE TYPE SAYS SO ──────────────────
 * A key conflict (`HMS-REQ-002`) means *you* already sent this request. `HMS-MAR-001` means a
 * possibly DIFFERENT nurse, on a different device, under a different key, already gave this dose —
 * only the unique index can know that, and only the database can arbitrate it. `existing` is the
 * administration holding the slot, and showing it is the whole point: a client that renders a
 * generic "something went wrong, retry" here is inviting a second dose into a patient.
 */
export interface MarSlotTaken {
  /** The slot that is taken, ISO. Render in the branch's zone. */
  scheduledFor: string;
  drugName: string;
  /**
   * Who holds it. Absent when the winning row sits in a branch this caller cannot read — the
   * refusal still stands, the server simply cannot name it, and a client must say so rather than
   * imply the dose was not given.
   */
  existing?: MedicationAdministration;
}

/**
 * Reads the slot-taken payload off an error, or `undefined` if it is not one.
 *
 * Lives here rather than in each app because it is the WIRE contract: the shape of
 * `details` is the API's promise, and two clients parsing it by hand is two chances to get the
 * clinically important case wrong.
 */
export function marSlotTaken(error: unknown): MarSlotTaken | undefined {
  if (!(error instanceof ApiClientError) || error.code !== "HMS-MAR-001") return undefined;
  const details = error.details as Partial<MarSlotTaken> | undefined;
  if (!details || typeof details.scheduledFor !== "string") return undefined;
  return {
    scheduledFor: details.scheduledFor,
    drugName: typeof details.drugName === "string" ? details.drugName : "this medication",
    ...(details.existing ? { existing: details.existing } : {}),
  };
}

/**
 * Which dose an attempt answers, by the identity M3-S1 established.
 *
 * ── THREE PARTS, AND ALL THREE ARE LOAD-BEARING ─────────────────────────────
 * `prescriptionId` + `lineIndex` + `scheduledFor`. Not `drugCode`: one prescription may
 * legitimately carry paracetamol QID on the round AND paracetamol SOS for breakthrough fever, and
 * matching on the code takes whichever comes first — charting the regular line when the nurse
 * meant the PRN one, or the 08:00 slot when they meant 14:00. A signed prescription's lines are
 * immutable, so the line POSITION is safe as an identity (`mar.model.ts` explains why).
 *
 * Not the drug NAME either, ever. Display text is for humans.
 */
export interface SlotRef {
  prescriptionId: string;
  lineIndex: number;
  scheduledFor: string;
}

export function sameSlot(slot: DoseSlot, ref: SlotRef): boolean {
  return (
    slot.prescriptionId === ref.prescriptionId &&
    slot.lineIndex === ref.lineIndex &&
    slot.scheduledFor === ref.scheduledFor
  );
}

export function findSlot(
  slots: readonly DoseSlot[] | undefined,
  ref: SlotRef,
): DoseSlot | undefined {
  return slots?.find((slot) => sameSlot(slot, ref));
}

/**
 * The identity to hand an administration screen — and the ONLY thing that should travel.
 *
 * Not the drug name, not the dose, not the state. By the time a nurse acts on a row the world may
 * have moved: another nurse may have answered that slot in the seconds since a round rendered. The
 * destination re-reads all of it from the server and matches on this triple, so carrying anything
 * else across is carrying a stale clinical claim.
 *
 * Lives beside `sameSlot` and `findSlot` because it is the CONSTRUCTOR for the type they consume —
 * a round on the phone and a round in the browser must spell the identity the same way, and two
 * hand-written copies of a three-field literal is how one of them quietly starts sending
 * `drugCode`.
 */
export function slotRef(slot: DoseSlot): SlotRef {
  return {
    prescriptionId: slot.prescriptionId,
    lineIndex: slot.lineIndex,
    scheduledFor: slot.scheduledFor,
  };
}

/**
 * Is this slot still open to an answer?
 *
 * `due` and `overdue` are the only open states, and both are DERIVED BY THE SERVER from the ward's
 * clock; the other four are recorded facts. An overdue dose is still very much giveable — that is
 * the whole point of showing it — so lateness gates nothing.
 *
 * Advisory only. The DATABASE refuses the second write whatever this returns, which is what makes
 * it safe for two nurses to have the same screen open at the same moment.
 */
export function isSlotOpen(slot: Pick<DoseSlot, "state">): boolean {
  return slot.state === "due" || slot.state === "overdue";
}

/** The answer already on a slot, for rendering instead of the actions. */
export function slotAnsweredAs(slot: DoseSlot): MarStatus | undefined {
  return isSlotOpen(slot) ? undefined : (slot.state as MarStatus);
}

/**
 * What one attempt at answering a dose came to.
 *
 * ── `unknown` IS NOT `failed`, AND THE DIFFERENCE IS THE POINT ──────────────
 * A client that cannot establish what happened must say exactly that. A nurse told "we could not
 * confirm this" checks the chart; a nurse told "not saved" gives the dose again.
 */
export type AdministerResult =
  /** The server wrote it. The only state that may be shown as done. */
  | { outcome: "recorded"; entry: MedicationAdministration }
  /**
   * The slot was already answered — by us on a lost attempt, or by another nurse. NOT a failure:
   * it is the answer, and `existing` (when the server could name it) says who and when.
   */
  | { outcome: "alreadyAnswered"; existing?: MedicationAdministration; drugName: string }
  /** Nothing was written and re-sending will not help. Show it; do not offer a retry. */
  | { outcome: "failed"; error: unknown }
  /**
   * We could not find out. The slot still reads open, so the dose is PROBABLY not charted — but
   * "probably" is why this is its own state and not `failed`.
   */
  | { outcome: "unknown"; error: unknown };

export interface AdministerDeps {
  /** `POST …/medication-administrations`, with the intent key. Called AT MOST ONCE per attempt. */
  record: () => Promise<MedicationAdministration>;
  /** `GET …/medication-schedule` — the slot oracle, read only when the attempt was ambiguous. */
  reloadSchedule: () => Promise<DoseSlot[]>;
  /** Which slot this attempt answers. */
  ref: SlotRef;
}

/**
 * The clinical schema refusals: the server could not enforce the rule this write rests on.
 *
 * Every one is raised by a capability guard that runs as the FIRST statement of its service
 * function — before the prescription is read, before the transaction opens, before anything is
 * written. So a response carrying one of these codes is a guarantee that nothing was recorded,
 * which is a stronger promise than "the request failed" and is why they can be classified rather
 * than reconciled.
 *
 * Exported because the same list decides what the CLIENT tells a clinician to do, and a second
 * copy of it is a second chance for the two to disagree about whether a dose was charted.
 */
export const CLINICAL_SCHEMA_REFUSALS = [
  "HMS-MAR-002",
  "HMS-PHM-004",
  "HMS-ORD-001",
  "HMS-ADM-003",
  "HMS-ENC-001",
] as const;

export function isClinicalSchemaRefusal(error: unknown): boolean {
  return (
    error instanceof ApiClientError &&
    (CLINICAL_SCHEMA_REFUSALS as readonly string[]).includes(error.code ?? "")
  );
}

/**
 * Errors decided BEFORE anything could be written.
 *
 * `HMS-REQ-002` — this key was used for a different body — belongs here and is worth the note: the
 * request was refused outright, so nothing was charted under it, and reconciling would find
 * whatever the EARLIER request wrote and risk reporting it as this one.
 *
 * `HMS-REQ-004` (the same key is still in flight) is deliberately NOT here. That first attempt may
 * be committing right now, so the only honest answer comes from the slot.
 *
 * ── WHY A 503 IS HERE AT ALL, WHICH LOOKS WRONG ─────────────────────────────
 * A 5xx normally means "ask the slot": the write may have committed before the connection died.
 * `HMS-MAR-002` is the exception, and only because of WHERE it is raised — `assertChartingIsSafe()`
 * is the first line of `recordAdministration`, so the refusal happens before the service has
 * looked at anything. Reconciling it was not unsafe (the slot correctly read open) but it was
 * useless, and it cost the nurse the answer: `unknown` renders "we could not confirm… press
 * again", so she was told to keep pressing a button that cannot succeed for the next minute,
 * while the instruction the server actually sent — chart on paper and escalate — was discarded.
 *
 * Only the refusal for THIS write belongs here. A `HMS-ORD-001` arriving on a dose route would
 * mean something has gone wrong that no classifier should paper over.
 */
function isDefinitelyNotWritten(error: unknown): boolean {
  if (!(error instanceof ApiClientError)) return false;
  return (
    error.isUnauthenticated ||
    error.isForbidden ||
    error.code === "HMS-VAL-001" ||
    error.code === "HMS-GEN-404" ||
    error.code === "HMS-STATE-001" ||
    error.code === "HMS-REQ-002" ||
    error.code === "HMS-MAR-002"
  );
}

/**
 * One attempt at answering a dose — the safety spine every surface that charts a dose must use.
 *
 *     record
 *       ├─ 201                  → recorded
 *       ├─ 409 HMS-MAR-001      → alreadyAnswered   ← the slot's own answer, with `existing`
 *       ├─ 401/403/400/404/422  → failed (decided before the write)
 *       └─ anything else        → ask the slot      ← every timeout, every 5xx, HMS-REQ-004
 *
 *     ask the slot = re-read the schedule and look at THIS slot
 *       ├─ answered             → alreadyAnswered
 *       ├─ still due / overdue  → unknown           ← almost certainly not written, but not proven
 *       └─ reload failed / gone → unknown
 *
 * ── WHY THIS LIVES IN THE CLIENT PACKAGE ────────────────────────────────────
 * For the reason `marSlotTaken` above does, only more so. Which HTTP failures mean "nothing was
 * written" is the API's promise, not a per-app opinion, and a second copy of this classification
 * is a second chance to tell a nurse "not saved" about a dose that is already in the patient.
 * Both the phone and the web browser chart doses; they must reach the same verdict from the same
 * response, and the way to guarantee that is to have one implementation.
 *
 * Nothing here checks for duplicates. A client-side "has this been given?" test cannot be
 * authoritative — between the check and the request another nurse's dose fits — and writing one
 * would create a second, weaker answer to a question the unique index already answers exactly.
 */
export async function attemptAdministration(deps: AdministerDeps): Promise<AdministerResult> {
  try {
    return { outcome: "recorded", entry: await deps.record() };
  } catch (error) {
    const taken = marSlotTaken(error);
    if (taken) {
      return {
        outcome: "alreadyAnswered",
        drugName: taken.drugName,
        ...(taken.existing ? { existing: taken.existing } : {}),
      };
    }
    if (isDefinitelyNotWritten(error)) return { outcome: "failed", error };
    return reconcileSlot(deps, error);
  }
}

/**
 * "Is this dose charted?" — asked of the slot, which is the only thing that can answer it.
 *
 * Exported so a screen can ask on its own: a nurse whose tab was suspended mid-save, or who
 * reloaded the page, must get the answer from this path rather than from a hopeful refetch nobody
 * classifies.
 */
export async function reconcileSlot(
  deps: AdministerDeps,
  error: unknown,
): Promise<AdministerResult> {
  let slots: DoseSlot[];
  try {
    slots = await deps.reloadSchedule();
  } catch {
    // The original failure is what the nurse is told about. The reload failing on top of it is our
    // problem, and reporting it would replace a useful message with a confusing one.
    return { outcome: "unknown", error };
  }

  const slot = findSlot(slots, deps.ref);
  // The slot has vanished from today's schedule — the order was stopped, or the day rolled over in
  // the ward's zone while the screen sat open. Nothing can be concluded about the dose from that.
  if (!slot) return { outcome: "unknown", error };

  if (isSlotOpen(slot)) return { outcome: "unknown", error };

  return {
    outcome: "alreadyAnswered",
    drugName: slot.drugName,
    ...(slot.administrationId
      ? {
          existing: {
            id: slot.administrationId,
            status: slot.state as MarStatus,
            drugName: slot.drugName,
            ...(slot.administeredAt ? { administeredAt: slot.administeredAt } : {}),
            ...(slot.administeredBy ? { administeredBy: slot.administeredBy } : {}),
            ...(slot.reason ? { reason: slot.reason } : {}),
          } as MedicationAdministration,
        }
      : {}),
  };
}

/* ── insurance (patient policies + claims) ── */

export type PolicyType = "cashless" | "reimbursement" | "government" | "corporate";
export type PolicyRelationship = "self" | "spouse" | "child" | "parent" | "other";
export type PolicyStatus = "active" | "inactive";
export type ClaimType = "cashless" | "reimbursement" | "preauth";
export type ClaimStatus =
  "draft" | "submitted" | "approved" | "partially_approved" | "rejected" | "settled";

/** A patient's insurance policy. Money (`sumInsured`) is PAISE; dates are `YYYY-MM-DD`. */
export interface InsurancePolicy {
  id: string;
  patientId: string;
  insurer: string;
  tpaName?: string;
  policyNumber: string;
  policyType: PolicyType;
  planName?: string;
  policyHolderName?: string;
  relationship?: PolicyRelationship;
  validFrom?: string;
  validTo?: string;
  sumInsured?: number;
  status: PolicyStatus;
  notes?: string;
  branchId?: string;
}

export interface ClaimStatusChange {
  from: ClaimStatus;
  to: ClaimStatus;
  at: string;
  by?: string;
  note?: string;
}

/** A claim filed against a policy. All amounts are PAISE. */
export interface InsuranceClaim {
  id: string;
  patientId: string;
  policyId: string;
  encounterId?: string;
  /** The bill whose insurer share this claim recovers (payer split). */
  invoiceId?: string;
  claimType: ClaimType;
  claimNumber?: string;
  claimedAmount: number;
  approvedAmount?: number;
  settledAmount?: number;
  status: ClaimStatus;
  notes?: string;
  statusHistory: ClaimStatusChange[];
  branchId?: string;
  createdAt: string;
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
  /**
   * The site the observation was taken at.
   *
   * Present because the PATIENT trend (`listPatientVitals`) is deliberately tenant-wide — a weight
   * recorded at one branch is the same person's weight at another — so one list can genuinely span
   * sites in different timezones. Render each reading's time in ITS branch's zone, not the
   * reader's active one, or a 22:00 observation from another city reads as 20:30 here.
   */
  branchId?: string;
  flags: Partial<Record<VitalField, VitalFlag>>;
  /** True when any recorded value is outside its adult reference range. */
  abnormal: boolean;
  bmi?: number;
}

/* ── charting observations when the network is not certain (M3-S4) ─────────── */

/**
 * ── TWO LAYERS, BECAUSE THEY FIX DIFFERENT FAILURES ─────────────────────────
 * `POST /encounters/:id/vitals` has carried `idempotent()` since it shipped, and the key is the
 * strong guarantee: the same key replays the original 201 and writes nothing.
 *
 * The key still does not tell the NURSE what happened. When the response is lost the client has no
 * idea whether the observation landed, and the honest answer to "is it on the chart?" can only
 * come from the chart. So every ambiguous ending re-reads the visit's readings and looks for one
 * that was not there before.
 *
 * ── WHY BOTH, WHEN EITHER SOUNDS SUFFICIENT ─────────────────────────────────
 * They fail differently. A key is scoped to one attempt from one device and expires out of the
 * store; the chart is the record and does not. Deleting the key would bring back duplicate
 * readings; deleting the reconciliation would leave the nurse guessing and re-entering, which is
 * how the duplicate arrives by a different road.
 *
 * ── WHEN IN DOUBT, SAY IT DID NOT SAVE ──────────────────────────────────────
 * If there is no reliable snapshot to compare against, this refuses to conclude anything and
 * reports `notSaved`. The two errors are not symmetric:
 *
 *   wrongly "saved"     → the nurse walks away and the observation is GONE. Unrecoverable, and
 *                         the next clinician reads a gap as "nobody has been".
 *   wrongly "not saved" → the nurse presses save again. With the key that is a REPLAY, so the
 *                         likely cost is nothing at all, and the worst case is one duplicate row.
 *
 * The cheap failure is the one to choose, every time.
 *
 * ── WHY IT LIVES IN THIS PACKAGE ────────────────────────────────────────────
 * It was written for the phone (M3-S4) and moved here when the WEB vitals form needed exactly the
 * same envelope. Which HTTP failures mean "nothing was written", and how to recognise our own
 * reading in a reloaded chart, are statements about the API's behaviour rather than about either
 * app — and a nurse and a doctor should not meet two different behaviours when the wifi drops in
 * the same corridor. Same reasoning as `attemptAdministration` above.
 */
export type VitalsOutcome =
  /** On the chart. `reconciled` means we learned it by re-reading, not from the response. */
  | { outcome: "saved"; reading: VitalsReading; reconciled: boolean }
  /** Confirmed or presumed absent. Pressing save again replays the same key — see above. */
  | { outcome: "notSaved"; error: unknown }
  /** Decided before anything could be written. Report it; a retry changes nothing. */
  | { outcome: "failed"; error: unknown };

export interface VitalsWriteDeps {
  /** `POST /encounters/:id/vitals`, with the intent key. Called AT MOST ONCE per attempt. */
  record: () => Promise<VitalsReading>;
  /** `GET /encounters/:id/vitals`. The oracle, read only when the attempt was ambiguous. */
  reload: () => Promise<VitalsReading[]>;
  /**
   * The visit's readings immediately before the attempt, or `undefined` if the screen never
   * loaded them. `undefined` disables the "saved" conclusion — see above.
   */
  before: readonly VitalsReading[] | undefined;
  /** The signed-in user. Narrows the match; `undefined` widens it, never breaks it. */
  recordedBy?: string;
}

/**
 * Errors decided BEFORE the observation could have been written, so there is nothing to reconcile.
 *
 * `HMS-VAL-001` is in this list and it is the interesting one: the server validates before the
 * insert, so a rejected value means nothing was charted — which is exactly why a screen can keep
 * the nurse's figures on screen and let them correct the flagged box.
 *
 * `HMS-REQ-002` (this key was used for a DIFFERENT body) is also definite: the earlier request
 * with this key is what exists, and the current one was refused. It is a bug if it happens, and
 * the nurse should see the refusal rather than a reconciliation that finds the earlier reading and
 * calls it this one.
 */
function vitalsDefinitelyNotWritten(error: unknown): boolean {
  if (!(error instanceof ApiClientError)) return false;
  return (
    error.isUnauthenticated ||
    error.isForbidden ||
    error.code === "HMS-VAL-001" ||
    error.code === "HMS-GEN-404" ||
    error.code === "HMS-REQ-002"
  );
}

/** Readings present now that were not present before — by id, so nothing depends on a clock. */
export function newReadingsSince(
  before: readonly VitalsReading[],
  after: readonly VitalsReading[],
): VitalsReading[] {
  const seen = new Set(before.map((reading) => reading.id));
  return after.filter((reading) => !seen.has(reading.id));
}

/**
 * Did OUR reading land?
 *
 * ── MATCHED ON IDENTITY AND AUTHORSHIP, NEVER ON THE VALUES ─────────────────
 * A set difference on ids against a snapshot, then the author. NOT the numbers — and that is the
 * whole point of the design. Two nurses on one bay can legitimately chart the same pulse a minute
 * apart, and a colleague's identical reading claimed as ours would report a save that never
 * happened and lose the observation. A timestamp window would be worse still: it needs the
 * device's clock to agree with the server's, which is the assumption this whole milestone refuses
 * to make.
 *
 * When several of our readings are new — possible if an earlier attempt landed unseen — the OLDEST
 * is returned. That is the one this submission created; anything after it came later.
 */
export function matchingReading(
  before: readonly VitalsReading[],
  after: readonly VitalsReading[],
  recordedBy: string | undefined,
): VitalsReading | undefined {
  const candidates = newReadingsSince(before, after).filter(
    (reading) => recordedBy === undefined || reading.recordedBy === recordedBy,
  );
  if (candidates.length === 0) return undefined;
  return candidates.reduce((oldest, reading) =>
    Date.parse(reading.recordedAt) < Date.parse(oldest.recordedAt) ? reading : oldest,
  );
}

/**
 * One attempt at charting observations, with reconciliation on every ambiguous ending.
 *
 *     record
 *       ├─ 201                          → saved
 *       ├─ 401 / 403 / 400 / 404 / 409* → failed (decided before the write)   *HMS-REQ-002 only
 *       └─ anything else                → reconcile   ← every timeout, every dropped connection
 *
 *     reconcile = re-read the visit's readings
 *       ├─ a new reading of ours        → saved (reconciled)
 *       ├─ none                         → notSaved
 *       ├─ no snapshot to compare       → notSaved   ← cannot conclude, so does not
 *       └─ reload also failed           → notSaved
 */
export async function attemptVitals(deps: VitalsWriteDeps): Promise<VitalsOutcome> {
  try {
    const reading = await deps.record();
    return { outcome: "saved", reading, reconciled: false };
  } catch (error) {
    if (vitalsDefinitelyNotWritten(error)) return { outcome: "failed", error };
    return reconcileVitals(deps, error);
  }
}

/**
 * "Did the observations actually land?" — asked of the chart.
 *
 * Exported so a screen can ask on its own: a nurse whose tab was suspended mid-save, or who
 * reloaded the page, must get the answer from this code path rather than from a hopeful refetch
 * nobody classifies.
 */
export async function reconcileVitals(
  deps: VitalsWriteDeps,
  error: unknown,
): Promise<VitalsOutcome> {
  // No baseline, no conclusion. Every reading in the list would look "new", and the first one
  // this nurse charted on this visit last night would be reported as this one.
  if (deps.before === undefined) return { outcome: "notSaved", error };

  let after: VitalsReading[];
  try {
    after = await deps.reload();
  } catch {
    // The original failure is what the nurse is told about. The reload failing on top of it is our
    // problem, and reporting it would replace a useful message with a confusing one.
    return { outcome: "notSaved", error };
  }

  const found = matchingReading(deps.before, after, deps.recordedBy);
  if (found) return { outcome: "saved", reading: found, reconciled: true };
  return { outcome: "notSaved", error };
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
  departmentId?: string;
  /** Every transition, with who made it and why — the desk's record of what happened. */
  statusHistory: AppointmentStatusChange[];
}

/** What a reschedule answers with: the retired appointment and the one that replaced it. */
export interface RescheduleResult {
  /** The original, now `rescheduled`. Its `rescheduledTo` points at the new one. */
  cancelled: Appointment;
  booked: Appointment;
}

/** A bookable slot. Computed per day from the doctor's weekly template — never stored. */ /* ── Status histories ───────────────────────────────────────────────────────
 * Every long-lived record carries the trail of how it got to its current state. The API has always
 * sent these; the client simply never declared them, so a screen that wanted to show "who
 * cancelled this, and why" had no typed way to read it.
 */

/** One transition of an appointment. */
export interface AppointmentStatusChange {
  from: AppointmentStatus;
  to: AppointmentStatus;
  at: string;
  by?: string;
  reason?: string;
}

/** One transition of an encounter. */
export interface EncounterHistoryEntry {
  from: EncounterStatus;
  to: EncounterStatus;
  at: string;
  by?: string;
  reason?: string;
}

/** One transition of an order. */
export interface OrderHistoryEntry {
  from: OrderStatus;
  to: OrderStatus;
  at: string;
  by?: string;
  reason?: string;
}

/** One transition of a prescription. */
export interface PrescriptionHistoryEntry {
  from: PrescriptionStatus;
  to: PrescriptionStatus;
  at: string;
  by?: string;
  reason?: string;
}

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
  /** The site this belongs to (ADR-0015). Absent on pre-branch rows. */
  branchId?: string;
}

/** The named parts of a clinic day (Doc 02 D2). `full_day` is its own option. */
export type DoctorSession = "morning" | "afternoon" | "evening" | "full_day";

/** One weekday of a doctor's simple session roster — the sessions they are in that day. */
export interface DoctorAvailability {
  doctorId: string;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  sessions: DoctorSession[];
  branchId?: string;
}

/** A block of days a doctor is away — inclusive `fromDate`..`toDate` (`YYYY-MM-DD`). */
export interface DoctorLeave {
  id: string;
  doctorId: string;
  fromDate: string;
  toDate: string;
  reason?: string;
  branchId?: string;
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

/** The care setting. FHIR calls this `class`. */
export type EncounterClass = "OP" | "IP" | "ER" | "TELE" | "HOME";

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
  class: EncounterClass;
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
  /**
   * When the doctor called the patient in. ABSENT MEANS THE CONSULTATION HAS NOT STARTED.
   *
   * `doctorId` is who the patient is WAITING FOR — it is set at registration, before anyone has
   * been examined. Any document that attests to a clinical act (an OPD slip carrying a doctor's
   * signature) must read this, not `doctorId`.
   */
  seenAt?: string;
  /** Still-live orders (tests) on this visit. "Send for tests" needs at least one. */
  activeOrderCount: number;
  closedAt?: string;
  /** Every state transition, with who made it and why. */
  history: EncounterHistoryEntry[];
  createdAt: string;
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

/**
 * A visit on a LIST, carrying the patient it belongs to.
 *
 * Returned by `GET /encounters` (the queue, the register, the doctor's day) and `GET /inpatients`
 * (the ward). The identity is resolved by the API — the same `namesByIds` call the bed board and
 * the medication round already make, with the same hospital-wide semantics.
 *
 * ── A CLIENT MUST NEVER RECONSTRUCT THIS FROM A PATIENT LIST ────────────────
 * It reads as an obvious client-side join and it is wrong in a way nothing reports: the visits on
 * a queue and the first page of `/patients` are different populations, so a patient registered
 * before the page reaches back reduces to a dash. That is what `listInpatients` cost on the ward
 * and what `listEncounters` cost on the doctor's queue — 15 of 99 rows, silently.
 */
export interface EncounterRow extends Encounter {
  /** `Unknown patient` when the record cannot be read — never silently blank. */
  patientName: string;
  /** Empty only when the patient record itself carries none. */
  uhid: string;
}

/** The ward-list row. The same shape; the API names it separately and so do we. */
export type InpatientRow = EncounterRow;

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

/**
 * A worklist row — an `Order` that knows whose it is.
 *
 * Only the LIST carries the patient's name; a single order is fetched by someone who already
 * knows. Resolved server-side because a client joining against a page of patients blanks
 * everyone that page did not reach — see `listOrders`.
 */
export interface OrderRow extends Order {
  /** `Unknown patient` when the record cannot be read — never silently blank. */
  patientName: string;
  /** Empty only when the patient record itself carries none. */
  uhid: string;
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
  departmentId?: string;
  completedAt?: string;
  verifiedBy?: string;
  verifiedAt?: string;
  releasedAt?: string;
  result?: { summary?: string; values?: OrderResultValue[]; critical?: boolean };
  cancelReason?: string;
  /** The site this belongs to (ADR-0015). Absent on pre-branch rows. */
  branchId?: string;
  /** The client's idempotency key — a repeat of it returns this same order. */
  requestId?: string;
  /** Every state transition, with who made it and why. */
  history: OrderHistoryEntry[];
  createdAt: string;
}

export interface PlaceOrderResult {
  order: Order;
  /** True when this `requestId` had already placed it — a retry, not a new order. */
  duplicate: boolean;
}

/* ── billing (F-group) ────────────────────────────────────────────────────── */

export type ChargeCategory =
  "consultation" | "lab" | "radiology" | "pharmacy" | "procedure" | "bed" | "package" | "other";

export type InvoiceStatus = "draft" | "finalized" | "paid" | "cancelled";

/** A fixed-price care bundle — one price covers the services in `includedCodes`. Amounts PAISE. */
export interface CarePackage {
  id: string;
  code: string;
  name: string;
  description?: string;
  price: number;
  includedCodes: string[];
  active: boolean;
}

/** A package on a visit — snapshots the price and covered codes at enrol time. */
export interface PackageEnrollment {
  id: string;
  packageId: string;
  packageCode: string;
  packageName: string;
  price: number;
  includedCodes: string[];
  encounterId: string;
  patientId: string;
  status: "active" | "cancelled";
  chargeId?: string;
  enrolledAt: string;
}

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
/**
 * @deprecated Use `Charge`. This declared ten of the eighteen fields the server sends, so a
 * caller could not read `branchId`, `doctorId`, `source` or `voidReason` off a charge it already
 * had in hand.
 */
export type EncounterCharge = Charge;

/**
 * One payment taken against a bill.
 *
 * Named rather than written inline on `Invoice`, and the reason is the two fields the inline copy
 * had been missing for months: `by` (who took the money) and `requestId` (the idempotency key that
 * makes a double-clicked "Collect" take it once). A receipt screen needs the first and a retry
 * needs the second, and neither was reachable.
 */
export interface PaymentEntry {
  /** Paise. */
  amount: number;
  method: string;
  reference?: string;
  at: string;
  /** The user who recorded it. */
  by?: string;
  /** Client-supplied idempotency key — the same key never takes the money twice. */
  requestId?: string;
}

/**
 * A person a bill records an act by, as the printed receipt names them.
 *
 * `PaymentEntry.by` has always held the collector's user id; this is what turns it into a name
 * and, when they have uploaded one, the scanned signature that goes over the receipt's line.
 */
export interface InvoiceSignatory {
  userId: string;
  name: string;
  designation?: string;
  /** A `data:image/...;base64,…` URI. Absent means a blank line to sign by hand. */
  signature?: string;
}

/** Money handed back. Same shape as a payment, with a mandatory reason. */
export interface RefundEntry {
  /** Paise. */
  amount: number;
  method: string;
  reason: string;
  at: string;
  by?: string;
  requestId?: string;
}

export interface Invoice {
  id: string;
  encounterId: string;
  patientId: string;
  episodeId: string;
  number?: string;
  status: InvoiceStatus;
  lines: InvoiceLine[];
  subtotal: number;
  /** Paise off the subtotal — an approved write-down. `total = subtotal − discount`. */
  discount: number;
  discountReason?: string;
  total: number;
  paid: number;
  /** Paise an insurer is expected to bear (payer split). */
  coveredByInsurer: number;
  insurerPolicyId?: string;
  /** `total − coveredByInsurer` — the patient's own share, what the counter collects. */
  patientResponsibility: number;
  payments: PaymentEntry[];
  /** Money handed back. Net collected is `paid − refunded`. */
  refunds: RefundEntry[];
  refunded: number;
  finalizedAt?: string;
  createdAt: string;
  /** Optimistic-concurrency counter — a discount is applied against the version it read. */
  version: number;
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

/**
 * A visit carrying charges nobody has billed yet — one row of the cash counter's queue.
 *
 * Distinct from an `Invoice`: this is money owed that has no bill YET. Raising the bill
 * (`finalizeBill`) turns one of these into an Invoice, which is then payable.
 */
export interface PendingBill {
  encounterId: string;
  patientId: string;
  patientName: string;
  uhid: string;
  /** Paise waiting to be billed on this visit. */
  amount: number;
  /** How many charges make it up. */
  count: number;
  /** When the oldest waiting charge posted — how long this has gone unbilled. */
  since: string;
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
  /** Consultation only: days this fee buys free revisits to the same doctor. */
  followUpDays?: number;
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
/**
 * @deprecated Use `ServiceItem`, which is the name the contract publishes. Kept as an alias
 * because two identical hand-written copies of one server type are two things to keep in step.
 */
export type TariffItem = ServiceItem;

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
  /**
   * Who took the money — one row per cashier, heaviest first. What a desk run by several people
   * reconciles a drawer against. `collectedBy` is empty for payments posted without a user, and
   * `collectorName` reads "Not recorded" there: the row is kept so the parts still sum to `total`.
   */
  byCollector: { collectedBy: string; collectorName: string; amount: number; count: number }[];
  /** Paise. Bills settled from advance in the period — shown apart so it is not double-counted. */
  settledFromAdvance: number;
}

/** Revenue leakage — care given but never billed. Amounts are PAISE. */
export interface RevenueLeakageReport {
  /** Paise posted as a charge in the period but never put on a bill. The money at risk. */
  total: number;
  count: number;
  byCategory: { category: string; amount: number; count: number }[];
  bySource: { source: string; amount: number; count: number }[];
  /** The visits carrying unbilled charges, heaviest first — where to go and bill. */
  byEncounter: {
    encounterId: string;
    patientId: string;
    patientName: string;
    uhid: string;
    amount: number;
    count: number;
  }[];
}

/** Dues ageing — billed but unpaid, bucketed by age. Amounts are PAISE. */
export interface DuesAgeingReport {
  /** Paise still owed on finalized-but-unpaid bills, as of the report date. */
  totalOutstanding: number;
  invoiceCount: number;
  buckets: { bucket: "0-30" | "31-60" | "61-90" | "90+"; amount: number; count: number }[];
  /** The heaviest debts, for the collections desk to chase. */
  topDebtors: {
    invoiceId: string;
    number?: string;
    patientId: string;
    patientName: string;
    uhid: string;
    outstanding: number;
    ageDays: number;
  }[];
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
  /** Every state transition, with who made it and why. */
  history: PrescriptionHistoryEntry[];
  createdAt: string;
  notes?: string;
  /** Present only when the prescriber signed THROUGH a blocking safety alert. */
  safetyOverride?: {
    reason: string;
    by: string;
    at: string;
    /**
     * The alerts as they stood when the prescriber signed through them.
     *
     * NOT `SafetyAlert[]`: this is a frozen copy kept for the audit trail, and it is deliberately
     * smaller than the live screening result — it has no `drugCodes`. Typing it as the full alert
     * promised a field the server has never stored on this record.
     */
    alerts: { kind: string; severity: string; allergen?: string; message: string }[];
  };
  /** The site this belongs to (ADR-0015). Absent on pre-branch rows. */
  branchId?: string;
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
  /** The client's idempotency key — a repeat of it returns this same handover, never a second. */
  requestId?: string;
  /** Set when the handover was authorised on credit against an admitted patient's advance. */
  creditOverride?: { by: string; reason: string; shortfall: number; at: string };
  createdAt: string;
  /** The site this belongs to (ADR-0015). Absent on pre-branch rows. */
  branchId?: string;
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
  /** The site this belongs to (ADR-0015). Absent on pre-branch rows. */
  branchId?: string;
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

/* ── General store (G1/G3) — non-drug consumables ─────────────────────────────
 * A different room from the pharmacy, on purpose: a glove has no form, no strength and no
 * batch, and must never reach a prescribing pad. The shape mirrors the medicine master because
 * that pattern is proven, not because the two share a table.
 */

export const ITEM_CATEGORIES = [
  "consumable",
  "linen",
  "stationery",
  "housekeeping",
  "spare",
  "other",
] as const;
export type ItemCategory = (typeof ITEM_CATEGORIES)[number];

export const ITEM_UNITS = [
  "piece",
  "box",
  "pack",
  "pair",
  "roll",
  "metre",
  "litre",
  "kilogram",
] as const;
export type ItemUnit = (typeof ITEM_UNITS)[number];

/** An item as the store master holds it. The BALANCE is not here — see `StoreRow`. */
export interface InventoryItem {
  id: string;
  code: string;
  name: string;
  category: ItemCategory;
  unit: ItemUnit;
  /** At or below this the list calls it low. Zero means no flag. */
  reorderLevel: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export type StockPosition = "ok" | "low" | "out";

/**
 * An item WITH what is on the shelf the caller is looking at.
 *
 * `onHand` is per SITE, unlike the pharmacy's hospital-wide `stockUnits`: a store is a room, and
 * with a branch selected this is that room's count. In the aggregate view it is the sum across
 * the sites the user may see.
 */
export interface StoreRow extends InventoryItem {
  onHand: number;
  position: StockPosition;
}

export interface Supplier {
  id: string;
  code: string;
  name: string;
  phone?: string;
  email?: string;
  /** GSTIN / VAT / TIN, as printed on the invoice. Free text. */
  taxId?: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export type MovementKind = "receipt" | "issue" | "adjustment";

/** One line of the store ledger. Supplier and department names are captured at the time. */
export interface InventoryMovement {
  id: string;
  itemId: string;
  itemCode: string;
  kind: MovementKind;
  /** Signed: + in, − out. */
  delta: number;
  balanceAfter: number;
  supplierId?: string;
  supplierName?: string;
  invoiceRef?: string;
  unitCost?: number;
  departmentId?: string;
  departmentName?: string;
  reason?: string;
  branchId?: string;
  createdBy: string;
  createdAt: string;
}

export interface CreateItemInput {
  code: string;
  name: string;
  category: ItemCategory;
  unit: ItemUnit;
  reorderLevel?: number;
}

export type UpdateItemInput = Partial<Omit<CreateItemInput, "code">> & { active?: boolean };

export interface CreateSupplierInput {
  code: string;
  name: string;
  phone?: string;
  email?: string;
  taxId?: string;
}

export type UpdateSupplierInput = Partial<Omit<CreateSupplierInput, "code">> & {
  active?: boolean;
};

/**
 * Where an issue may go. Served by the STORE, not by `/departments` — a store keeper must not
 * hold `patient:read` merely to fill in a picker.
 */
export interface IssueDestination {
  id: string;
  name: string;
}

/** What a receive / issue / adjust answers with: the item, the new shelf, and the ledger row. */
export interface InventoryStockChange {
  item: InventoryItem;
  onHand: number;
  movement: InventoryMovement;
}

/* ── Admissions (ADR-0013 §4) ─────────────────────────────────────────────── */

export interface Bed {
  ward: string;
  bedCode: string;
  /** The tariff the bed-day is billed at — `BED_GEN`, `BED_ICU`. */
  tariffCode: string;
  /** The inventory bed (B4) this stay occupies, when admitted from the catalogue. */
  bedId?: string;
  // No `branchId`: this is the bed recorded ON an encounter, and the ENCOUNTER carries the site.
  // The field was declared here and never sent, so every read of it was `undefined`.
}

/**
 * `nursing` is the bedside entry — same collection and same chart as the medical notes, written
 * through its own endpoint under its own permission. It appears in `listWardNotes` without a
 * filter, which is the point: one chronological record, not two.
 */
export type WardNoteType = "progress" | "discharge_summary" | "outcome_note" | "nursing";

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
  /** The site this belongs to (ADR-0015). Absent on pre-branch rows. */
  branchId?: string;
}

/**
 * ── WHICH NOTE THIS USER MAY WRITE, AND THROUGH WHICH DOOR ──────────────────
 * Two endpoints write to the ward round and they are NOT interchangeable:
 *
 *   `emr:write`      → `POST /encounters/:id/notes`          → `type: "progress"`
 *   `nursing:manage` → `POST /encounters/:id/nursing-notes`  → `type: "nursing"`
 *
 * The API split them deliberately (M3-S2): `authorize()` takes exactly one permission, and a
 * nurse granted `emr:write` to reach the first door would also gain `discharge_summary` and
 * `outcome_note` — a doctor's record and the statutory account of a death. So there are two
 * doors, and a client has to pick the one the signed-in user actually holds.
 *
 * ── WHY THIS LIVES IN THE SHARED CLIENT AND NOT IN EACH APP ─────────────────
 * Both apps got it wrong in the same way and for months: each hard-coded `emr:write` and
 * `addWardNote`, so `nursing:manage` gated a route no client ever called and a nurse saw either
 * nothing (web hid the box) or a permanent 403 (mobile disabled the button). Duplicating the rule
 * a second time is how the NEXT note type ends up wired into one app only.
 *
 * ── THE ORDER IS THE RULE, AND IT PRESERVES TODAY'S BEHAVIOUR ───────────────
 * `emr:write` is tried FIRST. In the shipped catalogue the two are disjoint — `emr:write` is the
 * DOCTOR's alone and `nursing:manage` the NURSE's — so for every user that exists today this
 * returns exactly what the clients did before. A hospital that mints a custom role holding both
 * has said that person writes the doctor's record, and gets it unchanged rather than silently
 * demoted to a nursing note.
 */
export interface ChartNoteCapability {
  /** The permission that opens this door. Re-checked server-side on every request. */
  needs: "emr:write" | "nursing:manage";
  /**
   * What the SERVER will stamp on the note — never sent in the body (the nursing DTO is
   * `.strict()` with no `type` field, so naming one is a 400). Held here because reconciliation
   * after a lost response has to know what it is looking for on the chart.
   */
  type: Extract<WardNoteType, "progress" | "nursing">;
  /** What the box is called. A nurse writing "Progress note" is being asked the doctor's question. */
  label: string;
  placeholder: string;
}

/** The doctor's entry on the round. */
export const PROGRESS_NOTE: ChartNoteCapability = {
  needs: "emr:write",
  type: "progress",
  label: "Progress note",
  placeholder: "How is the patient today? What changed, what is planned…",
};

/** The nurse's bedside entry. Same chart, own door. */
export const NURSING_NOTE: ChartNoteCapability = {
  needs: "nursing:manage",
  type: "nursing",
  label: "Nursing note",
  placeholder: "What was observed, what was done, what to hand over…",
};

/** Most-privileged first — see the order rule above. */
export const CHART_NOTE_CAPABILITIES: readonly ChartNoteCapability[] = [
  PROGRESS_NOTE,
  NURSING_NOTE,
];

/**
 * The note this user may write, or `undefined` if they may write none.
 *
 * `undefined` is a real answer and callers must render nothing for it — a receptionist gets no
 * box at all rather than a disabled one, because there is nothing they could do to enable it.
 */
export function chartNoteCapability(
  can: (permission: string) => boolean,
): ChartNoteCapability | undefined {
  return CHART_NOTE_CAPABILITIES.find((capability) => can(capability.needs));
}

/**
 * Writes the note through the door the capability names.
 *
 * ── SEND THE KEY ────────────────────────────────────────────────────────────
 * Both routes carry `idempotent()` and neither collection de-duplicates. A note is append-only
 * with no update and no delete path, so a retry after a lost response is otherwise a permanent
 * duplicate on a medico-legal record. The parameter is optional because the ROUTES honour the
 * header rather than demanding it; every caller here should pass one.
 */
export function writeChartNote(
  api: Pick<ApiClient, "addWardNote" | "addNursingNote">,
  capability: ChartNoteCapability,
  encounterId: string,
  text: string,
  key?: string,
): Promise<WardNote> {
  return capability.type === "nursing"
    ? api.addNursingNote(encounterId, text, key)
    : api.addWardNote(encounterId, text, key);
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

/** A room's commercial class — how a hospital prices the space a bed sits in. */
export type RoomKind = "general" | "sharing" | "semi_private" | "private" | "deluxe" | "suite";
export type RoomStatus = "active" | "inactive";

export interface Ward {
  id: string;
  name: string;
  kind: WardKind;
  /** The default bed-day tariff for beds in this ward. */
  tariffCode: string;
  status: WardStatus;
  branchId?: string;
}

/** A room — the optional level between a ward and its beds (ward → room → bed), joined to its ward. */
export interface Room {
  id: string;
  wardId: string;
  name: string;
  kind: RoomKind;
  /** The room-class bed-day tariff, when set — the middle link of the bed → room → ward chain. */
  tariffCode?: string;
  status: RoomStatus;
  branchId?: string;
  wardName: string;
}

/**
 * A catalogue bed, joined to its ward (and room, if it has one). `tariffCode` is the EFFECTIVE
 * one, resolved bed → room → ward.
 */
export interface InventoryBed {
  id: string;
  wardId: string;
  /** The room this bed sits in, when it has one — absent for a bed on the open ward floor. */
  roomId?: string;
  code: string;
  /** LEGACY free-text room label, kept for beds catalogued before rooms were first-class. */
  room?: string;
  tariffCode: string;
  status: BedStatus;
  blockedReason?: string;
  branchId?: string;
  wardName: string;
  wardKind: WardKind;
  wardStatus: WardStatus;
  roomName?: string;
  roomKind?: RoomKind;
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
  /** LEGACY free-text room label — shown only when the bed has no first-class room. */
  room?: string;
  /** The first-class room this bed sits in, when it has one — the board groups by it. */
  roomId?: string;
  roomName?: string;
  roomKind?: RoomKind;
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

/**
 * Runtime licence state for the console (ADR-0016).
 *
 * `EXPIRING` is deliberately absent: it is a HEADER state (see `LicenseHeader`), computed per
 * request from the warning window, and no hospital record is ever stored or returned in it. One
 * type serving both meant the console carried a branch for a value the API cannot send.
 */
export type LicenseRuntimeState = "ACTIVE" | "GRACE" | "EXPIRED" | "PERPETUAL";

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
  status:
    | "provisioning"
    | "trial"
    | "active"
    | "suspended"
    | "expired"
    | "terminated"
    | "exported"
    | "purged";
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
  /**
   * The same rows `GET /subscription` returns. This was an inline copy that had lost `label` and
   * `ratio` and had made `limit`, `warning` and `exceeded` optional — so the console could not
   * render the usage bar it fetches this endpoint for, and `limit: null` (unlimited) did not
   * type-check against it at all.
   */
  usage: UsageLine[];
  features: string[];
}

/**
 * @deprecated Use `Plan`. This was a second, incomplete copy of the same server type — it had
 * lost `priceMinor` and `currency`, so the console could not show what an edition costs.
 */
export type Edition = Plan;

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

/**
 * The API version this client speaks. Every path it builds begins `/api/v1` or
 * `/api/platform/v1`, and that is not incidental — it is the compatibility promise the server
 * makes (Doc 04 §5.1, `docs/API_LIFECYCLE.md`): inside a version, changes are additive only.
 *
 * Exported so a mobile build can report what it speaks in a crash log, a support screen, or an
 * `X-Client-Version`-style diagnostic. A phone in the field is the one caller that cannot be
 * asked "which version are you on?" after the fact.
 */
export const API_VERSION = "v1" as const;

/**
 * A retirement notice read off a response (RFC 9745 `Deprecation`, RFC 8594 `Sunset`).
 *
 * ── WHY THE CLIENT SURFACES THIS AT ALL ────────────────────────────────────
 * The caller that needs it most cannot read the OpenAPI document: an app build installed
 * eighteen months ago, on a phone nobody will update, calling an endpoint that now has an end
 * date. It only ever learns about that date if the response it is already receiving carries it.
 *
 * So the client hands every notice to `onDeprecation` and lets the app decide — log it, report it
 * home, or show the "please update" banner while there is still a year to act. Nothing is
 * deprecated today; this is the receiver being in place BEFORE the first sender.
 */
export interface DeprecationNotice {
  /** ISO date the operation was deprecated, when the header carried a parseable value. */
  deprecatedAt: string | null;
  /** ISO date it stops answering. */
  sunsetAt: string | null;
  /** `rel` → URL, from the `Link` header: `deprecation` (docs), `successor-version`. */
  links: Record<string, string>;
}

/**
 * Reads the retirement headers, or null when the response carried none — which is the case for
 * every response the API sends today.
 */
export function readDeprecationHeaders(res: { headers: Headers }): DeprecationNotice | null {
  const deprecation = res.headers.get("deprecation");
  const sunset = res.headers.get("sunset");
  if (!deprecation && !sunset) return null;

  // RFC 9745 is a structured-field Item: `@<unix seconds>`. RFC 8594's `Sunset` is an HTTP-date.
  // Two adjacent headers in two formats is an inconsistency in the standards, not in us.
  const epoch = deprecation?.startsWith("@") ? Number(deprecation.slice(1)) : Number.NaN;
  const sunsetAt = sunset ? new Date(sunset) : null;

  const links: Record<string, string> = {};
  for (const entry of (res.headers.get("link") ?? "").split(/,(?=\s*<)/)) {
    const match = /<([^>]+)>\s*;\s*rel\s*=\s*"?([^";]+)"?/.exec(entry);
    if (match?.[1] && match[2]) links[match[2]] = match[1];
  }

  return {
    deprecatedAt: Number.isFinite(epoch) ? new Date(epoch * 1000).toISOString() : null,
    sunsetAt: sunsetAt && !Number.isNaN(sunsetAt.getTime()) ? sunsetAt.toISOString() : null,
    links,
  };
}

/**
 * A CSV export: the bytes, plus what a downloaded file cannot tell you about itself.
 *
 * `Blob` rather than a string or an ArrayBuffer, deliberately — React Native's fetch is
 * XHR-backed and implements `blob()` and `text()`, while `arrayBuffer()` is not available on
 * every version. A client that reached for `arrayBuffer()` would pass every test here and throw
 * on a phone.
 */
export interface CsvExport {
  blob: Blob;
  /** Rows written, from `x-audit-rows`. */
  rows: number | null;
  /** True when the export hit its cap — this file is NOT the whole trail. */
  truncated: boolean;
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
  private readonly onDeprecation?: (notice: DeprecationNotice, path: string) => void;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.getAccessToken = options.getAccessToken;
    this.credentials = options.credentials ?? "include";
    this.tenantHost = options.tenantHost;
    this.getActiveBranch = options.getActiveBranch;
    this.onUnauthorized = options.onUnauthorized;
    this.onLicenseState = options.onLicenseState;
    this.onDeprecation = options.onDeprecation;

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
    options?: RequestOptions,
  ): Promise<{ data: T; meta?: PageMeta }> {
    const token = this.getAccessToken?.();

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    if (this.tenantHost) headers.host = this.tenantHost;
    // The branch this request acts in (ADR-0015). Absent ⇒ the server treats it as aggregate mode.
    const activeBranch = this.getActiveBranch?.();
    if (activeBranch) headers["x-active-branch"] = activeBranch;
    /**
     * The caller's name for THIS intent (Doc 04 §5.1). Sent as given and never invented here —
     * a key minted inside the client would be new on every call, which protects nothing: the
     * two requests a double-click produces would carry two keys and the server would see two
     * unrelated payments. Only the caller knows which attempts are the same intent.
     */
    if (options?.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;

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

    /**
     * A retirement notice, if this operation carries one. Read on EVERY response rather than on
     * errors only: an endpoint being retired still works — that is the entire point of a sunset
     * window — so the only place the warning can appear is a successful response.
     */
    if (this.onDeprecation) {
      const notice = readDeprecationHeaders(res);
      if (notice) this.onDeprecation(notice, path);
    }

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
        // The SAME key on the replay, deliberately: this is one intent that had to be sent
        // twice, which is precisely the case the key exists for. A fresh key here would let a
        // token that expired between the write and its response take the money a second time.
        if (recovered) return this.send<T>(method, path, body, false, options);
      }

      throw error;
    }

    return { data: envelope.data as T, ...(envelope.meta ? { meta: envelope.meta } : {}) };
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<T> {
    return (await this.send<T>(method, path, body, true, options)).data;
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
  /**
   * Grants a role, and answers with the user's EFFECTIVE roles, branches and permissions after it.
   *
   * Typed `void` until Phase 2.1, which threw that away: a caller had to re-read the user to
   * discover what its own write had produced, and the permission set is derived (roles × branch
   * scope), so guessing it client-side is how a screen ends up disagreeing with the server.
   */
  assignStaffRole(userId: string, roleCode: string, branchIds: string[]): Promise<UserRoles> {
    return this.request<UserRoles>("POST", `/api/v1/users/${userId}/roles`, {
      roleCode,
      branchIds,
    });
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
  registerPatient(
    input: RegisterPatientInput,
    /**
     * Stable across the retries of ONE submission, new for a genuinely new one. Without it the
     * `idempotent()` middleware this route carries can never fire — see `checkClientContract.ts`
     * §6, which exists because two clinical routes shipped exactly that way.
     */
    key?: string,
  ): Promise<RegisterPatientResult> {
    return this.request<RegisterPatientResult>("POST", "/api/v1/patients", input, {
      ...(key ? { idempotencyKey: key } : {}),
    });
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

  /**
   * The OT board — bookings intersecting a day window (defaults to today). Needs `emr:read`.
   * Passing `patientId` with no window asks the chart's question instead: every procedure that
   * patient has ever had, oldest first.
   */
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

  /**
   * Writes the operation record onto a started or completed procedure. Needs `ot:record`.
   * Written once — a second call is a 409, not an overwrite.
   */
  recordOperativeNote(id: string, input: RecordOperativeNoteInput): Promise<OtBooking> {
    return this.request<OtBooking>("POST", `/api/v1/ot-bookings/${id}/operative-note`, input);
  }

  /* ── emergency department (D10) ── */

  /**
   * Everyone currently in the emergency department, worst first — untriaged at the very top.
   * Needs `encounter:read` + the emergency module.
   */
  edBoard(): Promise<EdBoardRow[]> {
    return this.request<EdBoardRow[]>("GET", "/api/v1/emergency/board");
  }

  /**
   * Assess, or re-assess, an ED patient. Needs `triage:perform` + the emergency module.
   * Re-triage overwrites the judgement on the same visit — it does not add a second one.
   */
  triagePatient(input: {
    encounterId: string;
    priority: TriagePriority;
    chiefComplaint?: string;
  }): Promise<EdTriage> {
    return this.request<EdTriage>("POST", "/api/v1/emergency/triage", input);
  }

  /**
   * The patient left for another hospital: records where they went, then closes the visit.
   * Needs `encounter:close` + the emergency module.
   */
  transferOutOfEd(input: {
    encounterId: string;
    destination: string;
    note?: string;
  }): Promise<EdTriage> {
    return this.request<EdTriage>("POST", "/api/v1/emergency/transfer-out", input);
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

  /* ── assets & maintenance (B7) ── */

  /** The asset register, optionally filtered by state or category. Needs `asset:manage`. */
  listAssets(query: { status?: AssetStatus; category?: AssetCategory } = {}): Promise<Asset[]> {
    const qs = new URLSearchParams(
      Object.entries(query).filter(([, v]) => v != null) as [string, string][],
    ).toString();
    return this.request<Asset[]>("GET", `/api/v1/assets${qs ? `?${qs}` : ""}`);
  }

  createAsset(input: {
    assetTag: string;
    name: string;
    category: AssetCategory;
    location?: string;
    manufacturer?: string;
    modelNumber?: string;
    serialNumber?: string;
    purchaseDate?: string;
    purchaseCost?: number;
    warrantyExpiry?: string;
    serviceIntervalDays?: number;
    nextServiceDue?: string;
  }): Promise<Asset> {
    return this.request<Asset>("POST", "/api/v1/assets", input);
  }

  updateAsset(
    id: string,
    patch: {
      name?: string;
      category?: AssetCategory;
      status?: AssetStatus;
      location?: string;
      manufacturer?: string;
      modelNumber?: string;
      serialNumber?: string;
      purchaseDate?: string;
      purchaseCost?: number;
      warrantyExpiry?: string;
      serviceIntervalDays?: number;
      nextServiceDue?: string;
    },
  ): Promise<Asset> {
    return this.request<Asset>("PATCH", `/api/v1/assets/${id}`, patch);
  }

  /** An asset's maintenance history, newest first. Needs `asset:manage`. */
  listAssetMaintenance(id: string): Promise<AssetMaintenance[]> {
    return this.request<AssetMaintenance[]>("GET", `/api/v1/assets/${id}/maintenance`);
  }

  /** Logs a service and rolls its date onto the asset. Needs `asset:manage`. */
  addAssetMaintenance(
    id: string,
    input: {
      type: MaintenanceType;
      performedOn: string;
      performedBy?: string;
      cost?: number;
      notes?: string;
      nextServiceDue?: string;
    },
  ): Promise<AssetMaintenance> {
    return this.request<AssetMaintenance>("POST", `/api/v1/assets/${id}/maintenance`, input);
  }

  /* ── feedback & complaints (B10) ── */

  /** The feedback/complaint register, optionally filtered. Needs `feedback:manage`. */
  listFeedback(
    query: {
      kind?: FeedbackKind;
      status?: FeedbackStatus;
      category?: FeedbackCategory;
      assignedTo?: string;
    } = {},
  ): Promise<FeedbackTicket[]> {
    const qs = new URLSearchParams(
      Object.entries(query).filter(([, v]) => v != null) as [string, string][],
    ).toString();
    return this.request<FeedbackTicket[]>("GET", `/api/v1/feedback${qs ? `?${qs}` : ""}`);
  }

  /** Logs a compliment or complaint. Needs `feedback:manage`. */
  createFeedback(input: {
    kind: FeedbackKind;
    category: FeedbackCategory;
    channel: FeedbackChannel;
    subject: string;
    description: string;
    patientId?: string;
    reporterName?: string;
    reporterPhone?: string;
    rating?: number;
    severity?: ComplaintSeverity;
  }): Promise<FeedbackTicket> {
    return this.request<FeedbackTicket>("POST", "/api/v1/feedback", input);
  }

  getFeedback(id: string): Promise<FeedbackTicket> {
    return this.request<FeedbackTicket>("GET", `/api/v1/feedback/${id}`);
  }

  /** Assigns (or, with `null`, un-assigns) a ticket to a staff member. Needs `complaint:manage`. */
  assignFeedback(id: string, assignedTo: string | null): Promise<FeedbackTicket> {
    return this.request<FeedbackTicket>("POST", `/api/v1/feedback/${id}/assign`, { assignedTo });
  }

  /** Moves a ticket along its lifecycle; resolving requires a note. Needs `complaint:manage`. */
  transitionFeedback(
    id: string,
    input: { to: FeedbackStatus; note?: string },
  ): Promise<FeedbackTicket> {
    return this.request<FeedbackTicket>("POST", `/api/v1/feedback/${id}/transition`, input);
  }

  /* ── lab test catalogue (D6 / LIS depth) ── */

  /** The lab test catalogue. Needs `order:read`. */
  listLabTests(includeInactive = false): Promise<LabTest[]> {
    const qs = includeInactive ? "?includeInactive=true" : "";
    return this.request<LabTest[]>("GET", `/api/v1/lab-tests${qs}`);
  }

  /** One test by its catalogue code — ordering + result entry look it up. Needs `order:read`. */
  getLabTest(code: string): Promise<LabTest> {
    return this.request<LabTest>("GET", `/api/v1/lab-tests/${encodeURIComponent(code)}`);
  }

  /** Defines a test. Needs `lab:approve` (the pathologist owns the master). */
  createLabTest(input: {
    code: string;
    name: string;
    specimenType?: string;
    analytes?: Analyte[];
  }): Promise<LabTest> {
    return this.request<LabTest>("POST", "/api/v1/lab-tests", input);
  }

  /** Edits a test — including retiring it via `active`. Needs `lab:approve`. */
  updateLabTest(
    id: string,
    patch: { name?: string; specimenType?: string; analytes?: Analyte[]; active?: boolean },
  ): Promise<LabTest> {
    return this.request<LabTest>("PATCH", `/api/v1/lab-tests/${id}`, patch);
  }

  /* ── medico-legal records (C3): consent + death record ── */

  /** A patient's consents, newest first. Needs `emr:read`. */
  listConsents(patientId: string): Promise<Consent[]> {
    return this.request<Consent[]>(
      "GET",
      `/api/v1/consents?patientId=${encodeURIComponent(patientId)}`,
    );
  }

  /** Records an informed consent. Needs `consent:manage`. */
  recordConsent(input: {
    patientId: string;
    encounterId?: string;
    type: ConsentType;
    procedure: string;
    risksExplained?: string;
    signedBy?: ConsentSigner;
    signerName: string;
    relationship?: string;
    language?: string;
    witnessName?: string;
    signedAt?: string;
  }): Promise<Consent> {
    return this.request<Consent>("POST", "/api/v1/consents", input);
  }

  /** Withdraws a standing consent. Needs `consent:manage`. */
  withdrawConsent(id: string, reason: string): Promise<Consent> {
    return this.request<Consent>("POST", `/api/v1/consents/${id}/withdraw`, { reason });
  }

  /** The death record for a visit, or null if none. Needs `emr:read`. */
  getDeathRecord(encounterId: string): Promise<DeathRecord | null> {
    return this.request<DeathRecord | null>(
      "GET",
      `/api/v1/death-records?encounterId=${encodeURIComponent(encounterId)}`,
    );
  }

  /** Files the statutory death record. Needs `death:certify` (licensed). */
  recordDeath(
    input: {
      encounterId: string;
      diedAt: string;
      pronouncedAt?: string;
      immediateCause: string;
      antecedentCause?: string;
      underlyingCause?: string;
      contributingConditions?: string;
      manner?: MannerOfDeath;
      medicoLegal?: boolean;
      postmortemRequired?: boolean;
      bodyHandedTo?: string;
      bodyHandedRelationship?: string;
      remarks?: string;
    },
    /**
     * Stable across the retries of ONE submission, new for a genuinely new one. Without it the
     * `idempotent()` middleware this route carries can never fire — see `checkClientContract.ts`
     * §6, which exists because two clinical routes shipped exactly that way.
     */
    key?: string,
  ): Promise<DeathRecord> {
    return this.request<DeathRecord>("POST", "/api/v1/death-records", input, {
      ...(key ? { idempotencyKey: key } : {}),
    });
  }

  /* ── MAR — medication administration (D5 / nursing) ── */

  /** The medication administration record for a visit, newest first. Needs `emr:read`. */
  listMedicationAdministrations(encounterId: string): Promise<MedicationAdministration[]> {
    return this.request<MedicationAdministration[]>(
      "GET",
      `/api/v1/encounters/${encounterId}/medication-administrations`,
    );
  }

  /**
   * The doses due on a ward day, with what has happened to each. Needs `emr:read`.
   *
   * The `date` is the WARD's calendar day (`YYYY-MM-DD`), resolved in the branch's timezone by the
   * server. Omit it for today. This is also the reconciliation path after a lost response: ask
   * what the server holds rather than inferring it from a local clock.
   */
  listMedicationSchedule(encounterId: string, date?: string): Promise<DoseSlot[]> {
    const qs = date ? `?date=${encodeURIComponent(date)}` : "";
    return this.request<DoseSlot[]>(
      "GET",
      `/api/v1/encounters/${encounterId}/medication-schedule${qs}`,
    );
  }

  /**
   * Charts a dose against a signed prescription line. Needs `mar:administer`.
   *
   * ── A 409 HERE IS AN ANSWER, NOT A FAILURE ────────────────────────────────
   * `HMS-MAR-001` means the dose slot is already taken, and `details.existing` carries the
   * administration that took it. A client whose response was lost must show that — "already given
   * at 14:03 by …" — and must NOT retry into a second dose. Scheduled doses are protected by a
   * unique index, so this is authoritative even against another nurse on another device.
   *
   * `scheduledFor` is optional: send the slot from `listMedicationSchedule` when charting a round,
   * omit it for a PRN dose. Omitting it on a scheduled drug does not opt out of the protection —
   * the server binds the nearest round itself.
   *
   * ── THE KEY MATTERS MORE HERE THAN ANYWHERE ELSE IN THIS CLIENT ───────────
   * The route has carried `idempotent()` since M3-S1 and, until M3-S5A, this method sent no header
   * — so the middleware could never fire for any caller. The unique index still stopped a second
   * row for a SCHEDULED dose, which is the protection that matters most; but a PRN dose has no
   * slot and is therefore unconstrained by design, and for those a retry after a lost response was
   * a second dose in a patient with nothing anywhere to prevent it.
   *
   * Pass a key that is stable across the retries of ONE clinical decision, and a NEW key for a
   * genuinely new one. Give, Hold and Refuse are three different decisions and must never share.
   */
  recordMedicationAdministration(
    encounterId: string,
    input: {
      prescriptionId: string;
      drugCode: string;
      /** Required only when the same drug appears on the prescription more than once. */
      lineIndex?: number;
      status: MarStatus;
      scheduledFor?: string;
      administeredAt?: string;
      reason?: string;
      note?: string;
    },
    key?: string,
  ): Promise<MedicationAdministration> {
    return this.request<MedicationAdministration>(
      "POST",
      `/api/v1/encounters/${encounterId}/medication-administrations`,
      input,
      { ...(key ? { idempotencyKey: key } : {}) },
    );
  }

  /* ── insurance (patient policies + claims) ── */

  /** A patient's insurance policies. Needs `insurance:link` + the insurance module. */
  listInsurancePolicies(patientId: string): Promise<InsurancePolicy[]> {
    return this.request<InsurancePolicy[]>(
      "GET",
      `/api/v1/patients/${patientId}/insurance-policies`,
    );
  }

  /** Attaches a policy to a patient. Needs `insurance:link`. */
  linkInsurancePolicy(
    patientId: string,
    input: {
      insurer: string;
      tpaName?: string;
      policyNumber: string;
      policyType: PolicyType;
      planName?: string;
      policyHolderName?: string;
      relationship?: PolicyRelationship;
      validFrom?: string;
      validTo?: string;
      sumInsured?: number;
      notes?: string;
    },
  ): Promise<InsurancePolicy> {
    return this.request<InsurancePolicy>(
      "POST",
      `/api/v1/patients/${patientId}/insurance-policies`,
      input,
    );
  }

  /** Edits a policy — including retiring it via `status`. Needs `insurance:link`. */
  updateInsurancePolicy(
    id: string,
    patch: Partial<{
      insurer: string;
      tpaName: string;
      policyNumber: string;
      policyType: PolicyType;
      planName: string;
      policyHolderName: string;
      relationship: PolicyRelationship;
      validFrom: string;
      validTo: string;
      sumInsured: number;
      status: PolicyStatus;
      notes: string;
    }>,
  ): Promise<InsurancePolicy> {
    return this.request<InsurancePolicy>("PATCH", `/api/v1/insurance-policies/${id}`, patch);
  }

  /** A patient's claims, newest first. Needs `insurance:link`. */
  listInsuranceClaims(patientId: string): Promise<InsuranceClaim[]> {
    return this.request<InsuranceClaim[]>("GET", `/api/v1/patients/${patientId}/insurance-claims`);
  }

  /** Files a claim against one of the patient's policies. Needs `insurance:claim`. */
  fileInsuranceClaim(
    patientId: string,
    input: {
      policyId: string;
      encounterId?: string;
      invoiceId?: string;
      claimType: ClaimType;
      claimNumber?: string;
      claimedAmount: number;
      notes?: string;
    },
    /**
     * Stable across the retries of ONE submission, new for a genuinely new one. Without it the
     * `idempotent()` middleware this route carries can never fire — see `checkClientContract.ts`
     * §6, which exists because two clinical routes shipped exactly that way.
     */
    key?: string,
  ): Promise<InsuranceClaim> {
    return this.request<InsuranceClaim>(
      "POST",
      `/api/v1/patients/${patientId}/insurance-claims`,
      input,
      { ...(key ? { idempotencyKey: key } : {}) },
    );
  }

  /** Moves a claim through submission and the payer's decision. Needs `insurance:claim`. */
  transitionInsuranceClaim(
    id: string,
    input: { to: ClaimStatus; approvedAmount?: number; note?: string },
  ): Promise<InsuranceClaim> {
    return this.request<InsuranceClaim>("POST", `/api/v1/insurance-claims/${id}/transition`, input);
  }

  /** Records the payer's settlement — reconciliation. Needs `insurance:reconcile`. */
  settleInsuranceClaim(
    id: string,
    input: { settledAmount: number; note?: string },
    key?: string,
  ): Promise<InsuranceClaim> {
    return this.request<InsuranceClaim>("POST", `/api/v1/insurance-claims/${id}/settle`, input, {
      ...(key ? { idempotencyKey: key } : {}),
    });
  }

  /* ── vitals ── */

  /**
   * Charts one set of observations against a visit. Needs `vitals:record`.
   *
   * ── THE KEY IS NOT OPTIONAL IN PRACTICE, ONLY IN THE SIGNATURE ──────────────
   * The route has carried `idempotent()` since it shipped, and until M3-S4 no client could reach
   * it: this method sent no header, so every retry after a lost response charted a SECOND set of
   * observations. A duplicate reading is milder than a duplicate dose, and it is not harmless —
   * the chart is append-only, so a phantom 14:05 blood pressure is permanent, and the next
   * clinician cannot tell which of the two the patient actually had.
   *
   * `key` stays optional because omitting it is what the web app does today and making it
   * mandatory would be a breaking change to a shipped method. New callers pass one.
   */
  recordVitals(
    encounterId: string,
    input: RecordVitalsInput,
    key?: string,
  ): Promise<VitalsReading> {
    return this.request<VitalsReading>("POST", `/api/v1/encounters/${encounterId}/vitals`, input, {
      ...(key ? { idempotencyKey: key } : {}),
    });
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
   * The reports attached to these ORDERS — the lab worklist's read.
   *
   * Needs `order:read`, which a lab technician holds, rather than the `emr:read` the patient-wide
   * list above requires and they deliberately do not. Metadata only: enough to say a file has
   * landed, not enough to open it.
   */
  reportsForOrders(orderIds: string[]): Promise<ReportMeta[]> {
    if (orderIds.length === 0) return Promise.resolve([]);
    const qs = new URLSearchParams({ orderIds: orderIds.join(",") }).toString();
    return this.request<ReportMeta[]>("GET", `/api/v1/reports?${qs}`);
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
  bookAppointment(
    input: {
      patientId: string;
      doctorId: string;
      startAt: Date;
      reason?: string;
      /** Write into a specific site (ADR-0015). Omitted = the caller's active branch. */
      branchId?: string;
    },
    /**
     * Stable across the retries of ONE submission, new for a genuinely new one. Without it the
     * `idempotent()` middleware this route carries can never fire — see `checkClientContract.ts`
     * §6, which exists because two clinical routes shipped exactly that way.
     */
    key?: string,
  ): Promise<Appointment> {
    return this.request<Appointment>(
      "POST",
      "/api/v1/appointments",
      { ...input, startAt: input.startAt.toISOString() },
      { ...(key ? { idempotencyKey: key } : {}) },
    );
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
    /** Write into a specific site (ADR-0015). Omitted = the caller's active branch. */
    branchId?: string;
  }): Promise<DoctorSchedule> {
    return this.request<DoctorSchedule>("PUT", "/api/v1/doctors/schedule", input);
  }

  /* ── doctor availability (session roster) & leave (Doc 02 D2) ── */

  /** A doctor's whole week of sessions — the simple roster reception reads. */
  getDoctorAvailability(doctorId: string): Promise<DoctorAvailability[]> {
    return this.request<DoctorAvailability[]>("GET", `/api/v1/doctors/${doctorId}/availability`);
  }

  /** Sets one weekday's sessions; an empty `sessions` clears the day (returns null). */
  setDoctorAvailability(input: {
    doctorId: string;
    weekday: number;
    sessions: DoctorSession[];
    /** Write into a specific site (ADR-0015). Omitted = the caller's active branch. */
    branchId?: string;
  }): Promise<DoctorAvailability | null> {
    return this.request<DoctorAvailability | null>("PUT", "/api/v1/doctors/availability", input);
  }

  getDoctorLeave(doctorId: string): Promise<DoctorLeave[]> {
    return this.request<DoctorLeave[]>("GET", `/api/v1/doctors/${doctorId}/leave`);
  }

  addDoctorLeave(input: {
    doctorId: string;
    fromDate: string;
    toDate: string;
    reason?: string;
    /** Write into a specific site (ADR-0015). Omitted = the caller's active branch. */
    branchId?: string;
  }): Promise<DoctorLeave> {
    return this.request<DoctorLeave>("POST", "/api/v1/doctors/leave", input);
  }

  removeDoctorLeave(id: string): Promise<{ removed: boolean }> {
    return this.request<{ removed: boolean }>("DELETE", `/api/v1/doctors/leave/${id}`);
  }

  /* ── a doctor's OWN roster (`doctor:self-manage`) ──────────────────────────
   *
   * The same three writes as above with the `doctorId` REMOVED, because the server takes it from
   * the token. That is the whole difference and it is the point: these need only the permission a
   * doctor actually holds, and there is no id a caller could put in the body to reach a colleague's
   * roster — the request schemas reject one outright.
   *
   * Reading stays on `getDoctorAvailability(id)` / `getDoctorLeave(id)`: a doctor may already read
   * any roster with `appointment:read`, so a `me` variant would be a second way to ask an existing
   * question.
   */

  /** Sets one weekday's sessions for the SIGNED-IN doctor. Empty `sessions` clears the day. */
  setOwnAvailability(input: {
    weekday: number;
    sessions: DoctorSession[];
    /** Write into a specific site (ADR-0015). Omitted = the caller's active branch. */
    branchId?: string;
  }): Promise<DoctorAvailability | null> {
    return this.request<DoctorAvailability | null>("PUT", "/api/v1/doctors/me/availability", input);
  }

  /** Books leave for the SIGNED-IN doctor — inclusive `fromDate`..`toDate`. */
  addOwnLeave(input: {
    fromDate: string;
    toDate: string;
    reason?: string;
    /** Write into a specific site (ADR-0015). Omitted = the caller's active branch. */
    branchId?: string;
  }): Promise<DoctorLeave> {
    return this.request<DoctorLeave>("POST", "/api/v1/doctors/me/leave", input);
  }

  /**
   * Cancels the signed-in doctor's own leave. Somebody else's row answers 404, not 403 — see the
   * repository: confirming that a given id belongs to a colleague would leak their roster.
   */
  removeOwnLeave(id: string): Promise<{ removed: boolean }> {
    return this.request<{ removed: boolean }>("DELETE", `/api/v1/doctors/me/leave/${id}`);
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
  startEncounter(
    input: {
      patientId: string;
      origin?: EncounterOrigin;
      /** The care setting. `ER` puts the visit on the emergency board. Defaults to `OP`. */
      class?: EncounterClass;
      doctorId?: string;
      departmentId?: string;
      reason?: string;
      /** A paid fast-track OP visit — priority in the queue plus an express surcharge. */
      express?: boolean;
      /** Write into a specific site (ADR-0015). Omitted = the caller's active branch. */
      branchId?: string;
    },
    /**
     * Stable across the retries of ONE submission, new for a genuinely new one. Without it the
     * `idempotent()` middleware this route carries can never fire — see `checkClientContract.ts`
     * §6, which exists because two clinical routes shipped exactly that way.
     */
    key?: string,
  ): Promise<StartEncounterResult> {
    return this.request<StartEncounterResult>("POST", "/api/v1/encounters", input, {
      ...(key ? { idempotencyKey: key } : {}),
    });
  }

  /**
   * The register, the queue board and the doctor's list — one endpoint.
   *
   * `date` is `YYYY-MM-DD` and is resolved in the HOSPITAL's timezone by the server.
   * `queued` returns everyone waiting or being seen, in token order.
   *
   * Each row names its patient (`EncounterRow`). Do not join against `listPatients` to get one.
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
  ): Promise<Paged<EncounterRow>> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    const qs = query.toString();
    return this.paged<EncounterRow>(`/api/v1/encounters${qs ? `?${qs}` : ""}`);
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

  /**
   * The structured consultation note for a visit (D3). `null` when the doctor has not started one.
   * Needs `emr:read`.
   */
  getConsultation(encounterId: string): Promise<ConsultationNote | null> {
    return this.request<ConsultationNote | null>(
      "GET",
      `/api/v1/encounters/${encounterId}/consultation`,
    );
  }

  /**
   * Writes the consultation note; the encounter's OPD-slip lines are derived from it server-side.
   * Only the fields sent are touched (a blank string / empty list clears one). Needs `emr:write`.
   */
  saveConsultation(
    encounterId: string,
    input: {
      chiefComplaint?: string;
      history?: string;
      examination?: string;
      diagnoses?: Diagnosis[];
      plan?: string;
      followUpDays?: number;
    },
  ): Promise<ConsultationNote> {
    return this.request<ConsultationNote>(
      "PUT",
      `/api/v1/encounters/${encounterId}/consultation`,
      input,
    );
  }

  cancelEncounter(id: string, reason: string): Promise<Encounter> {
    return this.request<Encounter>("POST", `/api/v1/encounters/${id}/cancel`, { reason });
  }

  /* ── MRD: ICD-10 coding + disease register ── */

  /** Search the ICD-10 master (code or title). Needs `mrd:code`. */
  listIcdCodes(search?: string, includeInactive = false): Promise<IcdCode[]> {
    const qs = new URLSearchParams();
    if (search) qs.set("search", search);
    if (includeInactive) qs.set("includeInactive", "true");
    const s = qs.toString();
    return this.request<IcdCode[]>("GET", `/api/v1/mrd/icd-codes${s ? `?${s}` : ""}`);
  }

  /** Adds an ICD-10 code to the master. Needs `mrd:manage`. */
  createIcdCode(input: { code: string; title: string; chapter?: string }): Promise<IcdCode> {
    return this.request<IcdCode>("POST", "/api/v1/mrd/icd-codes", input);
  }

  /** Edits an ICD-10 code (including retiring it). Needs `mrd:manage`. */
  updateIcdCode(
    id: string,
    patch: { title?: string; chapter?: string; active?: boolean },
  ): Promise<IcdCode> {
    return this.request<IcdCode>("PATCH", `/api/v1/mrd/icd-codes/${id}`, patch);
  }

  /** The coding on a visit, or null. Needs `mrd:code`. */
  getCoding(encounterId: string): Promise<EncounterCoding | null> {
    return this.request<EncounterCoding | null>("GET", `/api/v1/mrd/codings/${encounterId}`);
  }

  /** Codes a visit — replaces the whole set; exactly one code must be primary. Needs `mrd:code`. */
  saveCoding(encounterId: string, codes: CodedDiagnosis[]): Promise<EncounterCoding> {
    return this.request<EncounterCoding>("PUT", `/api/v1/mrd/codings/${encounterId}`, { codes });
  }

  /** The disease/morbidity register — primary diagnoses by ICD code in a period. Needs `mrd:register:view`. */
  mrdDiseaseRegister(range: ReportRange): Promise<DiseaseRegisterRow[]> {
    return this.request<DiseaseRegisterRow[]>(
      "GET",
      `/api/v1/mrd/disease-register${rangeQs(range)}`,
    );
  }

  /* ── mortuary: body custody register ── */

  /** The mortuary register; pass `in_storage` for the occupancy board. Needs `mortuary:manage`. */
  listMortuary(status?: MortuaryStatus): Promise<MortuaryEntry[]> {
    const qs = status ? `?status=${status}` : "";
    return this.request<MortuaryEntry[]>("GET", `/api/v1/mortuary/register${qs}`);
  }

  /** The mortuary entry for a visit, or null. Needs `mortuary:manage`. */
  getMortuaryForEncounter(encounterId: string): Promise<MortuaryEntry | null> {
    return this.request<MortuaryEntry | null>(
      "GET",
      `/api/v1/mortuary/for-encounter/${encounterId}`,
    );
  }

  /**
   * Receives a deceased body into the mortuary. The death must already be recorded — the patient and
   * medico-legal status are derived from it. Needs `mortuary:manage`.
   */
  receiveBody(input: {
    encounterId: string;
    tagNumber: string;
    storageUnit?: string;
    remarks?: string;
  }): Promise<MortuaryEntry> {
    return this.request<MortuaryEntry>("POST", "/api/v1/mortuary/register", input);
  }

  /**
   * Releases a stored body. A medico-legal body needs a `clearanceRef` (police/magistrate NOC) or the
   * server refuses. Needs `mortuary:release`.
   */
  releaseBody(
    id: string,
    input: {
      releasedTo: string;
      releasedRelationship: string;
      clearanceRef?: string;
      remarks?: string;
    },
  ): Promise<MortuaryEntry> {
    return this.request<MortuaryEntry>("POST", `/api/v1/mortuary/register/${id}/release`, input);
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
  placeOrder(
    input: {
      encounterId: string;
      category: OrderCategory;
      code: string;
      name: string;
      priority?: OrderPriority;
      notes?: string;
      requestId?: string;
      /** Write into a specific site (ADR-0015). Omitted = the caller's active branch. */
      branchId?: string;
    },
    key?: string,
  ): Promise<PlaceOrderResult> {
    return this.request<PlaceOrderResult>("POST", "/api/v1/orders", input, {
      ...(key ? { idempotencyKey: key } : {}),
    });
  }

  /**
   * `{ category: "lab", outstanding: true }` IS the lab's worklist.
   *
   * Rows carry `patientName` and `uhid`, resolved server-side. Do NOT reconstruct identity by
   * fetching a page of patients and joining — that silently blanks every patient the page did not
   * reach, and the worklist did exactly that until it was found in manual testing.
   */
  listOrders(
    params: {
      category?: OrderCategory;
      status?: OrderStatus;
      priority?: OrderPriority;
      encounterId?: string;
      patientId?: string;
      outstanding?: boolean;
      /**
       * `queue` (default) is a WORKLIST — sickest first, then longest-waiting. `recent` is a
       * CHART — newest first. The difference matters at the 100-row ceiling: asking the worklist
       * question of a long-stay patient's history cuts off the newest results, which are exactly
       * the ones a doctor is waiting for.
       */
      sort?: "queue" | "recent";
      page?: number;
      limit?: number;
    } = {},
  ): Promise<Paged<OrderRow>> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    const qs = query.toString();
    return this.paged<OrderRow>(`/api/v1/orders${qs ? `?${qs}` : ""}`);
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
  finalizeBill(encounterId: string, key?: string): Promise<Invoice> {
    return this.request<Invoice>(
      "POST",
      `/api/v1/encounters/${encounterId}/bill/finalize`,
      {},
      {
        ...(key ? { idempotencyKey: key } : {}),
      },
    );
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
    key?: string,
  ): Promise<{ orderId: string; invoiceId: string; advanceBalance: number }> {
    return this.request(
      "POST",
      `/api/v1/billing/orders/${orderId}/settle-from-advance`,
      {},
      {
        ...(key ? { idempotencyKey: key } : {}),
      },
    );
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

  /** Revenue leakage — care given but never billed, by category/source and the visits that hold it. */
  reportRevenueLeakage(range: ReportRange): Promise<RevenueLeakageReport> {
    return this.request<RevenueLeakageReport>(
      "GET",
      `/api/v1/reports/revenue-leakage${rangeQs(range)}`,
    );
  }

  /** Dues ageing — billed but unpaid as of the range's `to` date, bucketed by age of the debt. */
  reportDuesAgeing(range: ReportRange): Promise<DuesAgeingReport> {
    return this.request<DuesAgeingReport>("GET", `/api/v1/reports/dues-ageing${rangeQs(range)}`);
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

  postCharge(
    input: {
      encounterId: string;
      code: string;
      category: ChargeCategory;
      description?: string;
      quantity?: number;
      /** Paise. Overrides the tariff. */
      unitPrice?: number;
    },
    key?: string,
  ): Promise<unknown> {
    return this.request("POST", "/api/v1/charges", input, {
      ...(key ? { idempotencyKey: key } : {}),
    });
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
    /**
     * Stable across the retries of ONE submission, new for a genuinely new one. Without it the
     * `idempotent()` middleware this route carries can never fire — see `checkClientContract.ts`
     * §6, which exists because two clinical routes shipped exactly that way.
     */
    key?: string,
  ): Promise<StockMoveResult> {
    return this.request<StockMoveResult>("POST", `/api/v1/medicines/${id}/receive`, input, {
      ...(key ? { idempotencyKey: key } : {}),
    });
  }

  /** A manual correction — breakage, a write-off, a stock-take. `delta` is signed. */
  adjustStock(
    id: string,
    input: { delta: number; reason: string },
    /**
     * Stable across the retries of ONE submission, new for a genuinely new one. Without it the
     * `idempotent()` middleware this route carries can never fire — see `checkClientContract.ts`
     * §6, which exists because two clinical routes shipped exactly that way.
     */
    key?: string,
  ): Promise<StockMoveResult> {
    return this.request<StockMoveResult>("POST", `/api/v1/medicines/${id}/adjust`, input, {
      ...(key ? { idempotencyKey: key } : {}),
    });
  }

  /* ── General store (needs module.support.inventory) ────────────────────────
   * Reads are gated on `inventory:manage`; the three writes each carry their own permission, so a
   * hospital can put the delivery, the issue and the stock-take in three different pairs of hands.
   */

  /** The store list — every item with this site's on-hand and its position, worst first. */
  listStoreItems(
    params: { search?: string; lowStockOnly?: boolean; includeInactive?: boolean } = {},
  ): Promise<StoreRow[]> {
    return this.request<StoreRow[]>("GET", `/api/v1/inventory-items${medicineQuery(params)}`);
  }

  createStoreItem(input: CreateItemInput): Promise<InventoryItem> {
    return this.request<InventoryItem>("POST", "/api/v1/inventory-items", input);
  }

  updateStoreItem(id: string, patch: UpdateItemInput): Promise<InventoryItem> {
    return this.request<InventoryItem>("PATCH", `/api/v1/inventory-items/${id}`, patch);
  }

  /** Where stock may be issued to — active departments, as an id and a label. */
  listStoreDestinations(): Promise<IssueDestination[]> {
    return this.request<IssueDestination[]>("GET", "/api/v1/inventory-destinations");
  }

  listStoreMovements(id: string): Promise<InventoryMovement[]> {
    return this.request<InventoryMovement[]>("GET", `/api/v1/inventory-items/${id}/movements`);
  }

  /**
   * Book a delivery in, against a supplier.
   *
   * `key` is stable across the retries of ONE submission and new for a genuinely new delivery.
   * Without it the `idempotent()` middleware this route carries can never fire — and a
   * double-booked delivery is a number that stays wrong until somebody counts the shelf by hand.
   */
  receiveStoreStock(
    id: string,
    input: { quantity: number; supplierId?: string; invoiceRef?: string; unitCost?: number },
    key?: string,
  ): Promise<InventoryStockChange> {
    return this.request<InventoryStockChange>(
      "POST",
      `/api/v1/inventory-items/${id}/receive`,
      input,
      { ...(key ? { idempotencyKey: key } : {}) },
    );
  }

  /** Hand stock out to a department. Refused (HMS-INV-002) when the shelf cannot cover it. */
  issueStoreStock(
    id: string,
    input: { quantity: number; departmentId: string },
    key?: string,
  ): Promise<InventoryStockChange> {
    return this.request<InventoryStockChange>(
      "POST",
      `/api/v1/inventory-items/${id}/issue`,
      input,
      { ...(key ? { idempotencyKey: key } : {}) },
    );
  }

  /** Correct the count after a stock-take. `delta` is signed; it may not go below zero. */
  adjustStoreStock(
    id: string,
    input: { delta: number; reason: string },
    key?: string,
  ): Promise<InventoryStockChange> {
    return this.request<InventoryStockChange>(
      "POST",
      `/api/v1/inventory-items/${id}/adjust`,
      input,
      { ...(key ? { idempotencyKey: key } : {}) },
    );
  }

  listSuppliers(params: { search?: string; includeInactive?: boolean } = {}): Promise<Supplier[]> {
    const parts: string[] = [];
    if (params.search) parts.push(`search=${encodeURIComponent(params.search)}`);
    if (params.includeInactive) parts.push("includeInactive=true");
    return this.request<Supplier[]>(
      "GET",
      `/api/v1/suppliers${parts.length ? `?${parts.join("&")}` : ""}`,
    );
  }

  createSupplier(input: CreateSupplierInput): Promise<Supplier> {
    return this.request<Supplier>("POST", "/api/v1/suppliers", input);
  }

  updateSupplier(id: string, patch: UpdateSupplierInput): Promise<Supplier> {
    return this.request<Supplier>("PATCH", `/api/v1/suppliers/${id}`, patch);
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
    /**
     * Stable across the retries of ONE submission, new for a genuinely new one. Without it the
     * `idempotent()` middleware this route carries can never fire — see `checkClientContract.ts`
     * §6, which exists because two clinical routes shipped exactly that way.
     */
    key?: string,
  ): Promise<AdmitResult> {
    return this.request<AdmitResult>("POST", `/api/v1/encounters/${encounterId}/admit`, input, {
      ...(key ? { idempotencyKey: key } : {}),
    });
  }

  /**
   * Everyone in a bed right now — the ward round's list, paged.
   *
   * `limit` defaults to 100 SERVER-SIDE, which is what this endpoint always returned before it
   * took parameters. Sending nothing therefore behaves exactly as it used to, and `meta.total`
   * now tells a caller whether there is more — a hospital with more than a hundred open stays
   * used to be silently truncated with nothing in the response to say so.
   *
   * ── EACH ROW NAMES ITS PATIENT, AND THAT IS NOT A CONVENIENCE ─────────────
   * `patientName` and `uhid` are resolved server-side. Do NOT go back to matching `patientId`
   * against a separately fetched patient list: that is what the web ward page did, against the
   * hundred most recently REGISTERED patients, so anyone admitted longer ago than that reached the
   * medication confirmation with a blank name and a blank UHID — the identity check that catches
   * the right drug given to the wrong person.
   */
  listInpatients(
    params: { page?: number; limit?: number; ward?: string } = {},
  ): Promise<Paged<InpatientRow>> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) query.set(key, String(value));
    }
    const qs = query.toString();
    return this.paged<InpatientRow>(`/api/v1/inpatients${qs ? `?${qs}` : ""}`);
  }

  /**
   * One page of the ward, with allergy and due-dose state resolved server-side.
   * Needs `emr:read` + `module.ops.ipd`.
   *
   * ── USE THIS RATHER THAN ASSEMBLING IT CLIENT-SIDE ────────────────────────
   * The same information can be had from `/inpatients` plus a per-patient allergy call plus a
   * per-encounter schedule call. For a twenty-bed ward that is sixty-one requests on hospital
   * wifi; this is four queries server-side however long the page.
   *
   * `ward` filters by NAME, because an admission records its bed as text.
   */
  listWardWorklist(
    params: { ward?: string; page?: number; limit?: number } = {},
  ): Promise<Paged<WorklistRow>> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) query.set(key, String(value));
    }
    const qs = query.toString();
    return this.paged<WorklistRow>(`/api/v1/ward-worklist${qs ? `?${qs}` : ""}`);
  }

  /**
   * One page of the ward's medication round — every dose expected on one clinical day, per
   * patient, with identity and allergy context. Needs `emr:read` + `module.clinical.nursing`.
   *
   * ── THE ALTERNATIVE IS A REQUEST PER PATIENT ──────────────────────────────
   * `/ward-worklist` says a patient has three doses due; only `/encounters/:id/
   * medication-schedule` says which three. Assembling a round from those is one request per bed,
   * which is the N+1 the worklist exists to avoid. This is five queries server-side, whatever the
   * page size, and the slots it returns are derived by the same function the per-encounter
   * schedule uses — so the two cannot disagree.
   *
   * `date` is `YYYY-MM-DD` **in the ward's timezone**, and that distinction is the point: at
   * 23:30 in Delhi it is still yesterday afternoon in a New York ward, and the round belongs to
   * the ward's day. Compute it from the branch's zone, never the device's. Omit it and the server
   * resolves the ward's today itself.
   */
  listMedicationRound(
    params: { ward?: string; date?: string; page?: number; limit?: number } = {},
  ): Promise<Paged<MedicationRoundRow>> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) query.set(key, String(value));
    }
    const qs = query.toString();
    return this.paged<MedicationRoundRow>(`/api/v1/medication-round${qs ? `?${qs}` : ""}`);
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

  /** Every room, or one ward's rooms — each joined to its ward name. */
  listRooms(wardId?: string): Promise<Room[]> {
    const qs = wardId ? `?wardId=${wardId}` : "";
    return this.request<Room[]>("GET", `/api/v1/rooms${qs}`);
  }

  createRoom(input: {
    wardId: string;
    name: string;
    kind: RoomKind;
    tariffCode?: string;
  }): Promise<Room> {
    return this.request<Room>("POST", "/api/v1/rooms", input);
  }

  updateRoom(
    id: string,
    patch: { name?: string; kind?: RoomKind; tariffCode?: string; status?: RoomStatus },
  ): Promise<Room> {
    return this.request<Room>("PATCH", `/api/v1/rooms/${id}`, patch);
  }

  /** Every bed, or one ward's beds — each joined to its ward name, room, and effective tariff. */
  listBeds(wardId?: string): Promise<InventoryBed[]> {
    const qs = wardId ? `?wardId=${wardId}` : "";
    return this.request<InventoryBed[]>("GET", `/api/v1/beds${qs}`);
  }

  createBed(input: {
    wardId: string;
    roomId?: string;
    code: string;
    room?: string;
    tariffCode?: string;
  }): Promise<InventoryBed> {
    return this.request<InventoryBed>("POST", "/api/v1/beds", input);
  }

  updateBed(
    id: string,
    patch: {
      /** A room id moves the bed into that room; `null` pulls it out onto the open ward floor. */
      roomId?: string | null;
      code?: string;
      room?: string;
      tariffCode?: string;
      status?: BedStatus;
      blockedReason?: string;
    },
  ): Promise<InventoryBed> {
    return this.request<InventoryBed>("PATCH", `/api/v1/beds/${id}`, patch);
  }

  /**
   * Today's entry on the ward round.
   *
   * ── SEND THE KEY. A WARD NOTE CANNOT BE UNDONE ──────────────────────────────
   * Notes are append-only: no update path, no delete path. Without `key`, a retry after a lost
   * response leaves two identical contemporaneous entries on a medico-legal record, permanently —
   * the server does not de-duplicate on content and never will, because two genuinely separate
   * observations may read the same. With it, the retry replays the original 201 and writes nothing.
   */
  addWardNote(encounterId: string, text: string, key?: string): Promise<WardNote> {
    return this.request<WardNote>(
      "POST",
      `/api/v1/encounters/${encounterId}/notes`,
      { text },
      { ...(key ? { idempotencyKey: key } : {}) },
    );
  }

  /**
   * The nurse's bedside entry. Needs `nursing:manage` — NOT `emr:write`, which a nurse does not
   * hold and which would also open discharge summaries and outcome notes.
   *
   * Lands in the same chart as `addWardNote`, with `type: "nursing"` set by the server. There is
   * no way to ask this endpoint for another type; the body carries only text.
   *
   * Send the `key`, for the same reason its sibling insists on it: the record is append-only, so a
   * retry after a lost response is otherwise a permanent duplicate on a medico-legal document.
   */
  addNursingNote(encounterId: string, text: string, key?: string): Promise<WardNote> {
    return this.request<WardNote>(
      "POST",
      `/api/v1/encounters/${encounterId}/nursing-notes`,
      { text },
      { ...(key ? { idempotencyKey: key } : {}) },
    );
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

  createPrescription(
    input: {
      encounterId: string;
      lines: PrescriptionLineInput[];
      notes?: string;
    },
    /**
     * Stable across the retries of ONE submission, new for a genuinely new one. Without it the
     * `idempotent()` middleware this route carries can never fire — see `checkClientContract.ts`
     * §6, which exists because two clinical routes shipped exactly that way.
     */
    key?: string,
  ): Promise<Prescription> {
    return this.request<Prescription>("POST", "/api/v1/prescriptions", input, {
      ...(key ? { idempotencyKey: key } : {}),
    });
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
    key?: string,
  ): Promise<DispenseResult> {
    return this.request<DispenseResult>(
      "POST",
      `/api/v1/prescriptions/${prescriptionId}/dispense`,
      input,
      { ...(key ? { idempotencyKey: key } : {}) },
    );
  }

  /** The handover ledger — who gave what, when. */
  listDispenses(prescriptionId: string): Promise<Dispense[]> {
    return this.request<Dispense[]>("GET", `/api/v1/prescriptions/${prescriptionId}/dispenses`);
  }

  /**
   * The cash counter's queue: visits carrying charges that are on no bill yet.
   *
   * The read that makes `billing:finalize` usable by the role that holds it. A cashier's screen
   * lists INVOICES, and a lab test a doctor ordered has no invoice until somebody raises one — so
   * without this the charge is invisible at the counter and the test is never paid for.
   * `q` matches a patient by name or UHID. Needs `billing:read`.
   */
  listPendingBills(
    params: { q?: string; page?: number; limit?: number } = {},
  ): Promise<Paged<PendingBill>> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    const qs = query.toString();
    return this.paged<PendingBill>(`/api/v1/billing/pending${qs ? `?${qs}` : ""}`);
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

  /**
   * The staff this bill records an act by, with their signatures — what the receipt prints over
   * "Received by". Answers "who signed THIS bill", not "tell me about user X". Needs `billing:read`.
   */
  listInvoiceSignatories(invoiceId: string): Promise<InvoiceSignatory[]> {
    return this.request<InvoiceSignatory[]>("GET", `/api/v1/invoices/${invoiceId}/signatories`);
  }

  /** Dated charges for a visit — the day-wise money on the IP treatment sheet. Needs `billing:read`. */
  getCharges(encounterId: string): Promise<EncounterCharge[]> {
    return this.request<EncounterCharge[]>("GET", `/api/v1/encounters/${encounterId}/charges`);
  }

  /**
   * Takes money. `amount` is PAISE. Refused on a draft; overpayment is refused.
   *
   * **Always pass `requestId`** (Doc 03 §5.2 — idempotency keys on all money-moving POSTs). It
   * must be stable across RETRIES OF THE SAME INTENT and different for a genuinely new payment,
   * so mint it once per payment form and renew it after a payment succeeds. A replay answers
   * `HMS-PAY-002` with the original receipt rather than taking the money twice.
   */
  recordPayment(
    invoiceId: string,
    input: { amount: number; method: string; reference?: string; requestId?: string },
    key?: string,
  ): Promise<Invoice> {
    return this.request<Invoice>("POST", `/api/v1/invoices/${invoiceId}/payments`, input, {
      ...(key ? { idempotencyKey: key } : {}),
    });
  }

  /**
   * Settles a bill from the patient's ADVANCE. A convenience over `recordPayment` — it is the
   * same endpoint with `method: "wallet"`, which draws the money from the wallet atomically.
   */
  payFromWallet(
    invoiceId: string,
    amount: number,
    requestId?: string,
    key?: string,
  ): Promise<Invoice> {
    return this.request<Invoice>(
      "POST",
      `/api/v1/invoices/${invoiceId}/payments`,
      { amount, method: "wallet", ...(requestId ? { requestId } : {}) },
      { ...(key ? { idempotencyKey: key } : {}) },
    );
  }

  /**
   * Applies an approved discount to a finalized bill. `amount` is PAISE. Needs `billing:discount`
   * (not the cashier's own authority — a write-down is approved, not self-served).
   */
  applyDiscount(
    invoiceId: string,
    input: { amount: number; reason: string },
    key?: string,
  ): Promise<Invoice> {
    return this.request<Invoice>("POST", `/api/v1/invoices/${invoiceId}/discount`, input, {
      ...(key ? { idempotencyKey: key } : {}),
    });
  }

  /**
   * Hands money back. `amount` is PAISE, never more than net collected. Needs `billing:refund`.
   * Pass `requestId` — see `recordPayment`; refunding twice is the worse leg to get wrong.
   */
  recordRefund(
    invoiceId: string,
    input: { amount: number; method: string; reason: string; requestId?: string },
    key?: string,
  ): Promise<Invoice> {
    return this.request<Invoice>("POST", `/api/v1/invoices/${invoiceId}/refund`, input, {
      ...(key ? { idempotencyKey: key } : {}),
    });
  }

  /**
   * Sets the payer split on a finalized bill: `coveredAmount` (PAISE) is the insurer's share under
   * `policyId`, so the patient owes only `total − coveredAmount`. Needs `insurance:link`.
   */
  setPayerSplit(
    invoiceId: string,
    input: { policyId: string; coveredAmount: number },
  ): Promise<Invoice> {
    return this.request<Invoice>("POST", `/api/v1/invoices/${invoiceId}/payer-split`, input);
  }

  /* ── care packages ── */

  /** The package catalogue — fixed-price bundles. Needs `billing:read`. */
  listPackages(includeInactive = false): Promise<CarePackage[]> {
    const qs = includeInactive ? "?includeInactive=true" : "";
    return this.request<CarePackage[]>("GET", `/api/v1/packages${qs}`);
  }

  /** Defines a package. Needs `tariff:manage` (the price list owner). */
  createPackage(input: {
    code: string;
    name: string;
    description?: string;
    price: number;
    includedCodes: string[];
  }): Promise<CarePackage> {
    return this.request<CarePackage>("POST", "/api/v1/packages", input);
  }

  /** Edits a package — including retiring it via `active`. Needs `tariff:manage`. */
  updatePackage(
    id: string,
    patch: {
      name?: string;
      description?: string;
      price?: number;
      includedCodes?: string[];
      active?: boolean;
    },
  ): Promise<CarePackage> {
    return this.request<CarePackage>("PATCH", `/api/v1/packages/${id}`, patch);
  }

  /** The package enrollments on a visit, newest first. Needs `billing:read`. */
  listPackageEnrollments(encounterId: string): Promise<PackageEnrollment[]> {
    return this.request<PackageEnrollment[]>(
      "GET",
      `/api/v1/encounters/${encounterId}/package-enrollments`,
    );
  }

  /** Enrols a visit in a package — charges the bundle once. Needs `package:enroll`. */
  enrollInPackage(
    encounterId: string,
    packageCode: string,
    /**
     * Stable across the retries of ONE submission, new for a genuinely new one. Without it the
     * `idempotent()` middleware this route carries can never fire — see `checkClientContract.ts`
     * §6, which exists because two clinical routes shipped exactly that way.
     */
    key?: string,
  ): Promise<PackageEnrollment> {
    return this.request<PackageEnrollment>(
      "POST",
      `/api/v1/encounters/${encounterId}/package-enrollments`,
      { packageCode },
      { ...(key ? { idempotencyKey: key } : {}) },
    );
  }

  /** Cancels an enrollment — voids its package charge, stops covering. Needs `package:enroll`. */
  cancelPackageEnrollment(id: string): Promise<PackageEnrollment> {
    return this.request<PackageEnrollment>("POST", `/api/v1/package-enrollments/${id}/cancel`, {});
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
  depositToWallet(patientId: string, input: WalletDepositInput, key?: string): Promise<Wallet> {
    return this.request<Wallet>("POST", `/api/v1/patients/${patientId}/wallet/deposits`, input, {
      ...(key ? { idempotencyKey: key } : {}),
    });
  }

  /** Refunds advance to the patient (leftover on discharge). `amount` is PAISE. */
  refundFromWallet(patientId: string, input: WalletRefundInput, key?: string): Promise<Wallet> {
    return this.request<Wallet>("POST", `/api/v1/patients/${patientId}/wallet/refunds`, input, {
      ...(key ? { idempotencyKey: key } : {}),
    });
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
    /** Sets the first administrator's password instead of generating one. */
    adminPassword?: string;
    /** Drives the edition preset — clinic, government hospital, diagnostic centre… */
    organizationType?: string;
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

  /** The plan catalogue, as the control plane sees it — the same shape `listPlans` returns. */
  listEditions(): Promise<Plan[]> {
    return this.request<Plan[]>("GET", "/api/platform/v1/editions");
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
  /**
   * @deprecated Cannot carry the access token. `/audit/export` is behind `authenticate()`, which
   * reads `Authorization: Bearer` and nothing else — so an `<a href>` navigation to this URL
   * arrives with no credential and is refused with `HMS-AUTH-002`. It looks like it works because
   * a URL builder cannot fail; the failure is at the far end.
   *
   * Use `fetchAuditCsv()`, which sends the token, returns the bytes, and additionally surfaces the
   * truncation flag that a downloaded file cannot show you. React Native has no equivalent of
   * "open an authenticated URL in a tab" at all, so the URL form is unusable there by construction.
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

  /**
   * The audit trail as CSV, authenticated — the download that actually works.
   *
   * Returns the row count and the truncation flag alongside the bytes because the route caps its
   * output and **a truncated export is byte-indistinguishable from a complete one**: same header
   * row, same shape, fewer rows. A compliance officer handing an auditor a file that silently
   * stops at the cap is the failure this exists to prevent, and it can only be surfaced from the
   * `x-audit-rows` / `x-audit-truncated` headers, which a browser download drops.
   */
  async fetchAuditCsv(params: AuditQuery = {}): Promise<CsvExport> {
    const token = this.getAccessToken?.();
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (this.tenantHost) headers.host = this.tenantHost;

    const res = await this.fetchImpl(this.auditExportUrl(params), {
      method: "GET",
      headers,
      credentials: this.credentials,
      cache: "no-store",
    });
    if (!res.ok) {
      throw new ApiClientError(
        res.status,
        "HMS-GEN-500",
        `Could not export the audit trail (HTTP ${String(res.status)}).`,
      );
    }

    const rows = Number(res.headers.get("x-audit-rows"));
    return {
      blob: await res.blob(),
      rows: Number.isFinite(rows) ? rows : null,
      truncated: res.headers.get("x-audit-truncated") === "true",
    };
  }

  /* ── contract coverage: operations that had no typed client method ──────── */

  /** The permission catalogue — what a role may be granted. */
  listPermissions(): Promise<Permission[]> {
    return this.request<Permission[]>("GET", "/api/v1/permissions");
  }

  getRole(id: string): Promise<RoleDetail> {
    return this.request<RoleDetail>("GET", `/api/v1/roles/${id}`);
  }

  createRole(input: {
    code: string;
    name: string;
    description?: string;
    permissions?: string[];
  }): Promise<Role> {
    return this.request<Role>("POST", "/api/v1/roles", input);
  }

  deleteRole(id: string): Promise<void> {
    return this.request<void>("DELETE", `/api/v1/roles/${id}`);
  }

  /** Answers with the codes as stored, not with the role — confirmation of what was written. */
  setRolePermissions(id: string, permissions: string[]): Promise<RolePermissions> {
    return this.request<RolePermissions>("PUT", `/api/v1/roles/${id}/permissions`, {
      permissions,
    });
  }

  /** Revokes a role, answering with what the user is left holding. */
  revokeUserRole(userId: string, roleCode: string): Promise<UserRoles> {
    return this.request<UserRoles>("DELETE", `/api/v1/users/${userId}/roles/${roleCode}`);
  }

  /* ── multi-factor authentication ── */

  /** Begins TOTP enrolment. The secret is shown once — render the QR, do not store it. */
  setupMfa(): Promise<MfaSetupResult> {
    return this.request<MfaSetupResult>("POST", "/api/v1/auth/mfa/setup", {});
  }

  activateMfa(code: string): Promise<MfaActivationResult> {
    return this.request<MfaActivationResult>("POST", "/api/v1/auth/mfa/activate", { code });
  }

  disableMfa(password: string): Promise<void> {
    return this.request<void>("POST", "/api/v1/auth/mfa/disable", { password });
  }

  /* ── subscription & entitlements ── */

  getSubscription(): Promise<SubscriptionView> {
    return this.request<SubscriptionView>("GET", "/api/v1/subscription");
  }

  listPlans(): Promise<Plan[]> {
    return this.request<Plan[]>("GET", "/api/v1/plans");
  }

  changePlan(planCode: string): Promise<SubscriptionView> {
    return this.request<SubscriptionView>("POST", "/api/v1/subscription/plan", { planCode });
  }

  /** A per-hospital flag override. `reason` is required — an override with no why is noise. */
  /** Overrides one feature flag, answering with the subscription as it now stands. */
  setFeatureFlag(input: {
    flag: string;
    enabled: boolean;
    reason: string;
    expiresAt?: string;
  }): Promise<SubscriptionView> {
    return this.request<SubscriptionView>("POST", "/api/v1/feature-flags", input);
  }

  /* ── patients, appointments, billing ── */

  /** Lookup by UHID is tenant-wide by design — a patient registered at one site is found at another. */
  getPatientByUhid(uhid: string): Promise<Patient> {
    return this.request<Patient>("GET", `/api/v1/patients/by-uhid/${uhid}`);
  }

  getAppointment(id: string): Promise<Appointment> {
    return this.request<Appointment>("GET", `/api/v1/appointments/${id}`);
  }

  /**
   * Moves an appointment. Answers with BOTH halves — the original, now `rescheduled`, and the new
   * booking that replaced it.
   *
   * Typed `Promise<Appointment>` until Phase 2.1, which was simply wrong: the payload has never
   * been an appointment, so `.id` on the result was `undefined` and the caller could not learn the
   * new appointment's id from the call that created it.
   */
  rescheduleAppointment(
    id: string,
    startAt: string,
    reason: string,
    /**
     * Stable across the retries of ONE submission, new for a genuinely new one. Without it the
     * `idempotent()` middleware this route carries can never fire — see `checkClientContract.ts`
     * §6, which exists because two clinical routes shipped exactly that way.
     */
    key?: string,
  ): Promise<RescheduleResult> {
    return this.request<RescheduleResult>(
      "POST",
      `/api/v1/appointments/${id}/reschedule`,
      { startAt, reason },
      { ...(key ? { idempotencyKey: key } : {}) },
    );
  }

  /** Voids a posted charge. Never deleted — a reversal is a record, an absence is not. */
  voidCharge(id: string, reason: string): Promise<Charge> {
    return this.request<Charge>("POST", `/api/v1/charges/${id}/void`, { reason });
  }

  /** Deactivated, not deleted: appointments were booked against it. */
  removeDoctorSchedule(id: string): Promise<void> {
    return this.request<void>("DELETE", `/api/v1/doctors/schedule/${id}`);
  }

  /* ── notifications ── */

  listNotifications(params?: {
    status?: string;
    templateKey?: string;
    recipientId?: string;
    page?: number;
    limit?: number;
  }): Promise<Paged<NotificationRecord>> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined) query.set(key, String(value));
    }
    const qs = query.toString();
    return this.paged<NotificationRecord>(`/api/v1/notifications${qs ? `?${qs}` : ""}`);
  }

  /**
   * The signed-in user's own inbox.
   *
   * ── ONE CALL SERVES THE BELL AND THE PAGE ───────────────────────────────
   * With `unread: true` the page meta's `total` IS the unread count, so the badge and its
   * dropdown come from a single request (`{ unread: true, limit: 5 }`); the full inbox asks
   * without the filter. There is deliberately no `recipientId` parameter — the server takes the
   * recipient from the session, which is what makes the route safe without a permission.
   */
  myNotifications(params?: {
    unread?: boolean;
    page?: number;
    limit?: number;
  }): Promise<Paged<InboxMessage>> {
    const query = new URLSearchParams();
    if (params?.unread !== undefined) query.set("unread", params.unread ? "true" : "false");
    if (params?.page !== undefined) query.set("page", String(params.page));
    if (params?.limit !== undefined) query.set("limit", String(params.limit));
    const qs = query.toString();
    return this.paged<InboxMessage>(`/api/v1/notifications/me${qs ? `?${qs}` : ""}`);
  }

  /**
   * Opening one message. Safe to repeat — the server keeps the FIRST `readAt`, so a double-click
   * or a retry cannot rewrite when the alert was actually seen.
   */
  markNotificationRead(id: string): Promise<InboxMessage> {
    return this.request<InboxMessage>("POST", `/api/v1/notifications/${id}/read`);
  }

  /**
   * Availability for the drugs on a prescribing pad. `prescription:create`, not a pharmacy
   * permission — a doctor asking whether their patient can get a drug here is not doing
   * inventory.
   *
   * ── WHY THIS IS CHUNKED ─────────────────────────────────────────────────────
   * `codes` is one comma-separated query parameter and the API caps it at 2,000 characters
   * (`availabilityQuerySchema`). The caller is the prescribing pad, which asks about every drug it
   * is SHOWING — and an unfiltered pad shows the whole formulary. Past roughly 100–150 codes the
   * single request became a 400, and because the pad swallows the error on purpose (an inventory
   * lookup must never put a banner over a prescribing screen), the stock column simply went blank
   * and stayed blank. Found by Stage A manual validation on 2026-08-19, on a hospital with 120
   * drugs; a real formulary is larger than that on day one.
   *
   * Splitting here rather than raising the cap: the bound is a reasonable thing for a URL to have,
   * and every caller of this method wants "tell me about these drugs" regardless of how many.
   */
  async medicineAvailability(codes: string[]): Promise<MedicineAvailability[]> {
    /** Comfortably inside the server's 2,000, with room for the longest code to not straddle it. */
    const BUDGET = 1_800;
    const batches: string[][] = [];
    let batch: string[] = [];
    let length = 0;
    for (const code of codes) {
      const cost = code.length + (batch.length === 0 ? 0 : 1);
      if (length + cost > BUDGET && batch.length > 0) {
        batches.push(batch);
        batch = [];
        length = 0;
      }
      batch.push(code);
      length += batch.length === 1 ? code.length : cost;
    }
    if (batch.length > 0) batches.push(batch);

    const pages = await Promise.all(
      batches.map((group) =>
        this.request<MedicineAvailability[]>(
          "GET",
          `/api/v1/medicines/availability?codes=${encodeURIComponent(group.join(","))}`,
        ),
      ),
    );
    return pages.flat();
  }

  /** Every lot of one drug, expired ones included — the pharmacist's shelf. */
  medicineBatches(code: string): Promise<MedicineBatch[]> {
    return this.request<MedicineBatch[]>(
      "GET",
      `/api/v1/medicines/${encodeURIComponent(code)}/batches`,
    );
  }

  listNotificationTemplates(): Promise<NotificationTemplate[]> {
    return this.request<NotificationTemplate[]>("GET", "/api/v1/notifications/templates");
  }

  updateNotificationTemplate(
    key: string,
    input: { subject?: string; body?: string; enabled?: boolean },
  ): Promise<NotificationTemplate> {
    return this.request<NotificationTemplate>(
      "PUT",
      `/api/v1/notifications/templates/${key}`,
      input,
    );
  }

  /* ── platform (operator console) ── */

  listOperators(): Promise<PlatformOperator[]> {
    return this.request<PlatformOperator[]>("GET", "/api/platform/v1/operators");
  }

  /**
   * Creates a platform operator and returns their ONE-TIME password.
   *
   * Typed `Promise<PlatformOperator>` until Phase 2.1 — a shape this endpoint has never sent. The
   * console had no typed way to read the temporary password it exists to display once, and only
   * once: the server stores a hash and cannot reissue it.
   */
  createOperator(input: {
    email: string;
    name: string;
    roles: string[];
  }): Promise<CreatedCredential> {
    return this.request<CreatedCredential>("POST", "/api/platform/v1/operators", input);
  }

  changeOperatorPassword(currentPassword: string, newPassword: string): Promise<void> {
    return this.request<void>("POST", "/api/platform/v1/auth/change-password", {
      currentPassword,
      newPassword,
    });
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
