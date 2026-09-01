"use client";

/**
 * Subscription & usage (Doc 02 A2 "Subscription Detail", "Usage & Limits").
 *
 * Shows what this hospital bought, how much of it they are using, and what is
 * switched on. The usage bar turns amber at 80% — the warning arrives before the
 * wall, not after, because "you cannot add this person" is a terrible way to
 * learn you needed to upgrade last week.
 *
 * ── A BAR WITH A LIMIT UNDER IT READS AS A WALL ─────────────────────────────
 * So the page distinguishes three states the API tells it apart, rather than drawing every
 * number the same way:
 *
 *   ENFORCED   the API refuses the next one (staff accounts, branches). A real bar, and the
 *              only kind that raises the banner at the top.
 *   MONITORED  counted and shown because an administrator asks "how many can I add?", but
 *              nothing stops them (doctors, beds). Said out loud, not implied by a bar.
 *   NOT INCLUDED  the plan allows none of this at all (`limit: 0`). A clinic edition sells no
 *              beds; rendering that as a full red bar would say it had run out of something
 *              it never bought.
 *
 * Below the meters sit the plan's remaining allowances — figures with no live counter behind
 * them (storage), shown as what the plan grants and never as usage nobody is measuring.
 *
 * ── THE TYPES COME FROM THE CLIENT, NOT FROM HERE ───────────────────────────
 * This page used to declare its own `SubscriptionView` and call `api.request` directly. The copy
 * omitted `limits`, so the plan's other allowances were fetched on every load and thrown away,
 * and nothing could notice: the local type was internally consistent, and the gate's client
 * conformance check only compares the SHARED client to the server. Importing the shared types
 * and the shared method is what keeps a field the server sends from being invisible here.
 */
import { useEffect, useState } from "react";
import { ApiClientError, type SubscriptionView, type UsageLine } from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import { Alert, Badge, Card } from "../../components/ui";

/** `module.clinical.criticalCare` → "Critical care" — a flag name is not a sentence. */
function humanise(flag: string): string {
  const leaf = flag.split(".").pop() ?? flag;
  const spaced = leaf.replace(/([a-z])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function UsageBar({ line }: { line: UsageLine }) {
  const pct = line.ratio === null ? 0 : Math.min(100, Math.round(line.ratio * 100));
  // Only an enforced limit gets the alarm colours. Passing 80% of a figure nothing refuses on
  // is not a warning about anything.
  const colour =
    line.enforced && line.exceeded
      ? "var(--color-danger)"
      : line.enforced && line.warning
        ? "var(--color-warning)"
        : "var(--color-brand-600)";

  const right = !line.included
    ? "Not included"
    : line.limit === null
      ? `${String(line.used)} (unlimited)`
      : `${String(line.used)} / ${String(line.limit)}`;

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-[var(--color-fg)]">
          {line.label}
          {!line.enforced && line.included && (
            <span
              className="ml-2 align-middle text-[10px] font-normal tracking-wide text-[var(--color-fg-subtle)] uppercase"
              title="Counted for guidance — the system does not stop you at this number."
            >
              not enforced
            </span>
          )}
        </span>
        <span
          className={`text-sm ${line.included ? "text-[var(--color-fg-muted)]" : "text-[var(--color-fg-subtle)]"}`}
        >
          {right}
        </span>
      </div>
      {line.included && line.limit !== null && (
        <div className="h-2 overflow-hidden rounded-full bg-[var(--color-bg-subtle)]">
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${String(pct)}%`, background: colour }}
          />
        </div>
      )}
      {/* A plan that grants none of something says so plainly, instead of a full red bar that
          would read as "you have used all your beds". */}
      {!line.included && (
        <p className="text-xs text-[var(--color-fg-subtle)]">
          Your plan does not include this
          {line.used > 0 ? ` — ${String(line.used)} already set up` : ""}.
        </p>
      )}
    </div>
  );
}

function Subscription() {
  const { api } = useAuth();
  const [view, setView] = useState<SubscriptionView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .getSubscription()
      .then(setView)
      .catch((err: unknown) => {
        setError(
          err instanceof ApiClientError && err.isForbidden
            ? "You do not have permission to view the subscription."
            : "Could not load the subscription.",
        );
      });
  }, [api]);

  // Only an ENFORCED limit gets a banner. "You are approaching your limit" about a figure the
  // API will never refuse on is how people learn to ignore the ones that mean it.
  const atRisk = view?.usage.filter((u) => u.enforced && (u.warning || u.exceeded)) ?? [];
  /**
   * Plan allowances with no live counter behind them — storage today. Shown as what the plan
   * GRANTS, never as a meter: a bar reading "0 GB used" over a hospital with a full disk is
   * worse than no bar, because it looks measured.
   */
  const allowances: { label: string; value: string }[] =
    view?.limits.storageGb !== undefined
      ? [{ label: "Document storage", value: `${String(view.limits.storageGb)} GB` }]
      : [];

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-[var(--color-fg)]">Subscription &amp; usage</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          What this hospital is on, and how much of it is in use.
        </p>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      {atRisk.map((line) => (
        <Alert
          key={line.metric}
          tone={line.exceeded ? "danger" : "warning"}
          title={line.exceeded ? "Limit reached" : "Approaching your limit"}
        >
          {line.used} of {line.limit} {line.label.toLowerCase()} used.{" "}
          {line.exceeded
            ? "You cannot add more until the plan is upgraded."
            : "Consider upgrading before you run out."}
        </Alert>
      ))}

      {view && (
        <>
          <Card className="p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs font-medium tracking-wide text-[var(--color-fg-subtle)] uppercase">
                  Current plan
                </p>
                <p className="mt-1 text-xl font-semibold text-[var(--color-fg)]">
                  {view.planName ?? "No plan assigned"}
                </p>
                {view.planCode && (
                  <code className="text-xs text-[var(--color-fg-subtle)]">{view.planCode}</code>
                )}
              </div>
              <p className="text-xs text-[var(--color-fg-muted)]">
                Changing plan is done by PaperlessTech — contact support.
              </p>
            </div>
          </Card>

          <Card className="space-y-5 p-6">
            <div>
              <h2 className="text-sm font-semibold text-[var(--color-fg)]">Usage</h2>
              <p className="mt-0.5 text-xs text-[var(--color-fg-muted)]">
                Counted live from this hospital&apos;s own data, across every branch. Figures marked
                “not enforced” are for planning — the system will not stop you at that number.
              </p>
            </div>
            {view.usage.map((line) => (
              <UsageBar key={line.metric} line={line} />
            ))}
          </Card>

          {allowances.length > 0 && (
            <Card className="p-6">
              <h2 className="mb-1 text-sm font-semibold text-[var(--color-fg)]">
                Also in the plan
              </h2>
              <p className="mb-3 text-xs text-[var(--color-fg-muted)]">
                What this plan grants. Usage of these is not measured yet, so no figure is shown for
                it rather than a figure nobody is counting.
              </p>
              <dl className="grid gap-3 sm:grid-cols-2">
                {allowances.map((a) => (
                  <div
                    key={a.label}
                    className="rounded-lg border border-[var(--color-border)] px-3 py-2"
                  >
                    <dt className="text-xs text-[var(--color-fg-muted)]">{a.label}</dt>
                    <dd className="text-lg font-semibold text-[var(--color-fg)]">{a.value}</dd>
                  </div>
                ))}
              </dl>
            </Card>
          )}

          <Card className="p-6">
            <h2 className="mb-3 text-sm font-semibold text-[var(--color-fg)]">
              Included in this plan
            </h2>
            {view.features.length === 0 ? (
              <p className="text-sm text-[var(--color-fg-muted)]">
                No modules are enabled. That usually means no plan has been assigned yet.
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {view.features.map((flag) => (
                  <Badge key={flag} tone="brand">
                    {humanise(flag)}
                  </Badge>
                ))}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

export default function Page() {
  return <Subscription />;
}
