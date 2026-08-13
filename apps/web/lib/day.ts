/**
 * Calendar days, in the BRANCH's timezone — never the browser's, never UTC.
 *
 * ── THE BUG THIS REPLACES, AND WHY IT WAS INVISIBLE ─────────────────────────
 * Six screens built a `YYYY-MM-DD` key by calling `toISOString().slice(0, 10)` on a Date they had
 * just constructed from LOCAL parts. `toISOString()` is UTC, so in every zone east of Greenwich
 * the key is the previous day for the first hours of the morning — and for a date built at local
 * midnight, always:
 *
 *     new Date(2026, 7, 1)            // 1 Aug 2026, 00:00 in Asia/Kolkata
 *     .toISOString().slice(0, 10)     // "2026-07-31"
 *
 * That is the Reports and MRD month presets. "This month" asked the server for a range starting
 * the previous day, so every collections total, dues figure and disease count carried an extra
 * day at the front and dropped one at the back. Nothing looked wrong: the dates in the picker
 * were right, and only the request was a day out.
 *
 * The same expression made the theatre and ambulance boards default to YESTERDAY between midnight
 * and 05:30 IST, which is precisely the night shift.
 *
 * ── WHOSE DAY IS IT ─────────────────────────────────────────────────────────
 * The ward's. A clinical or operational day belongs to the site it happened at, not to the person
 * reading it: a regional administrator in one state looking at another state's theatre list must
 * see that theatre's day, and a laptop with a wrong clock must not be able to move a report period.
 * This is the same rule the API applies server-side (`core/time/day.ts`) and the mobile app applies
 * on the device (`src/lib/time.ts`); this is the web copy of it.
 *
 * ── WHY A SEPARATE COPY RATHER THAN A SHARED PACKAGE ────────────────────────
 * For the reason mobile states about its own: a shared package would be the only thing these three
 * had in common, and the rule is small, stable and worth reading in place. What must NOT drift is
 * the answer, and the tests pin the answer rather than the implementation — the fallback chain, the
 * half-open range, and the DST behaviour are asserted against real zones.
 *
 * ── NO DATE LIBRARY ─────────────────────────────────────────────────────────
 * `Intl` does all of it and ships in every browser this app supports. Adding `date-fns-tz` or
 * `dayjs` would be a dependency, a bundle cost and a second source of truth for the one question
 * that must have exactly one answer.
 */

/**
 * The zone every hospital on this platform is in, and the last resort of the chain below.
 *
 * Deliberately NOT the browser's zone. A device zone is a property of the reader; a clinical day is
 * a property of the ward, and silently substituting one for the other is the whole defect. It
 * matches the API's `DEFAULT_TIMEZONE` and mobile's `PLATFORM_DEFAULT_ZONE`, so a branch that has
 * never had a timezone set reads the same on all three surfaces.
 */
export const PLATFORM_DEFAULT_ZONE = "Asia/Kolkata";

/**
 * ── NEITHER OBVIOUS CHECK WORKS ALONE, AND BOTH FAILURES ARE SILENT ─────────
 * `new Intl.DateTimeFormat(_, { timeZone: z })` is far too lenient: it accepts `IST`, `EST` and
 * `+05:30`, and worse, RESOLVES them — `EST` becomes `America/Panama`, which never observes
 * daylight saving, so a hospital that typed it gets times that are right for half the year.
 *
 * `Intl.supportedValuesOf("timeZone").includes(z)` is too strict in exactly the wrong place: the
 * list carries the legacy `Asia/Calcutta` and not `Asia/Kolkata`, so the modern spelling of the
 * zone that matters most here would be rejected.
 *
 * So: require the SHAPE of an IANA identifier — `Area/Location`, which no abbreviation and no
 * numeric offset has — then let `Intl` reject a well-shaped name that does not exist. `UTC` is the
 * one legitimate slash-free name and is allowed explicitly.
 */
const IANA_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+$/;
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
 * The zone to work in: the active branch's, else the hospital's main site, else the platform
 * default. Each candidate is validated and fallen through, so a branch row carrying `IST` — which
 * the API only started rejecting later, and which makes `Intl` throw — behaves as though it
 * carried nothing rather than crashing a report screen.
 */
export function resolveZone(...candidates: (string | undefined)[]): string {
  for (const candidate of candidates) {
    if (isValidZone(candidate)) return candidate;
  }
  return PLATFORM_DEFAULT_ZONE;
}

/**
 * Which calendar day an instant falls on, in a zone. `2026-08-13`.
 *
 * `en-CA` because its short date format IS ISO `YYYY-MM-DD` — a documented locale behaviour, and
 * cheaper than assembling the parts by hand. The same trick the API uses.
 */
export function dayKeyInZone(at: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: resolveZone(zone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** Today, where the branch is. The default for every "today" on every operational screen. */
export function todayInZone(zone: string, now: Date = new Date()): string {
  return dayKeyInZone(now, zone);
}

/** How far a zone is from UTC at a given instant, in milliseconds. Positive east of Greenwich. */
function offsetMsAt(at: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);

  const at_ = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asIfUtc = Date.UTC(
    at_("year"),
    at_("month") - 1,
    at_("day"),
    at_("hour"),
    at_("minute"),
    at_("second"),
  );
  return asIfUtc - at.getTime();
}

/**
 * The INSTANT at which a calendar day begins in a zone — what a date-only value means on the wire.
 *
 * ── TWO PASSES, BECAUSE THE OFFSET DEPENDS ON THE ANSWER ────────────────────
 * To know what UTC instant is midnight in New York, you need New York's offset; to know its offset,
 * you need an instant. So: guess with the offset at the naive timestamp, then re-read the offset at
 * the guess and correct if it moved. One correction is enough — offsets change by an hour or two,
 * never by a day.
 *
 * On the rare spring-forward that skips local midnight itself (Asia/Beirut, America/Santiago), the
 * second pass lands on the instant the day actually begins, which is the only useful answer.
 */
export function startOfDayInZone(dayKey: string, zone: string): Date {
  const resolved = resolveZone(zone);
  const [year = 1970, month = 1, day = 1] = dayKey.split("-").map(Number);
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0, 0);

  const firstGuess = naive - offsetMsAt(new Date(naive), resolved);
  const corrected = naive - offsetMsAt(new Date(firstGuess), resolved);
  return new Date(corrected);
}

/**
 * Calendar arithmetic on the KEY, not on a zoned timestamp.
 *
 * ── WHY THE KEY IS THE UNIT ─────────────────────────────────────────────────
 * The mistake this replaces is stepping a real Date: `probe.setDate(probe.getDate() + 1)` on a
 * value built from local parts, which is what the appointments screen did to find a doctor's next
 * working day. A spring-forward day is 23 hours long, so that arithmetic drifts an hour each time
 * it crosses one and eventually reports the wrong date.
 *
 * Inside here the arithmetic is deliberately done in UTC, where every day is exactly 24 hours and
 * no transition exists — so `Date.UTC(y, m, d + n)` is exact. `toISOString()` is the correct
 * reading of a Date built that way, which is why this is the one place in the app allowed to use
 * it for a day key.
 */
export function addDays(dayKey: string, days: number): string {
  const [year = 1970, month = 1, day = 1] = dayKey.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

/** The first day of a day-key's month. `2026-08-13` → `2026-08-01`. */
export function startOfMonth(dayKey: string): string {
  return `${dayKey.slice(0, 7)}-01`;
}

/** The last day of the month BEFORE a day-key's. `2026-08-13` → `2026-07-31`. */
export function endOfPreviousMonth(dayKey: string): string {
  return addDays(startOfMonth(dayKey), -1);
}

/** Shifts a day-key by whole months, clamped to the 1st. `2026-08-13`, −2 → `2026-06-01`. */
export function startOfMonthsAgo(dayKey: string, months: number): string {
  const [year = 1970, month = 1] = dayKey.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1 - months, 1));
  return shifted.toISOString().slice(0, 10);
}

export interface DayRange {
  /** Inclusive lower bound, as an instant. */
  from: string;
  /** EXCLUSIVE upper bound — the instant the day after `to` begins. */
  to: string;
}

/**
 * A branch-local date range as the instants the API expects — half-open, always.
 *
 * `>= start` and `< the next midnight`. Never `<= 23:59:59.999`: that is a real instant, a payment
 * can land in the millisecond after it, and it would vanish from the day's takings. The API says
 * the same thing about its own ranges, and the two must agree or the report is wrong at the edges.
 */
export function dayRangeInZone(fromKey: string, toKey: string, zone: string): DayRange {
  return {
    from: startOfDayInZone(fromKey, zone).toISOString(),
    to: startOfDayInZone(addDays(toKey, 1), zone).toISOString(),
  };
}
