"use client";

/**
 * Patient profile — the whole record for one person, in one place.
 *
 * A hospital's most-asked question is "who is this patient and what has happened to them?" — and
 * until now the answer was scattered across the encounter, order, prescription, billing and lab
 * screens. This page gathers them: a header that states the safety-critical facts at a glance
 * (allergies, dues), and a timeline plus tabs that trace every visit, test, prescription and bill.
 *
 * It is built ENTIRELY from existing per-patient endpoints — it reads the record, it does not
 * change it, so a receptionist and a doctor can both open it within their own permissions.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ApiClientError,
  type Allergy,
  type Encounter,
  type Invoice,
  type Order,
  type OrderRow,
  type DocumentMeta,
  type DocumentCategory,
  type Patient,
  type Prescription,
  type ReportMeta,
  type VitalsReading,
  type Wallet,
  type WalletEntry,
  type InsurancePolicy,
  type InsuranceClaim,
  type PolicyType,
  type PolicyRelationship,
  type ClaimType,
  type ClaimStatus,
  type Consent,
  type ConsentType,
  type ConsentSigner,
  type CarePackage,
  type PackageEnrollment,
  type IcdCode,
  type CodedDiagnosis,
} from "@medicore/api-client";
import { useAuth } from "../../../components/AuthProvider";
import { Alert, Badge, Button, Card, ConfirmDialog } from "../../../components/ui";
import { VitalsByVisit } from "../../../components/PatientVitals";
import { rupees, toPaise } from "../../../lib/money";
import {
  awaitingRelease,
  CRITICAL_PENDING_LABEL,
  isCriticalPending,
  isResultReadable,
} from "../../../lib/results";
import { idempotencyMessage, newIdempotencyKey } from "../../../lib/idempotency";

/* ── helpers ─────────────────────────────────────────────────────────────────── */

function ageOf(dob?: string): string {
  if (!dob) return "—";
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return "—";
  const now = new Date();
  let years = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) years--;
  return `${years}y`;
}

function fmtDate(iso?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** Outstanding = what is billed but not yet paid. Drafts are not dues; paid invoices owe nothing. */
function duesOf(invoices: Invoice[]): number {
  return invoices
    .filter((i) => i.status === "finalized")
    .reduce((sum, i) => sum + Math.max(0, i.total - i.paid), 0);
}

const ENCOUNTER_LABEL: Record<string, string> = {
  planned: "Planned",
  arrived: "Arrived",
  in_queue: "In queue",
  in_progress: "In progress",
  awaiting_results: "Awaiting results",
  closed: "Closed",
  cancelled: "Cancelled",
  left_without_being_seen: "Left unseen",
  admitted: "Admitted",
};

const ORDER_TONE: Record<string, "neutral" | "warning" | "success" | "brand"> = {
  placed: "warning",
  accepted: "warning",
  in_progress: "warning",
  completed: "brand",
  verified: "brand",
  released: "success",
  cancelled: "neutral",
};

/* ── page ────────────────────────────────────────────────────────────────────── */

type TabKey =
  | "timeline"
  | "visits"
  | "vitals"
  | "tests"
  | "prescriptions"
  | "bills"
  | "wallet"
  | "insurance"
  | "consent"
  | "coding"
  | "documents";

function Profile() {
  const { can, api, user } = useAuth();
  const canWallet = can("wallet:manage");
  const canInsurance = can("insurance:link");
  const canFileClaim = can("insurance:claim");
  const canReconcile = can("insurance:reconcile");
  const canReadVitals = can("emr:read");
  const canRecordVitals = can("vitals:record");
  const canManageConsent = can("consent:manage");
  const canEnrollPackage = can("package:enroll");
  const canCancelOrder = can("order:cancel");
  const canCode = can("mrd:code");
  const canReadDocs = can("file:read");
  const canUploadDocs = can("file:upload");
  const canDeleteDocs = can("file:delete");
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [patient, setPatient] = useState<Patient | null>(null);
  const [allergies, setAllergies] = useState<Allergy[]>([]);
  const [encounters, setEncounters] = useState<Encounter[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [prescriptions, setPrescriptions] = useState<Prescription[]>([]);
  const [reports, setReports] = useState<ReportMeta[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [doctors, setDoctors] = useState<Map<string, string>>(new Map());
  const [vitals, setVitals] = useState<VitalsReading[]>([]);
  const [documents, setDocuments] = useState<DocumentMeta[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("timeline");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // The record is fanned out across modules; pull the pieces in parallel. A missing
      // permission on one strand (e.g. billing) must not blank the whole page, so each
      // optional strand tolerates a failure and simply shows empty.
      const soft = <T,>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback);
      const [pat, alg, enc, ord, rx, rep, inv, docs, vit, files] = await Promise.all([
        api.getPatient(id),
        soft(api.listAllergies(id), [] as Allergy[]),
        soft(api.listEncounters({ patientId: id, limit: 100 }), {
          items: [] as Encounter[],
          meta: { page: 1, limit: 0 },
        }),
        // 100 is the API's ceiling on every list. This asked for 200, was refused with
        // `HMS-VAL-001` on every chart, and `soft` turned that into an empty Tests tab — so a
        // patient with three orders read "Tests 0". The strand still tolerates a real refusal
        // (a desk without `order:read`); it no longer manufactures one.
        soft(api.listOrders({ patientId: id, limit: 100 }), {
          items: [] as OrderRow[],
          meta: { page: 1, limit: 0 },
        }),
        soft(api.listPrescriptions({ patientId: id }), [] as Prescription[]),
        soft(api.listReports(id), [] as ReportMeta[]),
        soft(api.listInvoices({ patientId: id, limit: 100 }), {
          items: [] as Invoice[],
          meta: { page: 1, limit: 0 },
        }),
        soft(api.listDoctors(), [] as { id: string; name: string }[]),
        // Vitals are clinical PHI behind `emr:read` — a desk user simply sees no tab.
        canReadVitals ? soft(api.listPatientVitals(id, 50), [] as VitalsReading[]) : [],
        // Documents (A7) are behind `file:read` — a role without it simply sees no tab.
        canReadDocs ? soft(api.listDocuments(id), [] as DocumentMeta[]) : [],
      ]);
      setPatient(pat);
      setAllergies(alg.filter((a) => a.status === "active"));
      setEncounters(enc.items);
      setOrders(ord.items);
      setPrescriptions(rx);
      setReports(rep);
      setInvoices(inv.items);
      setDoctors(new Map(docs.map((d) => [d.id, d.name])));
      setVitals(vit);
      setDocuments(files);

      // The wallet is only fetched for staff who may see it (cashier / front office); a
      // clinician's profile view simply has no advance panel, rather than a 403 in the console.
      if (canWallet) {
        setWallet(await soft(api.getWallet(id), null as Wallet | null));
      }
    } catch (err) {
      setError(
        err instanceof ApiClientError && err.code === "HMS-GEN-404"
          ? "This patient could not be found."
          : "Could not load this patient. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  }, [api, id, canWallet, canReadVitals]);

  useEffect(() => {
    void load();
  }, [load]);

  const who = useCallback(
    (userId?: string) => (userId ? (doctors.get(userId) ?? "—") : "—"),
    [doctors],
  );
  const dues = useMemo(() => duesOf(invoices), [invoices]);
  const reportByOrder = useMemo(() => new Map(reports.map((r) => [r.orderId, r])), [reports]);

  if (loading) {
    return (
      <Shell>
        <div className="flex justify-center py-24">
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--color-brand-600)] border-t-transparent" />
        </div>
      </Shell>
    );
  }

  if (error || !patient) {
    return (
      <Shell>
        <Alert tone="danger">{error ?? "Patient not found."}</Alert>
        <Link
          href="/patients"
          className="mt-4 inline-block text-sm text-[var(--color-brand-600)] hover:underline"
        >
          ← Back to patients
        </Link>
      </Shell>
    );
  }

  const tabs: { key: TabKey; label: string; count?: number }[] = [
    { key: "timeline", label: "Timeline" },
    { key: "visits", label: "Visits", count: encounters.length },
    ...(canReadVitals ? [{ key: "vitals" as const, label: "Vitals", count: vitals.length }] : []),
    { key: "tests", label: "Tests", count: orders.length },
    { key: "prescriptions", label: "Prescriptions", count: prescriptions.length },
    { key: "bills", label: "Bills", count: invoices.length },
    ...(canWallet ? [{ key: "wallet" as const, label: "Wallet" }] : []),
    ...(canInsurance ? [{ key: "insurance" as const, label: "Insurance" }] : []),
    ...(canReadVitals || canManageConsent ? [{ key: "consent" as const, label: "Consent" }] : []),
    ...(canCode ? [{ key: "coding" as const, label: "Coding" }] : []),
    ...(canReadDocs
      ? [{ key: "documents" as const, label: "Documents", count: documents.length }]
      : []),
  ];

  return (
    <Shell>
      <Link
        href="/patients"
        className="mb-4 inline-block text-sm text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
      >
        ← Patients
      </Link>

      {/* Header */}
      <Card className="p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-semibold text-[var(--color-fg)]">{patient.name}</h1>
              <Badge tone={patient.status === "active" ? "success" : "neutral"}>
                {patient.status}
              </Badge>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-[var(--color-fg-muted)]">
              <span className="font-mono text-xs">{patient.uhid}</span>
              <span>
                {ageOf(patient.dob)} · {patient.gender}
              </span>
              {patient.bloodGroup && <span>🩸 {patient.bloodGroup}</span>}
              {patient.contact.phone && <span>📞 {patient.contact.phone}</span>}
              <span>Registered {fmtDate(patient.createdAt)}</span>
            </div>
          </div>

          <div className="flex flex-col items-end gap-2">
            {canWallet && wallet && (
              <button
                type="button"
                onClick={() => setTab("wallet")}
                className="rounded-lg bg-[var(--color-success-bg)] px-3 py-1.5 text-sm font-semibold text-[var(--color-success)]"
                title="Patient advance balance"
              >
                Advance {rupees(wallet.balance)} →
              </button>
            )}
            {dues > 0 && (
              <button
                type="button"
                onClick={() => setTab("bills")}
                className="rounded-lg bg-[var(--color-warning-bg)] px-3 py-1.5 text-sm font-semibold text-[var(--color-warning)]"
              >
                Dues {rupees(dues)} →
              </button>
            )}
            {can("encounter:create") && (
              <Link href="/reception">
                <Button>Start visit</Button>
              </Link>
            )}
          </div>
        </div>

        {/* Allergy banner — the one thing that must never be a click away. */}
        {allergies.length > 0 ? (
          <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-danger)]/20 bg-[var(--color-danger-bg)] px-4 py-2.5">
            <span className="text-sm font-semibold text-[var(--color-danger)]">⚠ Allergies:</span>
            {allergies.map((a) => (
              <span
                key={a.id}
                className="rounded-md bg-[var(--color-danger)]/10 px-2 py-0.5 text-sm text-[var(--color-danger)]"
              >
                {a.label}
                {a.severity === "anaphylaxis" || a.severity === "severe" ? ` (${a.severity})` : ""}
              </span>
            ))}
          </div>
        ) : (
          <div className="mt-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-4 py-2 text-sm text-[var(--color-fg-muted)]">
            No known allergies on record.
          </div>
        )}
      </Card>

      {/* Tabs */}
      <div className="mt-6 flex flex-wrap gap-1 border-b border-[var(--color-border)]">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition ${
              tab === t.key
                ? "border-[var(--color-brand-600)] text-[var(--color-brand-700)]"
                : "border-transparent text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
            }`}
          >
            {t.label}
            {t.count !== undefined && (
              <span className="ml-1.5 rounded-full bg-[var(--color-bg-subtle)] px-1.5 py-0.5 text-xs">
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="mt-5">
        {tab === "timeline" && (
          <Timeline
            encounters={encounters}
            orders={orders}
            prescriptions={prescriptions}
            reports={reports}
            who={who}
          />
        )}
        {tab === "visits" && <Visits encounters={encounters} who={who} />}
        {tab === "vitals" && (
          <VitalsByVisit
            api={api}
            readings={vitals}
            encounters={encounters}
            canRecord={canRecordVitals}
            onSaved={(r) => setVitals((prev) => [r, ...prev])}
            {...(user?.id ? { recordedBy: user.id } : {})}
          />
        )}
        {tab === "tests" && (
          <Tests
            orders={orders}
            reportByOrder={reportByOrder}
            who={who}
            api={api}
            canCancel={canCancelOrder}
            onChanged={() => void load()}
          />
        )}
        {tab === "prescriptions" && <Prescriptions prescriptions={prescriptions} who={who} />}
        {tab === "bills" && (
          <Bills
            invoices={invoices}
            encounters={encounters}
            canEnroll={canEnrollPackage}
            balance={wallet?.balance ?? 0}
            canPayFromWallet={canWallet && (wallet?.balance ?? 0) > 0}
            api={api}
            reload={load}
          />
        )}
        {tab === "wallet" && canWallet && (
          <WalletPanel patientId={id} wallet={wallet} dues={dues} api={api} reload={load} />
        )}
        {tab === "insurance" && canInsurance && (
          <Insurance
            patientId={id}
            encounters={encounters}
            invoices={invoices}
            canFile={canFileClaim}
            canReconcile={canReconcile}
          />
        )}
        {tab === "consent" && (canReadVitals || canManageConsent) && (
          <ConsentPanel patientId={id} encounters={encounters} canManage={canManageConsent} />
        )}
        {tab === "coding" && canCode && <CodingPanel encounters={encounters} api={api} />}
        {tab === "documents" && canReadDocs && (
          <Documents
            patientId={id}
            documents={documents}
            canUpload={canUploadDocs}
            canDelete={canDeleteDocs}
            api={api}
            reload={load}
          />
        )}
      </div>
    </Shell>
  );
}

/* ── tab panels ──────────────────────────────────────────────────────────────── */

interface TimelineEvent {
  at: string;
  icon: string;
  text: string;
  tone?: "danger";
}

function Timeline({
  encounters,
  orders,
  prescriptions,
  reports,
  who,
}: {
  encounters: Encounter[];
  orders: Order[];
  prescriptions: Prescription[];
  reports: ReportMeta[];
  who: (id?: string) => string;
}) {
  const events: TimelineEvent[] = [];
  for (const e of encounters) {
    const doc = e.doctorId ? ` · Dr ${who(e.doctorId)}` : "";
    events.push({ at: e.arrivedAt, icon: "🏥", text: `${e.class} visit${doc}` });
  }
  for (const o of orders) {
    events.push({ at: o.orderedAt, icon: "🧪", text: `Ordered ${o.name} (${o.category})` });
    if (o.releasedAt) {
      events.push({
        at: o.releasedAt,
        icon: "📄",
        text: `Result released — ${o.name}${o.result?.critical ? " ⚠ critical" : ""}`,
        ...(o.result?.critical ? { tone: "danger" as const } : {}),
      });
    }
  }
  for (const r of reports) {
    events.push({ at: r.uploadedAt, icon: "📎", text: `Report uploaded — ${r.testName}` });
  }
  for (const p of prescriptions) {
    const when = p.signedAt ?? p.prescribedAt;
    const drugs = p.lines.map((l) => l.drugName).join(", ");
    events.push({
      at: when,
      icon: "💊",
      text: `Prescribed ${drugs || "medication"} · Dr ${who(p.prescribedBy)}`,
    });
  }

  events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  if (events.length === 0) return <Empty>No activity yet.</Empty>;

  // Group by calendar day.
  const groups: { day: string; items: TimelineEvent[] }[] = [];
  for (const ev of events) {
    const day = fmtDay(ev.at);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(ev);
    else groups.push({ day, items: [ev] });
  }

  return (
    <div className="space-y-6">
      {groups.map((g) => (
        <div key={g.day}>
          <p className="mb-2 text-xs font-semibold tracking-wide text-[var(--color-fg-subtle)] uppercase">
            {g.day}
          </p>
          <div className="space-y-2 border-l-2 border-[var(--color-border)] pl-4">
            {g.items.map((ev, i) => (
              <div key={i} className="flex items-start gap-2 text-sm">
                <span>{ev.icon}</span>
                <span
                  className={
                    ev.tone === "danger" ? "text-[var(--color-danger)]" : "text-[var(--color-fg)]"
                  }
                >
                  {ev.text}
                </span>
                <span className="ml-auto text-xs text-[var(--color-fg-subtle)]">
                  {new Date(ev.at).toLocaleTimeString("en-IN", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Visits({ encounters, who }: { encounters: Encounter[]; who: (id?: string) => string }) {
  if (encounters.length === 0) return <Empty>No visits recorded.</Empty>;
  const sorted = [...encounters].sort(
    (a, b) => new Date(b.arrivedAt).getTime() - new Date(a.arrivedAt).getTime(),
  );
  return (
    <Rows head={["Date", "Type", "Doctor", "Status", ""]}>
      {sorted.map((e) => (
        <tr key={e.id}>
          <Td>{fmtDate(e.arrivedAt)}</Td>
          <Td>
            <Badge tone="brand">{e.class}</Badge>
          </Td>
          <Td>{e.doctorId ? `Dr ${who(e.doctorId)}` : "—"}</Td>
          <Td>
            {ENCOUNTER_LABEL[e.status] ?? e.status}
            {e.disposition ? ` · ${e.disposition}` : ""}
          </Td>
          <Td>
            <a href={`/opd-slip/${e.id}`} className="text-[var(--color-brand-600)] hover:underline">
              OPD slip →
            </a>
          </Td>
        </tr>
      ))}
    </Rows>
  );
}

/**
 * The states an order can still be called back from.
 *
 * Mirrors the server's transition table (`order.model.ts`): `placed` and `accepted` may be
 * cancelled, `in_progress` may NOT — once the sample is in the analyser the reagent is spent and
 * the work exists whether or not anyone still wants it. The list is duplicated here only to decide
 * what to DRAW; the server refuses regardless of what this file believes.
 */
const CANCELLABLE = ["placed", "accepted"];

/**
 * Calling an order back before the department starts it.
 *
 * ── WHY THE REASON IS A FIELD AND NOT A `window.prompt` ─────────────────────
 * It is stored on the order as `cancelReason` and read downstream: billing reverses the charge,
 * and the lab sees why the sample it was about to run has gone. The server requires at least
 * three characters, so a prompt that cheerfully accepts "x" only produces a validation error the
 * user cannot connect to anything. The field states the rule and enforces it before asking.
 */
function CancelOrder({
  order,
  api,
  onChanged,
}: {
  order: Order;
  api: ReturnType<typeof useAuth>["api"];
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-danger)] hover:underline"
      >
        Cancel order
      </button>
    );
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await api.cancelOrder(order.id, reason.trim());
      onChanged();
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? // The likeliest 422 by far: the department picked the work up between this page
            // loading and the doctor deciding. Say that, rather than echoing a state name.
            err.message
          : "Could not cancel this order.",
      );
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1.5">
      <input
        autoFocus
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Why is this being cancelled?"
        maxLength={500}
        className="w-56 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-2.5 py-1.5 text-xs text-[var(--color-fg)]"
      />
      {error && <p className="text-xs text-[var(--color-danger)]">{error}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy || reason.trim().length < 3}
          onClick={() => void confirm()}
          className="rounded-md bg-[var(--color-danger)] px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40"
        >
          {busy ? "Cancelling…" : "Cancel order"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setReason("");
            setError(null);
          }}
          className="text-xs text-[var(--color-fg-muted)] hover:underline"
        >
          Keep it
        </button>
      </div>
    </div>
  );
}

function Tests({
  orders,
  reportByOrder,
  who,
  api,
  canCancel,
  onChanged,
}: {
  orders: Order[];
  reportByOrder: Map<string, ReportMeta>;
  who: (id?: string) => string;
  api: ReturnType<typeof useAuth>["api"];
  canCancel: boolean;
  onChanged: () => void;
}) {
  if (orders.length === 0) return <Empty>No tests ordered.</Empty>;
  const sorted = [...orders].sort(
    (a, b) => new Date(b.orderedAt).getTime() - new Date(a.orderedAt).getTime(),
  );

  async function download(report: ReportMeta) {
    try {
      const blob = await api.fetchReportBlob(report.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = report.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      /* best-effort download */
    }
  }

  return (
    <Rows head={["Date", "Test", "Ordered by", "Status", "Result"]}>
      {sorted.map((o) => {
        const report = reportByOrder.get(o.id);
        return (
          <tr key={o.id}>
            <Td>{fmtDate(o.orderedAt)}</Td>
            <Td className="font-medium text-[var(--color-fg)]">
              {o.name}
              <span className="ml-1 text-xs text-[var(--color-fg-subtle)]">{o.category}</span>
            </Td>
            <Td>Dr {who(o.orderedBy)}</Td>
            <Td>
              <div className="space-y-1.5">
                <Badge tone={ORDER_TONE[o.status] ?? "neutral"}>{o.status.replace("_", " ")}</Badge>
                {canCancel && CANCELLABLE.includes(o.status) && (
                  <CancelOrder order={o} api={api} onChanged={onChanged} />
                )}
                {/*
                 * Said out loud, because the button was there a moment ago and is now gone. The
                 * doctor has not lost a permission — the department has started the work, and the
                 * state machine deliberately has no `in_progress → cancelled` edge.
                 */}
                {canCancel && o.status === "in_progress" && (
                  <p className="text-xs text-[var(--color-fg-subtle)]">
                    Being run — too late to cancel
                  </p>
                )}
                {o.status === "cancelled" && o.cancelReason && (
                  <p className="text-xs text-[var(--color-fg-subtle)]">{o.cancelReason}</p>
                )}
              </div>
            </Td>
            <Td>
              {/*
               * The release gate, from `lib/results` — the same rule the consultation screen and
               * mobile ask. This column used to render `result.summary` at ANY status, so a doctor
               * reading the chart saw a number that no second pair of eyes had signed off, while
               * the same doctor reading the same order on the consultation screen did not.
               *
               * A scanned report is deliberately NOT gated: `report.model.ts` states that an
               * uploaded document has no separate approval step and reaches the ordering doctor as
               * soon as it lands. Only the structured RESULT passes through verify → release.
               */}
              {isResultReadable(o) ? (
                <span
                  className={o.result?.critical ? "font-medium text-[var(--color-danger)]" : ""}
                >
                  {o.result?.summary ?? "Released"}
                </span>
              ) : (
                <div className="space-y-1">
                  {isCriticalPending(o) && (
                    <p className="text-xs font-medium text-[var(--color-danger)]">
                      {CRITICAL_PENDING_LABEL}
                    </p>
                  )}
                  {report ? (
                    <button
                      type="button"
                      onClick={() => void download(report)}
                      className="text-[var(--color-brand-600)] hover:underline"
                    >
                      Download report
                    </button>
                  ) : (
                    <span className="text-[var(--color-fg-subtle)]">
                      {awaitingRelease(o) ?? "—"}
                    </span>
                  )}
                </div>
              )}
            </Td>
          </tr>
        );
      })}
    </Rows>
  );
}

function Prescriptions({
  prescriptions,
  who,
}: {
  prescriptions: Prescription[];
  who: (id?: string) => string;
}) {
  if (prescriptions.length === 0) return <Empty>No prescriptions.</Empty>;
  const sorted = [...prescriptions].sort(
    (a, b) => new Date(b.prescribedAt).getTime() - new Date(a.prescribedAt).getTime(),
  );
  return (
    <div className="space-y-3">
      {sorted.map((p) => {
        const dispensed = p.lines.every((l) => l.dispensedQty >= l.quantity);
        const partly = !dispensed && p.lines.some((l) => l.dispensedQty > 0);
        return (
          <Card key={p.id} className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-[var(--color-fg-muted)]">
                {fmtDate(p.signedAt ?? p.prescribedAt)} · Dr {who(p.prescribedBy)}
              </span>
              <Badge tone={dispensed ? "success" : partly ? "warning" : "neutral"}>
                {dispensed ? "Dispensed" : partly ? "Partly dispensed" : p.status.replace("_", " ")}
              </Badge>
            </div>
            <ul className="mt-2 space-y-1 text-sm">
              {p.lines.map((l, i) => (
                <li key={i} className="flex justify-between">
                  <span className="text-[var(--color-fg)]">
                    {l.drugName}{" "}
                    <span className="text-[var(--color-fg-muted)]">
                      {l.dose} · {l.frequency}
                    </span>
                  </span>
                  <span className="text-xs text-[var(--color-fg-subtle)]">
                    {l.dispensedQty}/{l.quantity} given
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        );
      })}
    </div>
  );
}

function Bills({
  invoices,
  encounters,
  canEnroll,
  balance,
  canPayFromWallet,
  api,
  reload,
}: {
  invoices: Invoice[];
  encounters: Encounter[];
  canEnroll: boolean;
  balance: number;
  canPayFromWallet: boolean;
  api: ReturnType<typeof useAuth>["api"];
  reload: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const settleKeys = useRef<Record<string, string>>({});

  async function payFromAdvance(invoiceId: string, outstanding: number) {
    // Draw whatever the advance can cover, up to the outstanding amount. The rest, if any,
    // stays owed and can be collected by another method.
    const amount = Math.min(outstanding, balance);
    if (amount <= 0) return;
    setBusy(invoiceId);
    setError(null);
    /**
     * Keyed per BILL, not per component: this is a row action, so the intent is "settle this
     * invoice from the advance". The key is held against the row until the money moves, so a
     * retry after a lost response reuses it (and is answered with the original receipt) while
     * settling the remainder later is correctly a new intent.
     */
    settleKeys.current[invoiceId] ??= newIdempotencyKey();
    try {
      const key = settleKeys.current[invoiceId];
      await api.payFromWallet(invoiceId, amount, key, key);
      delete settleKeys.current[invoiceId];
      await reload();
    } catch (err) {
      setError(
        idempotencyMessage(err) ??
          (err instanceof ApiClientError
            ? err.message
            : "Could not settle this bill from the advance."),
      );
    } finally {
      setBusy(null);
    }
  }

  const sorted = [...invoices].sort((a, b) =>
    a.finalizedAt && b.finalizedAt
      ? new Date(b.finalizedAt).getTime() - new Date(a.finalizedAt).getTime()
      : 0,
  );
  return (
    <div className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}

      <PackagesPanel encounters={encounters} canEnroll={canEnroll} api={api} />

      {invoices.length === 0 ? (
        <Empty>No bills.</Empty>
      ) : (
        <Rows head={["Invoice", "Date", "Total", "Paid", "Outstanding", "Status", ""]}>
          {sorted.map((i) => {
            const outstanding = Math.max(0, i.total - i.paid);
            const settleable = canPayFromWallet && i.status === "finalized" && outstanding > 0;
            return (
              <tr key={i.id}>
                <Td className="font-mono text-xs">{i.number ?? "draft"}</Td>
                <Td>{fmtDate(i.finalizedAt)}</Td>
                <Td>{rupees(i.total)}</Td>
                <Td>{rupees(i.paid)}</Td>
                <Td className={outstanding > 0 ? "font-medium text-[var(--color-warning)]" : ""}>
                  {rupees(outstanding)}
                </Td>
                <Td>
                  <Badge
                    tone={
                      i.status === "paid"
                        ? "success"
                        : i.status === "finalized"
                          ? "warning"
                          : "neutral"
                    }
                  >
                    {i.status}
                  </Badge>
                </Td>
                <Td>
                  {settleable && (
                    <button
                      type="button"
                      disabled={busy === i.id}
                      onClick={() => void payFromAdvance(i.id, outstanding)}
                      className="rounded-md bg-[var(--color-success-bg)] px-2.5 py-1 text-xs font-semibold text-[var(--color-success)] hover:opacity-80 disabled:opacity-50"
                    >
                      {busy === i.id
                        ? "Settling…"
                        : `Pay ${rupees(Math.min(outstanding, balance))} from advance`}
                    </button>
                  )}
                </Td>
              </tr>
            );
          })}
        </Rows>
      )}
    </div>
  );
}

/* ── Package enrollment (F5) ─────────────────────────────────────────────────── */

function PackagesPanel({
  encounters,
  canEnroll,
  api,
}: {
  encounters: Encounter[];
  canEnroll: boolean;
  api: ReturnType<typeof useAuth>["api"];
}) {
  // Enrollment hangs off a visit — offer the patient's visits, newest first, default the latest.
  const visits = [...encounters].sort(
    (a, b) => new Date(b.arrivedAt).getTime() - new Date(a.arrivedAt).getTime(),
  );
  const [encounterId, setEncounterId] = useState(visits[0]?.id ?? "");
  const [packages, setPackages] = useState<CarePackage[]>([]);
  const [enrollments, setEnrollments] = useState<PackageEnrollment[]>([]);
  const [packageCode, setPackageCode] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const loadEnrollments = useCallback(() => {
    if (!encounterId) {
      setEnrollments([]);
      return;
    }
    api
      .listPackageEnrollments(encounterId)
      .then(setEnrollments)
      .catch(() => setEnrollments([]));
  }, [api, encounterId]);

  useEffect(() => {
    api
      .listPackages(false)
      .then((p) => {
        setPackages(p);
        setPackageCode((cur) => cur || p[0]?.code || "");
      })
      .catch(() => setPackages([]));
  }, [api]);
  useEffect(loadEnrollments, [loadEnrollments]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      loadEnrollments();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const active = enrollments.find((e) => e.status === "active");

  // Nothing to show and nothing the viewer can do — keep the tab clean.
  if (!canEnroll && enrollments.length === 0) return null;

  return (
    <Card className="space-y-3 p-4">
      <h3 className="text-sm font-semibold text-[var(--color-fg)]">Care packages</h3>
      {error != null && (
        <Alert tone="danger">
          {error instanceof ApiClientError ? error.message : "Something went wrong."}
        </Alert>
      )}

      {visits.length > 1 && (
        <label className="block text-xs text-[var(--color-fg-muted)]">
          Visit
          <select
            value={encounterId}
            onChange={(e) => setEncounterId(e.target.value)}
            className="mt-0.5 w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-1.5 text-sm text-[var(--color-fg)]"
          >
            {visits.map((v) => (
              <option key={v.id} value={v.id}>
                {fmtDate(v.arrivedAt)} · {v.class}
              </option>
            ))}
          </select>
        </label>
      )}

      {active ? (
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <span className="font-medium text-[var(--color-fg)]">{active.packageName}</span>
              <span className="ml-2 text-sm text-[var(--color-fg-muted)]">
                {rupees(active.price)}
              </span>
            </div>
            {canEnroll && (
              <Button
                variant="ghost"
                onClick={() => void act(() => api.cancelPackageEnrollment(active.id))}
              >
                Cancel enrollment
              </Button>
            )}
          </div>
          <p className="mt-1 text-xs text-[var(--color-fg-subtle)]">
            Covers {active.includedCodes.length} service
            {active.includedCodes.length === 1 ? "" : "s"} — each posts at ₹0 on this visit while
            enrolled.
          </p>
        </div>
      ) : canEnroll ? (
        packages.length === 0 ? (
          <p className="text-xs text-[var(--color-fg-subtle)]">
            No packages defined. Create one under Care packages first.
          </p>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <label className="block text-xs text-[var(--color-fg-muted)]">
              Package
              <select
                value={packageCode}
                onChange={(e) => setPackageCode(e.target.value)}
                className="mt-0.5 w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-1.5 text-sm text-[var(--color-fg)]"
              >
                {packages.map((p) => (
                  <option key={p.id} value={p.code}>
                    {p.name} · {rupees(p.price)}
                  </option>
                ))}
              </select>
            </label>
            <Button
              disabled={busy || !encounterId || !packageCode}
              onClick={() => void act(() => api.enrollInPackage(encounterId, packageCode))}
            >
              Enrol visit
            </Button>
          </div>
        )
      ) : (
        <p className="text-xs text-[var(--color-fg-subtle)]">No package on this visit.</p>
      )}
    </Card>
  );
}

/* ── Wallet ──────────────────────────────────────────────────────────────────── */

const ENTRY_TONE: Record<string, string> = {
  deposit: "text-[var(--color-success)]",
  reversal: "text-[var(--color-success)]",
  debit: "text-[var(--color-warning)]",
  refund: "text-[var(--color-fg-muted)]",
};

const ENTRY_LABEL: Record<string, string> = {
  deposit: "Advance in",
  reversal: "Reversal",
  debit: "Bill settled",
  refund: "Refund out",
};

function WalletPanel({
  patientId,
  wallet,
  dues,
  api,
  reload,
}: {
  patientId: string;
  wallet: Wallet | null;
  dues: number;
  api: ReturnType<typeof useAuth>["api"];
  reload: () => Promise<void>;
}) {
  const balance = wallet?.balance ?? 0;
  const entries = wallet?.entries ?? [];

  const [mode, setMode] = useState<"deposit" | "refund" | null>(null);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("cash");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setMode(null);
    setAmount("");
    setReason("");
    setMethod("cash");
    setError(null);
  }

  async function submit() {
    const paise = toPaise(amount);
    if (paise <= 0) {
      setError("Enter an amount greater than zero.");
      return;
    }
    if (mode === "refund" && paise > balance) {
      setError("A refund cannot exceed the current balance.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (mode === "deposit") {
        await api.depositToWallet(patientId, {
          amount: paise,
          method,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        });
      } else {
        await api.refundFromWallet(patientId, {
          amount: paise,
          method,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        });
      }
      reset();
      await reload();
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : "Could not record this. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  // How the advance stands against what is currently owed — the question the desk actually asks.
  const coverage = balance - dues;

  return (
    <div className="space-y-5">
      {/* Balance card */}
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-4 bg-[var(--color-success-bg)] p-6">
          <div>
            <p className="text-xs font-semibold tracking-wide text-[var(--color-success)] uppercase">
              Advance balance
            </p>
            <p className="mt-1 text-3xl font-bold text-[var(--color-fg)]">{rupees(balance)}</p>
            {dues > 0 && (
              <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
                {coverage >= 0
                  ? `Covers current dues of ${rupees(dues)}`
                  : `Short of current dues by ${rupees(-coverage)}`}
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <Button onClick={() => setMode("deposit")}>Add advance</Button>
            <button
              type="button"
              onClick={() => setMode("refund")}
              disabled={balance <= 0}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-2 text-sm font-medium text-[var(--color-fg)] hover:bg-[var(--color-bg-subtle)] disabled:opacity-50"
            >
              Refund
            </button>
          </div>
        </div>

        {/* Deposit / refund form */}
        {mode && (
          <div className="border-t border-[var(--color-border)] p-5">
            <p className="mb-3 text-sm font-semibold text-[var(--color-fg)]">
              {mode === "deposit" ? "Collect advance" : "Refund advance"}
            </p>
            {error && (
              <div className="mb-3">
                <Alert tone="danger">{error}</Alert>
              </div>
            )}
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Amount (₹)">
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                  className="w-32 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
                />
              </Field>
              <Field label="Method">
                <select
                  value={method}
                  onChange={(e) => setMethod(e.target.value)}
                  className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
                >
                  <option value="cash">Cash</option>
                  <option value="card">Card</option>
                  <option value="upi">UPI</option>
                  <option value="netbanking">Net banking</option>
                </select>
              </Field>
              <Field label="Reason (optional)">
                <input
                  type="text"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={mode === "deposit" ? "e.g. Admission advance" : "e.g. On discharge"}
                  className="w-52 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
                />
              </Field>
              <div className="flex gap-2">
                <Button onClick={() => void submit()} disabled={busy}>
                  {busy ? "Saving…" : mode === "deposit" ? "Take advance" : "Refund"}
                </Button>
                <button
                  type="button"
                  onClick={reset}
                  className="rounded-lg px-3 py-2 text-sm text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </Card>

      {/* Ledger */}
      {entries.length === 0 ? (
        <Empty>No wallet activity yet. Collect an advance to open the wallet.</Empty>
      ) : (
        <Rows head={["Date", "Movement", "Amount", "Balance", "Details"]}>
          {entries.map((e: WalletEntry) => {
            const sign = e.type === "deposit" || e.type === "reversal" ? "+" : "−";
            return (
              <tr key={e.id}>
                <Td>{fmtDate(e.at)}</Td>
                <Td>
                  <span className={`font-medium ${ENTRY_TONE[e.type] ?? ""}`}>
                    {ENTRY_LABEL[e.type] ?? e.type}
                  </span>
                </Td>
                <Td className={`font-medium ${ENTRY_TONE[e.type] ?? ""}`}>
                  {sign}
                  {rupees(e.amount)}
                </Td>
                <Td>{rupees(e.balanceAfter)}</Td>
                <Td className="text-xs">
                  {[e.reason, e.method].filter(Boolean).join(" · ") || "—"}
                  {e.type === "deposit" && (
                    <>
                      {" · "}
                      <a
                        href={`/receipt/advance/${e.id}`}
                        className="text-[var(--color-brand-700)] hover:underline"
                      >
                        Receipt →
                      </a>
                    </>
                  )}
                </Td>
              </tr>
            );
          })}
        </Rows>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-[var(--color-fg-subtle)]">{label}</span>
      {children}
    </label>
  );
}

/* ── little shared bits ──────────────────────────────────────────────────────── */

function Shell({ children }: { children: ReactNode }) {
  return <div className="mx-auto max-w-4xl">{children}</div>;
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-[var(--color-border)] py-12 text-center text-sm text-[var(--color-fg-muted)]">
      {children}
    </div>
  );
}

function Rows({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-xs text-[var(--color-fg-subtle)]">
              {head.map((h) => (
                <th key={h} className="px-4 py-2.5 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">{children}</tbody>
        </table>
      </div>
    </Card>
  );
}

function Td({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <td className={`px-4 py-2.5 text-[var(--color-fg-muted)] ${className}`}>{children}</td>;
}

/* ── Documents (A7) ──────────────────────────────────────────────────────────── */

const DOC_CATEGORY_LABELS: Record<DocumentCategory, string> = {
  id_proof: "ID proof",
  consent: "Consent",
  insurance: "Insurance",
  referral: "Referral",
  discharge: "Discharge",
  clinical_image: "Clinical image",
  external_record: "Outside record",
  other: "Other",
};

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Reads a File as base64 (strips the `data:...;base64,` prefix the API does not want). */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(new Error("could not read the file"));
    reader.readAsDataURL(file);
  });
}

function Documents({
  patientId,
  documents,
  canUpload,
  canDelete,
  api,
  reload,
}: {
  patientId: string;
  documents: DocumentMeta[];
  canUpload: boolean;
  canDelete: boolean;
  api: ReturnType<typeof useAuth>["api"];
  reload: () => void;
}) {
  const [category, setCategory] = useState<DocumentCategory>("id_proof");
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The document awaiting a delete confirmation — irreversible, so it is asked in the app. */
  const [removing, setRemoving] = useState<DocumentMeta | null>(null);

  async function upload() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const dataBase64 = await readAsBase64(file);
      await api.uploadDocument(patientId, {
        category,
        title: title.trim() || file.name,
        filename: file.name,
        contentType: file.type || "application/octet-stream",
        dataBase64,
      });
      setTitle("");
      setFile(null);
      reload();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not upload the document.");
    } finally {
      setBusy(false);
    }
  }

  async function open(doc: DocumentMeta) {
    try {
      const blob = await api.fetchDocumentBlob(doc.id);
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      /* best-effort open */
    }
  }

  async function remove(doc: DocumentMeta) {
    try {
      await api.deleteDocument(doc.id);
      reload();
    } catch {
      /* best-effort */
    } finally {
      setRemoving(null);
    }
  }

  return (
    <div className="space-y-4">
      {canUpload && (
        <Card className="p-4">
          {error && (
            <div className="mb-3">
              <Alert tone="danger">{error}</Alert>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-4">
            <label className="text-xs text-[var(--color-fg-muted)]">
              Type
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as DocumentCategory)}
                className="mt-0.5 w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-2 py-1.5 text-sm text-[var(--color-fg)]"
              >
                {(Object.keys(DOC_CATEGORY_LABELS) as DocumentCategory[]).map((c) => (
                  <option key={c} value={c}>
                    {DOC_CATEGORY_LABELS[c]}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-[var(--color-fg-muted)] sm:col-span-2">
              Title
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={file?.name ?? "e.g. Aadhaar card"}
                className="mt-0.5 w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-2 py-1.5 text-sm text-[var(--color-fg)]"
              />
            </label>
            <label className="text-xs text-[var(--color-fg-muted)]">
              File
              <input
                type="file"
                accept=".pdf,image/*"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="mt-0.5 w-full text-xs text-[var(--color-fg-muted)] file:mr-2 file:rounded file:border-0 file:bg-[var(--color-brand-50)] file:px-2 file:py-1 file:text-[var(--color-brand-700)]"
              />
            </label>
          </div>
          <p className="mt-2 text-xs text-[var(--color-fg-subtle)]">
            PDF or image, up to 10 MB. ID proofs, consents, insurance cards, referral and outside
            records.
          </p>
          <div className="mt-3">
            <Button disabled={busy || !file} onClick={() => void upload()}>
              {busy ? "Uploading…" : "Upload document"}
            </Button>
          </div>
        </Card>
      )}

      {documents.length === 0 ? (
        <Empty>No documents on file.</Empty>
      ) : (
        <Rows head={["Title", "Type", "Uploaded", "Size", ""]}>
          {documents.map((d) => (
            <tr key={d.id}>
              <Td className="font-medium text-[var(--color-fg)]">
                <button className="hover:underline" onClick={() => void open(d)}>
                  {d.title}
                </button>
              </Td>
              <Td>
                <Badge tone="neutral">{DOC_CATEGORY_LABELS[d.category]}</Badge>
              </Td>
              <Td>{fmtDate(d.uploadedAt)}</Td>
              <Td>{fileSize(d.size)}</Td>
              <Td className="text-right">
                <button
                  className="text-xs text-[var(--color-brand-600)] hover:underline"
                  onClick={() => void open(d)}
                >
                  Open
                </button>
                {canDelete && (
                  <button
                    className="ml-3 text-xs text-[var(--color-danger)] hover:underline"
                    onClick={() => setRemoving(d)}
                  >
                    Remove
                  </button>
                )}
              </Td>
            </tr>
          ))}
        </Rows>
      )}

      {removing && (
        <ConfirmDialog
          title={`Remove "${removing.title}"?`}
          confirmLabel="Remove it"
          cancelLabel="Keep it"
          tone="danger"
          onConfirm={() => void remove(removing)}
          onCancel={() => setRemoving(null)}
        >
          <p>
            {DOC_CATEGORY_LABELS[removing.category]} · {removing.filename}. This cannot be undone —
            if the file is still needed anywhere it has to be uploaded again.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

/* ── insurance tab ─────────────────────────────────────────────────────────────── */

const POLICY_TYPE_LABEL: Record<PolicyType, string> = {
  cashless: "Cashless",
  reimbursement: "Reimbursement",
  government: "Government",
  corporate: "Corporate",
};
const CLAIM_STATUS_META: Record<
  ClaimStatus,
  { label: string; tone: "neutral" | "brand" | "warning" | "success" | "danger" }
> = {
  draft: { label: "Draft", tone: "neutral" },
  submitted: { label: "Submitted", tone: "brand" },
  approved: { label: "Approved", tone: "success" },
  partially_approved: { label: "Partially approved", tone: "warning" },
  rejected: { label: "Rejected", tone: "danger" },
  settled: { label: "Settled", tone: "success" },
};

function InsField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]">{label}</span>
      {children}
    </label>
  );
}

const insInput =
  "w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm outline-none focus:border-[var(--color-brand-500)] focus:ring-2 focus:ring-[var(--color-brand-500)]/30";

function Insurance({
  patientId,
  encounters,
  invoices,
  canFile,
  canReconcile,
}: {
  patientId: string;
  encounters: Encounter[];
  invoices: Invoice[];
  canFile: boolean;
  canReconcile: boolean;
}) {
  const { api } = useAuth();
  const [policies, setPolicies] = useState<InsurancePolicy[]>([]);
  const [claims, setClaims] = useState<InsuranceClaim[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [showPolicy, setShowPolicy] = useState(false);
  const [showClaim, setShowClaim] = useState(false);
  /** A claim step that needs a figure typed, awaiting the in-app dialog. */
  const [amountFor, setAmountFor] = useState<{
    claim: InsuranceClaim;
    step: "approve" | "settle";
    to?: ClaimStatus;
  } | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([api.listInsurancePolicies(patientId), api.listInsuranceClaims(patientId)])
      .then(([p, c]) => {
        setPolicies(p);
        setClaims(c);
      })
      .catch((e: unknown) => setError(e))
      .finally(() => setLoading(false));
  }, [api, patientId]);
  useEffect(load, [load]);

  const insurerOf = (policyId: string) =>
    policies.find((p) => p.id === policyId)?.insurer ?? "Policy";

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      load();
    } catch (e) {
      setError(e);
    }
  }

  /**
   * A claim's actions depend on its state; the amount-bearing steps ask for the figure first.
   *
   * They used `window.prompt`, which is worse here than anywhere else in the app: `toPaise`
   * returns ZERO for anything it cannot parse, so a mistyped "12o0" approved the claim for
   * nothing at all and said so nowhere. The dialog validates the figure before the request.
   */
  function decide(claim: InsuranceClaim, to: ClaimStatus) {
    if (to === "approved" || to === "partially_approved") {
      setAmountFor({ claim, step: "approve", to });
    } else {
      void act(() => api.transitionInsuranceClaim(claim.id, { to }));
    }
  }

  function submitAmount(raw: string) {
    if (!amountFor) return;
    const { claim, step, to } = amountFor;
    setAmountFor(null);
    if (step === "settle") {
      void act(() => api.settleInsuranceClaim(claim.id, { settledAmount: toPaise(raw) }));
    } else if (to) {
      void act(() => api.transitionInsuranceClaim(claim.id, { to, approvedAmount: toPaise(raw) }));
    }
  }

  if (loading) {
    return <p className="py-6 text-center text-sm text-[var(--color-fg-muted)]">Loading…</p>;
  }

  return (
    <div className="space-y-6">
      {error != null && (
        <Alert tone="danger">
          {error instanceof ApiClientError ? error.message : "Something went wrong."}
        </Alert>
      )}

      {/* Policies */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-semibold text-[var(--color-fg)]">Policies</h2>
          <Button variant="ghost" onClick={() => setShowPolicy((s) => !s)}>
            {showPolicy ? "Cancel" : "Link policy"}
          </Button>
        </div>

        {showPolicy && (
          <PolicyForm
            onSubmit={(v) =>
              void act(async () => {
                await api.linkInsurancePolicy(patientId, v);
                setShowPolicy(false);
              })
            }
          />
        )}

        {policies.length === 0 ? (
          <p className="text-sm text-[var(--color-fg-subtle)]">No policies on record.</p>
        ) : (
          <div className="space-y-2">
            {policies.map((p) => (
              <Card key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 p-3.5">
                <div className="min-w-40 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-[var(--color-fg)]">{p.insurer}</span>
                    <Badge tone="neutral">{POLICY_TYPE_LABEL[p.policyType]}</Badge>
                    {p.status === "inactive" && <Badge tone="warning">Inactive</Badge>}
                  </div>
                  <p className="mt-0.5 font-mono text-xs text-[var(--color-fg-subtle)]">
                    {p.policyNumber}
                    {p.tpaName ? ` · ${p.tpaName}` : ""}
                    {p.planName ? ` · ${p.planName}` : ""}
                  </p>
                </div>
                <div className="text-right text-xs text-[var(--color-fg-muted)]">
                  {p.sumInsured != null && <div>Cover {rupees(p.sumInsured)}</div>}
                  {(p.validFrom || p.validTo) && (
                    <div>
                      {fmtDate(p.validFrom)} – {fmtDate(p.validTo)}
                    </div>
                  )}
                </div>
                <button
                  className="text-xs text-[var(--color-brand-600)] hover:underline"
                  onClick={() =>
                    void act(() =>
                      api.updateInsurancePolicy(p.id, {
                        status: p.status === "active" ? "inactive" : "active",
                      }),
                    )
                  }
                >
                  {p.status === "active" ? "Deactivate" : "Reactivate"}
                </button>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Claims */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-semibold text-[var(--color-fg)]">Claims</h2>
          {canFile && policies.length > 0 && (
            <Button variant="ghost" onClick={() => setShowClaim((s) => !s)}>
              {showClaim ? "Cancel" : "File claim"}
            </Button>
          )}
        </div>

        {showClaim && canFile && (
          <ClaimForm
            policies={policies.filter((p) => p.status === "active")}
            encounters={encounters}
            invoices={invoices}
            onSubmit={(v) =>
              void act(async () => {
                await api.fileInsuranceClaim(patientId, v);
                setShowClaim(false);
              })
            }
          />
        )}

        {claims.length === 0 ? (
          <p className="text-sm text-[var(--color-fg-subtle)]">No claims filed.</p>
        ) : (
          <div className="space-y-2">
            {claims.map((c) => {
              const meta = CLAIM_STATUS_META[c.status];
              return (
                <Card key={c.id} className="p-3.5">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    <div className="min-w-40 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-[var(--color-fg)]">
                          {insurerOf(c.policyId)}
                        </span>
                        <Badge tone="neutral">{c.claimType}</Badge>
                        <Badge tone={meta.tone}>{meta.label}</Badge>
                      </div>
                      <p className="mt-0.5 text-xs text-[var(--color-fg-subtle)]">
                        {c.claimNumber ? `${c.claimNumber} · ` : ""}
                        filed {fmtDate(c.createdAt)}
                      </p>
                    </div>
                    <div className="text-right text-xs text-[var(--color-fg-muted)] tabular-nums">
                      <div>Claimed {rupees(c.claimedAmount)}</div>
                      {c.approvedAmount != null && <div>Approved {rupees(c.approvedAmount)}</div>}
                      {c.settledAmount != null && (
                        <div className="text-[var(--color-success)]">
                          Settled {rupees(c.settledAmount)}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Lifecycle actions */}
                  <div className="mt-2 flex flex-wrap gap-2">
                    {canFile && c.status === "draft" && (
                      <>
                        <ClaimBtn onClick={() => decide(c, "submitted")}>Submit</ClaimBtn>
                        <ClaimBtn danger onClick={() => decide(c, "rejected")}>
                          Reject
                        </ClaimBtn>
                      </>
                    )}
                    {canFile && c.status === "submitted" && (
                      <>
                        <ClaimBtn onClick={() => decide(c, "approved")}>Approve</ClaimBtn>
                        <ClaimBtn onClick={() => decide(c, "partially_approved")}>
                          Partially approve
                        </ClaimBtn>
                        <ClaimBtn danger onClick={() => decide(c, "rejected")}>
                          Reject
                        </ClaimBtn>
                      </>
                    )}
                    {canReconcile &&
                      (c.status === "approved" || c.status === "partially_approved") && (
                        <ClaimBtn onClick={() => setAmountFor({ claim: c, step: "settle" })}>
                          Record settlement
                        </ClaimBtn>
                      )}
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {amountFor && (
        <ConfirmDialog
          title={amountFor.step === "settle" ? "Record settlement" : "Record the payer's decision"}
          confirmLabel={amountFor.step === "settle" ? "Record it" : "Record the decision"}
          reason={{
            label:
              amountFor.step === "settle"
                ? "Amount settled by the payer (₹)"
                : "Amount the payer approved (₹)",
            multiline: false,
            defaultValue: String(
              (amountFor.step === "settle"
                ? (amountFor.claim.approvedAmount ?? amountFor.claim.claimedAmount)
                : amountFor.claim.claimedAmount) / 100,
            ),
            minLength: 1,
            validate: (raw) => {
              const value = Number(raw);
              if (!Number.isFinite(value)) return "Enter a number — for example 12500 or 12500.50.";
              if (value < 0) return "An amount cannot be negative.";
              return null;
            },
          }}
          onConfirm={submitAmount}
          onCancel={() => setAmountFor(null)}
        >
          <p>
            Claimed {rupees(amountFor.claim.claimedAmount)}
            {amountFor.claim.approvedAmount != null &&
              ` · approved ${rupees(amountFor.claim.approvedAmount)}`}
            .
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function ClaimBtn({
  children,
  onClick,
  danger,
}: {
  children: ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
        danger
          ? "border-[var(--color-danger)]/40 text-[var(--color-danger)] hover:bg-[var(--color-danger-bg)]"
          : "border-[var(--color-border-strong)] text-[var(--color-fg-muted)] hover:border-[var(--color-brand-500)] hover:text-[var(--color-brand-700)]"
      }`}
    >
      {children}
    </button>
  );
}

function PolicyForm({
  onSubmit,
}: {
  onSubmit: (v: Parameters<ReturnType<typeof useAuth>["api"]["linkInsurancePolicy"]>[1]) => void;
}) {
  const [insurer, setInsurer] = useState("");
  const [policyNumber, setPolicyNumber] = useState("");
  const [policyType, setPolicyType] = useState<PolicyType>("cashless");
  const [tpaName, setTpaName] = useState("");
  const [planName, setPlanName] = useState("");
  const [holder, setHolder] = useState("");
  const [relationship, setRelationship] = useState<PolicyRelationship>("self");
  const [validFrom, setValidFrom] = useState("");
  const [validTo, setValidTo] = useState("");
  const [sumInsured, setSumInsured] = useState("");
  const opt = (s: string) => (s.trim() ? s.trim() : undefined);

  return (
    <Card className="mb-3 space-y-3 p-4">
      <div className="grid grid-cols-2 gap-3">
        <InsField label="Insurer">
          <input
            className={insInput}
            value={insurer}
            onChange={(e) => setInsurer(e.target.value)}
          />
        </InsField>
        <InsField label="Policy number">
          <input
            className={insInput}
            value={policyNumber}
            onChange={(e) => setPolicyNumber(e.target.value)}
          />
        </InsField>
        <InsField label="Type">
          <select
            className={insInput}
            value={policyType}
            onChange={(e) => setPolicyType(e.target.value as PolicyType)}
          >
            {(Object.keys(POLICY_TYPE_LABEL) as PolicyType[]).map((t) => (
              <option key={t} value={t}>
                {POLICY_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </InsField>
        <InsField label="TPA (optional)">
          <input
            className={insInput}
            value={tpaName}
            onChange={(e) => setTpaName(e.target.value)}
          />
        </InsField>
        <InsField label="Plan (optional)">
          <input
            className={insInput}
            value={planName}
            onChange={(e) => setPlanName(e.target.value)}
          />
        </InsField>
        <InsField label="Sum insured (₹)">
          <input
            type="number"
            className={insInput}
            value={sumInsured}
            onChange={(e) => setSumInsured(e.target.value)}
          />
        </InsField>
        <InsField label="Policy holder (optional)">
          <input className={insInput} value={holder} onChange={(e) => setHolder(e.target.value)} />
        </InsField>
        <InsField label="Relationship">
          <select
            className={insInput}
            value={relationship}
            onChange={(e) => setRelationship(e.target.value as PolicyRelationship)}
          >
            {(["self", "spouse", "child", "parent", "other"] as PolicyRelationship[]).map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </InsField>
        <InsField label="Valid from">
          <input
            type="date"
            className={insInput}
            value={validFrom}
            onChange={(e) => setValidFrom(e.target.value)}
          />
        </InsField>
        <InsField label="Valid to">
          <input
            type="date"
            className={insInput}
            value={validTo}
            onChange={(e) => setValidTo(e.target.value)}
          />
        </InsField>
      </div>
      <div className="flex justify-end">
        <Button
          disabled={!insurer.trim() || !policyNumber.trim()}
          onClick={() =>
            onSubmit({
              insurer: insurer.trim(),
              policyNumber: policyNumber.trim(),
              policyType,
              ...(opt(tpaName) ? { tpaName: opt(tpaName) } : {}),
              ...(opt(planName) ? { planName: opt(planName) } : {}),
              ...(opt(holder) ? { policyHolderName: opt(holder) } : {}),
              relationship,
              ...(opt(validFrom) ? { validFrom: opt(validFrom) } : {}),
              ...(opt(validTo) ? { validTo: opt(validTo) } : {}),
              ...(sumInsured.trim() ? { sumInsured: toPaise(sumInsured) } : {}),
            })
          }
        >
          Link policy
        </Button>
      </div>
    </Card>
  );
}

function ClaimForm({
  policies,
  encounters,
  invoices,
  onSubmit,
}: {
  policies: InsurancePolicy[];
  encounters: Encounter[];
  invoices: Invoice[];
  onSubmit: (v: Parameters<ReturnType<typeof useAuth>["api"]["fileInsuranceClaim"]>[1]) => void;
}) {
  const [policyId, setPolicyId] = useState(policies[0]?.id ?? "");
  const [claimType, setClaimType] = useState<ClaimType>("cashless");
  const [claimedAmount, setClaimedAmount] = useState("");
  const [claimNumber, setClaimNumber] = useState("");
  const [encounterId, setEncounterId] = useState("");
  const [invoiceId, setInvoiceId] = useState("");
  // Bills that carry an insurer share are the ones a claim recovers — offer those first, pre-filling
  // the claimed amount from the split so the two numbers agree.
  const splitInvoices = invoices.filter((i) => i.coveredByInsurer > 0);

  return (
    <Card className="mb-3 space-y-3 p-4">
      <div className="grid grid-cols-2 gap-3">
        <InsField label="Policy">
          <select
            className={insInput}
            value={policyId}
            onChange={(e) => setPolicyId(e.target.value)}
          >
            {policies.map((p) => (
              <option key={p.id} value={p.id}>
                {p.insurer} · {p.policyNumber}
              </option>
            ))}
          </select>
        </InsField>
        <InsField label="Claim type">
          <select
            className={insInput}
            value={claimType}
            onChange={(e) => setClaimType(e.target.value as ClaimType)}
          >
            {(["cashless", "reimbursement", "preauth"] as ClaimType[]).map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </InsField>
        <InsField label="Claimed amount (₹)">
          <input
            type="number"
            className={insInput}
            value={claimedAmount}
            onChange={(e) => setClaimedAmount(e.target.value)}
          />
        </InsField>
        <InsField label="Claim number (optional)">
          <input
            className={insInput}
            value={claimNumber}
            onChange={(e) => setClaimNumber(e.target.value)}
          />
        </InsField>
        <InsField label="Against visit (optional)">
          <select
            className={insInput}
            value={encounterId}
            onChange={(e) => setEncounterId(e.target.value)}
          >
            <option value="">— none —</option>
            {encounters.map((e) => (
              <option key={e.id} value={e.id}>
                {fmtDate(e.arrivedAt)} · {e.class}
              </option>
            ))}
          </select>
        </InsField>
        <InsField label="Against bill (optional)">
          <select
            className={insInput}
            value={invoiceId}
            onChange={(e) => {
              const v = e.target.value;
              setInvoiceId(v);
              // Pre-fill the claimed amount from the bill's insurer share so they line up.
              const inv = splitInvoices.find((i) => i.id === v);
              if (inv) setClaimedAmount((inv.coveredByInsurer / 100).toFixed(2));
            }}
          >
            <option value="">— none —</option>
            {splitInvoices.map((i) => (
              <option key={i.id} value={i.id}>
                {i.number ?? "draft"} · insurer {rupees(i.coveredByInsurer)}
              </option>
            ))}
          </select>
        </InsField>
      </div>
      <div className="flex justify-end">
        <Button
          disabled={!policyId || !claimedAmount.trim()}
          onClick={() =>
            onSubmit({
              policyId,
              claimType,
              claimedAmount: toPaise(claimedAmount),
              ...(claimNumber.trim() ? { claimNumber: claimNumber.trim() } : {}),
              ...(encounterId ? { encounterId } : {}),
              ...(invoiceId ? { invoiceId } : {}),
            })
          }
        >
          File claim
        </Button>
      </div>
    </Card>
  );
}

/* ── consent (C3 / medico-legal) ─────────────────────────────────────────── */

const CONSENT_TYPE_LABEL: Record<ConsentType, string> = {
  general: "General",
  admission: "Admission",
  surgical: "Surgical",
  anaesthesia: "Anaesthesia",
  procedure: "Procedure",
  blood_transfusion: "Blood transfusion",
  high_risk: "High-risk",
  hiv_test: "HIV test",
  dnr: "DNR",
  research: "Research",
};

const CONSENT_SIGNER_LABEL: Record<ConsentSigner, string> = {
  patient: "Patient",
  guardian: "Guardian",
  spouse: "Spouse",
  parent: "Parent",
  next_of_kin: "Next of kin",
};

function ConsentPanel({
  patientId,
  encounters,
  canManage,
}: {
  patientId: string;
  encounters: Encounter[];
  canManage: boolean;
}) {
  const { api } = useAuth();
  const [consents, setConsents] = useState<Consent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [showForm, setShowForm] = useState(false);
  /** The consent awaiting a withdrawal reason — a medico-legal record, so it is asked properly. */
  const [withdrawing, setWithdrawing] = useState<Consent | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api
      .listConsents(patientId)
      .then(setConsents)
      .catch((e: unknown) => setError(e))
      .finally(() => setLoading(false));
  }, [api, patientId]);
  useEffect(load, [load]);

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      load();
    } catch (e) {
      setError(e);
    }
  }

  function withdraw(c: Consent, reason: string) {
    setWithdrawing(null);
    void act(() => api.withdrawConsent(c.id, reason));
  }

  if (loading) {
    return <p className="py-6 text-center text-sm text-[var(--color-fg-muted)]">Loading…</p>;
  }

  return (
    <div className="space-y-4">
      {error != null && (
        <Alert tone="danger">
          {error instanceof ApiClientError ? error.message : "Something went wrong."}
        </Alert>
      )}

      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-[var(--color-fg)]">Consents</h2>
        {canManage && (
          <Button variant="ghost" onClick={() => setShowForm((s) => !s)}>
            {showForm ? "Cancel" : "Record consent"}
          </Button>
        )}
      </div>

      {showForm && canManage && (
        <ConsentForm
          encounters={encounters}
          onSubmit={(v) =>
            void act(async () => {
              await api.recordConsent({ patientId, ...v });
              setShowForm(false);
            })
          }
        />
      )}

      {consents.length === 0 ? (
        <p className="text-sm text-[var(--color-fg-subtle)]">No consents on record.</p>
      ) : (
        <div className="space-y-2">
          {consents.map((c) => (
            <Card key={c.id} className="flex flex-wrap items-start gap-x-4 gap-y-1 p-3.5">
              <div className="min-w-40 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="neutral">{CONSENT_TYPE_LABEL[c.type]}</Badge>
                  <span className="font-medium text-[var(--color-fg)]">{c.procedure}</span>
                  {c.status === "withdrawn" && <Badge tone="danger">Withdrawn</Badge>}
                </div>
                <p className="mt-0.5 text-xs text-[var(--color-fg-subtle)]">
                  Signed by {c.signerName} ({CONSENT_SIGNER_LABEL[c.signedBy]}
                  {c.relationship ? `, ${c.relationship}` : ""})
                  {c.language ? ` · in ${c.language}` : ""}
                  {c.witnessName ? ` · witness ${c.witnessName}` : ""}
                </p>
                {c.risksExplained && (
                  <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
                    Risks: {c.risksExplained}
                  </p>
                )}
                {c.status === "withdrawn" && c.withdrawalReason && (
                  <p className="mt-1 text-xs text-[var(--color-danger)]">
                    Withdrawn: {c.withdrawalReason}
                  </p>
                )}
              </div>
              <div className="flex flex-col items-end gap-1 text-right text-xs text-[var(--color-fg-muted)]">
                <span>{fmtDate(c.signedAt)}</span>
                {canManage && c.status === "active" && (
                  <Button variant="ghost" onClick={() => setWithdrawing(c)}>
                    Withdraw
                  </Button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      {withdrawing && (
        <ConfirmDialog
          title="Withdraw this consent?"
          confirmLabel="Withdraw it"
          cancelLabel="Leave it in force"
          tone="danger"
          reason={{
            label: "Why is this consent being withdrawn?",
            placeholder: "Patient withdrew consent verbally, witnessed by the ward sister",
            // The server's own minimum (medicolegal.schema.ts).
            minLength: 1,
          }}
          onConfirm={(reason) => withdraw(withdrawing, reason)}
          onCancel={() => setWithdrawing(null)}
        >
          <p>
            This is a <strong>medico-legal record</strong>. The consent stays on file marked
            withdrawn, with this reason, the time and your name against it — nothing is erased.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function ConsentForm({
  encounters,
  onSubmit,
}: {
  encounters: Encounter[];
  onSubmit: (
    v: Omit<Parameters<ReturnType<typeof useAuth>["api"]["recordConsent"]>[0], "patientId">,
  ) => void;
}) {
  const [type, setType] = useState<ConsentType>("general");
  const [procedure, setProcedure] = useState("");
  const [signedBy, setSignedBy] = useState<ConsentSigner>("patient");
  const [signerName, setSignerName] = useState("");
  const [relationship, setRelationship] = useState("");
  const [language, setLanguage] = useState("");
  const [witnessName, setWitnessName] = useState("");
  const [risksExplained, setRisksExplained] = useState("");
  const [encounterId, setEncounterId] = useState("");

  const relationshipNeeded = signedBy !== "patient";
  const valid =
    procedure.trim() && signerName.trim() && (!relationshipNeeded || relationship.trim());

  return (
    <Card className="mb-3 space-y-3 p-4">
      <div className="grid grid-cols-2 gap-3">
        <InsField label="Consent for">
          <select
            className={insInput}
            value={type}
            onChange={(e) => setType(e.target.value as ConsentType)}
          >
            {(Object.keys(CONSENT_TYPE_LABEL) as ConsentType[]).map((t) => (
              <option key={t} value={t}>
                {CONSENT_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </InsField>
        <InsField label="Procedure / description">
          <input
            className={insInput}
            value={procedure}
            placeholder="e.g. Laparoscopic cholecystectomy"
            onChange={(e) => setProcedure(e.target.value)}
          />
        </InsField>
        <InsField label="Signed by">
          <select
            className={insInput}
            value={signedBy}
            onChange={(e) => setSignedBy(e.target.value as ConsentSigner)}
          >
            {(Object.keys(CONSENT_SIGNER_LABEL) as ConsentSigner[]).map((s) => (
              <option key={s} value={s}>
                {CONSENT_SIGNER_LABEL[s]}
              </option>
            ))}
          </select>
        </InsField>
        <InsField label="Signer's name">
          <input
            className={insInput}
            value={signerName}
            onChange={(e) => setSignerName(e.target.value)}
          />
        </InsField>
        {relationshipNeeded && (
          <InsField label="Relationship to patient">
            <input
              className={insInput}
              value={relationship}
              placeholder="e.g. son, wife"
              onChange={(e) => setRelationship(e.target.value)}
            />
          </InsField>
        )}
        <InsField label="Language explained in (optional)">
          <input
            className={insInput}
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
          />
        </InsField>
        <InsField label="Witness (optional)">
          <input
            className={insInput}
            value={witnessName}
            onChange={(e) => setWitnessName(e.target.value)}
          />
        </InsField>
        <InsField label="Against visit (optional)">
          <select
            className={insInput}
            value={encounterId}
            onChange={(e) => setEncounterId(e.target.value)}
          >
            <option value="">— none —</option>
            {encounters.map((e) => (
              <option key={e.id} value={e.id}>
                {fmtDate(e.arrivedAt)} · {e.class}
              </option>
            ))}
          </select>
        </InsField>
      </div>
      <InsField label="Risks explained (optional)">
        <textarea
          className={insInput}
          rows={2}
          value={risksExplained}
          onChange={(e) => setRisksExplained(e.target.value)}
        />
      </InsField>
      <div className="flex justify-end">
        <Button
          disabled={!valid}
          onClick={() =>
            onSubmit({
              type,
              procedure: procedure.trim(),
              signedBy,
              signerName: signerName.trim(),
              ...(relationshipNeeded && relationship.trim()
                ? { relationship: relationship.trim() }
                : {}),
              ...(language.trim() ? { language: language.trim() } : {}),
              ...(witnessName.trim() ? { witnessName: witnessName.trim() } : {}),
              ...(risksExplained.trim() ? { risksExplained: risksExplained.trim() } : {}),
              ...(encounterId ? { encounterId } : {}),
            })
          }
        >
          Record consent
        </Button>
      </div>
    </Card>
  );
}

/* ── ICD-10 coding (MRD) ─────────────────────────────────────────────────────── */

function CodingPanel({
  encounters,
  api,
}: {
  encounters: Encounter[];
  api: ReturnType<typeof useAuth>["api"];
}) {
  const visits = [...encounters].sort(
    (a, b) => new Date(b.arrivedAt).getTime() - new Date(a.arrivedAt).getTime(),
  );
  const [encounterId, setEncounterId] = useState(visits[0]?.id ?? "");
  const [codes, setCodes] = useState<CodedDiagnosis[]>([]);
  const [noteDx, setNoteDx] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<IcdCode[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  // Load the existing coding + the note's diagnoses (as a reference for what to code) per visit.
  useEffect(() => {
    if (!encounterId) return;
    setSaved(false);
    void api
      .getCoding(encounterId)
      .then((c) => setCodes(c?.codes ?? []))
      .catch(() => setCodes([]));
    void api
      .getConsultation(encounterId)
      .then((n) => setNoteDx(n ? n.diagnoses.map((d) => d.text) : []))
      .catch(() => setNoteDx([]));
  }, [api, encounterId]);

  // Search the ICD master as the coder types (debounced-ish: only when 2+ chars).
  useEffect(() => {
    if (search.trim().length < 2) {
      setResults([]);
      return;
    }
    let live = true;
    void api
      .listIcdCodes(search.trim())
      .then((r) => live && setResults(r))
      .catch(() => live && setResults([]));
    return () => {
      live = false;
    };
  }, [api, search]);

  function addCode(c: IcdCode) {
    if (codes.some((x) => x.code === c.code)) return;
    // The first code added becomes primary; the rest are secondary until the coder says otherwise.
    setCodes((cur) => [...cur, { code: c.code, title: c.title, primary: cur.length === 0 }]);
    setSearch("");
    setResults([]);
    setSaved(false);
  }
  function removeCode(code: string) {
    setCodes((cur) => {
      const next = cur.filter((c) => c.code !== code);
      // If we removed the primary, promote the first remaining so a coding is never primary-less.
      const first = next[0];
      if (first && !next.some((c) => c.primary)) next[0] = { ...first, primary: true };
      return next;
    });
    setSaved(false);
  }
  function setPrimary(code: string) {
    setCodes((cur) => cur.map((c) => ({ ...c, primary: c.code === code })));
    setSaved(false);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.saveCoding(encounterId, codes);
      setSaved(true);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  if (visits.length === 0) return <Empty>No visits to code.</Empty>;

  return (
    <div className="space-y-4">
      {error != null && (
        <Alert tone="danger">
          {error instanceof ApiClientError ? error.message : "Could not save the coding."}
        </Alert>
      )}
      {saved && <Alert tone="success">Coding saved.</Alert>}

      <label className="block text-xs text-[var(--color-fg-muted)]">
        Visit
        <select
          value={encounterId}
          onChange={(e) => setEncounterId(e.target.value)}
          className="mt-0.5 w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-1.5 text-sm text-[var(--color-fg)]"
        >
          {visits.map((v) => (
            <option key={v.id} value={v.id}>
              {fmtDate(v.arrivedAt)} · {v.class}
            </option>
          ))}
        </select>
      </label>

      {noteDx.length > 0 && (
        <p className="text-xs text-[var(--color-fg-subtle)]">From the note: {noteDx.join("; ")}</p>
      )}

      {/* Assigned codes */}
      {codes.length === 0 ? (
        <p className="text-sm text-[var(--color-fg-subtle)]">
          No codes yet. Search below to add ICD-10 codes for this visit.
        </p>
      ) : (
        <div className="space-y-1.5">
          {codes.map((c) => (
            <Card key={c.code} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3">
              <span className="font-mono text-sm font-semibold text-[var(--color-fg)]">
                {c.code}
              </span>
              <span className="min-w-40 flex-1 text-sm text-[var(--color-fg)]">{c.title}</span>
              <label className="flex items-center gap-1.5 text-xs text-[var(--color-fg-muted)]">
                <input
                  type="radio"
                  name="primary-dx"
                  checked={c.primary}
                  onChange={() => setPrimary(c.code)}
                />
                Primary
              </label>
              <button
                type="button"
                onClick={() => removeCode(c.code)}
                className="text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-danger)]"
                aria-label="Remove"
              >
                ✕
              </button>
            </Card>
          ))}
        </div>
      )}

      {/* Search + add */}
      <div className="relative">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search ICD-10 code or diagnosis…"
          className="w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm text-[var(--color-fg)]"
        />
        {results.length > 0 && (
          <div className="absolute z-10 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-lg">
            {results.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => addCode(r)}
                className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-[var(--color-bg-subtle)]"
              >
                <span className="font-mono text-xs font-semibold text-[var(--color-fg)]">
                  {r.code}
                </span>
                <span className="text-[var(--color-fg-muted)]">{r.title}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {search.trim().length >= 2 && results.length === 0 && (
        <p className="text-xs text-[var(--color-fg-subtle)]">
          No matching code. Add it under Medical records first.
        </p>
      )}

      <div className="flex justify-end">
        <Button disabled={busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save coding"}
        </Button>
      </div>
    </div>
  );
}

export default function PatientProfilePage() {
  return <Profile />;
}
