"use client";

/**
 * The doctor's day (Doc 02 E0, ADR-0013 §3).
 *
 * ── ONE SCREEN, BECAUSE A CONSULTATION IS ONE ACT ────────────────────────────
 * The waiting list on the left, the patient in front of you on the right. Calling
 * someone in, ordering their bloods and sending them to the lab happen in one place
 * because they happen in one conversation. A doctor who has to navigate between
 * screens mid-consultation writes on paper instead, and then the software is a
 * data-entry chore performed at 6pm from memory.
 *
 * ── THE ORDER PAD IS THE POINT ───────────────────────────────────────────────
 * Ordering a test HERE is what puts it in the lab's worklist, instantly, with no
 * hand-off (ADR-0013 §3). There is no "send to lab" button anywhere in this product,
 * and that absence is the feature.
 *
 * ── WHAT IS DELIBERATELY ABSENT ──────────────────────────────────────────────
 * A price. A doctor who can see what a patient owes may treat them differently, and
 * that is a decision for a hospital to make explicitly, not for this screen to make
 * by accident. `billing:read` is not in the DOCTOR grant.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ApiClientError,
  ALLERGENS,
  ALLERGY_SEVERITIES,
  DRUG_FREQUENCIES,
  DRUG_ROUTES,
  type Allergy,
  type AllergySeverity,
  type DrugFrequency,
  type DrugRoute,
  type Encounter,
  type EncounterRow,
  type Order,
  type OrderPriority,
  type CatalogueItem,
  type Prescription,
  type PrescriptionLineInput,
  type ReportMeta,
  type SafetyAlert,
  type VitalsReading,
  type DoctorRef,
  type Diagnosis,
  type DiagnosisType,
  type MedicineAvailability,
  type OtBooking,
} from "@medicore/api-client";
import { VitalsPanel } from "../../components/Vitals";
import { OperativeNoteDetail } from "../../components/OperativeNote";
import { useAuth } from "../../components/AuthProvider";
import { ProblemPanel } from "../../components/ProblemList";
import { Alert, Badge, Button, Card, ConfirmDialog, PermissionGate } from "../../components/ui";
import { idempotencyMessage, useIntentKeys } from "../../lib/idempotency";
import { groupReportsByOrder } from "../../lib/reports";
import { CRITICAL_PENDING_LABEL, isCriticalPending, isResultReadable } from "../../lib/results";

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * A stable idempotency key per (encounter, test).
 *
 * A doctor double-clicking "Order" must not draw two tubes of blood from a real arm
 * and raise two bills for it — and a retry after a timeout is the case a disabled
 * button cannot save you from, because the first request may well have succeeded
 * before the connection dropped. The server arbitrates with a unique index; this is
 * what gives it something to arbitrate on.
 */
const PRIORITIES: OrderPriority[] = ["routine", "urgent", "stat", "emergency"];

function priorityTone(p: OrderPriority): "danger" | "brand" | "neutral" {
  if (p === "emergency" || p === "stat") return "danger";
  if (p === "urgent") return "brand";
  return "neutral";
}

/**
 * What the doctor can order, grouped by where the work goes.
 *
 * ── MARK, THEN SEND — NOT ONE-CLICK-ONE-ORDER ───────────────────────────────
 * A consultation ends with "bloods, a chest film and a urine test", not one test at a time.
 * So the pad is multi-SELECT: tap the tests to mark them, set one priority for the batch, and
 * send them together. Each order still carries its own idempotency key, so a double-tap on
 * "Send" places each test exactly once — the mark-then-send flow does not weaken that.
 */
function OrderPad({
  encounter,
  services,
  onOrdered,
}: {
  encounter: Encounter;
  services: CatalogueItem[];
  onOrdered: () => void;
}) {
  const { api } = useAuth();
  const [priority, setPriority] = useState<OrderPriority>("routine");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /**
   * One key per test in THIS submission — see the note in `lib/idempotency.ts`. It replaces
   * `` `ord-${encounterId}-${code}-${Date.now()}` ``, which changed on every click and therefore
   * stopped nothing: a double-click drew two tubes of blood.
   *
   * Held across a retry of the same basket and dropped when the basket changes, because a
   * different set of tests under the same key is a conflict, not a retry.
   */
  const orderKeys = useIntentKeys();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const orderable = useMemo(
    () => services.filter((s) => ["lab", "radiology", "procedure"].includes(s.category)),
    [services],
  );

  function toggle(code: string) {
    setNotice(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  async function sendSelected() {
    const items = orderable.filter((s) => selected.has(s.code));
    if (items.length === 0) return;

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      let placed = 0;
      let duplicates = 0;
      // One request each — the endpoint is idempotent per (encounter, code), so a retry of
      // the whole batch never double-orders. A true batch endpoint would save round trips;
      // at a consultation's scale (a handful of tests) this is simpler and just as safe.
      for (const item of items) {
        const key = orderKeys.keyFor(item.code);
        const result = await api.placeOrder(
          {
            encounterId: encounter.id,
            category: item.category as "lab" | "radiology" | "procedure",
            code: item.code,
            name: item.name,
            priority,
            requestId: key,
          },
          key,
        );
        // `duplicate` now only appears if the header was stripped in transit and the server
        // answered from the order's own `requestId` guard. A header replay returns the original
        // 201, so the ordinary retry path reports what the FIRST attempt did — which is true.
        if (result.duplicate) duplicates += 1;
        else placed += 1;
      }

      setNotice(
        `${String(placed)} test${placed === 1 ? "" : "s"} ordered — on the department worklist now${duplicates > 0 ? `, ${String(duplicates)} already ordered` : ""}.`,
      );
      setSelected(new Set());
      orderKeys.reset();
      onOrdered();
    } catch (err) {
      setError(
        idempotencyMessage(err) ??
          (err instanceof ApiClientError ? err.message : "Could not place the orders."),
      );
    } finally {
      setBusy(false);
    }
  }

  const groups: { label: string; category: string }[] = [
    { label: "Blood & lab", category: "lab" },
    { label: "X-ray & imaging", category: "radiology" },
    { label: "Procedures", category: "procedure" },
  ];

  return (
    <div className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-[var(--color-fg-muted)]">Priority</span>
        {PRIORITIES.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPriority(p)}
            className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
              priority === p
                ? "bg-[var(--color-brand-600)] text-[var(--color-on-accent)]"
                : "bg-[var(--color-bg-subtle)] text-[var(--color-fg-muted)] hover:bg-[var(--color-bg)]"
            }`}
          >
            {p}
          </button>
        ))}
        {(priority === "stat" || priority === "emergency") && (
          <span className="text-xs text-[var(--color-danger)]">
            Goes to the top of the lab&apos;s list.
          </span>
        )}
      </div>

      {groups.map((group) => {
        const items = orderable.filter((s) => s.category === group.category);
        if (items.length === 0) return null;

        return (
          <div key={group.category}>
            <p className="mb-1.5 text-xs font-semibold text-[var(--color-fg-muted)] uppercase">
              {group.label}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {items.map((item) => {
                const on = selected.has(item.code);
                return (
                  <button
                    key={item.code}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggle(item.code)}
                    className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
                      on
                        ? "border-[var(--color-brand-600)] bg-[var(--color-brand-600)] text-[var(--color-on-accent)]"
                        : "border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] text-[var(--color-fg)] hover:border-[var(--color-brand-500)] hover:bg-[var(--color-brand-50)]"
                    }`}
                  >
                    <span className="text-[0.7rem]">{on ? "✓" : "+"}</span>
                    {item.name}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}

      <div className="flex items-center gap-3 border-t border-[var(--color-border)] pt-3">
        <Button disabled={busy || selected.size === 0} onClick={() => void sendSelected()}>
          {busy
            ? "Ordering…"
            : selected.size === 0
              ? "Select tests to order"
              : `Order ${String(selected.size)} test${selected.size === 1 ? "" : "s"}`}
        </Button>
        {selected.size > 0 && !busy && (
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="text-xs text-[var(--color-fg-muted)] hover:underline"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

/** What has been asked for on this visit, and what has come back. */
function OrdersForVisit({ orders }: { orders: Order[] }) {
  if (orders.length === 0) {
    return <p className="text-xs text-[var(--color-fg-subtle)]">Nothing ordered on this visit.</p>;
  }

  return (
    <ul className="space-y-2">
      {orders.map((o) => (
        <li
          key={o.id}
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-2.5"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-[var(--color-fg)]">{o.name}</span>
            <Badge tone={priorityTone(o.priority)}>{o.priority}</Badge>
            <Badge tone={o.status === "released" ? "success" : "neutral"}>
              {o.status.replace("_", " ")}
            </Badge>
            {/*
             * A critical flag before release is shown WITH the words, never as a bare red pill.
             * The hospital has already emailed this doctor the value (`order.critical`, sent
             * synchronously at completion), so saying nothing here would be incoherent — but an
             * unqualified CRITICAL badge invites action on a number nobody has confirmed, and
             * makes it impossible to tell which reds are signed off. See `lib/results`.
             */}
            {isCriticalPending(o) ? (
              <Badge tone="danger">{CRITICAL_PENDING_LABEL}</Badge>
            ) : (
              o.result?.critical && <Badge tone="danger">CRITICAL</Badge>
            )}
          </div>

          {/*
           * The result appears here ONLY once released — never at `completed` or
           * `verified`. A number that has been run but not signed off must not reach
           * the person who will act on it (STATE_MACHINE_CATALOG §15). The gate itself now
           * lives in `lib/results` so the patient chart cannot answer it differently.
           */}
          {isResultReadable(o) && o.result && (
            <div className="mt-2 rounded-md bg-[var(--color-bg-elevated)] p-2 text-xs">
              {o.result.summary && <p className="text-[var(--color-fg)]">{o.result.summary}</p>}
              {o.result.values && o.result.values.length > 0 && (
                <table className="mt-1.5 w-full text-left">
                  <tbody>
                    {o.result.values.map((v) => (
                      <tr key={v.code}>
                        <td className="py-0.5 pr-3 text-[var(--color-fg-muted)]">{v.label}</td>
                        <td
                          className={`py-0.5 pr-3 font-medium ${
                            v.flag?.startsWith("critical")
                              ? "text-[var(--color-danger)]"
                              : "text-[var(--color-fg)]"
                          }`}
                        >
                          {v.value} {v.unit ?? ""}
                        </td>
                        <td className="py-0.5 text-[var(--color-fg-subtle)]">
                          {v.referenceRange ?? ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * The prescription pad.
 *
 * ── COMPOSE, THEN SIGN — AND THE TWO ARE NOT THE SAME CLICK ─────────────────
 * Lines are gathered here and nothing exists on the server until "Sign". The signature is
 * what makes the document an authority for drugs to leave a shelf, and after it the
 * prescription is IMMUTABLE (STATE_MACHINE_CATALOG §6) — which is exactly why the editing
 * happens before it and not after.
 *
 * ── DOSE, ROUTE AND FREQUENCY ARE THE WHOLE PRESCRIPTION ────────────────────
 * `route` and `frequency` are pickers rather than text boxes on purpose: a drug given by
 * the wrong route kills people, and it has. A picker cannot stop a doctor choosing wrongly;
 * it can stop them choosing something nobody has ever thought about.
 *
 * No prices here either — this is the same price-free catalogue the order pad uses.
 */
/**
 * The tone a safety alert is drawn in. `contraindicated` is the block — it must look
 * different from a warning, because the whole point of the severity ladder is that a doctor
 * can tell at a glance which one they are allowed to click past.
 */
function alertTone(severity: SafetyAlert["severity"]): "danger" | "warning" {
  return severity === "contraindicated" ? "danger" : "warning";
}

function SafetyAlertList({ alerts }: { alerts: SafetyAlert[] }) {
  return (
    <div className="space-y-2">
      {alerts.map((a, i) => (
        <Alert key={`${a.kind}-${String(i)}`} tone={alertTone(a.severity)}>
          <span className="font-semibold uppercase tracking-wide" style={{ fontSize: "0.65rem" }}>
            {a.severity === "contraindicated" ? "Contraindicated" : a.kind.replace(/_/g, " ")}
          </span>
          <span className="ml-2">{a.message}</span>
        </Alert>
      ))}
    </div>
  );
}

/**
 * A patient's known allergies, at the top of the prescribing pad — because the safest place
 * for this information is directly in front of the person about to prescribe. The server
 * screen is the real gate; this is so the doctor is never surprised by it.
 */
function AllergyBanner({ allergies }: { allergies: Allergy[] }) {
  const active = allergies.filter((a) => a.status === "active");
  if (active.length === 0) {
    return (
      <p className="text-xs text-[var(--color-fg-subtle)]">No known drug allergies recorded.</p>
    );
  }
  return (
    <Alert tone="danger" title="Allergies">
      <div className="flex flex-wrap gap-1.5">
        {active.map((a) => (
          <span
            key={a.id}
            className="rounded border border-[var(--color-danger)]/30 px-1.5 py-0.5 text-xs font-medium"
          >
            {a.label}
            {a.severity === "anaphylaxis" || a.severity === "severe" ? ` (${a.severity})` : ""}
          </span>
        ))}
      </div>
    </Alert>
  );
}

/**
 * Record and rule out allergies. Recording is against a CATALOGUE code, never free text —
 * the `<select>` is not a convenience, it is the guarantee that what is stored is what the
 * prescribing check screens against. A typed "penicilin" would be a check that never fires.
 */
function AllergyPanel({
  patientId,
  allergies,
  canManage,
  onChange,
}: {
  patientId: string;
  allergies: Allergy[];
  canManage: boolean;
  onChange: () => void;
}) {
  const { api } = useAuth();
  const [allergen, setAllergen] = useState("");
  const [severity, setSeverity] = useState<AllergySeverity>("moderate");
  const [reaction, setReaction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The allergy awaiting a rule-out reason, asked for in the app rather than by `window.prompt`. */
  const [refuting, setRefuting] = useState<Allergy | null>(null);

  const active = allergies.filter((a) => a.status === "active");
  const refuted = allergies.filter((a) => a.status === "refuted");

  async function record() {
    if (!allergen) return;
    setBusy(true);
    setError(null);
    try {
      await api.recordAllergy(patientId, {
        allergen,
        severity,
        ...(reaction.trim() ? { reaction: reaction.trim() } : {}),
      });
      setAllergen("");
      setReaction("");
      setSeverity("moderate");
      onChange();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not record the allergy.");
    } finally {
      setBusy(false);
    }
  }

  async function refute(id: string, reason: string) {
    setBusy(true);
    setError(null);
    try {
      await api.refuteAllergy(id, reason);
      setRefuting(null);
      onChange();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not rule out the allergy.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {error && <Alert tone="danger">{error}</Alert>}

      {active.length === 0 ? (
        <p className="text-xs text-[var(--color-fg-subtle)]">No known drug allergies recorded.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {active.map((a) => (
            <span
              key={a.id}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger-bg)] px-2 py-1 text-xs text-[var(--color-danger)]"
            >
              <span className="font-medium">{a.label}</span>
              <span className="opacity-70">· {a.severity}</span>
              {canManage && (
                <button
                  type="button"
                  onClick={() => setRefuting(a)}
                  disabled={busy}
                  className="opacity-60 hover:opacity-100"
                  title="Rule this out"
                >
                  ✕
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {refuted.length > 0 && (
        <p className="text-xs text-[var(--color-fg-subtle)]">
          Ruled out: {refuted.map((a) => a.label).join(", ")}
        </p>
      )}

      {canManage && (
        <div className="flex flex-wrap items-end gap-2 border-t border-[var(--color-border)] pt-3">
          <label className="text-xs text-[var(--color-fg-muted)]">
            Allergen
            <select
              value={allergen}
              onChange={(e) => setAllergen(e.target.value)}
              className="mt-0.5 block w-40 rounded border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-1.5 py-1 text-xs text-[var(--color-fg)]"
            >
              <option value="">Choose…</option>
              {Object.entries(ALLERGENS).map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-[var(--color-fg-muted)]">
            Severity
            <select
              value={severity}
              onChange={(e) => setSeverity(e.target.value as AllergySeverity)}
              className="mt-0.5 block rounded border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-1.5 py-1 text-xs text-[var(--color-fg)]"
            >
              {ALLERGY_SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="flex-1 text-xs text-[var(--color-fg-muted)]">
            Reaction (optional)
            <input
              value={reaction}
              onChange={(e) => setReaction(e.target.value)}
              placeholder="rash, throat swelling…"
              className="mt-0.5 block w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-1.5 py-1 text-xs text-[var(--color-fg)]"
            />
          </label>
          <Button variant="secondary" disabled={busy || !allergen} onClick={() => void record()}>
            Add
          </Button>
        </div>
      )}

      {refuting && (
        <ConfirmDialog
          title={`Rule out ${refuting.label}?`}
          confirmLabel="Rule it out"
          cancelLabel="Leave it on the record"
          tone="danger"
          busy={busy}
          reason={{
            label: "Why is this being ruled out?",
            placeholder: "Challenge tested negative on 12 Aug — patient tolerated a full dose",
            // The server requires a reason (allergy.schema.ts); a ruled-out allergy without one is
            // indistinguishable from a mis-click, and the prescribing check stops screening for it.
            minLength: 1,
          }}
          onConfirm={(reason) => void refute(refuting.id, reason)}
          onCancel={() => setRefuting(null)}
        >
          <p>
            The prescribing check <strong>stops screening against this allergy</strong>. It stays
            visible on the record as ruled out, with this reason and your name against it.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

const REPORT_CATEGORY_LABEL: Record<string, string> = {
  lab: "Blood & lab",
  radiology: "X-ray & imaging",
  procedure: "Procedures",
};

function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * The patient's diagnostic reports, across EVERY visit — grouped by appointment date, then by
 * category. This is where a doctor opens "what did the last CBC show" without leaving the
 * consultation, and it deliberately reaches back through previous encounters: a result is a
 * fact about the patient, not about the visit it was ordered in.
 */
function PatientReports({ reports }: { reports: ReportMeta[] }) {
  const { api } = useAuth();
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function open(report: ReportMeta) {
    setOpening(report.id);
    setError(null);
    try {
      const blob = await api.fetchReportBlob(report.id);
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener");
      // Revoke after a beat — long enough for the new tab to have loaded it.
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch {
      setError("Could not open the report.");
    } finally {
      setOpening(null);
    }
  }

  if (reports.length === 0) {
    return (
      <p className="text-xs text-[var(--color-fg-subtle)]">
        No reports uploaded for this patient yet. When the lab uploads one it appears here.
      </p>
    );
  }

  // Group by visit day (newest first), then by category within a day.
  const byDay = new Map<string, ReportMeta[]>();
  for (const r of reports) {
    const key = dayLabel(r.visitDate);
    (byDay.get(key) ?? byDay.set(key, []).get(key)!).push(r);
  }

  return (
    <div className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}
      {[...byDay.entries()].map(([day, dayReports]) => {
        const byCategory = new Map<string, ReportMeta[]>();
        for (const r of dayReports) {
          (byCategory.get(r.category) ?? byCategory.set(r.category, []).get(r.category)!).push(r);
        }
        return (
          <div key={day}>
            <p className="mb-2 text-xs font-semibold text-[var(--color-fg)]">{day}</p>
            <div className="space-y-2 border-l-2 border-[var(--color-border)] pl-3">
              {[...byCategory.entries()].map(([category, catReports]) => (
                <div key={category}>
                  <p className="text-xs font-medium tracking-wide text-[var(--color-fg-subtle)] uppercase">
                    {REPORT_CATEGORY_LABEL[category] ?? category}
                  </p>
                  {/*
                    ONE ROW PER TEST. A test with two files attached is one test that was uploaded
                    twice — not two tests — and drawing it as two rows is exactly what made four
                    completed orders look like seven results on the doctor's screen. Both files stay
                    openable, because the second is often the corrected one and this screen has no
                    business choosing between them.
                  */}
                  <ul className="mt-1 space-y-1">
                    {groupReportsByOrder(catReports).map((g) => {
                      const [latest, ...earlier] = g.files;
                      if (!latest) return null;
                      return (
                        <li
                          key={g.orderId}
                          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-3 py-2"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium text-[var(--color-fg)]">
                                {g.testName}
                              </p>
                              <p className="truncate text-xs text-[var(--color-fg-muted)]">
                                {latest.filename} · {(latest.size / 1024).toFixed(0)} KB
                                {earlier.length > 0 && (
                                  <span className="text-[var(--color-fg-subtle)]">
                                    {" "}
                                    · latest of {g.files.length}
                                  </span>
                                )}
                              </p>
                            </div>
                            <Button
                              variant="secondary"
                              disabled={opening === latest.id}
                              onClick={() => void open(latest)}
                            >
                              {opening === latest.id ? "Opening…" : "View"}
                            </Button>
                          </div>

                          {earlier.length > 0 && (
                            <ul className="mt-1.5 space-y-1 border-t border-[var(--color-border)] pt-1.5">
                              {earlier.map((f) => (
                                <li
                                  key={f.id}
                                  className="flex items-center justify-between gap-3 text-xs"
                                >
                                  <span className="min-w-0 truncate text-[var(--color-fg-subtle)]">
                                    Earlier upload · {f.filename} ·{" "}
                                    {new Date(f.uploadedAt).toLocaleString(undefined, {
                                      day: "numeric",
                                      month: "short",
                                      hour: "2-digit",
                                      minute: "2-digit",
                                    })}
                                  </span>
                                  <button
                                    type="button"
                                    disabled={opening === f.id}
                                    onClick={() => void open(f)}
                                    className="shrink-0 text-[var(--color-brand-700)] underline underline-offset-2"
                                  >
                                    {opening === f.id ? "Opening…" : "View"}
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * How much of a drug the hospital pharmacy could hand over today.
 *
 * Silent when the lookup has not answered — an absent line is honest, and a "0" printed because a
 * request is still in flight would tell a doctor the pharmacy is empty when it is not.
 */
function Availability({ of }: { of?: MedicineAvailability }) {
  if (!of) return null;

  if (of.units <= 0) {
    return <span className="ml-1.5 font-medium text-[var(--color-danger)]">· out of stock</span>;
  }
  return <span className="ml-1.5 text-[var(--color-fg-subtle)]">· {of.units} in stock</span>;
}

function RxPad({
  encounter,
  drugs,
  allergies,
  onSigned,
}: {
  encounter: Encounter;
  drugs: CatalogueItem[];
  allergies: Allergy[];
  onSigned: () => void;
}) {
  const { api } = useAuth();
  const [lines, setLines] = useState<PrescriptionLineInput[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  /** After a screen finds something, we hold the draft and its alerts here for confirmation. */
  const [review, setReview] = useState<{
    draftId: string;
    alerts: SafetyAlert[];
    blocking: boolean;
  } | null>(null);
  const [override, setOverride] = useState("");

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? drugs.filter((d) => d.name.toLowerCase().includes(q)) : drugs;
  }, [drugs, filter]);

  /**
   * ── WHAT THE PHARMACY COULD ACTUALLY GIVE THIS PATIENT ──────────────────
   * INFORMATION, never permission. Nothing below consumes this to disable a button or refuse a
   * line, and nothing should: a doctor prescribes what the patient needs, and if the hospital is
   * out they buy it outside — the prescription is what they take to the shop. A stock check that
   * could block prescribing would turn an inventory problem into a clinical one.
   *
   * Asked for the whole visible list in ONE request rather than per drug, and re-asked when the
   * filter changes the list. It fails silently on purpose: a prescriber who cannot see stock is
   * mildly worse off, and an error banner over a prescribing pad because an inventory lookup
   * timed out would be far worse than not knowing.
   */
  const [stock, setStock] = useState<Record<string, MedicineAvailability>>({});
  useEffect(() => {
    const codes = shown.map((d) => d.code);
    if (codes.length === 0) return;
    let live = true;
    api
      .medicineAvailability(codes)
      .then((rows) => {
        if (!live) return;
        setStock((prev) => ({ ...prev, ...Object.fromEntries(rows.map((r) => [r.code, r])) }));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api, shown]);

  /**
   * Editing the lines invalidates any pending safety review — it was screened against
   * different drugs. The draft created for that review is discarded so it does not linger
   * as an unsigned orphan.
   */
  function invalidateReview() {
    if (review) {
      void api.discardPrescription(review.draftId).catch(() => undefined);
      setReview(null);
      setOverride("");
    }
  }

  function add(drug: CatalogueItem) {
    invalidateReview();
    setLines((prev) => [
      ...prev,
      {
        drugCode: drug.code,
        drugName: drug.name,
        // Sensible starting points a doctor overrides — never a default that pretends to
        // be a clinical decision. The quantity is the thing the pharmacy counts, so it
        // starts at a number the doctor must look at rather than one they might not.
        dose: "1 unit",
        route: "oral",
        frequency: "BD",
        durationDays: 5,
        quantity: 10,
      },
    ]);
  }

  function update(index: number, patch: Partial<PrescriptionLineInput>) {
    invalidateReview();
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function remove(index: number) {
    invalidateReview();
    setLines((prev) => prev.filter((_, i) => i !== index));
  }

  /**
   * First press: draft the prescription and SCREEN it. If nothing fires, it signs straight
   * away — the check is invisible when there is nothing to say. If something fires, we stop
   * and show it: a contraindication demands a written override, a warning just wants a
   * second look. The screen re-runs server-side at the signature regardless, so this is the
   * doctor's early warning, not the enforcement.
   */
  async function reviewAndSign() {
    setBusy(true);
    setError(null);
    try {
      const rx = await api.createPrescription({ encounterId: encounter.id, lines });
      const screening = await api.screenPrescription(rx.id);

      if (screening.alerts.length === 0) {
        await api.signPrescription(rx.id);
        finish();
        return;
      }
      setReview({ draftId: rx.id, alerts: screening.alerts, blocking: screening.blocking });
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not prepare the prescription.");
    } finally {
      setBusy(false);
    }
  }

  /** Second press: sign the reviewed draft, carrying the override reason if it was blocked. */
  async function confirmSign() {
    if (!review) return;
    if (review.blocking && !override.trim()) {
      setError("A contraindication must be acknowledged with a reason before signing.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.signPrescription(review.draftId, review.blocking ? override.trim() : undefined);
      finish();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not sign the prescription.");
    } finally {
      setBusy(false);
    }
  }

  function cancelReview() {
    if (review) void api.discardPrescription(review.draftId).catch(() => undefined);
    setReview(null);
    setOverride("");
  }

  function finish() {
    setLines([]);
    setReview(null);
    setOverride("");
    onSigned();
  }

  return (
    <div className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}

      <AllergyBanner allergies={allergies} />

      <input
        type="search"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Search drugs…"
        className="w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-1.5 text-sm text-[var(--color-fg)]"
      />

      <div className="flex flex-wrap gap-1.5">
        {shown.map((d) => (
          <button
            key={d.code}
            type="button"
            onClick={() => add(d)}
            className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-2.5 py-1.5 text-xs text-[var(--color-fg)] transition-colors hover:border-[var(--color-brand-500)] hover:bg-[var(--color-brand-50)]"
          >
            {d.name}
            {/*
             * Out of stock is said in WORDS, not by a colour or a disabled button. The drug is
             * still one tap away — this tells the doctor to warn the patient they will be buying
             * it outside, which is the entire point of showing it.
             */}
            <Availability of={stock[d.code]} />
          </button>
        ))}
        {shown.length === 0 && (
          <p className="text-xs text-[var(--color-fg-subtle)]">No drugs match.</p>
        )}
      </div>

      {lines.length > 0 && (
        <div className="space-y-2">
          {lines.map((l, i) => (
            <div
              key={`${l.drugCode}-${String(i)}`}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-2.5"
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-[var(--color-fg)]">{l.drugName}</span>
                <button
                  type="button"
                  onClick={() => remove(i)}
                  className="text-xs text-[var(--color-danger)] hover:underline"
                >
                  Remove
                </button>
              </div>

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                <label className="text-xs text-[var(--color-fg-muted)]">
                  Dose
                  <input
                    value={l.dose}
                    onChange={(e) => update(i, { dose: e.target.value })}
                    className="mt-0.5 w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-1.5 py-1 text-xs text-[var(--color-fg)]"
                  />
                </label>
                <label className="text-xs text-[var(--color-fg-muted)]">
                  Route
                  <select
                    value={l.route}
                    onChange={(e) => update(i, { route: e.target.value as DrugRoute })}
                    className="mt-0.5 w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-1.5 py-1 text-xs text-[var(--color-fg)]"
                  >
                    {DRUG_ROUTES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-xs text-[var(--color-fg-muted)]">
                  Frequency
                  <select
                    value={l.frequency}
                    onChange={(e) => update(i, { frequency: e.target.value as DrugFrequency })}
                    className="mt-0.5 w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-1.5 py-1 text-xs text-[var(--color-fg)]"
                  >
                    {DRUG_FREQUENCIES.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-xs text-[var(--color-fg-muted)]">
                  Days
                  <input
                    type="number"
                    min={1}
                    value={l.durationDays ?? 1}
                    onChange={(e) => update(i, { durationDays: Number(e.target.value) })}
                    className="mt-0.5 w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-1.5 py-1 text-xs text-[var(--color-fg)]"
                  />
                </label>
                <label className="text-xs text-[var(--color-fg-muted)]">
                  Quantity
                  <input
                    type="number"
                    min={1}
                    value={l.quantity}
                    onChange={(e) => update(i, { quantity: Number(e.target.value) })}
                    className="mt-0.5 w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-1.5 py-1 text-xs text-[var(--color-fg)]"
                  />
                </label>
              </div>
            </div>
          ))}

          {!review ? (
            <>
              <Button disabled={busy} onClick={() => void reviewAndSign()}>
                {busy ? "Checking…" : `Sign prescription (${String(lines.length)})`}
              </Button>
              <p className="text-xs text-[var(--color-fg-subtle)]">
                Signing checks the patient&apos;s allergies, then sends it to the pharmacy. After
                that it cannot be edited — changing a dose creates a new version.
              </p>
            </>
          ) : (
            <div className="space-y-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-subtle)] p-3">
              <p className="text-sm font-semibold text-[var(--color-fg)]">
                {review.blocking ? "Safety alert — review before signing" : "Please review"}
              </p>
              <SafetyAlertList alerts={review.alerts} />

              {review.blocking && (
                <label className="block text-xs text-[var(--color-fg-muted)]">
                  Reason for overriding (required — this is recorded on the prescription)
                  <textarea
                    value={override}
                    onChange={(e) => setOverride(e.target.value)}
                    rows={2}
                    placeholder="e.g. prior reaction was a mild childhood rash; benefit outweighs risk, will monitor"
                    className="mt-0.5 w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-2 py-1.5 text-xs text-[var(--color-fg)]"
                  />
                </label>
              )}

              <div className="flex flex-wrap gap-2">
                <Button
                  variant={review.blocking ? "danger" : "primary"}
                  disabled={busy || (review.blocking && !override.trim())}
                  onClick={() => void confirmSign()}
                >
                  {busy ? "Signing…" : review.blocking ? "Override and sign" : "Sign anyway"}
                </Button>
                <Button variant="secondary" disabled={busy} onClick={cancelReview}>
                  Go back
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** What this patient has been put on, and how much of it they have actually been given. */
function PrescriptionsForVisit({
  prescriptions,
  onCancel,
}: {
  prescriptions: Prescription[];
  onCancel: (id: string) => void;
}) {
  if (prescriptions.length === 0) {
    return (
      <p className="text-xs text-[var(--color-fg-subtle)]">Nothing prescribed on this visit.</p>
    );
  }

  return (
    <ul className="space-y-2">
      {prescriptions.map((rx) => (
        <li
          key={rx.id}
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-2.5"
        >
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <Badge tone={rx.status === "dispensed" ? "success" : "neutral"}>
              {rx.status.replace("_", " ")}
            </Badge>
            {rx.version > 1 && <Badge tone="brand">v{rx.version}</Badge>}
            {rx.status === "signed" && (
              <button
                type="button"
                onClick={() => onCancel(rx.id)}
                className="ml-auto text-xs text-[var(--color-danger)] hover:underline"
              >
                Stop
              </button>
            )}
          </div>

          <ul className="space-y-0.5">
            {rx.lines.map((l, i) => (
              <li key={`${l.drugCode}-${String(i)}`} className="text-xs text-[var(--color-fg)]">
                {l.drugName} — {l.dose} {l.route} {l.frequency}
                {l.durationDays ? ` × ${String(l.durationDays)}d` : ""}
                {/*
                 * The gap between what was authorised and what the patient actually has.
                 * This is the whole of `partially_dispensed`, and the doctor is the person
                 * who most needs to know the pharmacy only had six of the ten.
                 */}
                <span className="ml-1.5 text-[var(--color-fg-subtle)]">
                  ({l.dispensedQty}/{l.quantity} given)
                </span>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

/**
 * Admit, or hand over.
 *
 * ── ADMITTING ENDS THIS VISIT AND STARTS ANOTHER ────────────────────────────
 * The wording says so out loud, because the doctor is about to do something irreversible:
 * the OP encounter closes forever and an inpatient one opens in the same care story
 * (ADR-0013 §4). Two encounters can always be read as one timeline; one encounter can
 * never be split back apart once notes, orders and charges have piled onto it.
 *
 * ── THE BED CLASS IS A PRICE, SO THE DOCTOR PICKS IT DELIBERATELY ───────────
 * `General Ward` and `ICU` differ by a factor of eight on the bill. The tariff code is
 * chosen here rather than derived from a ward name, because a hospital that renames a ward
 * must not silently re-price every bed in it.
 */
function AdmitOrTransfer({
  encounter,
  doctors,
  onDone,
}: {
  encounter: Encounter;
  doctors: DoctorRef[];
  onDone: (message: string) => void;
}) {
  const { api, user, can } = useAuth();
  const [mode, setMode] = useState<"none" | "admit" | "transfer">("none");
  // Bed picker (B4): the free beds from the inventory. `null` = not loaded yet.
  const [freeBeds, setFreeBeds] = useState<{ bedId: string; label: string }[] | null>(null);
  const [selectedBedId, setSelectedBedId] = useState("");
  // Legacy free-text fallback, used only when the inventory has no free bed to pick.
  const [ward, setWard] = useState("General Ward");
  const [bedCode, setBedCode] = useState("");
  const [tariffCode, setTariffCode] = useState("BED_GEN");
  const [toDoctor, setToDoctor] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const BEDS = [
    { code: "BED_GEN", ward: "General Ward" },
    { code: "BED_SEMI", ward: "Semi-private Room" },
    { code: "BED_PVT", ward: "Private Room" },
    { code: "BED_ICU", ward: "ICU" },
  ];

  // When the doctor opens the admit panel, load the free beds once. A bed board read is `emr:read`,
  // which the doctor holds. If it fails or the inventory is empty, the panel falls back to manual
  // entry, so a hospital that has not built its bed inventory yet can still admit.
  useEffect(() => {
    if (mode !== "admit" || freeBeds !== null) return;
    void api
      .bedBoard()
      .then((b) => {
        const free = b.wards
          .filter((w) => w.status === "active")
          .flatMap((w) =>
            w.beds
              .filter((bd) => bd.state === "free")
              .map((bd) => ({
                bedId: bd.bedId,
                label: `${w.name} · ${bd.code}${bd.room ? ` (${bd.room})` : ""}`,
              })),
          );
        setFreeBeds(free);
        if (free.length > 0) setSelectedBedId(free[0]!.bedId);
      })
      .catch(() => setFreeBeds([]));
  }, [mode, freeBeds, api]);

  const usePicker = freeBeds !== null && freeBeds.length > 0;

  async function admit() {
    setBusy(true);
    setError(null);
    try {
      const input =
        usePicker && selectedBedId ? { bedId: selectedBedId } : { ward, bedCode, tariffCode };
      await api.admitPatient(encounter.id, input);
      onDone(
        "Admitted. This visit is closed and the stay is on the ward list. Send the patient to reception to pay the admission advance.",
      );
      setMode("none");
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not admit the patient.");
    } finally {
      setBusy(false);
    }
  }

  async function transfer() {
    setBusy(true);
    setError(null);
    try {
      await api.transferDoctor(encounter.id, toDoctor, reason);
      onDone("Handed over. The patient is on their list now.");
      setMode("none");
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not transfer the patient.");
    } finally {
      setBusy(false);
    }
  }

  const others = doctors.filter((d) => d.id !== (user?.id ?? ""));

  return (
    <div className="space-y-3">
      {error && <Alert tone="danger">{error}</Alert>}

      {mode === "none" && (
        <div className="flex flex-wrap gap-2">
          <PermissionGate can={can} permission="admission:create">
            <Button variant="secondary" onClick={() => setMode("admit")}>
              Admit to a bed
            </Button>
          </PermissionGate>
          <PermissionGate can={can} permission="encounter:update">
            <Button variant="secondary" onClick={() => setMode("transfer")}>
              Transfer to another doctor
            </Button>
          </PermissionGate>
        </div>
      )}

      {mode === "admit" && (
        <div className="space-y-2">
          {freeBeds === null ? (
            <p className="text-xs text-[var(--color-fg-subtle)]">Finding free beds…</p>
          ) : usePicker ? (
            <label className="block text-xs text-[var(--color-fg-muted)]">
              Free bed
              <select
                value={selectedBedId}
                onChange={(e) => setSelectedBedId(e.target.value)}
                className="mt-0.5 w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-2 py-1.5 text-sm text-[var(--color-fg)]"
              >
                {freeBeds.map((b) => (
                  <option key={b.bedId} value={b.bedId}>
                    {b.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <>
              <p className="text-xs text-[var(--color-fg-subtle)]">
                No free bed in the inventory — enter the bed manually. (Configure wards and beds on
                the Bed board to pick from a list.)
              </p>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-xs text-[var(--color-fg-muted)]">
                  Bed class
                  <select
                    value={tariffCode}
                    onChange={(e) => {
                      const bed = BEDS.find((b) => b.code === e.target.value);
                      setTariffCode(e.target.value);
                      if (bed) setWard(bed.ward);
                    }}
                    className="mt-0.5 w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-2 py-1.5 text-sm text-[var(--color-fg)]"
                  >
                    {BEDS.map((b) => (
                      <option key={b.code} value={b.code}>
                        {b.ward}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-xs text-[var(--color-fg-muted)]">
                  Bed number
                  <input
                    value={bedCode}
                    onChange={(e) => setBedCode(e.target.value)}
                    placeholder="A-12"
                    className="mt-0.5 w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-2 py-1.5 text-sm text-[var(--color-fg)]"
                  />
                </label>
              </div>
            </>
          )}
          <p className="text-xs text-[var(--color-fg-subtle)]">
            Admitting CLOSES this visit and opens an inpatient stay in the same care story. The bed
            is billed for every day the patient is here, starting today.
          </p>
          <div className="flex gap-2">
            <Button
              disabled={
                busy || (usePicker ? selectedBedId.length === 0 : bedCode.trim().length === 0)
              }
              onClick={() => void admit()}
            >
              {busy ? "Admitting…" : "Admit"}
            </Button>
            <Button variant="secondary" onClick={() => setMode("none")}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {mode === "transfer" && (
        <div className="space-y-2">
          <label className="block text-xs text-[var(--color-fg-muted)]">
            To
            <select
              value={toDoctor}
              onChange={(e) => setToDoctor(e.target.value)}
              className="mt-0.5 w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-2 py-1.5 text-sm text-[var(--color-fg)]"
            >
              <option value="">Choose a doctor…</option>
              {others.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs text-[var(--color-fg-muted)]">
            Why (the receiving doctor sees this)
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="needs a surgical opinion"
              className="mt-0.5 w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-2 py-1.5 text-sm text-[var(--color-fg)]"
            />
          </label>
          {/* The reason is the handover note, and it is the only thing the receiving
              doctor has to go on. The server refuses a transfer without one. */}
          <div className="flex gap-2">
            <Button
              disabled={busy || !toDoctor || reason.trim().length < 3}
              onClick={() => void transfer()}
            >
              {busy ? "Transferring…" : "Transfer"}
            </Button>
            <Button variant="secondary" onClick={() => setMode("none")}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function MyPatients() {
  const { api, user, can } = useAuth();

  /**
   * The queue, and it NAMES its patients (D18).
   *
   * This page used to hold a second list — `listPatients({ limit: 100 })` — and match `patientId`
   * against it. The two lists are different populations: this one is everybody queued for this
   * doctor, that one was the hundred most recent REGISTRATIONS. 15 of 99 rows on the demo hospital
   * fell outside it and rendered "—", with no error and no empty state. `EncounterRow` carries the
   * identity the server already had, so there is nothing left to reconcile.
   */
  const [waiting, setWaiting] = useState<EncounterRow[]>([]);
  /** How many queued patients did not fit on the page this screen asked for — see `load`. */
  const [beyondPage, setBeyondPage] = useState(0);
  const [services, setServices] = useState<CatalogueItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [prescriptions, setPrescriptions] = useState<Prescription[]>([]);
  const [allergies, setAllergies] = useState<Allergy[]>([]);
  const [vitals, setVitals] = useState<VitalsReading[]>([]);
  const [reports, setReports] = useState<ReportMeta[]>([]);
  const [procedures, setProcedures] = useState<OtBooking[]>([]);
  const [doctors, setDoctors] = useState<DoctorRef[]>([]);

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    /**
     * The CATALOGUE, not the tariff. Same collection on the server, price stripped —
     * a doctor sees what can be ordered and never what it costs, so a patient's means
     * cannot shape what they are offered (billing.routes.ts).
     */
    void api
      .listCatalogue()
      .then(setServices)
      .catch(() => undefined);

    // Who a patient can be handed to. Names only, gated on `encounter:read` — the front
    // desk and every clinician hold it, and none of them get a personnel file for it.
    void api
      .listDoctors()
      .then(setDoctors)
      .catch(() => undefined);
  }, [api]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      /**
       * Everyone queued for THIS doctor — filtered by the SERVER.
       *
       * This used to fetch the whole queue and filter in the browser, with an
       * `|| !e.doctorId` fallback that quietly showed every unassigned patient to
       * every doctor: two doctors would each have believed the same patient was
       * theirs. Filtering here means the wrong rows never leave the database.
       *
       * `queued=true` is in_queue + in_progress + awaiting_results, in token order —
       * arrival order, the only order a waiting room accepts as fair.
       */
      if (!user?.id) return;
      const page = await api.listEncounters({ queued: true, doctorId: user.id, limit: 100 });
      setWaiting(page.items);
      /**
       * ── A CAP THAT TRUNCATES MUST SAY SO (D18) ──────────────────────────
       * 100 is the server's ceiling on every list, and this asks for one page. A queue longer
       * than that is unusual — but "unusual" was also the reasoning that let a capped join
       * silently dash 15 of 99 rows, and this truncation is the same shape: the tail of the
       * waiting room simply is not on screen, and nothing said so. Found by an E2E patient who
       * was genuinely in the queue at position 104 and could not be found on the page.
       *
       * Deliberately NOT a bigger limit: the rows are in TOKEN order, so the hundred shown are
       * the hundred who arrived first, which is the right hundred to work through. What was
       * missing was the sentence admitting there are more.
       */
      setBeyondPage(Math.max(0, (page.meta.total ?? page.items.length) - page.items.length));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not load your list.");
    } finally {
      setLoading(false);
    }
  }, [api, user?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadOrders = useCallback(
    (encounterId: string) => {
      void api
        .listOrders({ encounterId, limit: 50 })
        .then((page) => setOrders(page.items))
        .catch(() => setOrders([]));
    },
    [api],
  );

  /** `current: true` — a chart shows what is in force, not the versions it replaced. */
  const loadPrescriptions = useCallback(
    (encounterId: string) => {
      void api
        .listPrescriptions({ encounterId, current: true, limit: 50 })
        .then(setPrescriptions)
        .catch(() => setPrescriptions([]));
    },
    [api],
  );

  /** Allergies are the PATIENT'S, not the visit's — keyed on patientId, read hospital-wide. */
  const loadAllergies = useCallback(
    (patientId: string) => {
      void api
        .listAllergies(patientId)
        .then(setAllergies)
        .catch(() => setAllergies([]));
    },
    [api],
  );

  /** This VISIT's observations — what the nurse charted before the patient came in. */
  const loadVitals = useCallback(
    (encounterId: string) => {
      void api
        .listEncounterVitals(encounterId)
        .then(setVitals)
        .catch(() => setVitals([]));
    },
    [api],
  );

  /**
   * Every operation this patient has ever had — no date window, so a hernia repair from two years
   * ago is still on the chart. A hospital that does not carry surgery (no OT module) answers 403,
   * which is an empty section here rather than an error: the doctor did not ask a wrong question.
   */
  const loadProcedures = useCallback(
    (patientId: string) => {
      void api
        .listOtBookings({ patientId })
        .then(setProcedures)
        .catch(() => setProcedures([]));
    },
    [api],
  );

  /** Reports too are the PATIENT'S — every visit, so the doctor sees prior results. */
  const loadReports = useCallback(
    (patientId: string) => {
      void api
        .listReports(patientId)
        .then(setReports)
        .catch(() => setReports([]));
    },
    [api],
  );

  const selected = waiting.find((e) => e.id === selectedId) ?? null;
  const selectedPatientId = selected?.patientId ?? null;
  // The consultation has actually started — the patient was CALLED IN. Ordering tests and
  // prescribing are held until then: you do not investigate or medicate someone still in the queue.
  const consulting = !!selected && ["in_progress", "awaiting_results"].includes(selected.status);
  // Live tests on this visit (a cancelled order no longer counts). "Send for tests" needs at least
  // one — parking a patient in the lab queue with nothing ordered strands them there.
  const activeOrders = orders.filter((o) => o.status !== "cancelled");

  useEffect(() => {
    if (selectedId) {
      loadOrders(selectedId);
      loadPrescriptions(selectedId);
      loadVitals(selectedId);
    }
  }, [selectedId, loadOrders, loadPrescriptions, loadVitals]);

  useEffect(() => {
    if (selectedPatientId) {
      loadAllergies(selectedPatientId);
      loadReports(selectedPatientId);
      loadProcedures(selectedPatientId);
    }
  }, [selectedPatientId, loadAllergies, loadReports, loadProcedures]);

  async function act(action: string) {
    if (!selected) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (action === "start") await api.startEncounterConsultation(selected.id);
      if (action === "investigations") {
        await api.sendForInvestigations(selected.id);
        setNotice(
          "Sent for tests. They keep this visit — when every result is back they return to your list automatically.",
        );
      }
      if (action === "close") {
        await api.closeEncounter(selected.id);
        setNotice("Visit closed.");
        setSelectedId(null);
      }
      await load();
      if (selectedId) loadOrders(selectedId);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not update the visit.");
    } finally {
      setBusy(false);
    }
  }

  /** The pharmacy half of the same price-free catalogue the order pad reads. */
  const drugs = useMemo(() => services.filter((s) => s.category === "pharmacy"), [services]);

  async function stopPrescription(id: string) {
    setError(null);
    try {
      await api.cancelPrescription(id, "stopped by the prescriber");
      setNotice("Prescription stopped. Anything already dispensed stays on the record.");
      if (selectedId) loadPrescriptions(selectedId);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not stop the prescription.");
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-[var(--color-fg)]">My patients</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Everyone waiting, in token order. Click a patient to consult.
        </p>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        {/* ── the waiting list ── */}
        <Card className="p-4">
          <h2 className="mb-1 text-sm font-semibold text-[var(--color-fg)]">
            Waiting ({waiting.length})
          </h2>
          {beyondPage > 0 && (
            <p className="mb-3 text-xs text-[var(--color-warning)]">
              {beyondPage} more {beyondPage === 1 ? "patient is" : "patients are"} queued beyond
              this page. These are the first 100 by token — the earliest arrivals.
            </p>
          )}

          {loading ? (
            <p className="py-6 text-center text-sm text-[var(--color-fg-subtle)]">Loading…</p>
          ) : waiting.length === 0 ? (
            <p className="py-6 text-center text-sm text-[var(--color-fg-subtle)]">
              Nobody is waiting.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {waiting.map((e) => (
                <li key={e.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(e.id)}
                    className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
                      selectedId === e.id
                        ? "border-[var(--color-brand-500)] bg-[var(--color-brand-50)]"
                        : "border-[var(--color-border)] hover:bg-[var(--color-bg-subtle)]"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      {e.token && (
                        <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded bg-[var(--color-brand-600)] font-mono text-xs font-semibold text-[var(--color-on-accent)]">
                          {e.token}
                        </span>
                      )}
                      <span className="truncate text-sm text-[var(--color-fg)]">
                        {e.patientName}
                      </span>
                      {e.express && (
                        <span className="ml-auto shrink-0 rounded-full bg-[var(--color-warning-bg)] px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-[var(--color-warning)] uppercase">
                          Express
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <Badge
                        tone={
                          e.status === "awaiting_results"
                            ? "neutral"
                            : e.status === "in_progress"
                              ? "brand"
                              : "neutral"
                        }
                      >
                        {e.status.replace(/_/g, " ")}
                      </Badge>
                      <span className="text-xs text-[var(--color-fg-subtle)]">
                        {time(e.arrivedAt)}
                      </span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* ── the consultation ── */}
        <div className="space-y-4">
          {!selected ? (
            <Card className="p-10">
              <p className="text-center text-sm text-[var(--color-fg-subtle)]">
                Choose a patient from the waiting list.
              </p>
            </Card>
          ) : (
            <>
              <Card className="p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold text-[var(--color-fg)]">
                      {selected.patientName}
                    </h2>
                    <p className="mt-0.5 font-mono text-xs text-[var(--color-fg-muted)]">
                      {selected.uhid}
                    </p>
                    {selected.reason && (
                      <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
                        Reason: {selected.reason}
                      </p>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {/* Derived from §14 — a button that 422s should not be drawn. */}
                    {selected.status === "in_queue" && can("encounter:update") && (
                      <Button disabled={busy} onClick={() => void act("start")}>
                        Call in
                      </Button>
                    )}
                    {selected.status === "in_progress" && can("encounter:update") && (
                      <Button
                        variant="secondary"
                        disabled={busy || activeOrders.length === 0}
                        title={
                          activeOrders.length === 0
                            ? "Order at least one test below first"
                            : undefined
                        }
                        onClick={() => void act("investigations")}
                      >
                        Send for tests
                      </Button>
                    )}
                    {["in_progress", "awaiting_results"].includes(selected.status) &&
                      can("encounter:close") && (
                        <Button
                          variant="secondary"
                          disabled={busy}
                          onClick={() => void act("close")}
                        >
                          Close visit
                        </Button>
                      )}
                    {/* The take-home OPD slip — a clean printable sheet. Same tab so the signed-in
                        (per-tab, in dev) session is present; the slip has its own Back button. */}
                    <a
                      href={`/opd-slip/${selected.id}`}
                      className="inline-flex items-center rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm font-medium text-[var(--color-fg)] transition-colors hover:border-[var(--color-brand-500)]"
                    >
                      OPD slip →
                    </a>
                  </div>

                  {selected.status === "in_progress" && (
                    <p className="text-xs text-[var(--color-fg-muted)]">
                      {activeOrders.length === 0 ? (
                        <>
                          Order the tests below first. <em>Send for tests</em> then moves the
                          patient to the lab to wait for results — you can keep adding tests until
                          they go to pay.
                        </>
                      ) : (
                        <>
                          {activeOrders.length} test{activeOrders.length === 1 ? "" : "s"} ordered
                          on this visit. Add more if needed, then <em>Send for tests</em> to send
                          the patient to wait for results.
                        </>
                      )}
                    </p>
                  )}
                </div>

                <AdmitOrTransfer
                  encounter={selected}
                  doctors={doctors}
                  onDone={(message) => {
                    setNotice(message);
                    setSelectedId(null);
                    void load();
                  }}
                />

                {selected.status === "awaiting_results" && (
                  <Alert tone="info">
                    At the lab. They keep this visit — when the last result is released they come
                    back to your list on their own. You can still order more tests below if you need
                    to.
                  </Alert>
                )}
              </Card>

              {/*
               * Observations come FIRST, and outside the "called in" gate. A nurse charts them
               * while the patient waits, and an abnormal set is exactly what should make a doctor
               * call someone in ahead of their turn — so the doctor must be able to see them
               * before the consultation starts, not after.
               */}
              <PermissionGate can={can} permission="emr:read">
                <CollapsibleCard
                  title="Vitals"
                  count={vitals.length}
                  defaultOpen={vitals.some((v) => v.abnormal)}
                >
                  <VitalsPanel
                    api={api}
                    encounterId={selected.id}
                    readings={vitals}
                    canRecord={can("vitals:record")}
                    onSaved={() => loadVitals(selected.id)}
                    emptyHint="No observations charted for this visit yet."
                    {...(user?.id ? { recordedBy: user.id } : {})}
                  />
                </CollapsibleCard>
              </PermissionGate>

              {/*
               * ── CALL IN BEFORE YOU ORDER OR PRESCRIBE ───────────────────────────────
               * A patient still in the queue has not been seen. Ordering their bloods or
               * prescribing them a drug before the consultation has started is acting on a
               * patient the doctor has not called in — so the pads are held until "Call in".
               */}
              {!consulting ? (
                <Card className="p-5">
                  <p className="text-sm text-[var(--color-fg-muted)]">
                    <strong className="text-[var(--color-fg)]">
                      Call the patient in to begin.
                    </strong>{" "}
                    Ordering tests and prescribing open once the consultation has started — press{" "}
                    <em>Call in</em> above.
                  </p>
                </Card>
              ) : (
                <>
                  <PermissionGate can={can} permission="order:create">
                    <CollapsibleCard
                      title="Order"
                      defaultOpen={["in_progress", "awaiting_results"].includes(selected.status)}
                    >
                      <p className="mb-4 text-xs text-[var(--color-fg-muted)]">
                        Each test reaches its department&apos;s worklist the moment you order it.
                        Order as many as you need — <em>Send for tests</em> above then sends the
                        patient to wait for the results.
                      </p>
                      <OrderPad
                        encounter={selected}
                        services={services}
                        onOrdered={() => loadOrders(selected.id)}
                      />
                    </CollapsibleCard>
                  </PermissionGate>

                  <PermissionGate can={can} permission="prescription:sign">
                    <CollapsibleCard
                      title="Prescribe"
                      defaultOpen={selected.status === "in_progress"}
                    >
                      <p className="mb-4 text-xs text-[var(--color-fg-muted)]">
                        Signing puts it on the pharmacy counter immediately. Nothing is charged
                        until the drugs are actually handed over.
                      </p>
                      <RxPad
                        encounter={selected}
                        drugs={drugs}
                        allergies={allergies}
                        onSigned={() => {
                          setNotice("Prescription signed — it is on the pharmacy counter now.");
                          loadPrescriptions(selected.id);
                        }}
                      />
                    </CollapsibleCard>
                  </PermissionGate>

                  <PermissionGate can={can} permission="emr:write">
                    <CollapsibleCard title="Consultation note" defaultOpen={false}>
                      <p className="mb-3 text-xs text-[var(--color-fg-muted)]">
                        The structured record of the visit. The final diagnoses and plan are what
                        print on the patient&apos;s OPD slip.
                      </p>
                      <ConsultationNoteEditor
                        encounter={selected}
                        onSaved={() => {
                          setNotice("Consultation note saved — the OPD slip reflects it.");
                          void load();
                        }}
                      />
                    </CollapsibleCard>
                  </PermissionGate>
                </>
              )}

              <PermissionGate can={can} permission="allergy:read">
                <CollapsibleCard title="Allergies" count={allergies.length} defaultOpen={false}>
                  <p className="mb-4 text-xs text-[var(--color-fg-muted)]">
                    Recorded against the patient, seen at every branch. The prescribing check
                    screens against this list.
                  </p>
                  <AllergyPanel
                    patientId={selected.patientId}
                    allergies={allergies}
                    canManage={can("allergy:manage")}
                    onChange={() => loadAllergies(selected.patientId)}
                  />
                </CollapsibleCard>
              </PermissionGate>

              <CollapsibleCard
                title="Prescribed on this visit"
                count={prescriptions.length}
                defaultOpen={false}
              >
                <PrescriptionsForVisit
                  prescriptions={prescriptions}
                  onCancel={(id) => void stopPrescription(id)}
                />
              </CollapsibleCard>

              <CollapsibleCard
                title="Ordered on this visit"
                count={orders.length}
                defaultOpen={false}
              >
                <OrdersForVisit orders={orders} />
              </CollapsibleCard>

              {/*
               * ── SURGICAL HISTORY, NOT THIS VISIT'S ──────────────────────────────────
               * Rendered only when the patient HAS been operated on. An always-visible "no
               * procedures" panel on the 95% of patients who have never seen a theatre is noise
               * on the screen a doctor reads under time pressure, and noise is what makes the
               * one patient who does have a surgical history stop standing out.
               */}
              {procedures.length > 0 && (
                <CollapsibleCard title="Procedures" count={procedures.length} defaultOpen={false}>
                  <ProceduresForPatient bookings={procedures} doctors={doctors} />
                </CollapsibleCard>
              )}

              <Card className="p-5">
                <h3 className="mb-1 text-sm font-semibold text-[var(--color-fg)]">Reports</h3>
                <p className="mb-3 text-xs text-[var(--color-fg-muted)]">
                  Every uploaded report for this patient, newest visit first — including previous
                  appointments.
                </p>
                <PatientReports reports={reports} />
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * A titled card that folds away to save vertical space — the consult panel stacks a lot of sections,
 * and once a patient is at the lab the doctor wants the finished ones out of the way. Self-manages
 * its open state; the count sits in the header so a folded section still tells you how much is inside.
 */
/**
 * The patient's operations, newest first, each with its record when the surgeon has written one.
 *
 * A booking with NO record still appears. Hiding it would answer "has this patient had surgery?"
 * with "only the surgery somebody wrote up", and an operation nobody documented is exactly the one
 * a doctor needs to know happened.
 */
function ProceduresForPatient({
  bookings,
  doctors,
}: {
  bookings: OtBooking[];
  doctors: DoctorRef[];
}) {
  const newestFirst = [...bookings].sort((a, b) =>
    b.scheduledStart.localeCompare(a.scheduledStart),
  );
  return (
    <ul className="divide-y divide-[var(--color-border)]">
      {newestFirst.map((b) => (
        <li key={b.id} className="py-3 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium text-[var(--color-fg)]">
              {b.operativeNote?.procedurePerformed ?? b.procedureName}
            </span>
            <span className="flex items-center gap-2">
              <span className="text-xs text-[var(--color-fg-muted)]">
                {dayLabel(b.scheduledStart)}
              </span>
              <Badge tone={b.status === "completed" ? "success" : "neutral"}>
                {b.status.replace("_", " ")}
              </Badge>
            </span>
          </div>
          <p className="mt-0.5 text-xs text-[var(--color-fg-muted)]">{b.theatreName}</p>
          {b.operativeNote ? (
            <div className="mt-3 rounded-lg border border-[var(--color-border)] p-3">
              <OperativeNoteDetail
                note={b.operativeNote}
                surgeonName={doctors.find((d) => d.id === b.operativeNote?.surgeonId)?.name}
              />
            </div>
          ) : (
            <p className="mt-2 text-xs text-[var(--color-fg-subtle)]">
              No operation record written yet.
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

function CollapsibleCard({
  title,
  count,
  defaultOpen = true,
  children,
}: {
  title: string;
  count?: number;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Card className="p-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 px-5 py-4 text-left"
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-[var(--color-fg)]">
          {title}
          {count !== undefined && count > 0 && (
            <span className="rounded-full bg-[var(--color-bg-subtle)] px-1.5 py-0.5 text-xs font-normal text-[var(--color-fg-muted)]">
              {count}
            </span>
          )}
        </span>
        <span className="text-[var(--color-fg-subtle)]">{open ? "▾" : "▸"}</span>
      </button>
      {open && <div className="px-5 pb-5">{children}</div>}
    </Card>
  );
}

/**
 * The structured consultation note (D3 / EMR depth) — chief complaint, history, examination, the
 * typed diagnoses and the plan. The OPD slip's diagnosis/advice lines are DERIVED from it on the
 * server, so the doctor writes the record once. Seeds from the saved note and re-seeds when the
 * doctor switches patients.
 */
const noteArea =
  "mt-0.5 w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm text-[var(--color-fg)]";

type DxRow = { text: string; code: string; type: DiagnosisType };

function ConsultationNoteEditor({
  encounter,
  onSaved,
}: {
  encounter: Encounter;
  onSaved: () => void;
}) {
  const { api } = useAuth();
  const [chiefComplaint, setChiefComplaint] = useState("");
  const [history, setHistory] = useState("");
  const [examination, setExamination] = useState("");
  const [diagnoses, setDiagnoses] = useState<DxRow[]>([]);
  /**
   * The diagnoses AS THE SERVER HOLDS THEM. Separate from the edit buffer above because promotion
   * is by index into the SAVED note — offering it against unsaved rows would promote whatever
   * happens to sit at that index on the server, which is a different condition the moment the
   * doctor adds a line and has not pressed save.
   */
  const [savedDiagnoses, setSavedDiagnoses] = useState<Diagnosis[]>([]);
  const [plan, setPlan] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the saved note for this visit; reset when the doctor moves to another patient.
  useEffect(() => {
    let live = true;
    api
      .getConsultation(encounter.id)
      .then((n) => {
        if (!live) return;
        setChiefComplaint(n?.chiefComplaint ?? "");
        setHistory(n?.history ?? "");
        setExamination(n?.examination ?? "");
        setDiagnoses(
          (n?.diagnoses ?? []).map((d) => ({ text: d.text, code: d.code ?? "", type: d.type })),
        );
        setSavedDiagnoses(n?.diagnoses ?? []);
        setPlan(n?.plan ?? "");
        setFollowUp(n?.followUpDays != null ? String(n.followUpDays) : "");
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api, encounter.id]);

  function setDx(i: number, patch: Partial<DxRow>) {
    setDiagnoses((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const saved = await api.saveConsultation(encounter.id, {
        chiefComplaint,
        history,
        examination,
        diagnoses: diagnoses
          .filter((d) => d.text.trim())
          .map((d) => ({
            text: d.text.trim(),
            type: d.type,
            ...(d.code.trim() ? { code: d.code.trim() } : {}),
          })),
        plan,
        ...(followUp.trim() ? { followUpDays: Number(followUp) } : { followUpDays: 0 }),
      });
      // What the server now holds — the only diagnoses a promotion may be offered against.
      setSavedDiagnoses(saved.diagnoses);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not save the note.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {error && <Alert tone="danger">{error}</Alert>}

      <label className="block text-xs text-[var(--color-fg-muted)]">
        Chief complaint
        <textarea
          value={chiefComplaint}
          onChange={(e) => setChiefComplaint(e.target.value)}
          rows={2}
          placeholder="What brought the patient in…"
          className={noteArea}
        />
      </label>
      <label className="block text-xs text-[var(--color-fg-muted)]">
        History
        <textarea
          value={history}
          onChange={(e) => setHistory(e.target.value)}
          rows={2}
          placeholder="History of the presenting illness…"
          className={noteArea}
        />
      </label>
      <label className="block text-xs text-[var(--color-fg-muted)]">
        Examination
        <textarea
          value={examination}
          onChange={(e) => setExamination(e.target.value)}
          rows={2}
          placeholder="Findings on examination…"
          className={noteArea}
        />
      </label>

      {/* Diagnoses — a typed list, not a comma string. */}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs text-[var(--color-fg-muted)]">Diagnoses</span>
          <button
            type="button"
            className="text-xs text-[var(--color-brand-600)] hover:underline"
            onClick={() => setDiagnoses((r) => [...r, { text: "", code: "", type: "provisional" }])}
          >
            + Add diagnosis
          </button>
        </div>
        {diagnoses.length === 0 ? (
          <p className="text-xs text-[var(--color-fg-subtle)]">None recorded.</p>
        ) : (
          <div className="space-y-1.5">
            {diagnoses.map((d, i) => (
              <div key={i} className="flex flex-wrap items-center gap-1.5">
                <input
                  value={d.text}
                  onChange={(e) => setDx(i, { text: e.target.value })}
                  placeholder="Condition"
                  className="min-w-40 flex-1 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-1.5 text-sm"
                />
                <input
                  value={d.code}
                  onChange={(e) => setDx(i, { code: e.target.value.toUpperCase() })}
                  placeholder="ICD"
                  className="w-24 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-1.5 font-mono text-xs"
                />
                <select
                  value={d.type}
                  onChange={(e) => setDx(i, { type: e.target.value as DiagnosisType })}
                  className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-2 py-1.5 text-xs"
                >
                  <option value="provisional">Provisional</option>
                  <option value="final">Final</option>
                </select>
                <button
                  type="button"
                  className="text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-danger)]"
                  onClick={() => setDiagnoses((r) => r.filter((_, idx) => idx !== i))}
                  aria-label="Remove diagnosis"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <label className="block text-xs text-[var(--color-fg-muted)]">
        Plan &amp; advice
        <textarea
          value={plan}
          onChange={(e) => setPlan(e.target.value)}
          rows={2}
          placeholder="Investigations, medication, rest, diet…"
          className={noteArea}
        />
      </label>
      <label className="block text-xs text-[var(--color-fg-muted)]">
        Follow-up in (days)
        <input
          type="number"
          value={followUp}
          onChange={(e) => setFollowUp(e.target.value)}
          placeholder="e.g. 7"
          className={`${noteArea} max-w-32`}
        />
      </label>

      <Button disabled={busy} onClick={() => void save()}>
        {busy ? "Saving…" : "Save note"}
      </Button>

      {/**
       * The patient's longitudinal problem list, beneath the note that feeds it. Here rather than
       * only on the chart because this is where the decision is made: the doctor has just written
       * "Type 2 diabetes" as a diagnosis for THIS visit, and whether it belongs on the patient's
       * standing list is a judgement they make in the same breath — not one they will come back
       * for from another screen.
       */}
      <div className="mt-4 border-t border-[var(--color-border)] pt-3">
        <ProblemPanel
          api={api}
          patientId={encounter.patientId}
          canWrite
          promoteFrom={{ encounterId: encounter.id, diagnoses: savedDiagnoses }}
        />
      </div>
    </div>
  );
}

export default function MyPatientsPage() {
  return <MyPatients />;
}
