/**
 * Calendar days, in the hospital's timezone.
 *
 * ── WHY THIS IS NOT A ONE-LINER ─────────────────────────────────────────────
 * A receptionist asking for "today's patients" means today in Kolkata, not today in
 * UTC. `new Date("2026-07-16")` parses as UTC midnight, which is 05:30 on the 16th in
 * India — so a naive range would silently omit every patient who arrived before half
 * past five and include everyone from the small hours of the 17th. The register would
 * be subtly, permanently wrong, and nobody would notice for months.
 *
 * ── THE RANGE IS HALF-OPEN, ALWAYS ──────────────────────────────────────────
 * `>= start` and `< next midnight`. Never `<= 23:59:59.999`: that is a real instant, a
 * patient can arrive in the millisecond after it, and they would vanish from the day's
 * list. It is a bug that hides for years and then loses exactly one record — usually
 * the one somebody is looking for.
 */
import { env } from "../../config/env.js";
import { zoneOrDefault } from "./zone.js";

/**
 * Which calendar day an instant falls on, in the hospital's zone. `2026-07-16`.
 *
 * `en-CA` because its short date format IS ISO `YYYY-MM-DD` — a documented locale
 * behaviour, and cheaper than assembling parts by hand.
 */
export function dayKeyInZone(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    // Validation at the edge stops new bad data; it cannot fix a branch row written before the
    // rule existed, and `Intl` throws on an unknown zone. A stay costed in the platform default
    // is wrong by at most a day boundary and shows in the bill; a RangeError here is a ward that
    // cannot discharge anybody. See `core/time/zone.ts`.
    timeZone: zoneOrDefault(timeZone, env.DEFAULT_TIMEZONE),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/**
 * How many calendar days a stay TOUCHES — the hospital's unit of bed billing.
 *
 * ── WHY "DAYS STARTED" AND NOT 24-HOUR BLOCKS ───────────────────────────────
 * A patient admitted at 22:00 and discharged at 09:00 the next morning has been in the
 * bed for eleven hours, and no hospital in India bills that as zero. The bed was made,
 * occupied and turned over across two calendar days, and it could not be sold to anyone
 * else on either of them. Counting whole 24-hour blocks would bill that stay ₹0 — which
 * is not generosity, it is a hole in the ledger the ward will paper over by admitting
 * people at one minute past midnight.
 *
 * So: **every calendar day the patient was in the bed for any part of, minimum one.**
 * Admitted and discharged the same afternoon is one day. Admitted Monday 22:00,
 * discharged Wednesday 09:00 is three (Mon, Tue, Wed).
 *
 * This is a POLICY, and it is the commonest Indian one — not a law of nature. A hospital
 * that bills 24-hour blocks from the admission time needs a different function, and when
 * one asks, it belongs here beside this one, chosen by config (ADR-0011). It does NOT
 * belong inlined into billing with an `if`.
 *
 * In the hospital's ZONE, because "which day" is the entire question. Computed on day
 * KEYS rather than by dividing milliseconds, so a DST transition — a 23-hour day — cannot
 * round a stay down by one.
 */
export function calendarDaysStarted(from: Date, to: Date, timeZone: string): number {
  if (to.getTime() < from.getTime()) {
    throw new Error(
      `calendarDaysStarted: discharge (${to.toISOString()}) precedes admission (${from.toISOString()})`,
    );
  }

  const startKey = dayKeyInZone(from, timeZone);
  const endKey = dayKeyInZone(to, timeZone);

  // Both keys are wall-clock dates in the zone; parsing them as UTC midnights makes the
  // difference a whole number of days with no offset arithmetic to get wrong.
  const startUtc = Date.parse(`${startKey}T00:00:00.000Z`);
  const endUtc = Date.parse(`${endKey}T00:00:00.000Z`);

  const days = Math.round((endUtc - startUtc) / 86_400_000);
  return days + 1;
}

/**
 * Calendar arithmetic on the day KEY, not on an instant. `("2026-08-23", 7)` → `"2026-08-30"`.
 *
 * ── WHY THE KEY IS THE UNIT ─────────────────────────────────────────────────
 * "Come back in seven days" is a statement about the calendar, not about 604,800,000
 * milliseconds. Adding that many milliseconds to an instant drifts by an hour across a DST
 * transition and eventually lands on the wrong date; stepping a `Date` with `setDate` and
 * re-reading it has the same fault. Inside here the arithmetic is done in UTC, where every day is
 * exactly 24 hours and no transition exists, so `Date.UTC(y, m, d + n)` is exact.
 *
 * The zone question is already answered before this is called: the caller turns an instant into a
 * key with `dayKeyInZone` (the site's clock), and this walks the calendar from there. The web app
 * carries the same function for the same reason (`apps/web/lib/day.ts`).
 *
 * Throws on a malformed key rather than returning `NaN-aN-aN`, which would be stored and only
 * discovered by whoever went looking for the patient it belonged to.
 */
export function addDaysToKey(dayKey: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) throw new Error(`expected YYYY-MM-DD, got "${dayKey}"`);

  const [, y, m, d] = match;
  const shifted = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d) + days));
  // `toISOString` is the correct reading of a Date built in UTC — this and `dayRangeInZone` are
  // the only places in this file where that is true.
  return shifted.toISOString().slice(0, 10);
}

/**
 * Whole calendar days between two day KEYS — `("2026-08-20", "2026-08-23")` → 3.
 *
 * Negative when `to` precedes `from`. Used to say how overdue a follow-up is, which is a count of
 * calendar days and not of elapsed time: a patient told to come back on Monday is "3 days late"
 * on Thursday regardless of the hour.
 */
export function daysBetweenKeys(from: string, to: string): number {
  const parse = (key: string): number => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
    if (!match) throw new Error(`expected YYYY-MM-DD, got "${key}"`);
    const [, y, m, d] = match;
    return Date.UTC(Number(y), Number(m) - 1, Number(d));
  };
  return Math.round((parse(to) - parse(from)) / 86_400_000);
}

/**
 * How far the zone is from UTC at a given instant, in milliseconds.
 *
 * Computed by asking Intl what the wall clock reads there and diffing — which is the
 * only way to get this right without shipping a timezone database. It re-reads the
 * offset per instant rather than caching one, so a zone that observes DST is handled
 * correctly. (India does not, but this code should not be the reason we cannot sell to
 * a hospital that does.)
 */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);

  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  // `hour` comes back as 24 at midnight under hour12:false in some engines.
  const hour = get("hour") % 24;

  const wallClockAsUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    hour,
    get("minute"),
    get("second"),
  );

  return wallClockAsUtc - at.getTime();
}

/**
 * `2026-07-16` in `Asia/Kolkata` → the half-open UTC instants bounding that day.
 *
 * Throws on a malformed date rather than quietly returning `Invalid Date`, which would
 * turn into a query that matches nothing and looks like "no patients today".
 */
export function dayRangeInZone(date: string, timeZone: string): { from: Date; before: Date } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error(`expected YYYY-MM-DD, got "${date}"`);

  const [, y, m, d] = match;
  const naiveUtc = Date.UTC(Number(y), Number(m) - 1, Number(d));

  return {
    from: solveWallClock(naiveUtc, timeZone),
    before: solveWallClock(naiveUtc + 24 * 60 * 60 * 1000, timeZone),
  };
}

/**
 * The UTC instant at which a given WALL CLOCK time occurs in a zone.
 * `("2026-03-08", 8, 0, "America/New_York")` → 13:00Z; the day after that DST spring
 * forward, the same 08:00 is 12:00Z. **Both are 08:00 to the nurse**, which is the entire
 * point: a drug round is a wall-clock event, so a course that crosses a DST boundary must
 * keep landing at 08:00 rather than sliding by an hour halfway through.
 *
 * This is what `slots.ts` deliberately does NOT do — an appointment session is four hours
 * long and cannot straddle a transition, so adding minutes to a known midnight is honest
 * there. A five-day course of antibiotics straddles one routinely, so it is not honest here.
 *
 * Throws on a malformed date, like its sibling: a silent `Invalid Date` becomes a schedule
 * with no doses in it, which reads as "nothing is due" — the most dangerous possible failure
 * for this particular function.
 */
export function wallClockInZone(
  date: string,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error(`expected YYYY-MM-DD, got "${date}"`);

  const [, y, m, d] = match;
  return solveWallClock(Date.UTC(Number(y), Number(m) - 1, Number(d), hour, minute), timeZone);
}

/**
 * Turns "this wall clock reading, in this zone" into the instant it happens at.
 *
 * Two passes. The offset depends on the instant, and the instant is what we are solving
 * for — so guess with the offset AT the naive reading, then re-read the offset at that
 * guess and correct. One iteration converges everywhere except the ambiguous hour of a
 * DST transition, where either answer is defensible and the difference is one hour.
 *
 * @param naiveUtc the wall clock reading, interpreted as if it were UTC.
 */
function solveWallClock(naiveUtc: number, timeZone: string): Date {
  const guess = new Date(naiveUtc - zoneOffsetMs(new Date(naiveUtc), timeZone));
  return new Date(naiveUtc - zoneOffsetMs(guess, timeZone));
}
