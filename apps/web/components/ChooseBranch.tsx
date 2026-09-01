"use client";

/**
 * "Which site are you working at?" — asked BEFORE the work, not after it (D19).
 *
 * ── THE DEFECT THIS EXISTS TO CLOSE ─────────────────────────────────────────
 * A write that stamps a branch is refused when the user can reach several sites and has chosen
 * none (`HMS-BRANCH-001`). The server was right and the screen was silent: on the emergency board
 * with the header on "All branches", every action was enabled, and a nurse picked a priority,
 * typed a chief complaint and pressed Save before anything told her. Switching branch to fix it
 * closed the modal and discarded what she had typed — so the product asked for the work twice and
 * explained itself neither time.
 *
 * ── WHY THE SITES ARE LISTED HERE AND NOT JUST POINTED AT ───────────────────
 * "Pick a branch in the switcher" sends someone to the top-right corner to find a control they
 * have not needed until this moment. The choice belongs where the refusal is. Selecting from here
 * calls the same `select()` the switcher does, so the header, the scope key and this notice all
 * move together.
 *
 * ── AND WHY IT SITS ABOVE THE ACTION RATHER THAN INSIDE THE FORM ────────────
 * Choosing a branch re-keys the routed subtree (`BranchScope`) and discards the screen — which is
 * correct, and is exactly what must NOT happen with a half-typed form on it. So the guard is on
 * the way IN: the action that would open the form is disabled while this is showing, the user
 * chooses a site with nothing to lose, and the form is reachable afterwards.
 *
 * ── IT IS NOT THE BOUNDARY ──────────────────────────────────────────────────
 * `writeBranchId()` still refuses on the server, unchanged. A user who re-enables the button gets
 * the same 400 they got before. This decides only whether the product asks somebody to do work it
 * already knows it will refuse (Constitution §3.6, the same rule as `PermissionGate`).
 */
import { useBranch } from "./BranchProvider";
import { Card } from "./ui";

export function ChooseBranchNotice({ action }: { action: string }) {
  const { branches, mustChooseBranch, select } = useBranch();

  if (!mustChooseBranch) return null;

  return (
    <Card className="border-[var(--color-warning)]/40 bg-[var(--color-warning-bg)]/40 p-4">
      <p className="text-sm font-medium text-[var(--color-fg)]">
        Choose a site before you {action}.
      </p>
      <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
        You are viewing all branches. A new record has to belong to one site, so the
        hospital&rsquo;s record says where it happened — pick the site you are working at.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {branches.map((b) => (
          <button
            key={b.id}
            type="button"
            onClick={() => select(b.id)}
            className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-1.5 text-sm font-medium text-[var(--color-fg)] hover:bg-[var(--color-bg-subtle)]"
          >
            {b.name}
          </button>
        ))}
      </div>
    </Card>
  );
}

/**
 * The tooltip a disabled write action carries while a site is unchosen.
 *
 * One sentence, in one place, so the eleven buttons this applies to cannot drift into eleven
 * different explanations of the same rule.
 */
export const CHOOSE_BRANCH_HINT = "Choose a site in the banner above before recording this";
