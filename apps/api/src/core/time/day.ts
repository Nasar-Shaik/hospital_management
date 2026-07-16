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

  /**
   * Two passes. The offset depends on the instant, and the instant is what we are
   * solving for — so guess with the offset at naive-UTC-midnight, then re-read the
   * offset AT that guess and correct. One iteration converges everywhere except the
   * ambiguous hour of a DST transition, where either answer is defensible and the
   * difference is an hour of a day boundary.
   */
  const guess = new Date(naiveUtc - zoneOffsetMs(new Date(naiveUtc), timeZone));
  const from = new Date(naiveUtc - zoneOffsetMs(guess, timeZone));

  const nextNaive = naiveUtc + 24 * 60 * 60 * 1000;
  const nextGuess = new Date(nextNaive - zoneOffsetMs(new Date(nextNaive), timeZone));
  const before = new Date(nextNaive - zoneOffsetMs(nextGuess, timeZone));

  return { from, before };
}
