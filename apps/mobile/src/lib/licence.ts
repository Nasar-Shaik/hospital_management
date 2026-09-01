/**
 * THE LICENCE POLICY (M2 L) — what the phone knows about the hospital's subscription.
 *
 * ── THE SERVER ALREADY ENFORCES THIS, COMPLETELY ────────────────────────────
 * `resolveTenant` (ADR-0016) evaluates the licence before authentication, before routing, before
 * anything. Past the grace window it throws `HMS-TEN-005` and the request never reaches a handler
 * — reads and writes alike, for every client. Nothing here is enforcement, and nothing here may be
 * written as though it were: the phone cannot let a write through that the server would refuse, and
 * must not pretend it could.
 *
 * What this is for is the other direction: not composing four hundred words of a discharge summary
 * into a form that is already guaranteed to be refused. The guard turns a refusal-after-the-tap
 * into a disabled button with a sentence next to it, which is the entire benefit and the whole
 * scope.
 *
 * ── THE SERVER SPEAKS IN TWO CHANNELS, AND THEY MEAN DIFFERENT THINGS ───────
 * The one that has to be understood before any of this makes sense:
 *
 *   HEADER   `X-License-State: ACTIVE | EXPIRING | GRACE`, stamped on every served response.
 *            Note what is NOT in that union — there is no `EXPIRED` header and there never can be,
 *            because a hard-expired hospital's response is refused before the header is set.
 *
 *   REFUSAL  `HMS-TEN-005`, 403, on every request. THIS is expiry, and it is the only way the phone
 *            can learn about it. A client that waited for a header saying `EXPIRED` would wait for
 *            a value the API is structurally incapable of sending.
 *
 * So `EXPIRED` here is derived from an observed refusal, and the other three from the header. Both
 * feed one store (`state/licence.ts`) so that screens ask one question.
 *
 * ── NO HEADER MEANS PERPETUAL, WHICH MEANS THIS FAILS OPEN ──────────────────
 * `setLicenseHeaders` returns early for a hospital with no expiry date at all. A perpetual licence
 * therefore produces exactly the same absence as a non-tenant call — and a client that read absence
 * as expiry would disable every write button at the hospitals that have paid indefinitely.
 *
 * Failing open is safe here for a reason that does not generalise: the consequence of being wrong
 * is one wasted round trip, because the server refuses the write anyway. The consequence of failing
 * closed is a doctor who cannot record a prescription at a hospital with nothing wrong with it.
 */
import type { LicenseHeader } from "@medicore/api-client";

/**
 * What the app believes about the subscription right now.
 *
 * The three header values, plus the one that only a refusal can establish. Spelled as the wire
 * spells them so that `LicenseHeader["state"]` assigns straight in with no translation table to
 * drift — the American spelling is the API's, and it stops at this type.
 */
export type LicenceState = "ACTIVE" | "EXPIRING" | "GRACE" | "EXPIRED";

export interface Licence {
  state: LicenceState;
  /**
   * ACTIVE/EXPIRING: days until expiry. GRACE: days until access is actually cut. `null` when the
   * hospital is perpetual, or when the app has not been told.
   */
  daysLeft: number | null;
}

/**
 * What the app assumes before any response has arrived, and what a perpetual hospital stays at.
 *
 * ACTIVE rather than an "unknown" fourth state: nothing in the UI would treat unknown differently
 * from active — both allow writing, neither warns — so the extra branch would exist only to be
 * mapped back onto this one at every call site.
 */
export const LICENCE_UNKNOWN: Licence = { state: "ACTIVE", daysLeft: null };

/**
 * The licence as the last response described it.
 *
 * `null` — no licence headers on the response — resolves to ACTIVE, because that is what absence
 * actually means (see the header). It cannot mean "still expired": a hard-expired hospital has no
 * served responses to carry headers in the first place.
 */
export function fromHeader(header: LicenseHeader | null): Licence {
  if (!header) return LICENCE_UNKNOWN;
  return { state: header.state, daysLeft: header.daysLeft };
}

/**
 * True when this failure is the licence gate refusing the request (ADR-0016).
 *
 * Matched on the CODE and not the status: 403 is also every ordinary permission refusal, and
 * treating those as a lapsed subscription would tell a doctor to call their administrator about
 * billing when what they actually hit was a route their role does not include.
 *
 * Typed against the shape rather than `instanceof ApiClientError` so this module keeps importing
 * only a type from the client — the same reason `classifyError` in `lock.ts` takes a string.
 */
export function isLicenceRefusal(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "HMS-TEN-005"
  );
}

/* ════════════════════════════════════════════════════════════════════════════
 * WHAT THE UI DOES WITH IT
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * May a clinical write be attempted?
 *
 * ── GRACE DOES NOT BLOCK, AND THAT IS THE DELIBERATE PART ───────────────────
 * A hospital in grace is one the server is still choosing to serve. Refusing to save a prescription
 * because a renewal invoice is late would be this app inventing a policy that neither the API nor
 * the web app has — and inventing it in the one place where the cost lands on a patient rather than
 * on the person who owes the money. The doctor gave the drug either way; the only question is
 * whether the chart records it.
 *
 * So grace WARNS (`licenceNotice`) and expiry BLOCKS, which is exactly the line the server draws.
 */
export function blocksWrites(licence: Licence): boolean {
  return licence.state === "EXPIRED";
}

export interface LicenceNotice {
  /** One sentence, written for a clinician who cannot fix it and needs to know who can. */
  message: string;
  /** GRACE is red because access ends on a known day; EXPIRING is amber. */
  tone: "warning" | "danger";
}

/**
 * The banner, or nothing at all.
 *
 * ACTIVE says nothing — a permanent "your licence is fine" is noise that trains people to ignore
 * the banner on the day it matters. EXPIRED says nothing either, because by then every screen is
 * already showing the blocking error from `toUserMessage`, and two messages about one problem read
 * as two problems.
 */
export function licenceNotice(licence: Licence): LicenceNotice | undefined {
  const days = licence.daysLeft;
  const dayLabel = days === null ? "" : `${String(days)} day${days === 1 ? "" : "s"}`;

  if (licence.state === "GRACE") {
    return {
      message: dayLabel
        ? `This hospital's subscription has lapsed. ${dayLabel} left before the app stops working — an administrator must renew it.`
        : "This hospital's subscription has lapsed. An administrator must renew it before the app stops working.",
      tone: "danger",
    };
  }
  if (licence.state === "EXPIRING") {
    return {
      message: dayLabel
        ? `This hospital's subscription expires in ${dayLabel}. Tell an administrator so your ward is not interrupted.`
        : "This hospital's subscription expires soon. Tell an administrator so your ward is not interrupted.",
      tone: "warning",
    };
  }
  return undefined;
}
