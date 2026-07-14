/**
 * AppError hierarchy (Doc 09 §7). Codes come exclusively from
 * docs/ERROR_CODES.md — never invent codes inline.
 */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    message: string,
    public readonly details?: unknown,
    public readonly isOperational = true,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found", details?: unknown) {
    super("HMS-GEN-404", 404, message, details);
  }
}

export class ValidationError extends AppError {
  constructor(details: unknown) {
    super("HMS-VAL-001", 400, "Validation failed", details);
  }
}

/* ── Identity & Authentication (ADR-0009, ERROR_CODES: HMS-AUTH-*) ───────── */

/**
 * HMS-AUTH-001 — bad email/password, unknown user, disabled account, or a
 * locked account. All four collapse into ONE response on purpose: distinguishing
 * them would turn the login form into a user-enumeration oracle. `details` may
 * carry `lockedUntil` because that is already known to a legitimate owner.
 */
export class InvalidCredentialsError extends AppError {
  constructor(details?: unknown) {
    super("HMS-AUTH-001", 401, "Invalid credentials", details);
  }
}

/** HMS-AUTH-002 — access/refresh token missing, malformed, expired or revoked. */
export class SessionExpiredError extends AppError {
  constructor(details?: unknown) {
    super("HMS-AUTH-002", 401, "Session expired", details);
  }
}

/**
 * HMS-AUTH-003 — an already-rotated refresh token was presented again. Either
 * the token was stolen or the client is broken; both mean the whole family is
 * untrustworthy, so it is revoked before this is thrown.
 */
export class TokenReuseDetectedError extends AppError {
  constructor(details?: unknown) {
    super("HMS-AUTH-003", 401, "Refresh token reuse detected", details);
  }
}

/** HMS-AUTH-004 — password verified, but the account requires an MFA challenge. */
export class MfaRequiredError extends AppError {
  constructor(details?: unknown) {
    super("HMS-AUTH-004", 403, "MFA required", details);
  }
}

/** HMS-AUTH-005 — authenticated, but lacking the required permission (Phase 1C). */
export class InsufficientPermissionError extends AppError {
  constructor(details?: unknown) {
    super("HMS-AUTH-005", 403, "Insufficient permission", details);
  }
}

/* ── Tenancy (Doc 03 §1.2, ERROR_CODES: HMS-TEN-*) ───────────────────────── */

/** HMS-TEN-001 — host did not resolve to any tenant in the registry. */
export class TenantNotFoundError extends AppError {
  constructor(details?: unknown) {
    super("HMS-TEN-001", 404, "Organization not found", details);
  }
}

/** HMS-TEN-002 — tenant exists but its status is not servable (suspended/expired/terminated). */
export class TenantSuspendedError extends AppError {
  constructor(details?: unknown) {
    super("HMS-TEN-002", 403, "Organization suspended", details);
  }
}

/** HMS-TEN-003 — JWT tenant claim does not match the host-resolved tenant (Doc 04 §2.2.1 step 4). */
export class TenantMismatchError extends AppError {
  constructor(details?: unknown) {
    super("HMS-TEN-003", 403, "Tenant mismatch", details);
  }
}

/** HMS-TEN-004 — registry or tenant database unreachable; client may retry with backoff. */
export class TenantUnavailableError extends AppError {
  constructor(details?: unknown) {
    super("HMS-TEN-004", 503, "A dependency is unavailable", details);
  }
}

/* ── Patients (Doc 02 C1, ERROR_CODES: HMS-PAT-*) ────────────────────────── */

/** HMS-PAT-001 — no patient with that id or UHID *that this caller may see*. */
export class PatientNotFoundError extends AppError {
  constructor(details?: unknown) {
    super("HMS-PAT-001", 404, "Patient not found", details);
  }
}

/**
 * HMS-PAT-002 — the MPI believes this person is already registered.
 *
 * A 409, not a 400: the request is well-formed and may well be correct. It is a
 * CONFLICT with what we already know, and the resolution is a human decision —
 * use the existing record, or override and register anyway (which needs
 * `patient:merge`). `details.candidates` carries who we think they are, with the
 * reason for each, because a refusal a clerk cannot act on just gets worked around.
 */
export class DuplicatePatientError extends AppError {
  constructor(details: unknown) {
    super("HMS-PAT-002", 409, "Possible duplicate patient", details);
  }
}
