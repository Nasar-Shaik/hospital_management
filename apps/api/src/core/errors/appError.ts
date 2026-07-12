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
