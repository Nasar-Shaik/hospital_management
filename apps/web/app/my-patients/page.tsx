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
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiClientError,
  type Encounter,
  type Order,
  type OrderPriority,
  type CatalogueItem,
  type Patient,
} from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import { Protected } from "../../components/Protected";
import { Alert, Badge, Button, Card, PermissionGate } from "../../components/ui";

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
function requestKey(encounterId: string, code: string): string {
  return `ord-${encounterId}-${code}-${String(Date.now())}`;
}

const PRIORITIES: OrderPriority[] = ["routine", "urgent", "stat", "emergency"];

function priorityTone(p: OrderPriority): "danger" | "brand" | "neutral" {
  if (p === "emergency" || p === "stat") return "danger";
  if (p === "urgent") return "brand";
  return "neutral";
}

/** What the doctor can order, grouped by where the work goes. */
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
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const orderable = useMemo(
    () => services.filter((s) => ["lab", "radiology", "procedure"].includes(s.category)),
    [services],
  );

  async function order(item: CatalogueItem) {
    setBusy(item.code);
    setError(null);
    setNotice(null);
    try {
      const result = await api.placeOrder({
        encounterId: encounter.id,
        // The tariff's category IS the destination department. One polymorphic order,
        // and the category is the only thing that differs (ADR-0013 §3).
        category: item.category as "lab" | "radiology" | "procedure",
        code: item.code,
        name: item.name,
        priority,
        requestId: requestKey(encounter.id, item.code),
      });

      setNotice(
        result.duplicate
          ? `${item.name} was already ordered — not ordered twice.`
          : `${item.name} ordered. It is in the ${item.category} worklist now.`,
      );
      onOrdered();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not place the order.");
    } finally {
      setBusy(null);
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
              {items.map((item) => (
                <button
                  key={item.code}
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void order(item)}
                  className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-2.5 py-1.5 text-xs text-[var(--color-fg)] transition-colors hover:border-[var(--color-brand-500)] hover:bg-[var(--color-brand-50)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy === item.code ? "Ordering…" : item.name}
                </button>
              ))}
            </div>
          </div>
        );
      })}
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
            {o.result?.critical && <Badge tone="danger">CRITICAL</Badge>}
          </div>

          {/*
           * The result appears here ONLY once released — never at `completed` or
           * `verified`. A number that has been run but not signed off must not reach
           * the person who will act on it (STATE_MACHINE_CATALOG §15).
           */}
          {o.status === "released" && o.result && (
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

function MyPatients() {
  const { api, user, can } = useAuth();

  const [waiting, setWaiting] = useState<Encounter[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [services, setServices] = useState<CatalogueItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

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

    /**
     * The CATALOGUE, not the tariff. Same collection on the server, price stripped —
     * a doctor sees what can be ordered and never what it costs, so a patient's means
     * cannot shape what they are offered (billing.routes.ts).
     */
    void api
      .listCatalogue()
      .then(setServices)
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

  useEffect(() => {
    if (selectedId) loadOrders(selectedId);
  }, [selectedId, loadOrders]);

  const selected = waiting.find((e) => e.id === selectedId) ?? null;

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

  const nameOf = (id: string): string => patients.find((p) => p.id === id)?.name ?? "—";
  const uhidOf = (id: string): string => patients.find((p) => p.id === id)?.uhid ?? "";

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
          <h2 className="mb-3 text-sm font-semibold text-[var(--color-fg)]">
            Waiting ({waiting.length})
          </h2>

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
                        {nameOf(e.patientId)}
                      </span>
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
                      {nameOf(selected.patientId)}
                    </h2>
                    <p className="mt-0.5 font-mono text-xs text-[var(--color-fg-muted)]">
                      {uhidOf(selected.patientId)}
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
                        disabled={busy}
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
                  </div>
                </div>

                {selected.status === "awaiting_results" && (
                  <Alert tone="info">
                    At the lab. They keep this visit — when the last result is released they come
                    back to your list on their own.
                  </Alert>
                )}
              </Card>

              <PermissionGate can={can} permission="order:create">
                <Card className="p-5">
                  <h3 className="mb-1 text-sm font-semibold text-[var(--color-fg)]">Order</h3>
                  <p className="mb-4 text-xs text-[var(--color-fg-muted)]">
                    Ordering puts it in that department&apos;s worklist immediately. There is no
                    &ldquo;send to lab&rdquo; step.
                  </p>
                  <OrderPad
                    encounter={selected}
                    services={services}
                    onOrdered={() => loadOrders(selected.id)}
                  />
                </Card>
              </PermissionGate>

              <Card className="p-5">
                <h3 className="mb-3 text-sm font-semibold text-[var(--color-fg)]">
                  Ordered on this visit
                </h3>
                <OrdersForVisit orders={orders} />
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function MyPatientsPage() {
  return (
    <Protected>
      <MyPatients />
    </Protected>
  );
}
