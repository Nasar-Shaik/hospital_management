"use client";

/**
 * The service tariff — the hospital's price list (needs `tariff:manage`).
 *
 * Where an administrator DEFINES what things cost: consultations, tests, X-rays, procedures.
 * Every order and every charge carries a code, and the price the patient is billed is the one
 * set here — so this is the single screen that decides the number on the bill, kept apart from
 * the counters that only read it.
 *
 * A code, once created, is frozen: it is the key an order matches on, and renaming it would
 * orphan the charges already raised against it. To stop offering something, retire it — the
 * history keeps its price, but the doctor's order pad no longer lists it.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ApiClientError, type ChargeCategory, type TariffItem } from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import { Alert, Badge, Button, Card, Field } from "../../components/ui";
import { rupees, toPaise } from "../../lib/money";

const CATEGORIES: { value: ChargeCategory; label: string }[] = [
  { value: "consultation", label: "Consultation" },
  { value: "lab", label: "Lab" },
  { value: "radiology", label: "Radiology" },
  { value: "pharmacy", label: "Pharmacy" },
  { value: "procedure", label: "Procedure" },
  { value: "bed", label: "Bed" },
  { value: "other", label: "Other" },
];
const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(
  CATEGORIES.map((c) => [c.value, c.label]),
);

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-3">
          <h2 className="text-sm font-semibold text-[var(--color-fg)]">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="max-h-[75vh] overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

interface TariffForm {
  code: string;
  name: string;
  category: ChargeCategory;
  price: string; // rupees, as typed
  followUpDays: string; // days, as typed — consultation entries only
}

function TariffFormFields({
  mode,
  initial,
  onSubmit,
  saving,
  error,
}: {
  mode: "create" | "edit";
  initial?: TariffItem;
  onSubmit: (f: TariffForm) => void;
  saving: boolean;
  error?: string;
}) {
  const [f, setF] = useState<TariffForm>(() => ({
    code: initial?.code ?? "",
    name: initial?.name ?? "",
    category: initial?.category ?? "procedure",
    price: initial ? String(initial.price / 100) : "",
    followUpDays: initial?.followUpDays ? String(initial.followUpDays) : "",
  }));
  const set = (patch: Partial<TariffForm>) => setF((prev) => ({ ...prev, ...patch }));

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
          hint={mode === "edit" ? "The code cannot change — orders match on it." : "e.g. LAB_LFT"}
          required
        />
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-[var(--color-fg)]">Category</span>
          <select
            value={f.category}
            onChange={(e) => set({ category: e.target.value as ChargeCategory })}
            disabled={mode === "edit"}
            className="w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3.5 py-2.5 text-sm text-[var(--color-fg)] disabled:opacity-60"
          >
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <Field
          label="Name"
          name="name"
          value={f.name}
          onChange={(e) => set({ name: e.target.value })}
          required
        />
        <Field
          label="Price (₹)"
          name="price"
          type="number"
          min={0}
          step="1"
          value={f.price}
          onChange={(e) => set({ price: e.target.value })}
          hint="0 is valid — a government hospital's tariff is all zeros."
          required
        />
        {/*
          Only a consultation can grant a free revisit, so the field appears only there rather than
          sitting inert on every X-ray and drug in the price list.
        */}
        {f.category === "consultation" && (
          <Field
            label="OP validity (days)"
            name="followUpDays"
            type="number"
            min={0}
            max={365}
            step="1"
            value={f.followUpDays}
            onChange={(e) => set({ followUpDays: e.target.value })}
            hint="Revisits to the SAME doctor within this many days are free. Blank or 0 = charge every visit."
          />
        )}
      </div>
      <div className="flex justify-end">
        <Button type="submit" loading={saving}>
          {mode === "create" ? "Add to tariff" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}

function TariffPage() {
  const { api, can } = useAuth();
  const canManage = can("tariff:manage");

  const [items, setItems] = useState<TariffItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<ChargeCategory | "">("");

  const [modal, setModal] = useState<"create" | "edit" | null>(null);
  const [active, setActive] = useState<TariffItem | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | undefined>(undefined);

  const load = useCallback(() => {
    setLoading(true);
    api
      .listTariff(categoryFilter ? { category: categoryFilter } : {})
      .then((r) => {
        setItems(r);
        setError(null);
      })
      .catch((e: unknown) =>
        setError(e instanceof ApiClientError ? e.message : "Could not load the tariff"),
      )
      .finally(() => setLoading(false));
  }, [api, categoryFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (i) => i.name.toLowerCase().includes(q) || i.code.toLowerCase().includes(q),
    );
  }, [items, query]);

  async function run(action: () => Promise<unknown>) {
    setSaving(true);
    setFormError(undefined);
    try {
      await action();
      setModal(null);
      setActive(null);
      load();
    } catch (e) {
      setFormError(e instanceof ApiClientError ? e.message : "Something went wrong");
    } finally {
      setSaving(false);
    }
  }

  /**
   * The validity window as a number the API will accept. Only consultations carry one, and a blank
   * box means "no free follow-up" — sent as 0 rather than omitted so CLEARING the field on an entry
   * that had 15 days actually turns the entitlement off instead of silently leaving it in place.
   */
  function followUpOf(f: TariffForm): number {
    if (f.category !== "consultation") return 0;
    const n = Number(f.followUpDays);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  function submitCreate(f: TariffForm) {
    void run(() =>
      api.createTariff({
        code: f.code.trim(),
        name: f.name.trim(),
        category: f.category,
        price: toPaise(f.price),
        followUpDays: followUpOf(f),
      }),
    );
  }
  function submitEdit(f: TariffForm) {
    if (!active) return;
    void run(() =>
      api.updateTariff(active.id, {
        name: f.name.trim(),
        price: toPaise(f.price),
        followUpDays: followUpOf(f),
      }),
    );
  }
  function toggleActive(item: TariffItem) {
    void run(() => api.updateTariff(item.id, { active: !item.active }));
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--color-fg)]">Service tariff</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            The hospital's price list — consultations, tests, X-rays, procedures. The price set here
            is the one a patient is billed.
          </p>
        </div>
        {canManage && (
          <Button
            onClick={() => {
              setActive(null);
              setFormError(undefined);
              setModal("create");
            }}
          >
            Add service
          </Button>
        )}
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-[var(--color-border)] p-4">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or code…"
            className="w-full max-w-xs rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3.5 py-2 text-sm text-[var(--color-fg)] outline-none focus:border-[var(--color-brand-500)]"
          />
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value as ChargeCategory | "")}
            className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm text-[var(--color-fg)]"
          >
            <option value="">All categories</option>
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-[var(--color-border)] text-xs tracking-wide text-[var(--color-fg-subtle)] uppercase">
              <tr>
                <th className="px-4 py-3 font-medium">Service</th>
                <th className="px-4 py-3 font-medium">Code</th>
                <th className="px-4 py-3 font-medium">Category</th>
                <th className="px-4 py-3 text-right font-medium">Price</th>
                <th className="px-4 py-3 font-medium">Status</th>
                {canManage && <th className="px-4 py-3 text-right font-medium">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-[var(--color-fg-muted)]">
                    Loading…
                  </td>
                </tr>
              ) : visible.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-[var(--color-fg-muted)]">
                    No services yet. Add the first with “Add service”.
                  </td>
                </tr>
              ) : (
                visible.map((i) => (
                  <tr
                    key={i.id}
                    className={`hover:bg-[var(--color-bg-subtle)] ${i.active ? "" : "opacity-60"}`}
                  >
                    <td className="px-4 py-3 font-medium text-[var(--color-fg)]">
                      {i.name}
                      {/* The validity is part of what this fee BUYS, so it reads next to the name. */}
                      {i.followUpDays ? (
                        <span className="ml-2 align-middle">
                          <Badge tone="brand">{i.followUpDays}-day follow-up</Badge>
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-[var(--color-fg-muted)]">
                      {i.code}
                    </td>
                    <td className="px-4 py-3 text-[var(--color-fg-muted)]">
                      {CATEGORY_LABEL[i.category] ?? i.category}
                    </td>
                    <td className="px-4 py-3 text-right font-medium">{rupees(i.price)}</td>
                    <td className="px-4 py-3">
                      <Badge tone={i.active ? "success" : "neutral"}>
                        {i.active ? "Active" : "Retired"}
                      </Badge>
                    </td>
                    {canManage && (
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            onClick={() => {
                              setActive(i);
                              setFormError(undefined);
                              setModal("edit");
                            }}
                          >
                            Edit
                          </Button>
                          <Button variant="ghost" onClick={() => toggleActive(i)}>
                            {i.active ? "Retire" : "Restore"}
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
        <Modal title="Add service" onClose={() => setModal(null)}>
          <TariffFormFields
            mode="create"
            onSubmit={submitCreate}
            saving={saving}
            error={formError}
          />
        </Modal>
      )}
      {modal === "edit" && active && (
        <Modal title={`Edit ${active.name}`} onClose={() => setModal(null)}>
          <TariffFormFields
            mode="edit"
            initial={active}
            onSubmit={submitEdit}
            saving={saving}
            error={formError}
          />
        </Modal>
      )}
    </div>
  );
}

export default function Page() {
  return <TariffPage />;
}
