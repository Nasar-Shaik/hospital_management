/**
 * Which zone does a clinical timestamp render in? (M0 §14, M2 §timezone)
 *
 * ── THE CHAIN IS UTC → BRANCH ZONE → DISPLAY, NEVER UTC → DEVICE ────────────
 * The API sends an instant. The reader may be anywhere. A doctor covering a ward from another
 * state must see the dose at the time the WARD will give it, and a phone that crosses a timezone
 * on a train must not appear to reschedule a medication nobody edited. `src/lib/time.ts` owns the
 * formatting; this module owns the one decision upstream of it — WHICH zone.
 *
 * ── A RECORD'S `branchId` IS A LOOKUP KEY, NOT AN AUTHORITY ─────────────────
 * Clinical rows carry `branchId`, and the site's own zone is the clinically correct one: a result
 * released at 23:40 in Chennai reads as 23:40 to everyone, whichever branch the reader has
 * selected. So the record's branch is preferred.
 *
 * That id arrives in an API response, and the branch-safety rule says a branch id from a response
 * field is not trusted. It is not trusted here either — it is used ONLY as a key into the list
 * `/me/branches` returned and `BranchController` validated. An id that is not in that list resolves
 * to nothing and falls through to the active branch. So the worst a tampered or unknown id can do
 * is move a printed time to the fallback zone; it can never widen what is read, never reach the
 * network, and never become `X-Active-Branch` (that comes from the store, via the api-client).
 *
 * ── WHY NOT SIMPLY ALWAYS THE ACTIVE BRANCH ─────────────────────────────────
 * Because All-branches mode exists. In aggregate the list mixes sites, there is no active branch to
 * borrow a zone from, and rendering a Chennai event in Hyderabad's zone would be a silent, plausible
 * lie. Per-record resolution is the only answer that stays correct in aggregate mode.
 */
import { displayZone } from "../lib/time";

/** Structurally what this needs off a `Branch`; declared narrowly so tests need no fixtures. */
export interface BranchZoneSource {
  readonly id: string;
  readonly timezone?: string;
}

/**
 * The zone to format a record's timestamps in.
 *
 * @param branches the VALIDATED list from `/me/branches` — the only branch ids this trusts.
 * @param recordBranchId the `branchId` on the row. Untrusted; used only to look up a label.
 * @param activeBranchId the current selection, used when the row names no reachable branch.
 *
 * Never returns the device zone: `displayZone` ends at the platform default (`Asia/Kolkata`), and a
 * zone string a hospital typed wrongly is rejected on the way through rather than handed to `Intl`.
 */
export function zoneForRecord(
  branches: readonly BranchZoneSource[],
  recordBranchId: string | undefined,
  activeBranchId: string | undefined,
): string {
  const recorded = recordBranchId
    ? branches.find((branch) => branch.id === recordBranchId)?.timezone
    : undefined;
  const active = activeBranchId
    ? branches.find((branch) => branch.id === activeBranchId)?.timezone
    : undefined;

  // `displayZone` validates each candidate and falls through the ones it cannot use, so a branch
  // row carrying `IST` behaves as though it carried nothing rather than crashing a ward list.
  return displayZone(recorded, active);
}

/** A resolver bound to one branch list — what a screen holds while it renders many rows. */
export type ZoneResolver = (recordBranchId?: string) => string;

export function zoneResolver(
  branches: readonly BranchZoneSource[],
  activeBranchId: string | undefined,
): ZoneResolver {
  return (recordBranchId) => zoneForRecord(branches, recordBranchId, activeBranchId);
}
