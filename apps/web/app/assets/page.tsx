"use client";

/**
 * Asset register & maintenance (Module B7).
 *
 * The equipment the hospital owns and must keep serviceable, and the history of every service on
 * each. The register flags what is DUE — an asset whose next-service date has passed or is near — so
 * the biomedical desk works from the board, not a spreadsheet. Everything here is `asset:manage`;
 * the nav only shows it to those who hold it.
 */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  type Asset,
  type AssetMaintenance,
  type AssetCategory,
  type AssetStatus,
  type MaintenanceType,
} from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import { useBranch } from "../../components/BranchProvider";
import { addDays, todayInZone } from "../../lib/day";
import { Badge, Button, Card, Field, ErrorAlert } from "../../components/ui";
import { rupees, toPaise } from "../../lib/money";

const CATEGORIES: { value: AssetCategory; label: string }[] = [
  { value: "biomedical", label: "Biomedical" },
  { value: "imaging", label: "Imaging" },
  { value: "it_equipment", label: "IT equipment" },
  { value: "furniture", label: "Furniture" },
  { value: "vehicle", label: "Vehicle" },
  { value: "hvac", label: "HVAC" },
  { value: "electrical", label: "Electrical" },
  { value: "other", label: "Other" },
];
const categoryLabel = (c: AssetCategory): string =>
  CATEGORIES.find((x) => x.value === c)?.label ?? c;

type StatusMeta = { value: AssetStatus; label: string; tone: "success" | "warning" | "neutral" };
const STATUSES: StatusMeta[] = [
  { value: "in_service", label: "In service", tone: "success" },
  { value: "under_maintenance", label: "Under maintenance", tone: "warning" },
  { value: "retired", label: "Retired", tone: "neutral" },
];
const statusMeta = (s: AssetStatus): StatusMeta =>
  STATUSES.find((x) => x.value === s) ?? { value: s, label: s, tone: "neutral" };

const MAINT_TYPES: { value: MaintenanceType; label: string }[] = [
  { value: "preventive", label: "Preventive" },
  { value: "repair", label: "Repair" },
  { value: "inspection", label: "Inspection" },
  { value: "calibration", label: "Calibration" },
];

function fmtDate(iso?: string): string {
  if (!iso) return "—";
  return new Date(iso + "T00:00:00").toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * How the register flags an asset's service state from its stored next-due date.
 *
 * `today` is passed in rather than read here: "is this overdue?" is answered against the SITE's
 * calendar, and a module-level helper cannot reach the branch. Thirty days ahead is counted in
 * whole days on the key, not by adding milliseconds — a DST day is 23 hours long and would drift.
 */
function serviceFlag(
  asset: Asset,
  today: string,
): { label: string; tone: "danger" | "warning" } | null {
  if (!asset.nextServiceDue || asset.status === "retired") return null;
  const due = asset.nextServiceDue;
  if (due <= today) return { label: "Service overdue", tone: "danger" };
  if (due <= addDays(today, 30)) return { label: "Service due soon", tone: "warning" };
  return null;
}

/* ── shared bits ───────────────────────────────────────────────────────────── */

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-xl">
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-3.5">
          <h2 className="font-semibold text-[var(--color-fg)]">{title}</h2>
          <button
            onClick={onClose}
            className="text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]"
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

function Select({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-[var(--color-fg)]">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3.5 py-2.5 text-sm outline-none transition-colors focus:border-[var(--color-brand-500)] focus:ring-2 focus:ring-[var(--color-brand-500)]/30"
      >
        {children}
      </select>
    </label>
  );
}

function DateInput({
  label,
  value,
  onChange,
  min,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  min?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-[var(--color-fg)]">{label}</span>
      <input
        type="date"
        value={value}
        min={min}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2.5 text-sm outline-none focus:border-[var(--color-brand-500)] focus:ring-2 focus:ring-[var(--color-brand-500)]/30"
      />
    </label>
  );
}

/* ── asset form ────────────────────────────────────────────────────────────── */

interface AssetFormValues {
  assetTag: string;
  name: string;
  category: AssetCategory;
  location?: string;
  manufacturer?: string;
  modelNumber?: string;
  serialNumber?: string;
  purchaseDate?: string;
  purchaseCost?: number;
  warrantyExpiry?: string;
  serviceIntervalDays?: number;
  nextServiceDue?: string;
}

function AssetForm({
  initial,
  onSubmit,
  saving,
  error,
}: {
  initial?: Asset;
  onSubmit: (v: AssetFormValues) => void;
  saving: boolean;
  error?: unknown;
}) {
  const [tag, setTag] = useState(initial?.assetTag ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [category, setCategory] = useState<AssetCategory>(initial?.category ?? "biomedical");
  const [location, setLocation] = useState(initial?.location ?? "");
  const [manufacturer, setManufacturer] = useState(initial?.manufacturer ?? "");
  const [modelNumber, setModelNumber] = useState(initial?.modelNumber ?? "");
  const [serialNumber, setSerialNumber] = useState(initial?.serialNumber ?? "");
  const [purchaseDate, setPurchaseDate] = useState(initial?.purchaseDate ?? "");
  const [cost, setCost] = useState(
    initial?.purchaseCost != null ? (initial.purchaseCost / 100).toString() : "",
  );
  const [warranty, setWarranty] = useState(initial?.warrantyExpiry ?? "");
  const [interval, setInterval] = useState(
    initial?.serviceIntervalDays != null ? initial.serviceIntervalDays.toString() : "",
  );
  const [nextDue, setNextDue] = useState(initial?.nextServiceDue ?? "");

  const opt = (s: string) => (s.trim() ? s.trim() : undefined);

  return (
    <form
      className="space-y-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSubmit({
          assetTag: tag.trim(),
          name: name.trim(),
          category,
          location: opt(location),
          manufacturer: opt(manufacturer),
          modelNumber: opt(modelNumber),
          serialNumber: opt(serialNumber),
          purchaseDate: opt(purchaseDate),
          ...(cost.trim() ? { purchaseCost: toPaise(cost) } : {}),
          warrantyExpiry: opt(warranty),
          ...(interval.trim() ? { serviceIntervalDays: Number(interval) } : {}),
          nextServiceDue: opt(nextDue),
        });
      }}
    >
      {error != null && <ErrorAlert error={error} fallback="Could not save the asset." />}
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Asset tag"
          name="assetTag"
          value={tag}
          onChange={(e) => setTag(e.target.value.toUpperCase())}
          placeholder="AST-001"
          required
          disabled={Boolean(initial)}
        />
        <Select label="Category" value={category} onChange={(v) => setCategory(v as AssetCategory)}>
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </Select>
      </div>
      <Field
        label="Name"
        name="name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Ventilator, Ward 3"
        required
      />
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Location"
          name="location"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="ICU"
        />
        <Field
          label="Manufacturer"
          name="manufacturer"
          value={manufacturer}
          onChange={(e) => setManufacturer(e.target.value)}
        />
        <Field
          label="Model"
          name="modelNumber"
          value={modelNumber}
          onChange={(e) => setModelNumber(e.target.value)}
        />
        <Field
          label="Serial number"
          name="serialNumber"
          value={serialNumber}
          onChange={(e) => setSerialNumber(e.target.value)}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <DateInput label="Purchase date" value={purchaseDate} onChange={setPurchaseDate} />
        <Field
          label="Purchase cost (₹)"
          name="purchaseCost"
          type="number"
          value={cost}
          onChange={(e) => setCost(e.target.value)}
          placeholder="0"
        />
        <DateInput label="Warranty expiry" value={warranty} onChange={setWarranty} />
        <Field
          label="Service every (days)"
          name="serviceIntervalDays"
          type="number"
          value={interval}
          onChange={(e) => setInterval(e.target.value)}
          placeholder="e.g. 90"
        />
      </div>
      <DateInput label="Next service due" value={nextDue} onChange={setNextDue} />
      <div className="flex justify-end">
        <Button type="submit" loading={saving}>
          {initial ? "Save asset" : "Add asset"}
        </Button>
      </div>
    </form>
  );
}

/* ── maintenance panel ─────────────────────────────────────────────────────── */

function MaintenancePanel({ asset, onLogged }: { asset: Asset; onLogged: () => void }) {
  const { api } = useAuth();
  const { timezone } = useBranch();
  const [history, setHistory] = useState<AssetMaintenance[]>([]);
  const [loading, setLoading] = useState(true);
  const [type, setType] = useState<MaintenanceType>("preventive");
  const [performedOn, setPerformedOn] = useState(() => todayInZone(timezone));
  const [performedBy, setPerformedBy] = useState("");
  const [cost, setCost] = useState("");
  const [notes, setNotes] = useState("");
  const [nextDue, setNextDue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(() => {
    setLoading(true);
    api
      .listAssetMaintenance(asset.id)
      .then(setHistory)
      .catch((e: unknown) => setError(e))
      .finally(() => setLoading(false));
  }, [api, asset.id]);
  useEffect(load, [load]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.addAssetMaintenance(asset.id, {
        type,
        performedOn,
        ...(performedBy.trim() ? { performedBy: performedBy.trim() } : {}),
        ...(cost.trim() ? { cost: toPaise(cost) } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        ...(nextDue ? { nextServiceDue: nextDue } : {}),
      });
      setPerformedBy("");
      setCost("");
      setNotes("");
      setNextDue("");
      load();
      onLogged();
    } catch (e2) {
      setError(e2);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <form className="space-y-3" onSubmit={submit}>
        {error != null && <ErrorAlert error={error} fallback="Could not log the service." />}
        <div className="grid grid-cols-2 gap-3">
          <Select label="Type" value={type} onChange={(v) => setType(v as MaintenanceType)}>
            {MAINT_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
          <DateInput label="Performed on" value={performedOn} onChange={setPerformedOn} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Performed by"
            name="performedBy"
            value={performedBy}
            onChange={(e) => setPerformedBy(e.target.value)}
            placeholder="Engineer / vendor"
          />
          <Field
            label="Cost (₹)"
            name="cost"
            type="number"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
            placeholder="0"
          />
        </div>
        <Field
          label="Notes"
          name="notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="What was done"
        />
        <DateInput label="Next service due (optional)" value={nextDue} onChange={setNextDue} />
        <div className="flex justify-end">
          <Button type="submit" loading={saving}>
            Log service
          </Button>
        </div>
      </form>

      <div className="border-t border-[var(--color-border)] pt-4">
        <h3 className="mb-2 text-sm font-semibold text-[var(--color-fg)]">History</h3>
        {loading ? (
          <p className="text-sm text-[var(--color-fg-subtle)]">Loading…</p>
        ) : history.length === 0 ? (
          <p className="text-sm text-[var(--color-fg-subtle)]">No services logged yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {history.map((m) => (
              <li
                key={m.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-3 py-2 text-sm"
              >
                <span className="text-[var(--color-fg)]">
                  <span className="font-medium capitalize">{m.type}</span> ·{" "}
                  {fmtDate(m.performedOn)}
                  {m.performedBy && (
                    <span className="text-[var(--color-fg-subtle)]"> · {m.performedBy}</span>
                  )}
                </span>
                <span className="text-[var(--color-fg-muted)]">
                  {m.cost != null && <span className="mr-2 tabular-nums">{rupees(m.cost)}</span>}
                  {m.nextServiceDue && (
                    <span className="text-xs">next {fmtDate(m.nextServiceDue)}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/* ── page ──────────────────────────────────────────────────────────────────── */

type ModalState =
  | { kind: "create" }
  | { kind: "edit"; asset: Asset }
  | { kind: "maintenance"; asset: Asset }
  | null;

function AssetsPage() {
  const { api } = useAuth();
  const { timezone } = useBranch();
  const today = todayInZone(timezone);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [statusFilter, setStatusFilter] = useState<"" | AssetStatus>("");
  const [categoryFilter, setCategoryFilter] = useState<"" | AssetCategory>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<unknown>(null);

  const load = useCallback(() => {
    setLoading(true);
    api
      .listAssets({
        ...(statusFilter ? { status: statusFilter } : {}),
        ...(categoryFilter ? { category: categoryFilter } : {}),
      })
      .then(setAssets)
      .catch((e: unknown) => setError(e))
      .finally(() => setLoading(false));
  }, [api, statusFilter, categoryFilter]);
  useEffect(load, [load]);

  async function run(fn: () => Promise<unknown>) {
    setSaving(true);
    setFormError(null);
    try {
      await fn();
      setModal(null);
      load();
    } catch (e) {
      setFormError(e);
    } finally {
      setSaving(false);
    }
  }

  const dueCount = assets.filter((a) => serviceFlag(a, today)).length;

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-fg)]">Assets</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            The equipment the hospital owns and its service history.
            {dueCount > 0 && (
              <span className="ml-1 text-[var(--color-danger)]">{dueCount} due for service.</span>
            )}
          </p>
        </div>
        <Button
          onClick={() => {
            setFormError(null);
            setModal({ kind: "create" });
          }}
        >
          Add asset
        </Button>
      </div>

      <Card className="flex flex-wrap gap-3 p-4">
        <div className="min-w-40">
          <Select
            label="Status"
            value={statusFilter}
            onChange={(v) => setStatusFilter(v as "" | AssetStatus)}
          >
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="min-w-40">
          <Select
            label="Category"
            value={categoryFilter}
            onChange={(v) => setCategoryFilter(v as "" | AssetCategory)}
          >
            <option value="">All categories</option>
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>
        </div>
      </Card>

      {error != null && <ErrorAlert error={error} fallback="Could not load assets." />}

      {loading ? (
        <p className="py-8 text-center text-sm text-[var(--color-fg-muted)]">Loading…</p>
      ) : assets.length === 0 ? (
        <Card className="p-10 text-center">
          <p className="text-sm text-[var(--color-fg-muted)]">
            No assets yet. Add one to start the register.
          </p>
        </Card>
      ) : (
        <div className="space-y-2">
          {assets.map((a) => {
            const st = statusMeta(a.status);
            const flag = serviceFlag(a, today);
            return (
              <Card key={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
                <div className="min-w-40 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs font-semibold text-[var(--color-fg)]">
                      {a.assetTag}
                    </span>
                    <span className="font-medium text-[var(--color-fg)]">{a.name}</span>
                    <Badge tone="neutral">{categoryLabel(a.category)}</Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-[var(--color-fg-subtle)]">
                    {a.location ? `${a.location} · ` : ""}
                    {a.manufacturer ?? ""}
                    {a.modelNumber ? ` ${a.modelNumber}` : ""}
                  </p>
                </div>
                <div className="flex flex-col items-end text-right text-xs text-[var(--color-fg-muted)]">
                  <span>Next service: {fmtDate(a.nextServiceDue)}</span>
                  {a.warrantyExpiry && <span>Warranty: {fmtDate(a.warrantyExpiry)}</span>}
                </div>
                <div className="flex items-center gap-2">
                  {flag && <Badge tone={flag.tone}>{flag.label}</Badge>}
                  <Badge tone={st.tone}>{st.label}</Badge>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setFormError(null);
                      setModal({ kind: "maintenance", asset: a });
                    }}
                  >
                    Maintenance
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setFormError(null);
                      setModal({ kind: "edit", asset: a });
                    }}
                  >
                    Edit
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {modal?.kind === "create" && (
        <Modal title="Add asset" onClose={() => setModal(null)}>
          <AssetForm
            saving={saving}
            error={formError}
            onSubmit={(v) => void run(() => api.createAsset(v))}
          />
        </Modal>
      )}
      {modal?.kind === "edit" && (
        <Modal title={`Edit ${modal.asset.assetTag}`} onClose={() => setModal(null)}>
          <AssetForm
            initial={modal.asset}
            saving={saving}
            error={formError}
            onSubmit={(v) => {
              // The tag is the immutable key — never sent on an edit.
              const { assetTag: _tag, ...patch } = v;
              void run(() => api.updateAsset(modal.asset.id, patch));
            }}
          />
          <div className="mt-4 flex flex-wrap gap-2 border-t border-[var(--color-border)] pt-4">
            {modal.asset.status !== "in_service" && (
              <Button
                variant="ghost"
                onClick={() =>
                  void run(() => api.updateAsset(modal.asset.id, { status: "in_service" }))
                }
              >
                Return to service
              </Button>
            )}
            {modal.asset.status !== "under_maintenance" && (
              <Button
                variant="ghost"
                onClick={() =>
                  void run(() => api.updateAsset(modal.asset.id, { status: "under_maintenance" }))
                }
              >
                Mark under maintenance
              </Button>
            )}
            {modal.asset.status !== "retired" && (
              <Button
                variant="ghost"
                onClick={() =>
                  void run(() => api.updateAsset(modal.asset.id, { status: "retired" }))
                }
              >
                Retire
              </Button>
            )}
          </div>
        </Modal>
      )}
      {modal?.kind === "maintenance" && (
        <Modal
          title={`Maintenance · ${modal.asset.assetTag} ${modal.asset.name}`}
          onClose={() => setModal(null)}
        >
          <MaintenancePanel asset={modal.asset} onLogged={load} />
        </Modal>
      )}
    </div>
  );
}

export default function Page() {
  return <AssetsPage />;
}
