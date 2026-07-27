"use client";

/**
 * Dashboard — what THIS person needs the moment they sign in.
 *
 * Role-aware: a doctor lands on their own day (patients seen, tests ordered, meds prescribed — each
 * a click from the detail), an administrator sees the hospital's numbers, and everyone gets the
 * quick actions their permissions actually allow. Nothing here is invented — every figure is a real
 * query, self-scoped where it should be (your day is YOUR day), so a demo never shows a chart the
 * hospital cannot reproduce.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { type MyActivity } from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import { Protected } from "../../components/Protected";
import { Alert, Card, Skeleton, StatCard } from "../../components/ui";
import { Icon, type IconName } from "../../components/icons";
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
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-fg)]">
          {greeting}, {user.name.split(" ")[0]}
        </h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          {user.roles.join(" · ") || "No role assigned"}
        </p>
      </div>

      {user.mustChangePassword && (
        <Alert tone="warning" title="Change your password">
          You are using a temporary password.{" "}
          <Link href="/change-password" className="font-medium underline">
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

const METRIC_META: Record<Metric, { label: string; icon: IconName }> = {
  patients: { label: "Patients seen", icon: "patients" },
  tests: { label: "Tests ordered", icon: "worklist" },
  meds: { label: "Prescriptions", icon: "pharmacy" },
};

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

  const metrics: { key: Metric; value: number }[] = [
    { key: "patients", value: data?.patientsSeen ?? 0 },
    { key: "tests", value: data?.tests.length ?? 0 },
    { key: "meds", value: data?.prescriptions.length ?? 0 },
  ];

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-[var(--color-fg)]">My activity</h2>
        <div className="flex gap-0.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-0.5">
          {(["today", "week", "month"] as Preset[]).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => {
                setPreset(p);
                setOpen(null);
              }}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors duration-[var(--dur-fast)] ${
                preset === p
                  ? "bg-[var(--color-brand-600)] text-[var(--color-on-accent)] shadow-[var(--shadow-xs)]"
                  : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
              }`}
            >
              {p === "today" ? "Today" : p === "week" ? "7 days" : "30 days"}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {metrics.map((m) => {
          const meta = METRIC_META[m.key];
          const active = open === m.key;
          return (
            <button
              key={m.key}
              type="button"
              onClick={() => setOpen(active ? null : m.key)}
              className={`group rounded-xl border p-5 text-left shadow-[var(--shadow-xs)] transition-[transform,box-shadow,border-color] duration-[var(--dur)] ease-[var(--ease-standard)] hover:-translate-y-0.5 hover:shadow-[var(--shadow-md)] ${
                active
                  ? "border-[var(--color-brand-600)] bg-[var(--color-brand-50)]"
                  : "border-[var(--color-border)] bg-[var(--color-bg-elevated)] hover:border-[var(--color-border-strong)]"
              }`}
              style={active ? undefined : { background: "var(--gradient-surface)" }}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  {loading ? (
                    <Skeleton className="h-9 w-14" />
                  ) : (
                    <p className="text-3xl font-semibold tracking-tight text-[var(--color-fg)] tabular-nums">
                      {m.value}
                    </p>
                  )}
                  <p className="mt-1 text-sm text-[var(--color-fg-muted)]">{meta.label}</p>
                </div>
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--color-brand-50)] text-[var(--color-brand-700)]">
                  <Icon name={meta.icon} className="h-[18px] w-[18px]" />
                </span>
              </div>
              <p className="mt-3 text-xs font-medium text-[var(--color-brand-700)] opacity-0 transition-opacity group-hover:opacity-100">
                {active ? "Hide detail" : "View detail →"}
              </p>
            </button>
          );
        })}
      </div>

      {open && data && (
        <Card className="overflow-hidden">
          <Drill metric={open} data={data} rangeLabel={range.label} />
        </Card>
      )}
    </section>
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
      ? dedupePatients(data.visits).map((v) => ({
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
      <p className="px-4 py-8 text-center text-sm text-[var(--color-fg-muted)]">
        Nothing in {rangeLabel.toLowerCase()}.
      </p>
    );
  }

  return (
    <div className="divide-y divide-[var(--color-border)]">
      {rows.map((r) => (
        <Link
          key={r.key}
          href={`/patients/${r.patient.id}`}
          className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-[var(--color-bg-subtle)]"
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
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--color-fg)]">Today, hospital-wide</h2>
        <Link
          href="/reports"
          className="text-sm font-medium text-[var(--color-brand-600)] hover:underline"
        >
          All reports →
        </Link>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <StatCard
          label="Patient visits"
          value={visits ?? "—"}
          tone="info"
          icon={<Icon name="patients" className="h-[18px] w-[18px]" />}
        />
        <StatCard
          label="Collected"
          value={collected === null ? "—" : rupees(collected)}
          tone="success"
          icon={<Icon name="billing" className="h-[18px] w-[18px]" />}
        />
      </div>
    </section>
  );
}

/* ── quick actions ───────────────────────────────────────────────────────────── */

function QuickActions({ can }: { can: (p: string) => boolean }) {
  const all: { label: string; href: string; permission: string; icon: IconName }[] = [
    {
      label: "Register a patient",
      href: "/patients",
      permission: "patient:register",
      icon: "patients",
    },
    {
      label: "Reception queue",
      href: "/reception",
      permission: "encounter:create",
      icon: "reception",
    },
    { label: "My patients", href: "/my-patients", permission: "order:create", icon: "myPatients" },
    { label: "Lab worklist", href: "/worklist", permission: "order:read", icon: "worklist" },
    { label: "Pharmacy", href: "/pharmacy", permission: "pharmacy:dispense", icon: "pharmacy" },
    { label: "Billing", href: "/billing", permission: "billing:read", icon: "billing" },
    { label: "Ward", href: "/ward", permission: "emr:read", icon: "ward" },
    { label: "Staff", href: "/staff", permission: "user:read", icon: "staff" },
  ];
  const actions = all.filter((a) => can(a.permission));

  if (actions.length === 0) return null;

  return (
    <section className="space-y-4">
      <h2 className="text-sm font-semibold text-[var(--color-fg)]">Quick actions</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {actions.map((a) => (
          <Link
            key={a.href}
            href={a.href}
            className="group flex items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-3.5 text-sm font-medium text-[var(--color-fg)] shadow-[var(--shadow-xs)] transition-[transform,box-shadow,border-color] duration-[var(--dur)] ease-[var(--ease-standard)] hover:-translate-y-0.5 hover:border-[var(--color-brand-600)] hover:shadow-[var(--shadow-md)]"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-brand-50)] text-[var(--color-brand-700)] transition-transform duration-[var(--dur)] group-hover:scale-110">
              <Icon name={a.icon} className="h-[18px] w-[18px]" />
            </span>
            <span className="flex-1">{a.label}</span>
            <Icon
              name="chevron"
              className="h-4 w-4 text-[var(--color-fg-subtle)] transition-transform group-hover:translate-x-0.5"
            />
          </Link>
        ))}
      </div>
    </section>
  );
}

export default function Page() {
  return (
    <Protected>
      <Dashboard />
    </Protected>
  );
}
