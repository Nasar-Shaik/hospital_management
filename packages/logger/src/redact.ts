/**
 * PHI-safe log sanitisation (Constitution §3.2, Doc 09 §8).
 *
 * ── WHY A SANITISER AND NOT A LIST OF REDACT PATHS ──────────────────────────
 * pino's `redact` is backed by fast-redact, whose wildcards match exactly ONE
 * level: `*.name` censors `a.name` and walks straight past `b.c.name`. Proven,
 * not assumed — the probe that motivated this file produced:
 *
 *     {"a":{"name":"[R]"},"b":{"c":{"name":"DEEP"}}}
 *
 * The same probe showed the more serious half. pino's default error serializer
 * emits every enumerable own property of an Error, and `AppError.details` is a
 * public field, so one `logger.error({ err })` on a duplicate-patient refusal
 * wrote a real patient's name, UHID, date of birth and phone number into the log:
 *
 *     "details":{"candidates":[{"name":"Ramesh Kumar","uhid":"UH000123", ...}]}
 *
 * A list of known field names cannot fix either case, because the danger is
 * precisely the payload nobody predicted. So this module does two things a path
 * list cannot:
 *
 *   1. A DEPTH BOUND. Every runtime log call in this codebase logs flat scalars —
 *      ids, codes, counts, durations. Nothing legitimately logs a nested document.
 *      Beyond `MAX_DEPTH` an object becomes `"[Object]"`, so an accidental
 *      `logger.info({ patient })` cannot dump a record however its fields are
 *      named. That is a structural guarantee rather than a guess about vocabulary.
 *
 *   2. KEY MATCHING AT EVERY LEVEL, not one. Within the bound, PHI keys are
 *      redacted wherever they appear.
 *
 * ── REDACT VERSUS MASK ──────────────────────────────────────────────────────
 * Doc 09 §8 asks for masking, not deletion, on the two identifiers support
 * actually needs: "phone/UHID appear masked (`98•••••210`)". A masked value still
 * lets an engineer confirm two log lines concern the same patient, and still
 * cannot identify them. Everything else PHI-bearing is replaced outright, because
 * a partial name is still a name.
 */

/** Replaced outright — a partial value would still identify a person. */
const REDACT_KEYS = new Set(
  [
    // Identity
    "name",
    "fullname",
    "firstname",
    "lastname",
    "middlename",
    "patientname",
    "guardianname",
    "attendantname",
    "holdername",
    "relativename",
    "releasedto",
    "nextofkin",
    "fathername",
    "mothername",
    "spousename",
    // Contact
    "email",
    "address",
    "addressline",
    "addressline1",
    "addressline2",
    "line1",
    "line2",
    "street",
    "city",
    "district",
    "state",
    "pincode",
    "postalcode",
    "zip",
    // Strong identifiers
    "aadhaar",
    "aadhar",
    "abha",
    "abhaaddress",
    "pan",
    "passport",
    "policynumber",
    "insurancenumber",
    "mrn",
    "dob",
    "dateofbirth",
    // Clinical content — the "medical information" half of PHI
    "diagnosis",
    "diagnoses",
    "chiefcomplaint",
    "complaint",
    "symptoms",
    "examination",
    "history",
    "hpi",
    "advice",
    "plan",
    "notes",
    "note",
    "allergen",
    "allergy",
    "allergies",
    "drug",
    "drugname",
    "medication",
    "medications",
    "prescription",
    "observations",
    "resultvalue",
    "results",
    "findings",
    "impression",
    "remarks",
    "diagnosistext",
    // Credentials and secrets (kept here so there is ONE list to read)
    "password",
    "passwordhash",
    "token",
    "refreshtoken",
    "accesstoken",
    "authorization",
    "cookie",
    "secret",
    "apikey",
    "totpsecret",
    "recoverycodes",
    "phi",
  ].map((k) => k.toLowerCase()),
);

/** Masked rather than removed — support needs to correlate, not to identify (Doc 09 §8). */
const MASK_KEYS = new Set(
  ["phone", "mobile", "contactphone", "altphone", "telephone", "uhid", "abhanumber"].map((k) =>
    k.toLowerCase(),
  ),
);

/**
 * Keys whose values are structural, never PHI, and are worth keeping in full.
 * `stack` and `msg` would otherwise be truncated to uselessness.
 */
const NEVER_TRUNCATE = new Set(["stack", "msg", "message"]);

export const REDACTED = "[REDACTED]";

/**
 * Objects nested deeper than this collapse to `"[Object]"`.
 *
 * 2 is chosen from what the code actually logs. Every runtime call site is a flat
 * bag of scalars (`{ encounterId, orderId, count }`), and the one nested value any
 * of them carries is `err`, whose allow-listed fields sit one level down. So two
 * levels is everything the codebase legitimately produces, and a third level is
 * always either a mistake or a document.
 *
 * Note this bound applies AFTER the key rules, so `{ outer: { inner: { name } } }`
 * is still redacted by name rather than merely collapsed — the bound is the
 * backstop for fields we did not anticipate, not the first line of defence.
 */
const MAX_DEPTH = 2;
/** Arrays beyond this are truncated — a log line is not a data export. */
const MAX_ARRAY = 20;
/** Strings beyond this are truncated; a free-text clinical note is not a log field. */
const MAX_STRING = 512;

/**
 * `98•••••210` — the shape Doc 09 §8 specifies.
 *
 * Keeps the first two and last three characters so two lines about the same
 * patient can be tied together, which is the whole operational purpose. Short
 * values are hidden completely: masking a 5-character value leaves nothing to
 * hide behind.
 */
export function maskIdentifier(value: string): string {
  if (value.length < 7) return "•".repeat(value.length);
  const head = value.slice(0, 2);
  const tail = value.slice(-3);
  return `${head}${"•".repeat(Math.max(1, value.length - 5))}${tail}`;
}

function truncate(value: string, key: string): string {
  if (NEVER_TRUNCATE.has(key)) return value;
  return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value;
}

function sanitizeValue(value: unknown, key: string, depth: number): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") return truncate(value, key);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  // A function or symbol in a log payload is a mistake, not data.
  if (typeof value === "function" || typeof value === "symbol") return "[Function]";

  /**
   * Errors are normalised HERE, and that placement is load-bearing.
   *
   * pino runs `formatters.log` BEFORE `serializers` (verified, not assumed). So this sanitiser
   * is the first thing to see a thrown Error, while it is still an Error. Left to the generic
   * object branch below it would be flattened by `Object.entries`, which returns only ENUMERABLE
   * own properties — quietly dropping `message` and `stack` (non-enumerable on Error) while
   * KEEPING whatever custom fields were attached, which is precisely the wrong half.
   */
  if (value instanceof Error) return sanitizeObject(serializeError(value), depth + 1);

  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return "[Array]";
    const out = value.slice(0, MAX_ARRAY).map((v) => sanitizeValue(v, key, depth + 1));
    if (value.length > MAX_ARRAY) out.push(`…${String(value.length - MAX_ARRAY)} more`);
    return out;
  }

  if (typeof value === "object") {
    if (depth >= MAX_DEPTH) return "[Object]";
    return sanitizeObject(value as Record<string, unknown>, depth + 1);
  }

  return value;
}

function sanitizeObject(input: Record<string, unknown>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const lower = key.toLowerCase();

    if (REDACT_KEYS.has(lower)) {
      out[key] = REDACTED;
      continue;
    }
    if (MASK_KEYS.has(lower)) {
      out[key] = typeof value === "string" ? maskIdentifier(value) : REDACTED;
      continue;
    }
    out[key] = sanitizeValue(value, lower, depth);
  }
  return out;
}

/** The `formatters.log` hook — every log line passes through here, whatever produced it. */
export function sanitizeLogObject(input: Record<string, unknown>): Record<string, unknown> {
  return sanitizeObject(input, 0);
}

/**
 * The error serializer, and it is an ALLOW-LIST on purpose.
 *
 * pino's default emits every enumerable own property, which is how
 * `AppError.details` (duplicate-patient candidates, complete with names and
 * UHIDs), Mongoose's `ValidationError.errors[path].value` (the rejected field
 * value) and MongoDB's `E11000 keyValue` (the colliding value — often a phone
 * number) all reach the log without anyone writing them there.
 *
 * Only these five fields survive. Anything a future error carries is dropped
 * unless someone deliberately adds it here, which is the correct default for a
 * channel that is shipped, indexed and retained for thirteen months.
 */
/**
 * The PHI-safety half of the pino configuration, in one exported object.
 *
 * `createLogger` spreads it and the test suite instantiates from it, so a redaction test can
 * never end up describing a logger the services do not actually use — which is how a green
 * redaction suite comes to sit above a leaking logger.
 */
export const LOGGER_OPTIONS = {
  formatters: { log: sanitizeLogObject },
  serializers: { err: serializeError, error: serializeError },
} as const;

export function serializeError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) {
    /**
     * Already normalised by the sanitiser above (which pino runs first), so pass it straight
     * through — re-wrapping it would turn a perfectly good `{type, message, code, stack}` into
     * `{type: "object"}` and throw away the classification an on-call engineer needs.
     */
    if (err !== null && typeof err === "object") return err as Record<string, unknown>;
    return { type: typeof err, message: truncate(String(err), "message") };
  }
  const withCode = err as Error & { code?: unknown; httpStatus?: unknown; statusCode?: unknown };
  return {
    type: err.name,
    message: truncate(err.message, "message"),
    ...(typeof withCode.code === "string" || typeof withCode.code === "number"
      ? { code: withCode.code }
      : {}),
    ...(typeof withCode.httpStatus === "number" ? { httpStatus: withCode.httpStatus } : {}),
    ...(typeof withCode.statusCode === "number" ? { statusCode: withCode.statusCode } : {}),
    ...(err.stack ? { stack: err.stack } : {}),
  };
}
