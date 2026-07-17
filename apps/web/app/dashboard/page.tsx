"use client";

/**
 * Dashboard — what THIS person needs the moment they sign in.
 *
 * The dashboard is role-aware: a doctor lands on their own day (patients seen, tests ordered, meds
 * prescribed — each a click away from the detail), an administrator sees the hospital's numbers, and
 * everyone gets the quick actions their permissions actually allow. Nothing here is invented — every
 * figure is a real query, self-scoped where it should be (your day is YOUR day), so a demo never
 * shows a chart the hospital cannot reproduce.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { type MyActivity } from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import { Protected } from "../../components/Protected";
import { Alert, Card } from "../../components/ui";
import { rupees } from "../../lib/money";

/* ── date-range presets (half-open [from, to)) ───────────────────────────────── */

type Preset = "today" | "week" | "month";

function rangeFor(preset: Preset): { from: string; to: string; label: string } {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const tomorrow = new Date(start);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const from = new Date(start);
  if (preset === "week") from.setDate(from.getDate() - 6);
  if (preset === "month") from.setDate(from.getDate() - 29);

  const label = preset === "today" ? "Today" : preset === "week" ? "Last 7 days" : "Last 30 days";
  return { from: from.toISOString(), to: tomorrow.toISOString(), label };
}

/* ── page ────────────────────────────────────────────────────────────────────── */

function Dashboard() {
  const { user, can } = useAuth();
  if (!user) return null;

  // A clinician is anyone who orders tests or writes prescriptions — the "my day" panel is theirs.
  const clinician = can("order:create") || can("prescription:create");

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-[var(--color-fg)]">
          Good day, {user.name.split(" ")[0]}
        </h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          {user.roles.join(" · ") || "No role assigned"}
        </p>
      </div>

      {user.mustChangePassword && (
        <Alert tone="warning" title="Change your password">
          You are using a temporary password.{" "}
          <Link href="/change-password" className="underline">
            Set your own now
          </Link>
          .
        </Alert>
      )}
      {!user.mfaEnabled && (
        <Alert tone="info" title="Two-step verification is off">
          Adding a second factor is the single biggest improvement you can make to the security of a
          clinical account.
        </Alert>
      )}

      {clinician && <MyDay />}
      {can("report:view") && <ManagementStrip />}

      <QuickActions can={can} />
    </div>
  );
}

/* ── clinician's "my day" ────────────────────────────────────────────────────── */

type Metric = "patients" | "tests" | "meds";

function MyDay() {
  const { api } = useAuth();
  const [preset, setPreset] = useState<Preset>("today");
  const [data, setData] = useState<MyActivity | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Metric | null>(null);

  const range = useMemo(() => rangeFor(preset), [preset]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.myActivity({ from: range.from, to: range.to }));
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [api, range.from, range.to]);

  useEffect(() => {
    void load();
  }, [load]);

  const metrics: { key: Metric; label: string; value: number }[] = [
    { key: "patients", label: "Patients seen", value: data?.patientsSeen ?? 0 },
    { key: "tests", label: "Tests ordered", value: data?.tests.length ?? 0 },
    { key: "meds", label: "Prescriptions", value: data?.prescriptions.length ?? 0 },
  ];

  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-[var(--color-fg)]">My activity</h2>
        <div className="flex gap-1 rounded-lg border border-[var(--color-border)] p-0.5">
          {(["today", "week", "month"] as Preset[]).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => {
                setPreset(p);
                setOpen(null);
              }}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                preset === p
                  ? "bg-[var(--color-brand-600)] text-[var(--color-on-accent)]"
                  : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
              }`}
            >
              {p === "today" ? "Today" : p === "week" ? "7 days" : "30 days"}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {metrics.map((m) => (
          <button
            key={m.key}
            type="button"
            onClick={() => setOpen(open === m.key ? null : m.key)}
            className={`rounded-xl border p-4 text-left transition ${
              open === m.key
                ? "border-[var(--color-brand-600)] bg-[var(--color-brand-50)]"
                : "border-[var(--color-border)] hover:border-[var(--color-border-strong)]"
            }`}
          >
            <p className="text-3xl font-bold text-[var(--color-fg)]">{loading ? "…" : m.value}</p>
            <p className="mt-0.5 text-sm text-[var(--color-fg-muted)]">
              {m.label} <span className="text-[var(--color-fg-subtle)]">· view</span>
            </p>
          </button>
        ))}
      </div>

      {open && data && <Drill metric={open} data={data} rangeLabel={range.label} />}
    </Card>
  );
}

function Drill({
  metric,
  data,
  rangeLabel,
}: {
  metric: Metric;
  data: MyActivity;
  rangeLabel: string;
}) {
  const rows: {
    key: string;
    patient: MyActivity["visits"][number]["patient"];
    primary: string;
    secondary: string;
  }[] =
    metric === "patients"
      ? // Distinct patients seen — collapse the visit list to one row per patient.
        dedupePatients(data.visits).map((v) => ({
          key: v.patient.id,
          patient: v.patient,
          primary: v.class,
          secondary: v.status.replace(/_/g, " "),
        }))
      : metric === "tests"
        ? data.tests.map((t) => ({
            key: t.orderId,
            patient: t.patient,
            primary: t.name,
            secondary: `${t.category} · ${t.status.replace(/_/g, " ")}`,
          }))
        : data.prescriptions.map((p) => ({
            key: p.prescriptionId,
            patient: p.patient,
            primary: p.drugs.join(", ") || "Prescription",
            secondary: new Date(p.at).toLocaleDateString("en-IN", {
              day: "numeric",
              month: "short",
            }),
          }));

  if (rows.length === 0) {
    return (
      <p className="mt-4 text-sm text-[var(--color-fg-muted)]">
        Nothing in {rangeLabel.toLowerCase()}.
      </p>
    );
  }

  return (
    <div className="mt-4 divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)]">
      {rows.map((r) => (
        <Link
          key={r.key}
          href={`/patients/${r.patient.id}`}
          className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm hover:bg-[var(--color-bg-subtle)]"
        >
          <span className="min-w-0">
            <span className="font-medium text-[var(--color-fg)]">{r.patient.name}</span>
            <span className="ml-2 font-mono text-xs text-[var(--color-fg-subtle)]">
              {r.patient.uhid}
            </span>
          </span>
          <span className="truncate text-right text-[var(--color-fg-muted)]">
            {r.primary}
            <span className="ml-1 text-xs text-[var(--color-fg-subtle)]">{r.secondary}</span>
          </span>
        </Link>
      ))}
    </div>
  );
}

function dedupePatients(visits: MyActivity["visits"]): MyActivity["visits"] {
  const seen = new Set<string>();
  return visits.filter((v) => {
    if (seen.has(v.patient.id)) return false;
    seen.add(v.patient.id);
    return true;
  });
}

/* ── management KPI strip ────────────────────────────────────────────────────── */

function ManagementStrip() {
  const { api } = useAuth();
  const [collected, setCollected] = useState<number | null>(null);
  const [visits, setVisits] = useState<number | null>(null);

  useEffect(() => {
    const r = rangeFor("today");
    void api
      .reportCollections({ from: r.from, to: r.to })
      .then((c) => setCollected(c.total))
      .catch(() => setCollected(null));
    void api
      .reportPatientVisits({ from: r.from, to: r.to })
      .then((v) => setVisits(v.total))
      .catch(() => setVisits(null));
  }, [api]);

  return (
    <Card className="p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--color-fg)]">Today, hospital-wide</h2>
        <Link href="/reports" className="text-sm text-[var(--color-brand-600)] hover:underline">
          All reports →
        </Link>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-[var(--color-border)] p-4">
          <p className="text-3xl font-bold text-[var(--color-fg)]">{visits ?? "—"}</p>
          <p className="mt-0.5 text-sm text-[var(--color-fg-muted)]">Patient visits</p>
        </div>
        <div className="rounded-xl border border-[var(--color-border)] p-4">
          <p className="text-3xl font-bold text-[var(--color-fg)]">
            {collected === null ? "—" : rupees(collected)}
          </p>
          <p className="mt-0.5 text-sm text-[var(--color-fg-muted)]">Collected</p>
        </div>
      </div>
    </Card>
  );
}

/* ── quick actions ───────────────────────────────────────────────────────────── */

function QuickActions({ can }: { can: (p: string) => boolean }) {
  const actions: { label: string; href: string; permission: string }[] = [
    { label: "Register a patient", href: "/patients", permission: "patient:register" },
    { label: "Reception queue", href: "/reception", permission: "encounter:create" },
    { label: "My patients", href: "/my-patients", permission: "order:create" },
    { label: "Lab worklist", href: "/worklist", permission: "order:read" },
    { label: "Pharmacy", href: "/pharmacy", permission: "pharmacy:dispense" },
    { label: "Billing", href: "/billing", permission: "billing:read" },
    { label: "Ward", href: "/ward", permission: "emr:read" },
    { label: "Staff", href: "/staff", permission: "user:read" },
  ].filter((a) => can(a.permission));

  if (actions.length === 0) return null;

  return (
    <Card className="p-6">
      <h2 className="text-sm font-semibold text-[var(--color-fg)]">Quick actions</h2>
      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {actions.map((a) => (
          <Link
            key={a.href}
            href={a.href}
            className="rounded-lg border border-[var(--color-border)] px-4 py-3 text-sm font-medium text-[var(--color-fg)] transition hover:border-[var(--color-brand-600)] hover:text-[var(--color-brand-700)]"
          >
            {a.label} →
          </Link>
        ))}
      </div>
    </Card>
  );
}

export default function Page() {
  return (
    <Protected>
      <Dashboard />
    </Protected>
  );
}
