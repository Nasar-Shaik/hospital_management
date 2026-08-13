"use client";

/**
 * Discards the routed subtree when the active branch changes (ADR-0015).
 *
 * ── EIGHT LINES, AND THEY ARE THE WHOLE FIX ─────────────────────────────────
 * A `key` is React's declaration that two renders are not the same thing. Giving the page subtree
 * the branch scope as its key means React unmounts everything below on a switch and mounts it
 * fresh: every `useState` starts over, every `useEffect` runs again, and the reload happens
 * because the components are NEW, not because 44 pages each remembered to ask.
 *
 * Three properties fall out of that, none of which needed writing:
 *
 *   1. **The transition state is already right.** Every data page initialises `loading: true`, so
 *      the first paint after a switch is that page's own spinner — never the previous branch's
 *      rows under the new branch's name, and never a "no patients" that means "not asked yet".
 *   2. **An in-flight response cannot land in the wrong branch.** A request issued for Hyderabad
 *      resolves into a component that no longer exists; React drops the `setState` on the floor.
 *      There is no window in which the old answer is applied to the new question.
 *   3. **The shell survives.** This sits INSIDE `Protected`/`AppShell`, so the session, the
 *      navigation rail, its scroll position and the sidebar collapse are untouched. Only the data
 *      is discarded, which is the only thing that was wrong.
 *
 * ── WHY IT TAKES `scopeId` AS A PROP ────────────────────────────────────────
 * It could read `useBranch()` itself and save the caller a line. Taking the scope as a prop keeps
 * it a pure function of its input, which is what makes it testable without standing up a session,
 * an API client and a provider tree just to prove that a switch discards a list.
 */
import { Fragment, type ReactNode } from "react";

export function BranchScope({ scopeId, children }: { scopeId: string; children: ReactNode }) {
  return <Fragment key={scopeId}>{children}</Fragment>;
}
