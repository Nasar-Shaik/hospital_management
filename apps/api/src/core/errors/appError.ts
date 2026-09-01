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
    /**
     * Seconds a client should wait before retrying; `errorHandler` turns this into `Retry-After`.
     *
     * Only meaningful on a refusal that is expected to clear on its own or after an operator acts
     * (503/429). Omitted everywhere else, because telling a client to retry a 422 is a lie.
     */
    public readonly retryAfterSeconds?: number,
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

/**
 * HMS-TEN-005 — the tenant's LICENCE has lapsed past its grace window (ADR-0016).
 * Distinct from HMS-TEN-002 (operator suspend): the fix is renewal, not reactivation,
 * and it self-heals the moment the operator extends the expiry.
 */
export class LicenseExpiredError extends AppError {
  constructor(details?: unknown) {
    super("HMS-TEN-005", 403, "Subscription expired", details);
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

/* ── Request-level guards (ERROR_CODES: HMS-REQ-*) ───────────────────────── */

/**
 * HMS-REQ-002 — this `Idempotency-Key` was already used, for a DIFFERENT request.
 *
 * The one case where replaying would be dangerous rather than helpful: the caller asked for
 * something else under a name it had already spent. Answering with the old result would report
 * success for an operation that never ran — the ₹5,000 payment the client believes it made and
 * the hospital never took. So it is refused, loudly, and `details` carries what that key DID do
 * (ERROR_CODES: "Original response returned in `details`") so the caller can reconcile rather
 * than guess.
 *
 * Safe to disclose: a key is scoped to one tenant AND one user, so the original response is
 * always the caller's own.
 */
export class IdempotencyConflictError extends AppError {
  constructor(details: unknown) {
    super("HMS-REQ-002", 409, "Duplicate request (idempotency)", details);
  }
}

/**
 * HMS-REQ-004 — the SAME request is already in flight under this key.
 *
 * Distinct from HMS-REQ-002 on purpose, because the remedies are opposite. A conflict means
 * "your client has a bug, fix the key"; this means "your first attempt is still running, wait
 * and ask again" — and it is the answer a double-click gets, which is the most common thing
 * that will ever produce it. Collapsing the two into one code would tell a cashier to
 * investigate a defect that does not exist.
 *
 * This is what a claim looks like from the losing side of the unique index. Retryable: the
 * winner will finish, and the retry will then replay its result.
 */
export class IdempotencyInProgressError extends AppError {
  constructor(details: unknown) {
    super("HMS-REQ-004", 409, "A request with this Idempotency-Key is still in progress", details);
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
