/**
 * The branch the user is currently working in (ADR-0015), held client-side.
 *
 * Stored PER TAB in `sessionStorage`, for the same reason the dev session is (see `devSession.ts`):
 * a tab is one person working in one place, and two tabs may legitimately be two different branches
 * (or two different accounts) at once. It is read on every API call and sent as `X-Active-Branch`;
 * the server validates it against the caller's allowed set and ignores anything they cannot reach,
 * so a stale value is never a security problem — the store is a convenience, the server is the
 * authority.
 *
 * `undefined` / absent means "All branches" (aggregate) — the server's default when no header is
 * sent, so an old tab that never set one behaves exactly as before.
 */
const KEY = "hms.activeBranch";

const hasWindow = (): boolean => typeof window !== "undefined";

/** The active branch id for this tab, or undefined for All / not chosen. */
export function getActiveBranchId(): string | undefined {
  if (!hasWindow()) return undefined;
  return window.sessionStorage.getItem(KEY) ?? undefined;
}

/** Sets (or clears, with `undefined` / the "all" sentinel) this tab's active branch. */
export function setActiveBranchId(branchId: string | undefined): void {
  if (!hasWindow()) return;
  if (branchId && branchId !== "all") window.sessionStorage.setItem(KEY, branchId);
  else window.sessionStorage.removeItem(KEY);
}
