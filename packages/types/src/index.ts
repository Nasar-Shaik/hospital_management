/**
 * Shared domain-neutral types (Doc 04 §1). Business DTOs are added per module
 * in later phases via `z.infer<>` from @medicore/validation — never hand-written
 * duplicates (Doc 09 §5).
 */

/** Standard API response envelope (Doc 04 §2.3, Doc 09 §4). */
export interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  meta?: PageMeta;
  error?: ApiError;
}

export interface ApiError {
  /** Code from docs/ERROR_CODES.md — the only legal source. */
  code: string;
  message: string;
  details?: unknown;
  traceId?: string;
}

export interface PageMeta {
  page: number;
  limit: number;
  total?: number;
  hasMore?: boolean;
}

/** Health/readiness contract shared by all services (Doc 04 §8). */
export interface HealthStatus {
  status: "ok";
  service: string;
  version: string;
  uptimeSeconds: number;
}

export interface ReadinessStatus {
  status: "ready" | "degraded";
  service: string;
  checks: Record<string, "up" | "down" | "skipped">;
}
