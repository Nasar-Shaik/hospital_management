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
 */
import { useCallback, useEffect, useState } from "react";
import {
  ApiClientError,
  type Order,
  type OrderCategory,
  type OrderPriority,
  type OrderResultValue,
  type Patient,
} from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import { Protected } from "../../components/Protected";
import { Alert, Badge, Button, Card, ErrorAlert, PermissionGate } from "../../components/ui";
import { rupees } from "../../lib/money";

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
 * PAID / UNPAID for the test in front of the technician. Advisory, not a gate: an unpaid emergency
 * still gets run, and a zero-tariff government patient shows "free", never "unpaid". Absent (no
 * data) renders nothing rather than a misleading "unpaid".
 */
function PaymentBadge({ state }: { state?: "paid" | "unpaid" | "unbilled" | "free" }) {
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
function ResultForm({ order, onDone }: { order: Order; onDone: () => void }) {
  const { api } = useAuth();
  const [summary, setSummary] = useState("");
  const [critical, setCritical] = useState(false);
  const [values, setValues] = useState<OrderResultValue[]>([
    { code: "", label: "", value: "", unit: "" },
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
          Values (optional)
        </span>
        {values.map((v, i) => (
          <div key={i} className="mb-1.5 grid grid-cols-[2fr_1fr_1fr_1.5fr] gap-1.5">
            <input
              value={v.label}
              onChange={(e) => setValue(i, { label: e.target.value })}
              placeholder="Haemoglobin"
              className="rounded border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-2 py-1.5 text-xs text-[var(--color-fg)]"
            />
            <input
              value={v.value}
              onChange={(e) => setValue(i, { value: e.target.value })}
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
  const [active, setActive] = useState<Order[]>([]);
  const [done, setDone] = useState<Order[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [entering, setEntering] = useState<string | null>(null);

  const [payment, setPayment] = useState<Record<string, "paid" | "unpaid" | "unbilled" | "free">>(
    {},
  );
  // Admitted-patient settle-from-advance info, keyed by order id (empty for OP patients).
  const [settlement, setSettlement] = useState<Record<string, Settlement>>({});
  // Order ids that already have an uploaded report/document. A result can only be marked complete
  // when there is something to show for it — typed values (Enter result) or an uploaded doc.
  const [reported, setReported] = useState<Set<string>>(new Set());

  const [tab, setTab] = useState<WorkTab>("pending");
  const [search, setSearch] = useState("");
  const [datePreset, setDatePreset] = useState<DatePreset>("today");

  // Holds the raw thrown value, so ErrorAlert can surface its trace reference for support.
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);

  useEffect(() => {
    /**
     * 100 is the server's cap. Asking for more is a 400, not a bigger page.
     *
     * The failure is SURFACED rather than swallowed: an earlier `.catch(() => undefined)`
     * here turned that 400 into an empty dropdown with no error, which reads as "this
     * hospital has no patients" — a lie that took a browser session to disbelieve.
     */
    void api
      .listPatients({ limit: 100 })
      .then((page) => setPatients(page.items))
      .catch((err: unknown) =>
        setError(err instanceof ApiClientError ? err.message : "Could not load patients."),
      );
  }, [api]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // The active queue (sickest first, then oldest — the server sorts) and the released history.
      const [activePage, donePage] = await Promise.all([
        api.listOrders({ category, outstanding: true, limit: 100 }),
        api.listOrders({ category, status: "released", limit: 100 }),
      ]);
      setActive(activePage.items);
      setDone(donePage.items);
      setError(null);

      // Payment status is advisory — the worklist still works if billing refuses (a technician who
      // cannot reach it just sees no badge), so a failure here never blanks the list.
      const ids = [...activePage.items, ...donePage.items].map((o) => o.id);
      api
        .orderPaymentStatus(ids)
        .then(setPayment)
        .catch(() => setPayment({}));

      // For admitted patients, whether the test can be settled from the advance and the balance to
      // draw it against. Advisory too — a failure just falls back to the "pay at billing" message.
      api
        .orderSettlementInfo(activePage.items.map((o) => o.id))
        .then(setSettlement)
        .catch(() => setSettlement({}));

      // Which in-progress orders already have an uploaded document, so "Mark complete" (the
      // upload path) is only offered once there is a document to stand behind it. Reports are read
      // per patient; failures here just leave the set empty (the tech can still Enter result).
      const inProgressPatients = [
        ...new Set(
          activePage.items.filter((o) => o.status === "in_progress").map((o) => o.patientId),
        ),
      ];
      Promise.all(inProgressPatients.map((pid) => api.listReports(pid).catch(() => [])))
        .then((lists) => setReported(new Set(lists.flat().map((r) => r.orderId))))
        .catch(() => setReported(new Set()));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [api, category]);

  useEffect(() => {
    void load();
  }, [load]);

  const matchesSearch = (o: Order): boolean =>
    search.trim() === "" || o.name.toLowerCase().includes(search.trim().toLowerCase());

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

  const tabs: { key: WorkTab; label: string; orders: Order[] }[] = [
    { key: "pending", label: "Pending", orders: pending },
    { key: "inprogress", label: "In progress", orders: inprogress },
    { key: "completed", label: "Completed", orders: completed },
  ];
  const orders = tabs.find((t) => t.key === tab)?.orders ?? [];

  async function act(order: Order, action: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (action === "accept") await api.acceptOrder(order.id);
      if (action === "start") await api.startOrder(order.id);
      if (action === "complete") {
        // The quick path for work whose deliverable is an uploaded document (a scan, a signed
        // report) rather than typed values: record a one-line note and move it to "completed".
        // Honest by construction — the note says what happened, and a full result still goes
        // through "Enter result".
        const note = window.prompt(
          "Short result note (e.g. 'See uploaded report'):",
          "See uploaded report",
        );
        if (note === null) {
          setBusy(false);
          return;
        }
        await api.completeOrder(order.id, note.trim() ? { summary: note.trim() } : {});
        setNotice(`${order.name} marked complete — awaiting verification.`);
      }
      if (action === "verify") await api.verifyOrder(order.id);
      if (action === "release") {
        await api.releaseOrder(order.id);
        setNotice(
          `${order.name} released — it is on the ordering doctor's screen now, and the patient can be called back.`,
        );
      }
      if (action === "cancel") {
        const why = window.prompt("Why is this order being cancelled?");
        if (!why) {
          setBusy(false);
          return;
        }
        await api.cancelOrder(order.id, why);
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

  /**
   * Draws an admitted patient's test straight from their advance, so the report never waits for
   * money to change hands at a counter. The balance may go negative (the ward settles the shortfall
   * later) — that is the point: an inpatient's test is not held.
   */
  async function settleFromAdvance(order: Order) {
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
  async function uploadReport(order: Order, file: File) {
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

      await api.uploadReport(order.id, {
        filename: file.name,
        contentType: file.type || "application/octet-stream",
        dataBase64,
      });
      // The order now has a document behind it — "Mark complete" becomes available.
      setReported((prev) => new Set(prev).add(order.id));
      setNotice(`Report uploaded for ${order.name}. The ordering doctor can see it now.`);
    } catch (err) {
      setError(err);
    } finally {
      setUploading(null);
    }
  }

  const nameOf = (id: string): string => patients.find((p) => p.id === id)?.name ?? "—";
  const uhidOf = (id: string): string => patients.find((p) => p.id === id)?.uhid ?? "";

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
            placeholder="Filter by test…"
            className="w-40 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-1.5 text-sm text-[var(--color-fg)] outline-none focus:border-[var(--color-brand-500)]"
          />
        </div>
      </div>

      <Card className="p-5">
        {loading ? (
          <p className="py-6 text-center text-sm text-[var(--color-fg-subtle)]">Loading…</p>
        ) : orders.length === 0 ? (
          <p className="py-6 text-center text-sm text-[var(--color-fg-subtle)]">
            {tab === "pending"
              ? "Nothing waiting. When a doctor orders something it appears here instantly."
              : tab === "inprogress"
                ? "Nothing in progress."
                : "No completed work in this period."}
          </p>
        ) : (
          <ul className="space-y-2.5">
            {orders.map((o) => (
              <li key={o.id} className="rounded-lg border border-[var(--color-border)] p-3.5">
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
                    <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
                      {nameOf(o.patientId)}{" "}
                      <span className="font-mono text-xs">{uhidOf(o.patientId)}</span>
                      <span className="mx-1.5 text-[var(--color-fg-subtle)]">·</span>
                      <span className="text-xs">ordered {time(o.orderedAt)}</span>
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {/*
                     * ── PAY BEFORE THE LAB RUNS ────────────────────────────────────────────
                     * An UNPAID test is held: the technician cannot accept, start, record or
                     * upload against it until the patient has paid at billing. `free` (zero-tariff
                     * government patient), `unbilled` (no charge raised yet) and `paid` all proceed
                     * — only a real, raised, unpaid charge holds the work. Cancel is always allowed.
                     */}
                    {payment[o.id] === "unpaid" &&
                    ["placed", "accepted", "in_progress"].includes(o.status) ? (
                      settlement[o.id]?.admitted ? (
                        /* Admitted patient: draw the test straight from their advance so it never
                           waits. Shows the balance (red when negative) and the amount to deduct. */
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
                        {/* Only the edges §15 allows, and only for the role that holds them. */}
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
                             * "Mark complete" is the UPLOAD path — its result is a document, not
                             * typed values. So it only appears once a report has actually been
                             * uploaded for this order; otherwise there is nothing to complete
                             * against, and the tech is directed to Enter result (which itself
                             * refuses an empty result). No completing on thin air.
                             */}
                            {reported.has(o.id) ? (
                              <Button
                                variant="secondary"
                                disabled={busy}
                                onClick={() => void act(o, "complete")}
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
                      <Button variant="ghost" disabled={busy} onClick={() => void act(o, "cancel")}>
                        Cancel
                      </Button>
                    )}

                    {/* Upload a scanned report — no verify step, straight to the doctor. Held
                        while the test is unpaid, the same as the run itself. */}
                    {o.status !== "cancelled" &&
                      can("order:perform") &&
                      payment[o.id] !== "unpaid" && (
                        <label
                          className={`inline-flex cursor-pointer items-center rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm text-[var(--color-fg)] transition-colors hover:border-[var(--color-brand-500)] ${
                            uploading === o.id ? "opacity-50" : ""
                          }`}
                        >
                          {uploading === o.id ? "Uploading…" : "Upload report"}
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

                {o.result?.critical && (
                  <p className="mt-2 text-xs font-semibold text-[var(--color-danger)]">
                    CRITICAL — the ordering doctor was alerted when this was recorded.
                  </p>
                )}

                {o.result?.summary && (o.status === "completed" || o.status === "released") && (
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
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

export default function WorklistPage() {
  return (
    <Protected>
      <Worklist />
    </Protected>
  );
}
