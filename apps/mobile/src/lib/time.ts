/**
 * Times are rendered in the BRANCH's zone, never the device's (M0 §14).
 *
 * ── WHY NOT THE PHONE'S CLOCK ───────────────────────────────────────────────
 * A doctor on call from another state must see the medication round at the time the ward will give
 * it. A clock that quietly follows the device turns an "08:00 dose" into a different number for
 * every reader, and a phone crossing a timezone on a train would appear to change a schedule that
 * nobody edited.
 *
 * ── THE SERVER NOW VALIDATES `Branch.timezone` — AND THIS STILL MATTERS ─────
 * When this module was written the field was accepted as any 64-character string, so `IST`,
 * `+05:30` and `Asia/Kolkatta` were all storable and every one of them makes
 * `Intl.DateTimeFormat` throw `RangeError`. The API closed that at the edge (`core/time/zone.ts`,
 * the same two-part rule as below).
 *
 * Validation at the edge stops NEW bad data; it cannot fix a branch row written before the rule
 * existed, and this app talks to whatever version a hospital is running. Formatting a date must
 * not be able to crash a ward list because of something typed into a settings field two years
 * ago — so `isValidZone` stays, and stays deliberately a separate copy: the mobile core imports
 * nothing from the server, and a shared package would be the only thing it did import.
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

/**
 * `2026-08-12` — the calendar day an instant falls on IN THE BRANCH'S ZONE.
 *
 * This is what `?date=` on the encounter list takes, and it is the reason the parameter cannot be
 * built from the device clock: a doctor in London asking for "today" at 21:00 would otherwise ask
 * the Hyderabad server for yesterday's register and be told, accurately, that nobody is waiting.
 *
 * `en-CA` because its short date format IS `YYYY-MM-DD`; assembling the parts by hand is the same
 * answer with three more places to get the padding wrong.
 */
export function formatDayKey(at: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/**
 * `Today` / `Yesterday` / `12 Aug 2026` — a date heading a clinician can scan.
 *
 * Both instants are reduced to a day key in the SAME zone before they are compared, so "today"
 * means today at the hospital. Comparing a formatted date against `Date.now()` in the device zone
 * is the bug this exists to avoid: at 01:00 IST on a phone left in UTC, every event from the
 * current shift would be labelled "Yesterday".
 */
export function formatRelativeDay(at: Date, zone: string, now: Date = new Date()): string {
  const day = formatDayKey(at, zone);
  if (day === formatDayKey(now, zone)) return "Today";
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  if (day === formatDayKey(yesterday, zone)) return "Yesterday";
  return formatDate(at, zone);
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
