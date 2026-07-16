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

export interface ApiClientOptions {
  /** Absolute (`http://apollo.paperlesstech.in:4000`) or same-origin (`""`). */
  baseUrl: string;
  /** Returns the in-memory access token, if the caller has one. */
  getAccessToken?: () => string | undefined;
  /** Send cookies — required for the refresh flow. */
  credentials?: RequestCredentials;
  /** Overrides the `Host` the API sees. Server-side only; browsers ignore it. */
  tenantHost?: string;
  fetchImpl?: typeof fetch;
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

export interface StaffMember {
  id: string;
  email: string;
  name: string;
  status: "invited" | "active" | "locked" | "disabled" | "archived";
  phone?: string;
  employeeId?: string;
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
  reason?: string;
  branchId?: string;
  arrivedAt: string;
  closedAt?: string;
  /** Present when `class` is `IP`. The bed is RECORDED, not reserved — there is no
   * bed inventory, so nothing stops two patients being recorded in the same bed. */
  bed?: Bed;
  admittedAt?: string;
  dischargedAt?: string;
  /** The OP encounter this admission came out of. */
  admittedFrom?: string;
}

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

/* ── Admissions (ADR-0013 §4) ─────────────────────────────────────────────── */

export interface Bed {
  ward: string;
  bedCode: string;
  /** The tariff the bed-day is billed at — `BED_GEN`, `BED_ICU`. */
  tariffCode: string;
}

export type WardNoteType = "progress" | "discharge_summary";

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

export interface Hospital {
  id: string;
  slug: string;
  hospitalName: string;
  status: "provisioning" | "trial" | "active" | "suspended" | "terminated";
  planCode?: string;
  databaseName: string;
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

/* ── the client ───────────────────────────────────────────────────────────── */

export class ApiClient {
  private readonly baseUrl: string;
  private readonly getAccessToken?: () => string | undefined;
  private readonly credentials: RequestCredentials;
  private readonly tenantHost?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.getAccessToken = options.getAccessToken;
    this.credentials = options.credentials ?? "include";
    this.tenantHost = options.tenantHost;

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

  private async send<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ data: T; meta?: PageMeta }> {
    const token = this.getAccessToken?.();

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    if (this.tenantHost) headers.host = this.tenantHost;

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      credentials: this.credentials,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });

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
      throw new ApiClientError(
        res.status,
        err?.code ?? "HMS-GEN-500",
        err?.message ?? "Request failed",
        err?.details,
        err?.traceId,
      );
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

  /** Exchanges the httpOnly refresh cookie for a fresh access token. */
  refresh(): Promise<TokenPair> {
    return this.request<TokenPair>("POST", "/api/v1/auth/refresh", {});
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
    params: { page?: number; limit?: number; q?: string } = {},
  ): Promise<Paged<StaffMember>> {
    const query = new URLSearchParams();
    if (params.page) query.set("page", String(params.page));
    if (params.limit) query.set("limit", String(params.limit));
    if (params.q) query.set("q", params.q);
    const qs = query.toString();
    return this.paged<StaffMember>(`/api/v1/users${qs ? `?${qs}` : ""}`);
  }

  createStaff(input: {
    email: string;
    name: string;
    phone?: string;
    roles?: string[];
  }): Promise<CreateStaffResult> {
    return this.request<CreateStaffResult>("POST", "/api/v1/users", input);
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

  setStaffStatus(id: string, status: "active" | "disabled"): Promise<StaffMember> {
    return this.request<StaffMember>("POST", `/api/v1/users/${id}/status`, { status });
  }

  resetStaffPassword(id: string): Promise<{ temporaryPassword?: string }> {
    return this.request("POST", `/api/v1/users/${id}/reset-password`, {});
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

  /* ── Admissions ───────────────────────────────────────────────────────────
   * The OP encounter closes and an IP one opens in the same Episode of Care. Two
   * encounters, one care story (ADR-0013 §4).
   */

  admitPatient(
    encounterId: string,
    input: {
      ward: string;
      bedCode: string;
      tariffCode: string;
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

  addWardNote(encounterId: string, text: string): Promise<WardNote> {
    return this.request<WardNote>("POST", `/api/v1/encounters/${encounterId}/notes`, { text });
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

  /** The signature. The pharmacy hears about it without anyone telling them. */
  signPrescription(id: string): Promise<Prescription> {
    return this.request<Prescription>("POST", `/api/v1/prescriptions/${id}/sign`);
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
    input: { items: { lineIndex: number; quantity: number }[]; requestId?: string },
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

  /** Takes money. `amount` is PAISE. Refused on a draft; overpayment is refused. */
  recordPayment(
    invoiceId: string,
    input: { amount: number; method: string; reference?: string },
  ): Promise<Invoice> {
    return this.request<Invoice>("POST", `/api/v1/invoices/${invoiceId}/payments`, input);
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
  }): Promise<{ hospital: Hospital; admin: { email: string; temporaryPassword?: string } }> {
    return this.request("POST", "/api/platform/v1/hospitals", input);
  }

  setHospitalStatus(id: string, status: Hospital["status"]): Promise<Hospital> {
    return this.request<Hospital>("POST", `/api/platform/v1/hospitals/${id}/status`, { status });
  }

  setHospitalPlan(id: string, planCode: string): Promise<unknown> {
    return this.request("POST", `/api/platform/v1/hospitals/${id}/plan`, { planCode });
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
