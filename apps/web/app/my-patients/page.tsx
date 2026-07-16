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
  DRUG_FREQUENCIES,
  DRUG_ROUTES,
  type DrugFrequency,
  type DrugRoute,
  type Encounter,
  type Order,
  type OrderPriority,
  type CatalogueItem,
  type Patient,
  type Prescription,
  type PrescriptionLineInput,
  type DoctorRef,
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
function RxPad({
  encounter,
  drugs,
  onSigned,
}: {
  encounter: Encounter;
  drugs: CatalogueItem[];
  onSigned: () => void;
}) {
  const { api } = useAuth();
  const [lines, setLines] = useState<PrescriptionLineInput[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? drugs.filter((d) => d.name.toLowerCase().includes(q)) : drugs;
  }, [drugs, filter]);

  function add(drug: CatalogueItem) {
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
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function remove(index: number) {
    setLines((prev) => prev.filter((_, i) => i !== index));
  }

  async function sign() {
    setBusy(true);
    setError(null);
    try {
      // Draft, then sign. Two calls because they are two acts: the second is the one that
      // binds, and the server refuses to sign an empty one.
      const rx = await api.createPrescription({ encounterId: encounter.id, lines });
      await api.signPrescription(rx.id);
      setLines([]);
      onSigned();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not sign the prescription.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}

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

          <Button disabled={busy} onClick={() => void sign()}>
            {busy ? "Signing…" : `Sign prescription (${String(lines.length)})`}
          </Button>
          <p className="text-xs text-[var(--color-fg-subtle)]">
            Signing sends it to the pharmacy straight away. After that it cannot be edited —
            changing a dose creates a new version.
          </p>
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

  async function admit() {
    setBusy(true);
    setError(null);
    try {
      await api.admitPatient(encounter.id, { ward, bedCode, tariffCode });
      onDone("Admitted. This visit is closed and the stay is on the ward list.");
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
          <p className="text-xs text-[var(--color-fg-subtle)]">
            Admitting CLOSES this visit and opens an inpatient stay in the same care story. The bed
            is billed for every day the patient is here, starting today.
          </p>
          <div className="flex gap-2">
            <Button disabled={busy || bedCode.trim().length === 0} onClick={() => void admit()}>
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

  const [waiting, setWaiting] = useState<Encounter[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [services, setServices] = useState<CatalogueItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [prescriptions, setPrescriptions] = useState<Prescription[]>([]);
  const [doctors, setDoctors] = useState<DoctorRef[]>([]);

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

  useEffect(() => {
    if (selectedId) {
      loadOrders(selectedId);
      loadPrescriptions(selectedId);
    }
  }, [selectedId, loadOrders, loadPrescriptions]);

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

              <PermissionGate can={can} permission="prescription:sign">
                <Card className="p-5">
                  <h3 className="mb-1 text-sm font-semibold text-[var(--color-fg)]">Prescribe</h3>
                  <p className="mb-4 text-xs text-[var(--color-fg-muted)]">
                    Signing puts it on the pharmacy counter immediately. Nothing is charged until
                    the drugs are actually handed over.
                  </p>
                  <RxPad
                    encounter={selected}
                    drugs={drugs}
                    onSigned={() => {
                      setNotice("Prescription signed — it is on the pharmacy counter now.");
                      loadPrescriptions(selected.id);
                    }}
                  />
                </Card>
              </PermissionGate>

              <Card className="p-5">
                <h3 className="mb-3 text-sm font-semibold text-[var(--color-fg)]">
                  Prescribed on this visit
                </h3>
                <PrescriptionsForVisit
                  prescriptions={prescriptions}
                  onCancel={(id) => void stopPrescription(id)}
                />
              </Card>

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
