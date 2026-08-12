/**
 * Times are rendered in the BRANCH's zone, never the device's (M0 §14).
 *
 * ── WHY NOT THE PHONE'S CLOCK ───────────────────────────────────────────────
 * A doctor on call from another state must see the medication round at the time the ward will give
 * it. A clock that quietly follows the device turns an "08:00 dose" into a different number for
 * every reader, and a phone crossing a timezone on a train would appear to change a schedule that
 * nobody edited.
 *
 * ── `Branch.timezone` IS NOT VALIDATED SERVER-SIDE ──────────────────────────
 * The field is documented as IANA and accepted as any 64-character string (backend item E), so
 * `IST`, `+05:30` and `Asia/Kolkatta` are all storable today. `Intl.DateTimeFormat` throws
 * `RangeError` on any of them. Formatting a date must not be able to crash a ward list because of
 * something a hospital typed into a settings field two years ago — hence `isValidZone`, which is
 * the client-side half of that finding.
 */

/**
 * ── NEITHER OBVIOUS CHECK WORKS ON ITS OWN, AND BOTH FAILURES ARE SILENT ────
 * Measured on Node 22+/Hermes-class ICU, because the two plausible implementations are both wrong:
 *
 *   · `new Intl.DateTimeFormat(_, { timeZone: z })` is far too LENIENT. It accepts `IST`,
 *     `EST`, `GMT` and `+05:30`. Worse than accepting them, it silently resolves them — `EST`
 *     becomes `America/Panama`, a zone that never observes daylight saving, so a hospital that
 *     typed `EST` would get times that are correct for half the year.
 *
 *   · `Intl.supportedValuesOf("timeZone").includes(z)` is too STRICT in exactly the place that
 *     matters here: the list contains the legacy `Asia/Calcutta` and NOT `Asia/Kolkata`, so the
 *     modern, correct spelling of the zone every hospital on this platform is in would be
 *     rejected. Backend item E must not be implemented that way either.
 *
 * So: require the SHAPE of an IANA identifier — `Area/Location`, which no abbreviation and no
 * numeric offset has — and then let `Intl` reject a well-shaped name that does not exist
 * (`Asia/Kolkatta`). `UTC` is the one legitimate slash-free name, allowed explicitly.
 */
const IANA_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+$/;

/** Cached because the probe constructs a formatter, and a list renders hundreds of times. */
const zoneCache = new Map<string, boolean>();

export function isValidZone(zone: string | undefined): zone is string {
  if (!zone) return false;
  const cached = zoneCache.get(zone);
  if (cached !== undefined) return cached;

  let valid = false;
  if (zone === "UTC") {
    valid = true;
  } else if (IANA_SHAPE.test(zone)) {
    try {
      new Intl.DateTimeFormat("en-GB", { timeZone: zone });
      valid = true;
    } catch {
      valid = false;
    }
  }

  zoneCache.set(zone, valid);
  return valid;
}

/**
 * The zone to render in: the branch's, else the hospital default, else the platform default.
 *
 * The last fallback is `Asia/Kolkata` rather than the device zone, deliberately: every hospital on
 * the platform is in India today, and defaulting to the device would reintroduce exactly the bug
 * this module exists to avoid for the one user who is travelling.
 */
export const PLATFORM_DEFAULT_ZONE = "Asia/Kolkata";

export function displayZone(branchZone?: string, hospitalZone?: string): string {
  if (isValidZone(branchZone)) return branchZone;
  if (isValidZone(hospitalZone)) return hospitalZone;
  return PLATFORM_DEFAULT_ZONE;
}

export interface FormatOptions {
  zone: string;
  /** Append the zone abbreviation. On by default for anything a clinician may act on. */
  labelled?: boolean;
}

function parts(at: Date, zone: string, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: zone, ...opts }).format(at);
}

/** `09:00` — a wall-clock time in the branch's zone. */
export function formatTime(at: Date, options: FormatOptions): string {
  const time = parts(at, options.zone, { hour: "2-digit", minute: "2-digit", hour12: false });
  return options.labelled === false ? time : `${time} ${zoneAbbreviation(at, options.zone)}`;
}

/** `12 Aug 2026` */
export function formatDate(at: Date, zone: string): string {
  return parts(at, zone, { day: "2-digit", month: "short", year: "numeric" });
}

/** `12 Aug 2026, 09:00 IST` — the full stamp used on a record. */
export function formatDateTime(at: Date, zone: string): string {
  return `${formatDate(at, zone)}, ${formatTime(at, { zone })}`;
}

function zoneAbbreviation(at: Date, zone: string): string {
  const found = new Intl.DateTimeFormat("en-GB", { timeZone: zone, timeZoneName: "short" })
    .formatToParts(at)
    .find((part) => part.type === "timeZoneName");
  return found?.value ?? "";
}

/**
 * Parses what the API sends. `Wire<T>` maps every `Date` to an ISO string, so this is the one
 * place a string becomes a `Date` — and an unparseable value returns `undefined` rather than an
 * `Invalid Date` that renders as the word "Invalid" three components later.
 */
export function parseInstant(iso: string | undefined | null): Date | undefined {
  if (!iso) return undefined;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? undefined : at;
}
