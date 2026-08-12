/**
 * A logger that cannot leak PHI, because it cannot be handed an object (M0 §15).
 *
 * ── THE SIGNATURE IS THE CONTROL ────────────────────────────────────────────
 * Every PHI leak into logs starts the same way: `log.info({ patient }, "loaded")`. Somebody adds a
 * field to the object months later and it silently starts being written. So this logger takes a
 * message and an ALLOW-LISTED context — a fixed set of keys with primitive types — and there is no
 * overload that takes an arbitrary object. A leak now requires editing this file, which is exactly
 * where the reviewer is looking.
 *
 * The same rule applies to the analytics and crash pipeline (M0 §15), which is why nothing here
 * forwards anywhere: no SDK is installed in M1, and none may be until the scrubber exists.
 */

/** The only fields a log line may carry. Every one of these is safe in a vendor's database. */
export interface LogContext {
  /** The join key to the server's own log for this request. Resolves to everything, for anyone
   *  with API access, and to nothing for anyone without. This is what replaces the details. */
  traceId?: string;
  /** Templated — `/patients/[id]`, never `/patients/6a7b83…`. An id in a route is PHI. */
  route?: string;
  tenantSlug?: string;
  userId?: string;
  branchId?: string;
  role?: string;
  permission?: string;
  status?: number;
  code?: string;
  durationMs?: number;
  appVersion?: string;
  apiVersion?: string;
  /** An error's CLASS, not its message — a server message can quote a request body. */
  errorName?: string;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

/**
 * Strips an id out of a path so it can be logged: `/patients/6a7b…/orders/9f2` →
 * `/patients/[id]/orders/[id]`. Used for `route`, and the reason `route` is safe to record at all.
 */
export function templatePath(path: string): string {
  return path
    .split("/")
    .map((segment) => (/^[0-9a-f]{24}$/i.test(segment) || /^\d+$/.test(segment) ? "[id]" : segment))
    .join("/");
}

type Sink = (level: LogLevel, message: string, context?: LogContext) => void;

const consoleSink: Sink = (level, message, context) => {
  const line = context ? `${message} ${JSON.stringify(context)}` : message;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  // debug/info are dropped in a release build — see `createLogger`.
};

export function createLogger(
  options: { verbose: boolean; sink?: Sink } = { verbose: false },
): Logger {
  const sink = options.sink ?? consoleSink;
  const at =
    (level: LogLevel) =>
    (message: string, context?: LogContext): void => {
      if (!options.verbose && (level === "debug" || level === "info")) return;
      sink(level, message, context);
    };

  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}
