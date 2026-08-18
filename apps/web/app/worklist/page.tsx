"use client";

/**
 * Lab & imaging worklist (ADR-0013 §3, STATE_MACHINE_CATALOG §15).
 *
 * ── THIS LIST IS A QUERY, NOT AN INBOX ───────────────────────────────────────
 * Nothing was sent here. No hand-off ran, nobody pressed "transmit to lab", and there
 * is no chit. The doctor's order committed and this list is `?category=lab&outstanding=true`
 * over the same rows — so the work is here the instant it exists. That is the whole of
 * "orders appear automatically in the destination department", and the absence of a
 * hand-off step is precisely why there is no hand-off step to forget.
 *
 * ── SICKEST FIRST, THEN OLDEST ───────────────────────────────────────────────
 * The server sorts by `priorityRank` before `orderedAt`. A list sorted purely by time
 * is one where the emergency troponin waits behind the routine cholesterol.
 *
 * ── THE TWO-PERSON RULE IS VISIBLE HERE ──────────────────────────────────────
 * A technician can accept, run, and record a result. They CANNOT verify it — the
 * button does not appear, and the server would refuse it anyway. Verifying needs
 * authority over the category: a pathologist may sign off blood, a radiologist may
 * sign off a scan, and neither may sign the other's (order.authority.ts).
 *
 * ── THE UNIT OF WORK IS A PATIENT, NOT AN ORDER ──────────────────────────────
 * This used to be one flat list of every outstanding order in the department, which is
 * not how the bench actually works: one person walks up, one draw is taken, and four
 * tests come off it. A flat list scattered those four rows among everybody else's, so the
 * technician re-found the same patient four times and — reported in manual testing —
 * could not tell whose sample was whose at all. Orders are therefore GROUPED by patient
 * and the queue lists people; selecting one opens everything ordered for them.
 *
 * The group order is not re-sorted. Groups appear in the order their FIRST order appears
 * in the server's list, which is already sickest-first then oldest — so the emergency
 * troponin still pulls its patient to the top, and the sort rule lives in exactly one
 * place (the server) rather than being re-implemented, slightly differently, here.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiClientError,
  type OrderRow,
  type OrderCategory,
  type OrderPriority,
  type OrderResultValue,
  type Analyte,
  type ReportMeta,
} from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  ErrorAlert,
  PermissionGate,
} from "../../components/ui";
import { rupees } from "../../lib/money";
import { groupByPatient, waited } from "../../lib/worklist";
import { isHeldForPayment, type PaymentState } from "../../lib/payment";

/** Per-order settle-from-advance info for admitted patients. */
interface Settlement {
  admitted: boolean;
  advanceBalance: number;
  amount: number;
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function priorityTone(p: OrderPriority): "danger" | "brand" | "neutral" {
  if (p === "emergency" || p === "stat") return "danger";
  if (p === "urgent") return "brand";
  return "neutral";
}

/**
 * PAID / UNPAID for the test in front of the technician.
 *
 * ── THIS BADGE IS A LABEL; THE HOLD IS FORTY LINES BELOW ────────────────────
 * This comment used to read "Advisory, not a gate: an unpaid emergency still gets run" — and that
 * was not true of this page. `unpaid` on a `placed`/`accepted`/`in_progress` order replaces the
 * action buttons with "Awaiting payment", with no exemption for `stat` or `emergency`. The badge is
 * advisory; the BUTTONS are gated, and describing the file by its badge hid the actual rule.
 *
 * What genuinely does proceed: `paid`, `free` (a zero-tariff government patient, never shown as
 * "unpaid" and turned away), `unbilled` (no charge raised yet), an admitted patient settling from
 * their advance, and cancel. The API itself gates nothing — the order state machine has no payment
 * check — so this hold is a WEB policy, not a system invariant. See `AI_Workflow/docs/PAYMENT_POLICY.md`.
 *
 * Absent (no data) renders nothing rather than a misleading "unpaid".
 */
function PaymentBadge({ state }: { state?: PaymentState }) {
  if (!state) return null;
  if (state === "paid") return <Badge tone="success">paid</Badge>;
  if (state === "free") return <Badge tone="neutral">no charge</Badge>;
  if (state === "unbilled") return <Badge tone="neutral">not billed</Badge>;
  return <Badge tone="danger">unpaid</Badge>;
}

const DEPARTMENTS: { label: string; category: OrderCategory }[] = [
  { label: "Blood & lab", category: "lab" },
  { label: "X-ray & imaging", category: "radiology" },
  { label: "Procedures", category: "procedure" },
];

/**
 * Recording a result.
 *
 * ── `critical` IS NOT A STYLING CHOICE ───────────────────────────────────────
 * Ticking it sends an alert to the ordering doctor SYNCHRONOUSLY — before this
 * request returns, before a pathologist has verified anything, and without going
 * near the queue. A potassium of 7.2 stops the heart and does not wait for anyone
 * to come back from lunch. The checkbox is deliberately blunt and deliberately
 * frightening, because so is the number.
 */
/** Auto-flag a typed value against an analyte's numeric bounds — the machine's half of the range. */
function flagAgainst(raw: string, a?: Analyte): string | undefined {
  if (!a || (a.refLow == null && a.refHigh == null)) return undefined;
  const n = parseFloat(raw);
  if (Number.isNaN(n)) return undefined;
  if (a.refLow != null && n < a.refLow) return "low";
  if (a.refHigh != null && n > a.refHigh) return "high";
  return "normal";
}

const FLAG_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  normal: "success",
  low: "warning",
  high: "warning",
  critical_low: "danger",
  critical_high: "danger",
};

function ResultForm({ order, onDone }: { order: OrderRow; onDone: () => void }) {
  const { api } = useAuth();
  const [summary, setSummary] = useState("");
  const [critical, setCritical] = useState(false);
  const [values, setValues] = useState<OrderResultValue[]>([
    { code: "", label: "", value: "", unit: "" },
  ]);
  const [analytes, setAnalytes] = useState<Analyte[]>([]);
  const [specimen, setSpecimen] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Look the order's test up in the catalogue (D6). When it is defined, pre-fill the analyte grid
  // and reference ranges so the technician enters values, not paperwork — and the ranges are the
  // ones the lab agreed, not typed from memory.
  useEffect(() => {
    let live = true;
    api
      .getLabTest(order.code)
      .then((test) => {
        if (!live || test.analytes.length === 0) return;
        setAnalytes(test.analytes);
        setSpecimen(test.specimenType);
        setValues(
          test.analytes.map((a) => ({
            code: a.code,
            label: a.label,
            value: "",
            unit: a.unit ?? "",
            ...(a.refText ? { referenceRange: a.refText } : {}),
          })),
        );
      })
      .catch(() => undefined); // No catalogue entry — the manual grid stays.
    return () => {
      live = false;
    };
  }, [api, order.code]);

  function setValue(i: number, patch: Partial<OrderResultValue>) {
    setValues((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const filled = values.filter((v) => v.label && v.value);
      await api.completeOrder(order.id, {
        ...(summary ? { summary } : {}),
        ...(filled.length > 0
          ? { values: filled.map((v) => ({ ...v, code: v.code || v.label.toUpperCase() })) }
          : {}),
        ...(critical ? { critical: true } : {}),
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not record the result.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-3">
      {error && <Alert tone="danger">{error}</Alert>}

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]">
          Result / report
        </span>
        <textarea
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          rows={2}
          placeholder="Haemoglobin 11.9 g/dL. Within range."
          className="w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm text-[var(--color-fg)] outline-none"
        />
      </label>

      <div>
        <span className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]">
          Values {analytes.length > 0 ? "(from catalogue)" : "(optional)"}
          {specimen && (
            <span className="ml-2 font-normal text-[var(--color-fg-subtle)]">
              Specimen: {specimen}
            </span>
          )}
        </span>
        {values.map((v, i) => (
          <div
            key={i}
            className="mb-1.5 grid grid-cols-[2fr_1fr_1fr_1.5fr_auto] items-center gap-1.5"
          >
            <input
              value={v.label}
              onChange={(e) => setValue(i, { label: e.target.value })}
              placeholder="Haemoglobin"
              className="rounded border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-2 py-1.5 text-xs text-[var(--color-fg)]"
            />
            <input
              value={v.value}
              onChange={(e) =>
                setValue(i, {
                  value: e.target.value,
                  flag: flagAgainst(
                    e.target.value,
                    analytes.find((a) => a.code === v.code),
                  ),
                })
              }
              placeholder="11.9"
              className="rounded border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-2 py-1.5 text-xs text-[var(--color-fg)]"
            />
            <input
              value={v.unit ?? ""}
              onChange={(e) => setValue(i, { unit: e.target.value })}
              placeholder="g/dL"
              className="rounded border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-2 py-1.5 text-xs text-[var(--color-fg)]"
            />
            <input
              value={v.referenceRange ?? ""}
              onChange={(e) => setValue(i, { referenceRange: e.target.value })}
              placeholder="12–15"
              className="rounded border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-2 py-1.5 text-xs text-[var(--color-fg)]"
            />
            {v.flag && v.flag !== "normal" ? (
              <Badge tone={FLAG_TONE[v.flag] ?? "neutral"}>{v.flag.replace("_", " ")}</Badge>
            ) : v.flag === "normal" ? (
              <span className="text-xs text-[var(--color-success)]">✓</span>
            ) : (
              <span />
            )}
          </div>
        ))}
        <button
          type="button"
          onClick={() => setValues((r) => [...r, { code: "", label: "", value: "", unit: "" }])}
          className="text-xs text-[var(--color-brand-700)] underline underline-offset-2"
        >
          Add another value
        </button>
      </div>

      <label className="flex items-start gap-2 rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger-bg)] p-2.5">
        <input
          type="checkbox"
          checked={critical}
          onChange={(e) => setCritical(e.target.checked)}
          className="mt-0.5"
        />
        <span className="text-xs text-[var(--color-danger)]">
          <strong>Critical value</strong> — alerts the ordering doctor immediately, before
          verification. Use this when the number could harm the patient today.
        </span>
      </label>

      <Button
        disabled={busy || (!summary && !values.some((v) => v.label && v.value))}
        onClick={() => void submit()}
      >
        {busy ? "Recording…" : "Record result"}
      </Button>
    </div>
  );
}

/**
 * Which tab a status belongs to.
 *
 * Pending = not started; In progress = actively being run; Completed = the running is DONE. The
 * technician's job finishes when they record the result, so `completed` and `verified` belong in
 * Completed from their chair — the second-pair-of-eyes sign-off (verify → release) is a different
 * person's step, shown as a status label on the card, not a reason to keep the work in "In progress"
 * where the tech who finished it keeps seeing it. (This was the "it never leaves in-progress" bug.)
 */
type WorkTab = "pending" | "inprogress" | "completed";

const TAB_OF: Record<string, WorkTab> = {
  placed: "pending",
  accepted: "pending",
  in_progress: "inprogress",
  completed: "completed",
  verified: "completed",
  released: "completed",
};

type DatePreset = "today" | "week" | "all";

/** Half-open [start, end) for the completed-tab date filter, or null for "all". */
function completedSince(preset: DatePreset): Date | null {
  if (preset === "all") return null;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (preset === "week") d.setDate(d.getDate() - 6);
  return d;
}

function Worklist() {
  const { api, can } = useAuth();

  const [category, setCategory] = useState<OrderCategory>("lab");
  // The active queue (outstanding) and recently-released work are two different reads: pending
  // work persists across days regardless of when it was ordered, while "completed" is a dated
  // history. Keeping them apart is what lets the Completed tab be date-filtered without hiding a
  // two-day-old sample that still needs running.
  const [active, setActive] = useState<OrderRow[]>([]);
  const [done, setDone] = useState<OrderRow[]>([]);
  /**
   * How many outstanding orders EXIST, against however many we hold.
   *
   * The queue is capped at 100 rows per request and had no pagination and no total, so on a busy
   * day order 101 simply was not on the screen and nothing said so. A worklist that silently
   * stops short is a sample nobody runs — this is the one truncation that must never be quiet.
   */
  const [activeTotal, setActiveTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [entering, setEntering] = useState<string | null>(null);

  const [payment, setPayment] = useState<Record<string, PaymentState>>({});
  // Admitted-patient settle-from-advance info, keyed by order id (empty for OP patients).
  const [settlement, setSettlement] = useState<Record<string, Settlement>>({});
  /**
   * The documents already attached to each order of the SELECTED patient, keyed by order id.
   *
   * Two jobs. It decides whether "Mark complete" is offered (a result must have something behind
   * it), and — the reason it holds the files rather than just their ids — it is what the technician
   * SEES. Manual testing found the same patient's report uploaded twice for three of four tests,
   * about a minute apart each: nothing on the screen ever said the first upload had landed, so the
   * obvious response to "did that work?" was to do it again, and the doctor got every result twice.
   * A list of what is attached is the fix; the server is right to accept a second file (a re-scan
   * of a blurred image is a real thing), so the answer is to make the first one visible.
   */
  const [attached, setAttached] = useState<Map<string, ReportMeta[]>>(new Map());

  const [tab, setTab] = useState<WorkTab>("pending");
  const [search, setSearch] = useState("");
  const [datePreset, setDatePreset] = useState<DatePreset>("today");
  /** Which person's work is open. `null` ⇒ fall back to the top of the queue (see `group`). */
  const [selectedPatient, setSelectedPatient] = useState<string | null>(null);
  /** An action waiting on the in-app confirmation, rather than on `window.prompt`. */
  const [confirming, setConfirming] = useState<{
    order: OrderRow;
    action: "complete" | "cancel";
  } | null>(null);

  // Holds the raw thrown value, so ErrorAlert can surface its trace reference for support.
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // The active queue (sickest first, then oldest — the server sorts) and the released history.
      // `pages` grows with "Show more", so the queue is re-fetched whole rather than appended —
      // a page boundary that shifts under a re-sort would otherwise drop or double a row.
      const outstanding = await Promise.all(
        Array.from({ length: pages }, (_, i) =>
          api.listOrders({ category, outstanding: true, limit: 100, page: i + 1 }),
        ),
      );
      const donePage = await api.listOrders({ category, status: "released", limit: 100 });

      const activeItems = outstanding.flatMap((p) => p.items);
      setActive(activeItems);
      setActiveTotal(outstanding[0]?.meta.total ?? activeItems.length);
      setDone(donePage.items);
      setError(null);

      // Payment status is advisory — the worklist still works if billing refuses (a technician who
      // cannot reach it just sees no badge), so a failure here never blanks the list.
      const ids = [...activeItems, ...donePage.items].map((o) => o.id);
      api
        .orderPaymentStatus(ids)
        .then(setPayment)
        .catch(() => setPayment({}));

      // For admitted patients, whether the test can be settled from the advance and the balance to
      // draw it against. Advisory too — a failure just falls back to the "pay at billing" message.
      api
        .orderSettlementInfo(activeItems.map((o) => o.id))
        .then(setSettlement)
        .catch(() => setSettlement({}));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [api, category, pages]);

  useEffect(() => {
    void load();
  }, [load]);

  // A different department is a different queue — start it at one page.
  useEffect(() => {
    setPages(1);
  }, [category]);

  /**
   * The search a technician (or a doctor scanning their own orders) actually needs.
   *
   * It used to match `o.name` ALONE — the TEST name. So typing a patient's name into the box
   * marked "search" returned nothing, and there was no way to narrow the queue to one person at
   * all. Manual testing reported it as "we are getting placed investigation orders, currently all
   * coming with a large list, can we have filter by patients?" The box was never the problem; it
   * was searching the wrong column.
   *
   * Patient name and UHID are on the row now (server-resolved), so all three match.
   */
  const matchesSearch = (o: OrderRow): boolean => {
    const q = search.trim().toLowerCase();
    if (q === "") return true;
    return (
      o.name.toLowerCase().includes(q) ||
      o.patientName.toLowerCase().includes(q) ||
      o.uhid.toLowerCase().includes(q)
    );
  };

  const since = completedSince(datePreset);
  const pending = active.filter((o) => TAB_OF[o.status] === "pending" && matchesSearch(o));
  const inprogress = active.filter((o) => TAB_OF[o.status] === "inprogress" && matchesSearch(o));
  // Completed = work whose running is finished: the completed/verified rows still in the active
  // queue (awaiting the sign-off), plus the released history. The date filter only applies to the
  // released rows — a just-completed result must show whatever the date preset is, or the tech who
  // finished it a minute ago would think it vanished.
  const completedActive = active.filter(
    (o) => TAB_OF[o.status] === "completed" && matchesSearch(o),
  );
  const completedReleased = done.filter(
    (o) =>
      matchesSearch(o) &&
      (since === null || (o.releasedAt ? new Date(o.releasedAt) >= since : true)),
  );
  const completed = [...completedActive, ...completedReleased];

  const tabs: { key: WorkTab; label: string; orders: OrderRow[] }[] = [
    { key: "pending", label: "Pending", orders: pending },
    { key: "inprogress", label: "In progress", orders: inprogress },
    { key: "completed", label: "Completed", orders: completed },
  ];
  const orders = tabs.find((t) => t.key === tab)?.orders ?? [];
  const groups = useMemo(() => groupByPatient(orders), [orders]);

  /**
   * The open patient, DERIVED rather than corrected by an effect.
   *
   * The selection can stop being valid without anybody touching it — the last test for a person is
   * finished and their group leaves the tab, a search narrows them away, the department changes.
   * Falling back to the head of the queue in the same expression that reads it means there is never
   * a render where the pane is blank while an effect catches up, and no `setState` chasing another
   * `setState`.
   */
  const group = groups.find((g) => g.patientId === selectedPatient) ?? groups[0] ?? null;
  const openPatientId = group?.patientId ?? null;

  /**
   * The documents already attached to the OPEN patient's orders — one request per patient, made
   * when they are opened rather than for the whole queue up front. The flat list used to fetch this
   * for every patient with in-progress work on every reload, which is the same information at many
   * times the cost, and it went stale the moment an order left `in_progress`.
   */
  useEffect(() => {
    const orderIds = openPatientId
      ? (groups.find((g) => g.patientId === openPatientId)?.orders ?? []).map((o) => o.id)
      : [];
    if (orderIds.length === 0) {
      setAttached(new Map());
      return;
    }
    let live = true;
    /**
     * Keyed on the ORDERS, not the patient.
     *
     * `listReports(patientId)` needs `emr:read` — the doctor's cross-visit chart read — and a lab
     * technician deliberately does not hold it. So this soft-failed on a 403 for the one role that
     * uploads the files: they could attach a report and were never shown that it had landed, nor
     * that one was already there. `reportsForOrders` asks the same question about the orders in
     * front of them, under the `order:read` they already hold.
     */
    void api
      .reportsForOrders(orderIds)
      .then((reports) => {
        if (!live) return;
        const byOrder = new Map<string, ReportMeta[]>();
        for (const r of reports) byOrder.set(r.orderId, [...(byOrder.get(r.orderId) ?? []), r]);
        setAttached(byOrder);
      })
      // Still advisory: a lookup that fails must not stop somebody entering a result.
      .catch(() => {
        if (live) setAttached(new Map());
      });
    return () => {
      live = false;
    };
  }, [api, openPatientId, groups]);

  /**
   * The edges that need no extra information. `complete` and `cancel` are NOT here — both collect
   * text first, through `ConfirmDialog` (see `runConfirmed`), because both used `window.prompt`
   * and a suppressed prompt is a button that silently does nothing.
   */
  async function act(order: OrderRow, action: "accept" | "start" | "verify" | "release") {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (action === "accept") await api.acceptOrder(order.id);
      if (action === "start") await api.startOrder(order.id);
      if (action === "verify") await api.verifyOrder(order.id);
      if (action === "release") {
        await api.releaseOrder(order.id);
        setNotice(
          `${order.name} released — it is on the ordering doctor's screen now, and the patient can be called back.`,
        );
      }
      await load();
    } catch (err) {
      if (err instanceof ApiClientError && err.code === "HMS-AUTH-005") {
        /**
         * Almost always the category-authority check: a pathologist trying to sign off
         * a scan. Say WHY rather than "forbidden" — the user is not doing anything
         * wrong, they are the wrong specialist for this result.
         */
        const required = (err.details as { required?: string } | undefined)?.required;
        setError(
          required
            ? `You cannot verify a ${order.category} result — that needs "${required}". Ask the specialist for that department.`
            : err,
        );
      } else {
        setError(err);
      }
    } finally {
      setBusy(false);
    }
  }

  /** The half of `act` that needed a sentence typed first, once the dialog has it. */
  async function runConfirmed(text: string) {
    if (!confirming) return;
    const { order, action } = confirming;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (action === "complete") {
        // The quick path for work whose deliverable is an uploaded document (a scan, a signed
        // report) rather than typed values: record a one-line note and move it to "completed".
        // Honest by construction — the note says what happened, and a full result still goes
        // through "Enter result".
        await api.completeOrder(order.id, text ? { summary: text } : {});
        setNotice(`${order.name} marked complete — awaiting verification.`);
      } else {
        await api.cancelOrder(order.id, text);
      }
      setConfirming(null);
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Draws an admitted patient's test straight from their advance, so the report never waits for
   * money to change hands at a counter. The balance may go negative (the ward settles the shortfall
   * later) — that is the point: an inpatient's test is not held.
   */
  async function settleFromAdvance(order: OrderRow) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.settleOrderFromAdvance(order.id);
      setNotice(
        `${order.name} settled from advance. Advance now ${rupees(result.advanceBalance)}${
          result.advanceBalance < 0 ? " — the ward should collect the shortfall." : "."
        }`,
      );
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Uploads a scanned report against an order. No verify step — a document the technician
   * scanned in goes straight to the ordering doctor's patient record (report.model.ts). The
   * file is read as base64 in the browser and posted as JSON.
   */
  async function uploadReport(order: OrderRow, file: File) {
    setError(null);
    setNotice(null);
    setUploading(order.id);
    try {
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = String(reader.result);
          // A data URL is "data:<type>;base64,<payload>" — send only the payload.
          resolve(result.slice(result.indexOf(",") + 1));
        };
        reader.onerror = () => reject(new Error("Could not read the file."));
        reader.readAsDataURL(file);
      });

      const meta = await api.uploadReport(order.id, {
        filename: file.name,
        contentType: file.type || "application/octet-stream",
        dataBase64,
      });
      // The order now has a document behind it — "Mark complete" becomes available, and the file
      // appears in the row's attachment list so nobody has to guess whether it landed.
      setAttached((prev) => {
        const next = new Map(prev);
        next.set(order.id, [...(next.get(order.id) ?? []), meta]);
        return next;
      });
      setNotice(`Report uploaded for ${order.name}. The ordering doctor can see it now.`);
    } catch (err) {
      setError(err);
    } finally {
      setUploading(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-[var(--color-fg)]">Worklist</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Pending, in-progress and completed work. Nobody sent it here — the order is the hand-off.
        </p>
      </div>

      {error != null && <ErrorAlert error={error} fallback="Something went wrong." />}
      {notice && <Alert tone="success">{notice}</Alert>}

      <div className="flex flex-wrap gap-2">
        {DEPARTMENTS.map((d) => (
          <button
            key={d.category}
            type="button"
            onClick={() => setCategory(d.category)}
            className={`rounded-lg px-3.5 py-2 text-sm font-medium transition-colors ${
              category === d.category
                ? "bg-[var(--color-brand-600)] text-[var(--color-on-accent)]"
                : "bg-[var(--color-bg-elevated)] text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-subtle)]"
            }`}
          >
            {d.label}
          </button>
        ))}
      </div>

      {/* Status tabs + search. The tab is the worklist's state-of-play at a glance: what is waiting,
          what is running, what is done. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 rounded-lg border border-[var(--color-border)] p-0.5">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                tab === t.key
                  ? "bg-[var(--color-brand-600)] text-[var(--color-on-accent)]"
                  : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
              }`}
            >
              {t.label}
              <span
                className={`ml-1.5 rounded-full px-1.5 py-0.5 text-xs ${
                  tab === t.key ? "bg-white/20" : "bg-[var(--color-bg-subtle)]"
                }`}
              >
                {t.orders.length}
              </span>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          {tab === "completed" &&
            (["today", "week", "all"] as DatePreset[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setDatePreset(p)}
                className={`rounded-md px-2 py-1 text-xs font-medium transition ${
                  datePreset === p
                    ? "bg-[var(--color-bg-subtle)] text-[var(--color-fg)]"
                    : "text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]"
                }`}
              >
                {p === "today" ? "Today" : p === "week" ? "7 days" : "All"}
              </button>
            ))}
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Patient, UHID or test…"
            className="w-56 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-1.5 text-sm text-[var(--color-fg)] outline-none focus:border-[var(--color-brand-500)]"
          />
        </div>
      </div>

      {/*
        The cap, said out loud. The queue asks for 100 rows at a time; when the department has
        more than that, the rows we are NOT showing are the ones most likely to be forgotten, so
        the count and the way to reach them both belong on the screen.
      */}
      {activeTotal > active.length && (
        <Alert tone="warning">
          Showing {active.length} of {activeTotal} outstanding {category} orders. Search narrows the
          whole queue by patient, UHID or test —{" "}
          <button
            type="button"
            onClick={() => setPages((p) => p + 1)}
            className="font-medium underline"
          >
            or show the next 100
          </button>
          .
        </Alert>
      )}

      {loading ? (
        <Card className="p-5">
          <p className="py-6 text-center text-sm text-[var(--color-fg-subtle)]">Loading…</p>
        </Card>
      ) : groups.length === 0 ? (
        <Card className="p-5">
          <p className="py-6 text-center text-sm text-[var(--color-fg-subtle)]">
            {tab === "pending"
              ? "Nothing waiting. When a doctor orders something it appears here instantly."
              : tab === "inprogress"
                ? "Nothing in progress."
                : "No completed work in this period."}
          </p>
        </Card>
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(15rem,20rem)_1fr]">
          {/*
            THE QUEUE — one row per person, not per test. `aria-current` rather than a colour
            alone: which patient is open has to survive a screen reader and a monochrome screen.
          */}
          <Card className="p-2">
            <p className="px-2 py-1.5 text-xs font-medium text-[var(--color-fg-subtle)]">
              {groups.length === 1 ? "1 patient" : `${String(groups.length)} patients`} ·{" "}
              {orders.length === 1 ? "1 test" : `${String(orders.length)} tests`}
            </p>
            <ul className="max-h-[36rem] overflow-y-auto">
              {groups.map((g) => {
                const open = g.patientId === openPatientId;
                const unpaid = g.orders.filter((o) => payment[o.id] === "unpaid").length;
                return (
                  <li key={g.patientId}>
                    <button
                      type="button"
                      aria-current={open ? "true" : undefined}
                      onClick={() => setSelectedPatient(g.patientId)}
                      className={`w-full rounded-lg px-2.5 py-2 text-left transition-colors ${
                        open
                          ? "bg-[var(--color-brand-50)] text-[var(--color-fg)] ring-1 ring-[var(--color-brand-500)]/40"
                          : "hover:bg-[var(--color-bg-subtle)]"
                      }`}
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-sm font-medium text-[var(--color-fg)]">
                          {g.patientName}
                        </span>
                        <span className="shrink-0 text-xs text-[var(--color-fg-subtle)]">
                          {waited(g.waitingSince)}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-xs text-[var(--color-fg-muted)]">
                          {g.uhid}
                        </span>
                        <Badge tone="neutral">
                          {g.orders.length === 1 ? "1 test" : `${String(g.orders.length)} tests`}
                        </Badge>
                        {g.topPriority !== "routine" && (
                          <Badge tone={priorityTone(g.topPriority)}>{g.topPriority}</Badge>
                        )}
                        {unpaid > 0 && <Badge tone="danger">{unpaid} unpaid</Badge>}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Card>

          {/* EVERYTHING ORDERED FOR THE OPEN PATIENT. */}
          <Card className="p-5">
            {group === null ? (
              <p className="py-6 text-center text-sm text-[var(--color-fg-subtle)]">
                Select a patient to see their tests.
              </p>
            ) : (
              <>
                <div className="mb-4 border-b border-[var(--color-border)] pb-3">
                  <h2 className="text-base font-semibold text-[var(--color-fg)]">
                    {group.patientName}
                  </h2>
                  <p className="mt-0.5 text-xs text-[var(--color-fg-muted)]">
                    <span className="font-mono">{group.uhid}</span>
                    <span className="mx-1.5 text-[var(--color-fg-subtle)]">·</span>
                    {group.orders.length === 1
                      ? "1 test"
                      : `${String(group.orders.length)} tests`}{" "}
                    in this tab
                    <span className="mx-1.5 text-[var(--color-fg-subtle)]">·</span>
                    waiting {waited(group.waitingSince)}
                  </p>
                </div>
                <ul className="space-y-2.5">
                  {group.orders.map((o) => {
                    const files = attached.get(o.id) ?? [];
                    return (
                      <li
                        key={o.id}
                        className="rounded-lg border border-[var(--color-border)] p-3.5"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium text-[var(--color-fg)]">{o.name}</span>
                              <Badge tone={priorityTone(o.priority)}>{o.priority}</Badge>
                              <Badge tone={o.status === "completed" ? "brand" : "neutral"}>
                                {o.status.replace("_", " ")}
                              </Badge>
                              <PaymentBadge state={payment[o.id]} />
                            </div>
                            <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
                              ordered {time(o.orderedAt)}
                            </p>
                          </div>

                          <div className="flex flex-wrap gap-1.5">
                            {/*
                             * ── PAY BEFORE THE LAB RUNS — A WEB POLICY, NOT A SYSTEM RULE ──
                             * An UNPAID test is held here: the technician cannot accept, start,
                             * record or upload against it until the patient has paid at billing.
                             * `free` (zero-tariff government patient), `unbilled` (no charge raised
                             * yet) and `paid` all proceed — only a real, raised, unpaid charge
                             * holds the work. Cancel is always allowed, and an admitted patient is
                             * relieved immediately by settling from their advance.
                             *
                             * The API enforces NONE of this: the order state machine has no
                             * payment check, so any other client proceeds. That is deliberate — a
                             * hard server gate would refuse a stat troponin over an unfinalized
                             * bill — and it is written down in `AI_Workflow/docs/PAYMENT_POLICY.md`, along with
                             * the one thing this hold does NOT yet exempt: `stat` and `emergency`
                             * priorities are held like any other. That is an open product decision,
                             * recorded rather than quietly patched here.
                             */}
                            {isHeldForPayment(payment[o.id], o.status) ? (
                              settlement[o.id]?.admitted ? (
                                /* Admitted patient: draw the test straight from their advance so it
                                   never waits. Shows the balance (red when negative) and the
                                   amount to deduct. */
                                <PermissionGate can={can} permission="order:perform">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="inline-flex items-center gap-1.5 rounded-md bg-[var(--color-brand-50)] px-2.5 py-1 text-xs font-medium text-[var(--color-brand-700)]">
                                      Admitted · Advance{" "}
                                      <span
                                        className={
                                          settlement[o.id]!.advanceBalance < 0
                                            ? "font-semibold text-[var(--color-danger)]"
                                            : "font-semibold"
                                        }
                                      >
                                        {rupees(settlement[o.id]!.advanceBalance)}
                                      </span>
                                    </span>
                                    <Button
                                      disabled={busy}
                                      onClick={() => void settleFromAdvance(o)}
                                      title="Deduct this test from the patient's advance and proceed"
                                    >
                                      Proceed — deduct {rupees(settlement[o.id]!.amount)}
                                    </Button>
                                  </div>
                                </PermissionGate>
                              ) : (
                                <span className="inline-flex items-center rounded-md bg-[var(--color-warning-bg)] px-2.5 py-1 text-xs font-medium text-[var(--color-warning)]">
                                  Awaiting payment — held until paid at billing
                                </span>
                              )
                            ) : (
                              <>
                                {/* Only the edges §15 allows, and only for the role that holds
                                    them. */}
                                {o.status === "placed" && can("order:perform") && (
                                  <Button
                                    variant="secondary"
                                    disabled={busy}
                                    onClick={() => void act(o, "accept")}
                                  >
                                    Accept
                                  </Button>
                                )}
                                {o.status === "accepted" && can("order:perform") && (
                                  <Button
                                    variant="secondary"
                                    disabled={busy}
                                    onClick={() => void act(o, "start")}
                                  >
                                    Start
                                  </Button>
                                )}
                                {o.status === "in_progress" && can("order:perform") && (
                                  <>
                                    <Button
                                      disabled={busy}
                                      onClick={() => setEntering(entering === o.id ? null : o.id)}
                                    >
                                      {entering === o.id ? "Cancel entry" : "Enter result"}
                                    </Button>
                                    {/*
                                     * "Mark complete" is the UPLOAD path — its result is a
                                     * document, not typed values. So it only appears once a report
                                     * has actually been uploaded for this order; otherwise there is
                                     * nothing to complete against, and the tech is directed to
                                     * Enter result (which itself refuses an empty result). No
                                     * completing on thin air.
                                     */}
                                    {files.length > 0 ? (
                                      <Button
                                        variant="secondary"
                                        disabled={busy}
                                        onClick={() =>
                                          setConfirming({ order: o, action: "complete" })
                                        }
                                      >
                                        Mark complete
                                      </Button>
                                    ) : (
                                      <span className="inline-flex items-center rounded-md border border-dashed border-[var(--color-border-strong)] px-2.5 py-1 text-xs text-[var(--color-fg-subtle)]">
                                        Enter result or upload a report to complete
                                      </span>
                                    )}
                                  </>
                                )}
                              </>
                            )}
                            {/* The SECOND pair of eyes. A technician never sees this button. */}
                            {o.status === "completed" && can("order:verify") && (
                              <Button disabled={busy} onClick={() => void act(o, "verify")}>
                                Verify
                              </Button>
                            )}
                            {o.status === "verified" && can("order:release") && (
                              <Button disabled={busy} onClick={() => void act(o, "release")}>
                                Release to doctor
                              </Button>
                            )}
                            {["placed", "accepted"].includes(o.status) && can("order:cancel") && (
                              <Button
                                variant="ghost"
                                disabled={busy}
                                onClick={() => setConfirming({ order: o, action: "cancel" })}
                              >
                                Cancel
                              </Button>
                            )}

                            {/* Upload a scanned report — no verify step, straight to the doctor.
                                Held while the test is unpaid, the same as the run itself. Once one
                                is attached the label says "another", because a second file is added
                                alongside the first and never replaces it. */}
                            {o.status !== "cancelled" &&
                              can("order:perform") &&
                              payment[o.id] !== "unpaid" && (
                                <label
                                  className={`inline-flex cursor-pointer items-center rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm text-[var(--color-fg)] transition-colors hover:border-[var(--color-brand-500)] ${
                                    uploading === o.id ? "opacity-50" : ""
                                  }`}
                                >
                                  {uploading === o.id
                                    ? "Uploading…"
                                    : files.length > 0
                                      ? "Upload another"
                                      : "Upload report"}
                                  <input
                                    type="file"
                                    accept="application/pdf,image/*"
                                    className="hidden"
                                    disabled={uploading !== null}
                                    onChange={(e) => {
                                      const file = e.target.files?.[0];
                                      e.target.value = ""; // allow re-picking the same file
                                      if (file) void uploadReport(o, file);
                                    }}
                                  />
                                </label>
                              )}
                          </div>
                        </div>

                        {/*
                          WHAT IS ALREADY ATTACHED. The screen never used to say, so a technician
                          with no confirmation in front of them uploaded again — and the ordering
                          doctor received the same report twice. A second file is legitimate (a
                          re-scan of a blurred image), which is why this reports rather than
                          refuses; it just stops being invisible.
                        */}
                        {files.length > 0 && (
                          <div className="mt-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-2.5 py-2">
                            <p
                              className={`text-xs font-medium ${
                                files.length > 1
                                  ? "text-[var(--color-warning)]"
                                  : "text-[var(--color-fg-muted)]"
                              }`}
                            >
                              {files.length === 1
                                ? "1 report attached — the doctor can see it now."
                                : `${String(files.length)} reports attached — the doctor sees all of them.`}
                            </p>
                            <ul className="mt-1 space-y-0.5">
                              {files.map((f) => (
                                <li key={f.id} className="text-xs text-[var(--color-fg-subtle)]">
                                  {f.filename} · {(f.size / 1024).toFixed(0)} KB · uploaded{" "}
                                  {time(f.uploadedAt)}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {o.result?.critical && (
                          <p className="mt-2 text-xs font-semibold text-[var(--color-danger)]">
                            CRITICAL — the ordering doctor was alerted when this was recorded.
                          </p>
                        )}

                        {o.result?.summary &&
                          (o.status === "completed" || o.status === "released") && (
                            <p className="mt-2 rounded bg-[var(--color-bg-subtle)] p-2 text-xs text-[var(--color-fg-muted)]">
                              {o.result.summary}
                              {o.status === "completed" && (
                                <span className="mt-1 block text-[var(--color-fg-subtle)]">
                                  Awaiting verification — not yet visible to the doctor.
                                </span>
                              )}
                              {o.status === "released" && o.releasedAt && (
                                <span className="mt-1 block text-[var(--color-fg-subtle)]">
                                  Released{" "}
                                  {new Date(o.releasedAt).toLocaleDateString("en-IN", {
                                    day: "numeric",
                                    month: "short",
                                  })}{" "}
                                  — visible to the doctor.
                                </span>
                              )}
                            </p>
                          )}

                        {entering === o.id && (
                          <div className="mt-3">
                            <PermissionGate can={can} permission="order:perform">
                              <ResultForm
                                order={o}
                                onDone={() => {
                                  setEntering(null);
                                  void load();
                                }}
                              />
                            </PermissionGate>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </Card>
        </div>
      )}

      {/*
        The two edges that need a sentence typed first. Both used `window.prompt`, which cannot show
        which patient's test is about to change and which a browser may refuse to open at all.
      */}
      {confirming?.action === "complete" && (
        <ConfirmDialog
          title={`Mark complete: ${confirming.order.name}`}
          confirmLabel="Mark complete"
          busy={busy}
          reason={{
            label: "Result note",
            placeholder: "See uploaded report",
            defaultValue: "See uploaded report",
            multiline: false,
          }}
          onConfirm={(text) => void runConfirmed(text)}
          onCancel={() => setConfirming(null)}
        >
          <p>
            <strong className="text-[var(--color-fg)]">{confirming.order.patientName}</strong>{" "}
            <span className="font-mono text-xs">{confirming.order.uhid}</span>. This moves the test
            to <em>awaiting verification</em> — a second person still has to sign it off before the
            doctor sees a result.
          </p>
        </ConfirmDialog>
      )}

      {confirming?.action === "cancel" && (
        <ConfirmDialog
          title={`Cancel order: ${confirming.order.name}`}
          confirmLabel="Cancel this order"
          cancelLabel="Keep it"
          tone="danger"
          busy={busy}
          reason={{
            label: "Why is this order being cancelled?",
            placeholder: "Sample haemolysed — redraw requested",
            // The server's own minimum (order.schema.ts). Enforced here so a too-short reason is
            // caught in the dialog rather than coming back as a validation error.
            minLength: 3,
          }}
          onConfirm={(text) => void runConfirmed(text)}
          onCancel={() => setConfirming(null)}
        >
          <p>
            <strong className="text-[var(--color-fg)]">{confirming.order.patientName}</strong>{" "}
            <span className="font-mono text-xs">{confirming.order.uhid}</span>. The reason is stored
            on the order — billing reverses the charge against it, and the ordering doctor reads it.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

export default function WorklistPage() {
  return <Worklist />;
}
