/**
 * Structured JSON logger (Doc 09 §8, Doc 04 §8).
 * - pino JSON output; every log line carries service name.
 * - `traceId`/`tenantId` are bound per request via child loggers (P1 wires ALS context).
 * - PHI redaction paths are registered here so no service can forget them.
 */
import { pino, type Logger } from "pino";

export interface CreateLoggerOptions {
  /** Service name stamped on every line, e.g. "api", "workers". */
  service: string;
  level?: string;
  pretty?: boolean;
}

/** Redaction paths for fields that must never appear in logs (Doc 09 §8, Constitution §3.2). */
const REDACT_PATHS = [
  "*.password",
  "*.passwordHash",
  "*.authorization",
  "req.headers.authorization",
  "req.headers.cookie",
  "*.token",
  "*.refreshToken",
  "*.phi",
];

export function createLogger(options: CreateLoggerOptions): Logger {
  return pino({
    level: options.level ?? process.env.LOG_LEVEL ?? "info",
    base: { service: options.service },
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    timestamp: pino.stdTimeFunctions.isoTime,
    transport: options.pretty ? { target: "pino/file", options: { destination: 1 } } : undefined,
  });
}

export type { Logger };
