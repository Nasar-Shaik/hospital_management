/**
 * Is this string an IANA time zone this runtime can actually use?
 *
 * ── NEITHER OBVIOUS CHECK IS CORRECT ON ITS OWN ─────────────────────────────
 * Both were measured on this runtime during M1, and both are wrong in opposite directions:
 *
 *   `Intl.DateTimeFormat` alone is TOO LENIENT. It accepts `IST`, `EST`, `GMT` and `+05:30`
 *   without complaint and silently resolves them to something else — `EST` becomes
 *   `America/Panama`, a zone with no daylight saving. A hospital that typed `EST` would get
 *   times that are correct for half the year and an hour out for the other half, with nothing
 *   anywhere reporting an error.
 *
 *   `Intl.supportedValuesOf("timeZone")` alone is TOO STRICT. That list carries the LEGACY
 *   name `Asia/Calcutta` and does NOT contain `Asia/Kolkata` — which is this product's default
 *   zone and the correct modern name for it. Using the list as a membership test rejects the
 *   one zone almost every tenant needs.
 *
 * So the rule is both: an `Area/Location` SHAPE, which excludes the abbreviations and offsets
 * that `Intl` would silently accept, and then an `Intl` probe, which is the only thing that can
 * say whether this runtime's ICU data really knows the zone.
 *
 * Keep this in step with `apps/mobile/src/lib/time.ts`, which carries the same rule for the
 * phone. They are deliberately separate copies: the mobile core imports nothing from the server,
 * and a shared package would be the only thing it did import.
 */

/**
 * `Area/Location`, or `Area/Group/Location` — at least one slash, letters first.
 *
 * `+`/`-` are allowed inside a segment for the handful of real zones that use them
 * (`Etc/GMT+5`); a bare `+05:30` still fails, because it has no slash and does not start
 * with a letter. Underscores appear in `America/New_York`.
 */
export const IANA_ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+$/;

/**
 * Probing `Intl` allocates a formatter, and the same few zones are asked about on every
 * request that touches a bed-day. The answer cannot change while the process lives.
 */
const cache = new Map<string, boolean>();

export function isValidTimeZone(zone: string | null | undefined): zone is string {
  if (typeof zone !== "string" || zone.length === 0) return false;

  const cached = cache.get(zone);
  if (cached !== undefined) return cached;

  let valid = false;
  // `UTC` is the one legitimate zone with no slash, and every runtime knows it.
  if (zone === "UTC") {
    valid = true;
  } else if (IANA_ZONE_SHAPE.test(zone)) {
    try {
      new Intl.DateTimeFormat("en-GB", { timeZone: zone });
      valid = true;
    } catch {
      valid = false;
    }
  }

  cache.set(zone, valid);
  return valid;
}

/**
 * The zone to actually format in: the one asked for when it is usable, otherwise the fallback.
 *
 * ── WHY THE CONSUMERS DEGRADE INSTEAD OF THROWING ───────────────────────────
 * Validation at the edge stops NEW bad data. It cannot fix a row written before the rule
 * existed, and `Intl` throws a `RangeError` on an unknown zone — which, in `calendarDaysStarted`,
 * turns one bad branch record into a 500 on every bed-day calculation for that site. A stay
 * costed in the hospital's default zone is wrong by at most a day boundary and is visible in the
 * bill; an exception is a ward that cannot discharge anybody.
 *
 * So the edge refuses, and the consumer survives. The caller logs when it substitutes.
 */
export function zoneOrDefault(zone: string | null | undefined, fallback: string): string {
  if (isValidTimeZone(zone)) return zone;
  return isValidTimeZone(fallback) ? fallback : "UTC";
}
