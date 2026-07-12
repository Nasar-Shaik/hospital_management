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
