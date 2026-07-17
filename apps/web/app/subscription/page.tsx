"use client";

/**
 * Subscription & usage (Doc 02 A2 "Subscription Detail", "Usage & Limits").
 *
 * Shows what this hospital bought, how much of it they are using, and what is
 * switched on. The usage bar turns amber at 80% — the warning arrives before the
 * wall, not after, because "you cannot add this person" is a terrible way to
 * learn you needed to upgrade last week.
 */
import { useEffect, useState } from "react";
import { ApiClientError } from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import { Protected } from "../../components/Protected";
import { Alert, Badge, Card } from "../../components/ui";

interface UsageLine {
  metric: string;
  label: string;
  used: number;
  limit: number | null;
  ratio: number | null;
  warning: boolean;
  exceeded: boolean;
}

interface SubscriptionView {
  planCode: string | null;
  planName: string | null;
  features: string[];
  usage: UsageLine[];
}

/** `module.clinical.criticalCare` → "Critical care" — a flag name is not a sentence. */
function humanise(flag: string): string {
  const leaf = flag.split(".").pop() ?? flag;
  const spaced = leaf.replace(/([a-z])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function UsageBar({ line }: { line: UsageLine }) {
  const pct = line.ratio === null ? 0 : Math.min(100, Math.round(line.ratio * 100));
  const colour = line.exceeded
    ? "var(--color-danger)"
    : line.warning
      ? "var(--color-warning)"
      : "var(--color-brand-600)";

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-sm font-medium text-[var(--color-fg)]">{line.label}</span>
        <span className="text-sm text-[var(--color-fg-muted)]">
          {line.used}
          {line.limit === null ? " (unlimited)" : ` / ${String(line.limit)}`}
        </span>
      </div>
      {line.limit !== null && (
        <div className="h-2 overflow-hidden rounded-full bg-[var(--color-bg-subtle)]">
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${String(pct)}%`, background: colour }}
          />
        </div>
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
      .request<SubscriptionView>("GET", "/api/v1/subscription")
      .then(setView)
      .catch((err: unknown) => {
        setError(
          err instanceof ApiClientError && err.isForbidden
            ? "You do not have permission to view the subscription."
            : "Could not load the subscription.",
        );
      });
  }, [api]);

  const atRisk = view?.usage.filter((u) => u.warning || u.exceeded) ?? [];

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
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">Usage</h2>
            {view.usage.map((line) => (
              <UsageBar key={line.metric} line={line} />
            ))}
          </Card>

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
  return (
    <Protected>
      <Subscription />
    </Protected>
  );
}
