"use client";

/**
 * The general store (module.support.inventory).
 *
 * Where the store keeper runs the shelf: what the hospital stocks, how much of it is in THIS
 * site's store room, and the ledger of how it got there. Stock is never typed in — it is
 * RECEIVED from a supplier, ISSUED to a department, or ADJUSTED against a physical count. Every
 * one of those leaves a movement, so the number on the screen always has a history behind it.
 *
 * ── THE SHELF ON SCREEN BELONGS TO THE SITE IN THE HEADER ───────────────────
 * Unlike the pharmacy's hospital-wide balance, `onHand` here is per branch — a store is a room.
 * With "All branches" selected it is the sum of the rooms this user may see, which is what the
 * aggregate view means everywhere else. The three write actions stamp a site, so under "All
 * branches" they are disabled and `ChooseBranchNotice` asks first (D19) rather than letting
 * somebody fill in a form the server will refuse.
 *
 * ── AND THE LIST READS WORST-FIRST ──────────────────────────────────────────
 * Out of stock above low above fine. A store keeper opening this at the start of the day sees
 * what has to be ordered before the routine.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  ApiClientError,
  ITEM_CATEGORIES,
  ITEM_UNITS,
  type IssueDestination,
  type InventoryMovement,
  type ItemCategory,
  type ItemUnit,
  type StockPosition,
  type StoreRow,
  type Supplier,
} from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import { useBranch } from "../../components/BranchProvider";
import { CHOOSE_BRANCH_HINT, ChooseBranchNotice } from "../../components/ChooseBranch";
import { ModuleNotInEdition } from "../../components/ModuleNotInEdition";
import { isFeatureUnavailable } from "../../lib/errors";
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  Field,
  Modal,
  type Column,
} from "../../components/ui";

const POSITION_TONE: Record<StockPosition, "success" | "warning" | "danger"> = {
  ok: "success",
  low: "warning",
  out: "danger",
};
const POSITION_LABEL: Record<StockPosition, string> = {
  ok: "In stock",
  low: "Running low",
  out: "Out of stock",
};

const CATEGORY_LABEL: Record<ItemCategory, string> = {
  consumable: "Consumable",
  linen: "Linen",
  stationery: "Stationery",
  housekeeping: "Housekeeping",
  spare: "Spare part",
  other: "Other",
};

const UNIT_LABEL: Record<ItemUnit, string> = {
  piece: "Piece",
  box: "Box",
  pack: "Pack",
  pair: "Pair",
  roll: "Roll",
  metre: "Metre",
  litre: "Litre",
  kilogram: "Kilogram",
};

function Select({
  label,
  value,
  onChange,
  options,
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-[var(--color-fg)]">{label}</span>
      <select
        value={value}
        required={required}
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

/* ── forms ─────────────────────────────────────────────────────────────────── */

interface ItemDraft {
  code: string;
  name: string;
  category: ItemCategory;
  unit: ItemUnit;
  reorderLevel: string;
}

function draftFrom(row?: StoreRow): ItemDraft {
  return {
    code: row?.code ?? "",
    name: row?.name ?? "",
    category: row?.category ?? "consumable",
    unit: row?.unit ?? "piece",
    reorderLevel: row ? String(row.reorderLevel) : "0",
  };
}

/** Create or edit an item. On edit the code is frozen — it is the key the ledger matches on. */
function ItemForm({
  mode,
  initial,
  onSubmit,
  saving,
  error,
}: {
  mode: "create" | "edit";
  initial?: StoreRow;
  onSubmit: (d: ItemDraft) => void;
  saving: boolean;
  error?: string;
}) {
  const [d, setD] = useState<ItemDraft>(() => draftFrom(initial));
  const set = (patch: Partial<ItemDraft>) => setD((prev) => ({ ...prev, ...patch }));

  return (
    <form
      className="space-y-5"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSubmit(d);
      }}
    >
      {error && <Alert tone="danger">{error}</Alert>}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Code"
          name="code"
          value={d.code}
          onChange={(e) => set({ code: e.target.value })}
          disabled={mode === "edit"}
          hint={mode === "edit" ? "The code cannot change — the ledger matches on it." : undefined}
          required
        />
        <Field
          label="Name"
          name="name"
          value={d.name}
          onChange={(e) => set({ name: e.target.value })}
          required
        />
        <Select
          label="Category"
          value={d.category}
          onChange={(v) => set({ category: v as ItemCategory })}
          options={ITEM_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))}
        />
        <Select
          label="Counted in"
          value={d.unit}
          onChange={(v) => set({ unit: v as ItemUnit })}
          options={ITEM_UNITS.map((u) => ({ value: u, label: UNIT_LABEL[u] }))}
        />
        <Field
          label="Reorder level"
          name="reorderLevel"
          type="number"
          min={0}
          value={d.reorderLevel}
          onChange={(e) => set({ reorderLevel: e.target.value })}
          hint="At or below this the item is flagged. Zero means no flag."
        />
      </div>

      <div className="flex justify-end">
        <Button type="submit" loading={saving}>
          {mode === "create" ? "Add item" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}

function ReceiveForm({
  row,
  suppliers,
  onSubmit,
  saving,
  error,
}: {
  row: StoreRow;
  suppliers: Supplier[];
  onSubmit: (input: {
    quantity: number;
    supplierId?: string;
    invoiceRef?: string;
    unitCost?: number;
  }) => void;
  saving: boolean;
  error?: string;
}) {
  const [quantity, setQuantity] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [invoiceRef, setInvoiceRef] = useState("");
  const [unitCost, setUnitCost] = useState("");

  return (
    <form
      className="space-y-5"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSubmit({
          quantity: Number(quantity),
          ...(supplierId ? { supplierId } : {}),
          ...(invoiceRef.trim() ? { invoiceRef: invoiceRef.trim() } : {}),
          ...(unitCost ? { unitCost: Number(unitCost) } : {}),
        });
      }}
    >
      {error && <Alert tone="danger">{error}</Alert>}
      <p className="text-sm text-[var(--color-fg-muted)]">
        Booking a delivery of <strong className="text-[var(--color-fg)]">{row.name}</strong> into
        this site&rsquo;s store. On hand now: {row.onHand} {UNIT_LABEL[row.unit].toLowerCase()}.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={`Quantity (${UNIT_LABEL[row.unit].toLowerCase()})`}
          name="quantity"
          type="number"
          min={1}
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          required
        />
        <Select
          label="Supplier"
          value={supplierId}
          onChange={setSupplierId}
          options={[
            { value: "", label: "— not recorded —" },
            ...suppliers.map((s) => ({ value: s.id, label: s.name })),
          ]}
        />
        <Field
          label="Invoice / delivery note"
          name="invoiceRef"
          value={invoiceRef}
          onChange={(e) => setInvoiceRef(e.target.value)}
        />
        <Field
          label="Cost per unit"
          name="unitCost"
          type="number"
          min={0}
          step="0.01"
          value={unitCost}
          onChange={(e) => setUnitCost(e.target.value)}
        />
      </div>
      <div className="flex justify-end">
        <Button type="submit" loading={saving}>
          Book it in
        </Button>
      </div>
    </form>
  );
}

function IssueForm({
  row,
  destinations,
  onSubmit,
  saving,
  error,
}: {
  row: StoreRow;
  destinations: IssueDestination[];
  onSubmit: (input: { quantity: number; departmentId: string }) => void;
  saving: boolean;
  error?: string;
}) {
  const [quantity, setQuantity] = useState("");
  const [departmentId, setDepartmentId] = useState("");

  return (
    <form
      className="space-y-5"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSubmit({ quantity: Number(quantity), departmentId });
      }}
    >
      {error && <Alert tone="danger">{error}</Alert>}
      <p className="text-sm text-[var(--color-fg-muted)]">
        Issuing <strong className="text-[var(--color-fg)]">{row.name}</strong> from this
        site&rsquo;s store. On hand now: {row.onHand} {UNIT_LABEL[row.unit].toLowerCase()}.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        {/**
         * No `max`, deliberately. The on-hand on screen is a SNAPSHOT: another keeper may have
         * issued from the same shelf since this list loaded, so a client-side cap built on it
         * would sometimes block a legal issue and sometimes fail to block an illegal one. The
         * server arbitrates with a conditional update and answers with the real number
         * (`HMS-INV-002`), which is a better message than the browser's generic one.
         *
         * This is NOT the D19 rule pointing the other way: there, the client can compute the
         * server's answer exactly, from the same list. Here it cannot.
         */}
        <Field
          label={`Quantity (${UNIT_LABEL[row.unit].toLowerCase()})`}
          name="quantity"
          type="number"
          min={1}
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          required
        />
        <Select
          label="To department"
          value={departmentId}
          onChange={setDepartmentId}
          required
          options={[
            { value: "", label: "— choose a department —" },
            ...destinations.map((d) => ({ value: d.id, label: d.name })),
          ]}
        />
      </div>
      <div className="flex justify-end">
        <Button type="submit" loading={saving} disabled={!departmentId}>
          Issue
        </Button>
      </div>
    </form>
  );
}

function AdjustForm({
  row,
  onSubmit,
  saving,
  error,
}: {
  row: StoreRow;
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
        Correcting <strong className="text-[var(--color-fg)]">{row.name}</strong> against a physical
        count. On hand now: {row.onHand}. Use a negative number to write stock off, a positive one
        to correct it up.
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
          Record correction
        </Button>
      </div>
    </form>
  );
}

function SupplierPanel({
  suppliers,
  canManage,
  onAdd,
  saving,
  error,
}: {
  suppliers: Supplier[];
  canManage: boolean;
  onAdd: (input: { code: string; name: string; phone?: string }) => void;
  saving: boolean;
  error?: string;
}) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");

  return (
    <div className="space-y-5">
      {error && <Alert tone="danger">{error}</Alert>}

      {suppliers.length === 0 ? (
        <p className="text-sm text-[var(--color-fg-muted)]">
          No suppliers yet. A delivery can still be booked in without one — it simply will not say
          who it came from.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--color-border)] text-sm">
          {suppliers.map((s) => (
            <li key={s.id} className="flex items-center justify-between py-2">
              <span className="text-[var(--color-fg)]">{s.name}</span>
              <span className="font-mono text-xs text-[var(--color-fg-muted)]">
                {s.phone ?? s.code}
              </span>
            </li>
          ))}
        </ul>
      )}

      {canManage && (
        <form
          className="space-y-4 border-t border-[var(--color-border)] pt-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            onAdd({
              code: code.trim(),
              name: name.trim(),
              ...(phone.trim() ? { phone: phone.trim() } : {}),
            });
            setCode("");
            setName("");
            setPhone("");
          }}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <Field
              label="Code"
              name="supplierCode"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
            <Field
              label="Name"
              name="supplierName"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
            <Field
              label="Phone"
              name="supplierPhone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
          <div className="flex justify-end">
            <Button type="submit" loading={saving}>
              Add supplier
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

function MovementHistory({ movements }: { movements: InventoryMovement[] }) {
  if (movements.length === 0) {
    return <p className="text-sm text-[var(--color-fg-muted)]">No movements at this site yet.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-[var(--color-border)] text-xs tracking-wide text-[var(--color-fg-subtle)] uppercase">
          <tr>
            <th className="px-3 py-2 font-medium">When</th>
            <th className="px-3 py-2 font-medium">Type</th>
            <th className="px-3 py-2 text-right font-medium">Change</th>
            <th className="px-3 py-2 text-right font-medium">On hand</th>
            <th className="px-3 py-2 font-medium">Who / why</th>
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
                className={`px-3 py-2 text-right font-medium tabular-nums ${
                  m.delta < 0 ? "text-[var(--color-danger)]" : "text-[var(--color-success)]"
                }`}
              >
                {m.delta > 0 ? `+${m.delta}` : m.delta}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{m.balanceAfter}</td>
              <td className="px-3 py-2 text-[var(--color-fg-muted)]">
                {m.departmentName ?? m.supplierName ?? m.reason ?? "—"}
                {m.invoiceRef ? ` · ${m.invoiceRef}` : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── the page ──────────────────────────────────────────────────────────────── */

type ModalKind = "create" | "edit" | "receive" | "issue" | "adjust" | "history" | "suppliers";

function InventoryPage() {
  const { api, can } = useAuth();
  const { mustChooseBranch } = useBranch();

  const canManage = can("inventory:manage");
  const canReceive = can("inventory:purchase");
  const canIssue = can("inventory:issue");
  const canAdjust = can("inventory:audit");
  const canSuppliers = can("vendor:manage");

  const [rows, setRows] = useState<StoreRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const [query, setQuery] = useState("");
  const [lowOnly, setLowOnly] = useState(false);

  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [destinations, setDestinations] = useState<IssueDestination[]>([]);
  const [movements, setMovements] = useState<InventoryMovement[]>([]);

  const [modal, setModal] = useState<ModalKind | null>(null);
  const [active, setActive] = useState<StoreRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | undefined>(undefined);

  const load = useCallback(() => {
    setLoading(true);
    api
      .listStoreItems(lowOnly ? { lowStockOnly: true } : {})
      .then((r) => {
        setRows(r);
        setError(null);
      })
      .catch((e: unknown) => setError(e))
      .finally(() => setLoading(false));
  }, [api, lowOnly]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * The two pickers, fetched ONCE rather than per modal open.
   *
   * Both are swallowed on failure: a keeper without `vendor:manage` legitimately cannot read the
   * supplier list, and that must leave an empty picker rather than an error banner over a working
   * shelf. The DESTINATIONS list is the store's own (`/inventory-destinations`) rather than
   * `/departments`, which is gated on `patient:read` — see the service.
   */
  useEffect(() => {
    let live = true;
    void api
      .listSuppliers()
      .then((s) => live && setSuppliers(s))
      .catch(() => undefined);
    void api
      .listStoreDestinations()
      .then((d) => live && setDestinations(d))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.name.toLowerCase().includes(q) || r.code.toLowerCase().includes(q));
  }, [rows, query]);

  const counts = useMemo(() => {
    const c = { out: 0, low: 0 };
    for (const r of rows) {
      if (r.position === "out") c.out += 1;
      else if (r.position === "low") c.low += 1;
    }
    return c;
  }, [rows]);

  function openFor(kind: ModalKind, row?: StoreRow) {
    setActive(row ?? null);
    setFormError(undefined);
    setModal(kind);
    if (kind === "history" && row) {
      void api
        .listStoreMovements(row.id)
        .then(setMovements)
        .catch(() => setMovements([]));
    }
  }

  function close() {
    setModal(null);
    setActive(null);
  }

  async function run(action: () => Promise<unknown>, refresh: "items" | "suppliers" = "items") {
    setSaving(true);
    setFormError(undefined);
    try {
      await action();
      if (refresh === "items") {
        close();
        load();
      } else {
        setSuppliers(await api.listSuppliers());
      }
    } catch (e) {
      setFormError(e instanceof ApiClientError ? e.message : "Something went wrong");
    } finally {
      setSaving(false);
    }
  }

  const columns: Column<StoreRow>[] = [
    {
      key: "item",
      header: "Item",
      render: (r) => (
        <div>
          <div className="font-medium text-[var(--color-fg)]">{r.name}</div>
          <div className="font-mono text-xs text-[var(--color-fg-muted)]">{r.code}</div>
        </div>
      ),
    },
    {
      key: "category",
      header: "Category",
      cellClassName: "text-[var(--color-fg-muted)]",
      render: (r) => CATEGORY_LABEL[r.category],
    },
    {
      key: "onHand",
      header: "On hand",
      align: "right",
      cellClassName: "tabular-nums",
      render: (r) => `${r.onHand} ${UNIT_LABEL[r.unit].toLowerCase()}`,
    },
    {
      key: "reorder",
      header: "Reorder at",
      align: "right",
      cellClassName: "tabular-nums text-[var(--color-fg-muted)]",
      render: (r) => (r.reorderLevel > 0 ? r.reorderLevel : "—"),
    },
    {
      key: "position",
      header: "Status",
      render: (r) => <Badge tone={POSITION_TONE[r.position]}>{POSITION_LABEL[r.position]}</Badge>,
    },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (r) => (
        <div className="flex justify-end gap-1">
          {canReceive && (
            <Button
              variant="ghost"
              disabled={mustChooseBranch}
              title={mustChooseBranch ? CHOOSE_BRANCH_HINT : undefined}
              onClick={() => openFor("receive", r)}
            >
              Receive
            </Button>
          )}
          {canIssue && (
            <Button
              variant="ghost"
              disabled={mustChooseBranch}
              title={mustChooseBranch ? CHOOSE_BRANCH_HINT : undefined}
              onClick={() => openFor("issue", r)}
            >
              Issue
            </Button>
          )}
          {canAdjust && (
            <Button
              variant="ghost"
              disabled={mustChooseBranch}
              title={mustChooseBranch ? CHOOSE_BRANCH_HINT : undefined}
              onClick={() => openFor("adjust", r)}
            >
              Adjust
            </Button>
          )}
          <Button variant="ghost" onClick={() => openFor("history", r)}>
            History
          </Button>
          {canManage && (
            <Button variant="ghost" onClick={() => openFor("edit", r)}>
              Edit
            </Button>
          )}
        </div>
      ),
    },
  ];

  /**
   * The hospital never bought the store (D20). Drawing an empty item list over "No items yet"
   * would tell a clinic it has an empty store room when it has no store module at all.
   */
  if (isFeatureUnavailable(error)) {
    return (
      <div className="mx-auto max-w-6xl space-y-6 p-6">
        <h1 className="text-xl font-semibold text-[var(--color-fg)]">General store</h1>
        <ModuleNotInEdition module="The general store" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-fg)]">General store</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            Consumables, linen and spares in this site&rsquo;s store room. Receive deliveries, issue
            to a department, and read the history behind every number.
          </p>
        </div>
        <div className="flex gap-2">
          {canSuppliers && (
            <Button variant="secondary" onClick={() => openFor("suppliers")}>
              Suppliers
            </Button>
          )}
          {canManage && <Button onClick={() => openFor("create")}>Add item</Button>}
        </div>
      </div>

      {(counts.out > 0 || counts.low > 0) && (
        <div className="flex flex-wrap gap-3 text-sm">
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

      {error != null && (
        <Alert tone="danger">
          {error instanceof ApiClientError ? error.message : "Could not load the store."}
        </Alert>
      )}

      {/* Asked before the work, not after it — see `ChooseBranch.tsx`. */}
      <ChooseBranchNotice action="receive, issue or correct stock" />

      <Card className="p-0">
        <div className="flex flex-wrap items-center gap-3 border-b border-[var(--color-border)] p-4">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or code…"
            aria-label="Search the store"
            className="w-full max-w-xs rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3.5 py-2 text-sm text-[var(--color-fg)] outline-none focus:border-[var(--color-brand-500)]"
          />
          <label className="flex items-center gap-2 text-sm text-[var(--color-fg-muted)]">
            <input
              type="checkbox"
              checked={lowOnly}
              onChange={(e) => setLowOnly(e.target.checked)}
            />
            Needs attention only
          </label>
        </div>

        <DataTable
          columns={columns}
          rows={visible}
          keyOf={(r) => r.id}
          loading={loading}
          empty="No items in the store list yet."
        />
      </Card>

      {modal === "create" && (
        <Modal title="Add an item" onClose={close} width="max-w-2xl">
          <ItemForm
            mode="create"
            saving={saving}
            error={formError}
            onSubmit={(d) =>
              void run(() =>
                api.createStoreItem({
                  code: d.code.trim(),
                  name: d.name.trim(),
                  category: d.category,
                  unit: d.unit,
                  ...(d.reorderLevel ? { reorderLevel: Number(d.reorderLevel) } : {}),
                }),
              )
            }
          />
        </Modal>
      )}

      {modal === "edit" && active && (
        <Modal title={`Edit ${active.name}`} onClose={close} width="max-w-2xl">
          <ItemForm
            mode="edit"
            initial={active}
            saving={saving}
            error={formError}
            onSubmit={(d) =>
              void run(() =>
                api.updateStoreItem(active.id, {
                  name: d.name.trim(),
                  category: d.category,
                  unit: d.unit,
                  reorderLevel: Number(d.reorderLevel) || 0,
                }),
              )
            }
          />
        </Modal>
      )}

      {modal === "receive" && active && (
        <Modal title={`Receive — ${active.name}`} onClose={close} width="max-w-2xl">
          <ReceiveForm
            row={active}
            suppliers={suppliers}
            saving={saving}
            error={formError}
            onSubmit={(input) =>
              void run(() => api.receiveStoreStock(active.id, input, crypto.randomUUID()))
            }
          />
        </Modal>
      )}

      {modal === "issue" && active && (
        <Modal title={`Issue — ${active.name}`} onClose={close} width="max-w-2xl">
          <IssueForm
            row={active}
            destinations={destinations}
            saving={saving}
            error={formError}
            onSubmit={(input) =>
              void run(() => api.issueStoreStock(active.id, input, crypto.randomUUID()))
            }
          />
        </Modal>
      )}

      {modal === "adjust" && active && (
        <Modal title={`Correct the count — ${active.name}`} onClose={close}>
          <AdjustForm
            row={active}
            saving={saving}
            error={formError}
            onSubmit={(input) =>
              void run(() => api.adjustStoreStock(active.id, input, crypto.randomUUID()))
            }
          />
        </Modal>
      )}

      {modal === "history" && active && (
        <Modal title={`Stock history — ${active.name}`} onClose={close} width="max-w-2xl">
          <MovementHistory movements={movements} />
        </Modal>
      )}

      {modal === "suppliers" && (
        <Modal title="Suppliers" onClose={close} width="max-w-2xl">
          <SupplierPanel
            suppliers={suppliers}
            canManage={canSuppliers}
            saving={saving}
            error={formError}
            onAdd={(input) => void run(() => api.createSupplier(input), "suppliers")}
          />
        </Modal>
      )}
    </div>
  );
}

export default function Page() {
  return <InventoryPage />;
}
