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
