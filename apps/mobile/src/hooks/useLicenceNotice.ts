/**
 * The licence warning the shell should currently be showing, or nothing.
 *
 * ── WHY A HOOK RATHER THAN A CALL IN EACH PLACE ─────────────────────────────
 * Two components need the SAME answer to "is the banner up?", and they need it to agree exactly:
 * `LicenceNotice` draws the bar and consumes the status-bar inset, and the group layout below it
 * has to stop the navigator consuming that inset a second time. If those two ever disagreed the
 * result is either a header jammed under the clock or a status-bar-sized gap above it.
 *
 * It decides NOTHING itself — `licenceNotice()` in `lib/licence.ts` remains the single derivation,
 * exactly as `routes.test.ts` requires. This is a subscription to that answer, not a second opinion.
 */
import { useLicence } from "./useStores";
import { licenceNotice, type LicenceNotice } from "../lib/licence";

export function useLicenceNotice(): LicenceNotice | undefined {
  return licenceNotice(useLicence());
}
