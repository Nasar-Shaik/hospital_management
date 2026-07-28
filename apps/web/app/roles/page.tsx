"use client";

/**
 * Roles & permissions (Doc 02 A4) — the administrator's guide to who does what.
 *
 * This is the page an admin reads when setting a hospital up and asking "which logins do I
 * actually need to create?". It answers that in three layers: a plain-language map from a
 * common need to the login that serves it, then each role's day-to-day duties, then the raw
 * list. The roles themselves come from the API (the source of truth for which roles this
 * hospital has); `roleGuide` decorates the ones the product ships with, and any custom role a
 * hospital adds later falls back to its own description rather than breaking the screen.
 */
import { useEffect, useState } from "react";
import { ApiClientError, type Role } from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import { Alert, Badge, Card } from "../../components/ui";
import { ROLE_GUIDE } from "../../lib/roleGuide";

interface PlanView {
  planCode: string | null;
  planName: string | null;
  features: string[];
  usage: { metric: string; label: string; used: number; limit: number | null }[];
}

/** "I want to… → create this login." The fastest possible onboarding answer. */
const NEED_TO_ROLE: { need: string; role: string }[] = [
  { need: "Register patients and book appointments", role: "RECEPTIONIST" },
  { need: "See a doctor's appointments and consult patients", role: "DOCTOR" },
  { need: "Run blood tests and enter diagnoses / reports", role: "LAB_TECHNICIAN" },
  { need: "Sign off and release lab results", role: "PATHOLOGIST" },
  { need: "Report and sign X-rays and scans", role: "RADIOLOGIST" },
  { need: "Dispense medicines and manage stock", role: "PHARMACIST" },
  { need: "Take bill payments at the counter", role: "CASHIER" },
  { need: "Record vitals and give medicines on the ward", role: "NURSE" },
  { need: "Review the activity trail for compliance", role: "AUDITOR" },
];

function PlanSummary({ plan }: { plan: PlanView | null }) {
  if (!plan) return null;
  const staff = plan.usage.find(
    (u) => u.metric === "staff" || u.label.toLowerCase().includes("staff"),
  );
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium tracking-wide text-[var(--color-fg-subtle)] uppercase">
            Your plan
          </p>
          <p className="mt-1 text-lg font-semibold text-[var(--color-fg)]">
            {plan.planName ?? "No plan assigned"}
          </p>
          {plan.planCode && (
            <code className="text-xs text-[var(--color-fg-subtle)]">{plan.planCode}</code>
          )}
        </div>
        {staff && (
          <div className="text-right">
            <p className="text-xs text-[var(--color-fg-muted)]">Staff logins</p>
            <p className="text-lg font-semibold text-[var(--color-fg)]">
              {staff.used}
              {staff.limit === null ? " (unlimited)" : ` / ${String(staff.limit)}`}
            </p>
          </div>
        )}
      </div>
      <p className="mt-3 text-sm text-[var(--color-fg-muted)]">
        Your edition decides which features are switched on. See{" "}
        <a className="underline" href="/subscription">
          Subscription &amp; usage
        </a>{" "}
        for the full picture.
      </p>
    </Card>
  );
}

function Roles() {
  const { api } = useAuth();
  const [roles, setRoles] = useState<Role[]>([]);
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .listRoles()
      .then(setRoles)
      .catch((err: unknown) => {
        setError(
          err instanceof ApiClientError && err.isForbidden
            ? "You do not have permission to manage roles."
            : "Could not load roles.",
        );
      });

    // Best-effort — the plan card is a bonus, not a reason to fail the whole page.
    void api
      .request<PlanView>("GET", "/api/v1/subscription")
      .then(setPlan)
      .catch(() => undefined);
  }, [api]);

  const nameByCode = new Map(roles.map((r) => [r.code, r.name]));

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-[var(--color-fg)]">Roles &amp; permissions</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Who does what here — and which login to create for each job.
        </p>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      <PlanSummary plan={plan} />

      <Card className="p-5">
        <h2 className="text-sm font-semibold text-[var(--color-fg)]">Which login do I need?</h2>
        <p className="mt-1 mb-4 text-xs text-[var(--color-fg-muted)]">
          Each job in the hospital maps to one login. Create the login, and that person can do the
          things below — and nothing they shouldn&apos;t.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-xs text-[var(--color-fg-subtle)]">
                <th className="py-2 pr-4 font-medium">I want to…</th>
                <th className="py-2 font-medium">Create this login</th>
              </tr>
            </thead>
            <tbody>
              {NEED_TO_ROLE.map((row) => (
                <tr key={row.need} className="border-b border-[var(--color-border)] last:border-0">
                  <td className="py-2 pr-4 text-[var(--color-fg-muted)]">{row.need}</td>
                  <td className="py-2">
                    <Badge tone="brand">{nameByCode.get(row.role) ?? row.role}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="space-y-3">
        {roles.map((role) => {
          const guide = ROLE_GUIDE[role.code];
          return (
            <Card key={role.id} className="p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-[var(--color-fg)]">{role.name}</p>
                  <code className="text-xs text-[var(--color-fg-subtle)]">{role.code}</code>
                </div>
                {role.isSystem && <Badge>system</Badge>}
              </div>

              <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
                {guide?.summary ?? role.description ?? "A role in this hospital."}
              </p>

              {guide && (
                <>
                  <div className="mt-3 rounded-lg border border-[var(--color-brand-500)]/30 bg-[var(--color-brand-50)] px-3 py-2">
                    <p className="text-xs font-medium text-[var(--color-brand-700)]">
                      When to create this login
                    </p>
                    <p className="mt-0.5 text-sm text-[var(--color-fg)]">{guide.createFor}</p>
                  </div>

                  <div className="mt-3 grid gap-4 sm:grid-cols-3">
                    <div className="sm:col-span-2">
                      <p className="text-xs font-medium text-[var(--color-fg-subtle)] uppercase">
                        What they do
                      </p>
                      <ul className="mt-1 space-y-1">
                        {guide.duties.map((d) => (
                          <li key={d} className="flex gap-2 text-sm text-[var(--color-fg-muted)]">
                            <span className="text-[var(--color-brand-600)]">•</span>
                            <span>{d}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <p className="text-xs font-medium text-[var(--color-fg-subtle)] uppercase">
                        Opens
                      </p>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {guide.access.map((a) => (
                          <span
                            key={a}
                            className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-xs text-[var(--color-fg-muted)]"
                          >
                            {a}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                </>
              )}
            </Card>
          );
        })}
      </div>

      <Alert tone="info">
        System roles ship with the product and cannot be edited — a hospital that stripped its own
        administrator role of <code>role:manage</code> would lock itself out permanently. Custom
        roles and the permission-matrix editor are next.
      </Alert>
    </div>
  );
}

export default function Page() {
  return <Roles />;
}
