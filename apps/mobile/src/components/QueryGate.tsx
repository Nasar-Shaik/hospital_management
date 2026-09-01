/**
 * Loading, error, empty — wired to a query once, instead of to every screen.
 *
 * ── THE THREE STATES ARE NOT OPTIONAL, SO THEY ARE NOT A CHOICE ─────────────
 * A screen that forgets the empty state renders a blank page, which a clinician reads as "this
 * patient has no results" rather than "this did not load". A screen that forgets the error state
 * renders the same blank page. Making the gate a component means the states arrive together or not
 * at all — and `StateView`'s own contract (a `UserFacingError`, never a raw exception) is enforced
 * on the way through, so no screen can put `err.message` on a ward display.
 *
 * ── EVERY FAILURE GOES THROUGH `toUserMessage` ──────────────────────────────
 * Including the ones nobody planned for. A 403 becomes "You do not have access"; `HMS-PLAN-002`
 * becomes "Not included in this edition"; a dropped connection becomes "No connection". The screen
 * chooses none of that wording, which is why the wording cannot drift between screens.
 */
import type { ReactNode } from "react";
import { toUserMessage } from "../lib/net/errors";
import { EmptyState, ErrorState, LoadingState } from "./StateView";

export function QueryGate({
  /** React Query's `isPending` — first load, nothing cached. A refetch must NOT blank the screen. */
  loading,
  error,
  /** True when the request succeeded and there is genuinely nothing to show. */
  empty,
  emptyTitle,
  emptyBody,
  loadingLabel,
  onRetry,
  children,
}: {
  loading: boolean;
  error: unknown;
  empty?: boolean;
  emptyTitle: string;
  emptyBody?: string;
  loadingLabel?: string;
  onRetry?: () => void;
  children: ReactNode;
}): React.JSX.Element {
  /**
   * Error BEFORE loading: a query that failed and is retrying is both `isPending` and errored on
   * some transitions, and a spinner that never resolves tells the user nothing. The failure is the
   * more useful truth.
   */
  if (error !== null && error !== undefined) {
    const message = toUserMessage(error);
    return <ErrorState error={message} {...(onRetry ? { onAction: onRetry } : {})} />;
  }
  if (loading) return <LoadingState {...(loadingLabel ? { label: loadingLabel } : {})} />;
  if (empty) return <EmptyState title={emptyTitle} {...(emptyBody ? { body: emptyBody } : {})} />;
  return <>{children}</>;
}
