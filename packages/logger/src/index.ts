/**
 * Structured JSON logger (Doc 09 §8, Doc 04 §8).
 * - pino JSON output; every log line carries service name.
 * - `traceId`/`tenantId` are bound per request via child loggers (P1 wires ALS context).
 * - PHI redaction is registered here so no service can forget it (see ./redact.ts for WHY it
 *   is a recursive sanitiser with a depth bound rather than a list of redact paths).
 */
import { pino, type Logger } from "pino";
import { LOGGER_OPTIONS } from "./redact.js";

export interface CreateLoggerOptions {
  /** Service name stamped on every line, e.g. "api", "workers". */
  service: string;
  level?: string;
  pretty?: boolean;
}

/**
 * Kept alongside the sanitiser, not replaced by it.
 *
 * These are exact paths for the two places a credential arrives in a shape the key-based pass
 * would not recognise: an HTTP header bag, where the sensitive thing is `req.headers.cookie`
 * rather than a field called `cookie` on a domain object. Cheap, and one less thing resting on
 * the sanitiser being reached.
 */
const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "request.headers.authorization",
  "request.headers.cookie",
];

export function createLogger(options: CreateLoggerOptions): Logger {
  return pino({
    level: options.level ?? process.env.LOG_LEVEL ?? "info",
    base: { service: options.service },
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    /**
     * The single choke point: `formatters.log` sees every line from every module whatever
     * built it, and the `err` serializer replaces pino's default (which emits every enumerable
     * own property of an Error, and so leaks `AppError.details`, Mongoose validation values and
     * E11000 key values). Shared with the test suite so the two cannot diverge — see redact.ts.
     */
    ...LOGGER_OPTIONS,
    timestamp: pino.stdTimeFunctions.isoTime,
    transport: options.pretty ? { target: "pino/file", options: { destination: 1 } } : undefined,
  });
}

export { maskIdentifier, REDACTED } from "./redact.js";
export type { Logger };
