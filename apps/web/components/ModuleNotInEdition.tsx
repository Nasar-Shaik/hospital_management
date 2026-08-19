"use client";

/**
 * "Your hospital does not have this module" — said once, instead of a refusal beside an emptiness.
 *
 * ── THE DEFECT THIS CLOSES (D20) ────────────────────────────────────────────
 * A page whose API refuses with `HMS-PLAN-002` used to show the refusal in an error strip AND its
 * ordinary empty state underneath, because the empty state is what a list renders when it has no
 * rows and a refused list has no rows. So `/emergency` said "Feature not in your edition" and,
 * directly below, **"Nobody in the emergency department."** — and `/theatres` offered "Book a
 * procedure" and "Add theatre" over "No theatres yet."
 *
 * Read together those say "you have this module and it is empty", which is the opposite of the
 * truth and is what sent a clinic administrator into the role editor looking for a permission that
 * could never have helped. The same "a refusal shown as emptiness" class `TESTING.md` §11 recorded
 * from the page sweep, reappearing on pages written after that sweep — which is why the lesson is
 * a shared component this time rather than a fix somebody has to remember.
 *
 * ── WHAT IT REPLACES, AND WHAT IT DOES NOT ──────────────────────────────────
 * It replaces the whole body of the page: no table, no empty state, and no write actions, because
 * every one of them would be refused too. It does NOT replace the server's answer — the refusal
 * arrived from the API, which is what makes this honest rather than a guess by the navigation.
 */
import { Card } from "./ui";

export function ModuleNotInEdition({ module }: { module: string }) {
  return (
    <Card className="p-10">
      <div className="mx-auto max-w-md text-center">
        <p className="text-sm font-medium text-[var(--color-fg)]">
          {module} is not part of your hospital&rsquo;s edition.
        </p>
        <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
          Nothing is missing from your records — this module was never included in your plan, so
          there is nothing here to show. Your account manager can add it.
        </p>
        {/* Named explicitly: a permission is fixable here and this is not, and the whole cost of
            the defect was people trying to fix it in the role editor. */}
        <p className="mt-3 text-xs text-[var(--color-fg-subtle)]">
          This is not a permissions problem. No change to your roles will open it.
        </p>
      </div>
    </Card>
  );
}
