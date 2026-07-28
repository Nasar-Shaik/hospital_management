"use client";

/**
 * The pharmacy's medicine master (module.pharmacy.full).
 *
 * Where the pharmacist runs the shelf: what the hospital stocks, what is left of each, and the
 * ledger of how it got there. Stock is never typed in directly — it is RECEIVED (a delivery),
 * ADJUSTED (breakage, a stock-take), or decremented by a dispense the pharmacy already made.
 * Every one of those leaves a movement, so the number on the screen always has a history behind
 * it that an auditor can read.
 *
 * The report reads worst-first: anything gone negative ("reconcile" — more went out than was
 * booked in) sits above anything out of stock, above anything low. A pharmacist opening this at
 * the start of the day sees the problems before the routine.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  ApiClientError,
  MEDICINE_FORMS,
  type Medicine,
  type MedicineForm,
  type StockMovement,
  type StockReportRow,
  type StockStatus,
} from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import { Alert, Badge, Button, Card, Field, Modal } from "../../components/ui";

const STATUS_TONE: Record<StockStatus, "success" | "warning" | "danger" | "neutral"> = {
  ok: "success",
  low: "warning",
  out: "danger",
  reconcile: "danger",
};
const STATUS_LABEL: Record<StockStatus, string> = {
  ok: "In stock",
  low: "Low",
  out: "Out of stock",
  reconcile: "Reconcile",
};
const FORM_LABEL: Record<MedicineForm, string> = {
  tablet: "Tablet",
  capsule: "Capsule",
  syrup: "Syrup",
  injection: "Injection",
  ointment: "Ointment",
  drops: "Drops",
  inhaler: "Inhaler",
  sachet: "Sachet",
  other: "Other",
};

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-[var(--color-fg)]">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3.5 py-2.5 text-sm text-[var(--color-fg)]"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

interface MedForm {
  code: string;
  name: string;
  manufacturer: string;
  generic: string;
  form: MedicineForm;
  strength: string;
  unitsPerSheet: string;
  sheetsPerPack: string;
  reorderLevel: string;
}

function formFrom(m?: Medicine): MedForm {
  return {
    code: m?.code ?? "",
    name: m?.name ?? "",
    manufacturer: m?.manufacturer ?? "",
    generic: m?.generic ?? "",
    form: m?.form ?? "tablet",
    strength: m?.strength ?? "",
    unitsPerSheet: m?.unitsPerSheet !== undefined ? String(m.unitsPerSheet) : "",
    sheetsPerPack: m?.sheetsPerPack !== undefined ? String(m.sheetsPerPack) : "",
    reorderLevel: m ? String(m.reorderLevel) : "0",
  };
}

/** Create or edit a medicine. On edit the code is frozen — it is the key a dispense matches on. */
function MedicineForm({
  mode,
  initial,
  onSubmit,
  saving,
  error,
}: {
  mode: "create" | "edit";
  initial?: Medicine;
  onSubmit: (f: MedForm) => void;
  saving: boolean;
  error?: string;
}) {
  const [f, setF] = useState<MedForm>(() => formFrom(initial));
  const set = (patch: Partial<MedForm>) => setF((prev) => ({ ...prev, ...patch }));

  return (
    <form
      className="space-y-5"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSubmit(f);
      }}
    >
      {error && <Alert tone="danger">{error}</Alert>}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Code"
          name="code"
          value={f.code}
          onChange={(e) => set({ code: e.target.value.toUpperCase() })}
          disabled={mode === "edit"}
          hint={
            mode === "edit" ? "The code cannot change — a dispense matches on it." : "e.g. PARA_500"
          }
          required
        />
        <Field
          label="Brand name"
          name="name"
          value={f.name}
          onChange={(e) => set({ name: e.target.value })}
          required
        />
        <Field
          label="Manufacturer"
          name="manufacturer"
          value={f.manufacturer}
          onChange={(e) => set({ manufacturer: e.target.value })}
        />
        <Field
          label="Generic / combination"
          name="generic"
          value={f.generic}
          onChange={(e) => set({ generic: e.target.value })}
          hint="The salt — e.g. Paracetamol 500mg"
        />
        <Select
          label="Form"
          value={f.form}
          onChange={(v) => set({ form: v as MedicineForm })}
          options={MEDICINE_FORMS.map((x) => ({ value: x, label: FORM_LABEL[x] }))}
        />
        <Field
          label="Strength"
          name="strength"
          value={f.strength}
          onChange={(e) => set({ strength: e.target.value })}
          hint="e.g. 500 mg, 5 mg/5 ml"
        />
        <Field
          label="Tablets per strip"
          name="unitsPerSheet"
          type="number"
          min={1}
          value={f.unitsPerSheet}
          onChange={(e) => set({ unitsPerSheet: e.target.value })}
        />
        <Field
          label="Strips per pack"
          name="sheetsPerPack"
          type="number"
          min={1}
          value={f.sheetsPerPack}
          onChange={(e) => set({ sheetsPerPack: e.target.value })}
        />
        <Field
          label="Reorder level"
          name="reorderLevel"
          type="number"
          min={0}
          value={f.reorderLevel}
          onChange={(e) => set({ reorderLevel: e.target.value })}
          hint="Alert at or below this many units. 0 = no alert."
        />
      </div>

      <div className="flex justify-end">
        <Button type="submit" loading={saving}>
          {mode === "create" ? "Add medicine" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}

/** Book a delivery in. */
function ReceiveForm({
  medicine,
  onSubmit,
  saving,
  error,
}: {
  medicine: Medicine;
  onSubmit: (input: { quantity: number; batchNo?: string; expiry?: string }) => void;
  saving: boolean;
  error?: string;
}) {
  const [quantity, setQuantity] = useState("");
  const [batchNo, setBatchNo] = useState("");
  const [expiry, setExpiry] = useState("");

  return (
    <form
      className="space-y-5"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        const qty = Number(quantity);
        onSubmit({
          quantity: qty,
          ...(batchNo ? { batchNo } : {}),
          ...(expiry ? { expiry: new Date(expiry).toISOString() } : {}),
        });
      }}
    >
      {error && <Alert tone="danger">{error}</Alert>}
      <p className="text-sm text-[var(--color-fg-muted)]">
        Receiving stock for <strong className="text-[var(--color-fg)]">{medicine.name}</strong> — on
        hand now: {medicine.stockUnits} {medicine.form === "tablet" ? "tablets" : "units"}.
      </p>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field
          label="Quantity (units)"
          name="quantity"
          type="number"
          min={1}
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          required
        />
        <Field
          label="Batch no."
          name="batchNo"
          value={batchNo}
          onChange={(e) => setBatchNo(e.target.value)}
        />
        <Field
          label="Expiry"
          name="expiry"
          type="date"
          value={expiry}
          onChange={(e) => setExpiry(e.target.value)}
        />
      </div>
      <div className="flex justify-end">
        <Button type="submit" loading={saving}>
          Receive stock
        </Button>
      </div>
    </form>
  );
}

/** A manual correction. Signed: negative writes off, positive corrects up. */
function AdjustForm({
  medicine,
  onSubmit,
  saving,
  error,
}: {
  medicine: Medicine;
  onSubmit: (input: { delta: number; reason: string }) => void;
  saving: boolean;
  error?: string;
}) {
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("");

  return (
    <form
      className="space-y-5"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSubmit({ delta: Number(delta), reason });
      }}
    >
      {error && <Alert tone="danger">{error}</Alert>}
      <p className="text-sm text-[var(--color-fg-muted)]">
        Adjusting <strong className="text-[var(--color-fg)]">{medicine.name}</strong> — on hand now:{" "}
        {medicine.stockUnits}. Use a negative number to write stock off, a positive one to correct
        it up.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Change (± units)"
          name="delta"
          type="number"
          value={delta}
          onChange={(e) => setDelta(e.target.value)}
          hint="e.g. -6 for breakage"
          required
        />
        <Field
          label="Reason"
          name="reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
        />
      </div>
      <div className="flex justify-end">
        <Button type="submit" loading={saving}>
          Record adjustment
        </Button>
      </div>
    </form>
  );
}

function MovementHistory({ movements }: { movements: StockMovement[] }) {
  if (movements.length === 0) {
    return <p className="text-sm text-[var(--color-fg-muted)]">No movements yet.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-[var(--color-border)] text-xs tracking-wide text-[var(--color-fg-subtle)] uppercase">
          <tr>
            <th className="px-3 py-2 font-medium">When</th>
            <th className="px-3 py-2 font-medium">Type</th>
            <th className="px-3 py-2 text-right font-medium">Change</th>
            <th className="px-3 py-2 text-right font-medium">Balance</th>
            <th className="px-3 py-2 font-medium">Note</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border)]">
          {movements.map((m) => (
            <tr key={m.id}>
              <td className="px-3 py-2 text-[var(--color-fg-muted)]">
                {new Date(m.createdAt).toLocaleString()}
              </td>
              <td className="px-3 py-2 capitalize">{m.kind}</td>
              <td
                className={`px-3 py-2 text-right font-medium ${
                  m.delta < 0 ? "text-[var(--color-danger)]" : "text-[var(--color-success)]"
                }`}
              >
                {m.delta > 0 ? `+${m.delta}` : m.delta}
              </td>
              <td className="px-3 py-2 text-right">{m.balanceAfter}</td>
              <td className="px-3 py-2 text-[var(--color-fg-muted)]">
                {m.reason ?? m.batchNo ?? (m.kind === "dispense" ? "dispensed" : "—")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type ModalKind = "create" | "edit" | "receive" | "adjust" | "history";

function MedicinesPage() {
  const { api, can } = useAuth();
  const canManage = can("pharmacy:stock");

  const [rows, setRows] = useState<StockReportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [lowOnly, setLowOnly] = useState(false);

  const [modal, setModal] = useState<ModalKind | null>(null);
  const [active, setActive] = useState<Medicine | null>(null);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | undefined>(undefined);

  const load = useCallback(() => {
    setLoading(true);
    api
      .stockReport(lowOnly ? { lowStockOnly: true } : {})
      .then((r) => {
        setRows(r);
        setError(null);
      })
      .catch((e: unknown) =>
        setError(e instanceof ApiClientError ? e.message : "Could not load medicines"),
      )
      .finally(() => setLoading(false));
  }, [api, lowOnly]);

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.code.toLowerCase().includes(q) ||
        (r.generic ?? "").toLowerCase().includes(q),
    );
  }, [rows, query]);

  const counts = useMemo(() => {
    const c = { reconcile: 0, out: 0, low: 0 };
    for (const r of rows) {
      if (r.status === "reconcile") c.reconcile += 1;
      else if (r.status === "out") c.out += 1;
      else if (r.status === "low") c.low += 1;
    }
    return c;
  }, [rows]);

  function openCreate() {
    setActive(null);
    setFormError(undefined);
    setModal("create");
  }
  function openFor(kind: ModalKind, m: Medicine) {
    setActive(m);
    setFormError(undefined);
    setModal(kind);
    if (kind === "history") {
      void api
        .listStockMovements(m.id)
        .then(setMovements)
        .catch(() => setMovements([]));
    }
  }
  function close() {
    setModal(null);
    setActive(null);
  }

  async function run(action: () => Promise<unknown>) {
    setSaving(true);
    setFormError(undefined);
    try {
      await action();
      close();
      load();
    } catch (e) {
      setFormError(e instanceof ApiClientError ? e.message : "Something went wrong");
    } finally {
      setSaving(false);
    }
  }

  function submitCreate(f: MedForm) {
    void run(() =>
      api.createMedicine({
        code: f.code.trim(),
        name: f.name.trim(),
        form: f.form,
        ...(f.manufacturer.trim() ? { manufacturer: f.manufacturer.trim() } : {}),
        ...(f.generic.trim() ? { generic: f.generic.trim() } : {}),
        ...(f.strength.trim() ? { strength: f.strength.trim() } : {}),
        ...(f.unitsPerSheet ? { unitsPerSheet: Number(f.unitsPerSheet) } : {}),
        ...(f.sheetsPerPack ? { sheetsPerPack: Number(f.sheetsPerPack) } : {}),
        ...(f.reorderLevel ? { reorderLevel: Number(f.reorderLevel) } : {}),
      }),
    );
  }
  function submitEdit(f: MedForm) {
    if (!active) return;
    void run(() =>
      api.updateMedicine(active.id, {
        name: f.name.trim(),
        form: f.form,
        manufacturer: f.manufacturer.trim(),
        generic: f.generic.trim(),
        strength: f.strength.trim(),
        reorderLevel: Number(f.reorderLevel) || 0,
        ...(f.unitsPerSheet ? { unitsPerSheet: Number(f.unitsPerSheet) } : {}),
        ...(f.sheetsPerPack ? { sheetsPerPack: Number(f.sheetsPerPack) } : {}),
      }),
    );
  }

  function packLabel(m: Medicine): string {
    if (m.unitsPerSheet && m.sheetsPerPack) return `${m.unitsPerSheet} × ${m.sheetsPerPack}`;
    if (m.unitsPerSheet) return `${m.unitsPerSheet}/strip`;
    return "—";
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--color-fg)]">Medicine master</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            What the pharmacy stocks, and what is left of each. Receive deliveries, correct the
            shelf, and read the history behind every number.
          </p>
        </div>
        {canManage && <Button onClick={openCreate}>Add medicine</Button>}
      </div>

      {(counts.reconcile > 0 || counts.out > 0 || counts.low > 0) && (
        <div className="flex flex-wrap gap-3 text-sm">
          {counts.reconcile > 0 && (
            <span className="rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-3 py-1.5">
              <strong>{counts.reconcile}</strong> to reconcile
            </span>
          )}
          {counts.out > 0 && (
            <span className="rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-3 py-1.5">
              <strong>{counts.out}</strong> out of stock
            </span>
          )}
          {counts.low > 0 && (
            <span className="rounded-lg border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-3 py-1.5">
              <strong>{counts.low}</strong> running low
            </span>
          )}
        </div>
      )}

      {error && <Alert tone="danger">{error}</Alert>}

      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-[var(--color-border)] p-4">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, code or generic…"
            className="w-full max-w-xs rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3.5 py-2 text-sm text-[var(--color-fg)] outline-none focus:border-[var(--color-brand-500)]"
          />
          <label className="flex items-center gap-2 text-sm text-[var(--color-fg-muted)]">
            <input
              type="checkbox"
              checked={lowOnly}
              onChange={(e) => setLowOnly(e.target.checked)}
            />
            Low stock only
          </label>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-[var(--color-border)] text-xs tracking-wide text-[var(--color-fg-subtle)] uppercase">
              <tr>
                <th className="px-4 py-3 font-medium">Medicine</th>
                <th className="px-4 py-3 font-medium">Code</th>
                <th className="px-4 py-3 font-medium">Form / strength</th>
                <th className="px-4 py-3 font-medium">Pack</th>
                <th className="px-4 py-3 text-right font-medium">Stock</th>
                <th className="px-4 py-3 font-medium">Status</th>
                {canManage && <th className="px-4 py-3 text-right font-medium">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-[var(--color-fg-muted)]">
                    Loading…
                  </td>
                </tr>
              ) : visible.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-[var(--color-fg-muted)]">
                    No medicines yet. Add the first with “Add medicine”.
                  </td>
                </tr>
              ) : (
                visible.map((m) => (
                  <tr key={m.id} className="hover:bg-[var(--color-bg-subtle)]">
                    <td className="px-4 py-3">
                      <div className="font-medium text-[var(--color-fg)]">{m.name}</div>
                      {m.generic && (
                        <div className="text-xs text-[var(--color-fg-muted)]">{m.generic}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-[var(--color-fg-muted)]">
                      {m.code}
                    </td>
                    <td className="px-4 py-3 text-[var(--color-fg-muted)]">
                      {FORM_LABEL[m.form]}
                      {m.strength ? ` · ${m.strength}` : ""}
                    </td>
                    <td className="px-4 py-3 text-[var(--color-fg-muted)]">{packLabel(m)}</td>
                    <td className="px-4 py-3 text-right font-medium">{m.stockUnits}</td>
                    <td className="px-4 py-3">
                      <Badge tone={STATUS_TONE[m.status]}>{STATUS_LABEL[m.status]}</Badge>
                    </td>
                    {canManage && (
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" onClick={() => openFor("receive", m)}>
                            Receive
                          </Button>
                          <Button variant="ghost" onClick={() => openFor("adjust", m)}>
                            Adjust
                          </Button>
                          <Button variant="ghost" onClick={() => openFor("history", m)}>
                            History
                          </Button>
                          <Button variant="ghost" onClick={() => openFor("edit", m)}>
                            Edit
                          </Button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {modal === "create" && (
        <Modal title="Add medicine" onClose={close} width="max-w-2xl">
          <MedicineForm mode="create" onSubmit={submitCreate} saving={saving} error={formError} />
        </Modal>
      )}
      {modal === "edit" && active && (
        <Modal title={`Edit ${active.name}`} onClose={close} width="max-w-2xl">
          <MedicineForm
            mode="edit"
            initial={active}
            onSubmit={submitEdit}
            saving={saving}
            error={formError}
          />
        </Modal>
      )}
      {modal === "receive" && active && (
        <Modal title={`Receive stock — ${active.name}`} onClose={close}>
          <ReceiveForm
            medicine={active}
            saving={saving}
            error={formError}
            onSubmit={(input) => run(() => api.receiveStock(active.id, input))}
          />
        </Modal>
      )}
      {modal === "adjust" && active && (
        <Modal title={`Adjust stock — ${active.name}`} onClose={close}>
          <AdjustForm
            medicine={active}
            saving={saving}
            error={formError}
            onSubmit={(input) => run(() => api.adjustStock(active.id, input))}
          />
        </Modal>
      )}
      {modal === "history" && active && (
        <Modal title={`Stock history — ${active.name}`} onClose={close} width="max-w-2xl">
          <MovementHistory movements={movements} />
        </Modal>
      )}
    </div>
  );
}

export default function Page() {
  return <MedicinesPage />;
}
