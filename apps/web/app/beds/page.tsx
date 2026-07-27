"use client";

/**
 * Bed board & inventory (Module B4) — where there is space, and the catalogue behind it.
 *
 * The board is the free-and-occupied view every ward needs before admitting: which beds are open,
 * who is in the taken ones, and which are out of service. It reads `emr:read`, so a doctor about to
 * admit and a nurse working the ward both see it. The INVENTORY behind it — adding a ward, adding or
 * blocking a bed — is an administrative act (`bed:manage`), shown only to those who hold it.
 *
 * Occupancy is not stored on a bed; it is derived on the server from the open inpatient encounters
 * (see the wards module). This screen only renders what the board hands it.
 */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  type BedBoard,
  type BedBoardBed,
  type Ward,
  type InventoryBed,
  type WardKind,
} from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import { Protected } from "../../components/Protected";
import { Badge, Button, Card, Field, ErrorAlert } from "../../components/ui";

const WARD_KINDS: { value: WardKind; label: string }[] = [
  { value: "general", label: "General ward" },
  { value: "semi_private", label: "Semi-private" },
  { value: "private", label: "Private room" },
  { value: "icu", label: "ICU" },
  { value: "nicu", label: "NICU" },
  { value: "picu", label: "PICU" },
  { value: "hdu", label: "HDU" },
  { value: "maternity", label: "Maternity" },
  { value: "emergency", label: "Emergency" },
  { value: "isolation", label: "Isolation" },
  { value: "daycare", label: "Day care" },
];
const kindLabel = (k: WardKind): string => WARD_KINDS.find((x) => x.value === k)?.label ?? k;

function daysIn(admittedAt?: string): number {
  if (!admittedAt) return 0;
  const ms = Date.now() - new Date(admittedAt).getTime();
  return Math.max(1, Math.floor(ms / 86_400_000) + 1);
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

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="flex flex-col">
      <span className={`text-2xl font-semibold tabular-nums ${tone}`}>{value}</span>
      <span className="text-xs tracking-wide text-[var(--color-fg-subtle)] uppercase">{label}</span>
    </div>
  );
}

/* ── the board ─────────────────────────────────────────────────────────────── */

function BedTile({ bed }: { bed: BedBoardBed }) {
  if (bed.state === "occupied" && bed.occupant) {
    return (
      <div className="rounded-lg border border-[var(--color-brand-500)]/40 bg-[var(--color-brand-50)] p-2.5">
        <div className="flex items-center justify-between gap-1">
          <span className="font-mono text-xs font-semibold text-[var(--color-fg)]">{bed.code}</span>
          <Badge tone="brand">Day {daysIn(bed.occupant.admittedAt)}</Badge>
        </div>
        <p
          className="mt-1 truncate text-sm font-medium text-[var(--color-fg)]"
          title={bed.occupant.patientName}
        >
          {bed.occupant.patientName}
        </p>
        <p className="truncate font-mono text-[11px] text-[var(--color-fg-subtle)]">
          {bed.occupant.uhid}
        </p>
      </div>
    );
  }
  if (bed.state === "blocked") {
    return (
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-2.5 opacity-70">
        <div className="flex items-center justify-between gap-1">
          <span className="font-mono text-xs font-semibold text-[var(--color-fg-muted)]">
            {bed.code}
          </span>
          <Badge tone="neutral">Blocked</Badge>
        </div>
        <p
          className="mt-1 truncate text-xs text-[var(--color-fg-subtle)]"
          title={bed.blockedReason}
        >
          {bed.blockedReason ?? "Out of service"}
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-dashed border-[var(--color-success)]/40 bg-[var(--color-success-bg)] p-2.5">
      <div className="flex items-center justify-between gap-1">
        <span className="font-mono text-xs font-semibold text-[var(--color-fg)]">{bed.code}</span>
        <Badge tone="success">Free</Badge>
      </div>
      <p className="mt-1 text-xs text-[var(--color-fg-subtle)]">{bed.room ?? "Available"}</p>
    </div>
  );
}

function Board({ board }: { board: BedBoard }) {
  return (
    <div className="space-y-6">
      <Card className="p-5">
        <div className="flex flex-wrap gap-8">
          <Stat label="Beds" value={board.totals.total} tone="text-[var(--color-fg)]" />
          <Stat label="Free" value={board.totals.free} tone="text-[var(--color-success)]" />
          <Stat
            label="Occupied"
            value={board.totals.occupied}
            tone="text-[var(--color-brand-600)]"
          />
          <Stat label="Blocked" value={board.totals.blocked} tone="text-[var(--color-fg-muted)]" />
        </div>
      </Card>

      {board.wards.length === 0 ? (
        <Card className="p-10 text-center">
          <p className="text-sm text-[var(--color-fg-muted)]">
            No wards yet. Add a ward and its beds to see the board fill in.
          </p>
        </Card>
      ) : (
        board.wards.map((w) => (
          <Card key={w.wardId} className={`p-5 ${w.status === "inactive" ? "opacity-60" : ""}`}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <h2 className="font-semibold text-[var(--color-fg)]">{w.name}</h2>
                <Badge tone="neutral">{kindLabel(w.kind)}</Badge>
                {w.status === "inactive" && <Badge tone="warning">Retired</Badge>}
              </div>
              <p className="text-xs text-[var(--color-fg-subtle)]">
                {w.counts.free} free · {w.counts.occupied} occupied · {w.counts.blocked} blocked
              </p>
            </div>
            {w.beds.length === 0 ? (
              <p className="py-4 text-center text-sm text-[var(--color-fg-subtle)]">
                No beds in this ward yet.
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                {w.beds.map((b) => (
                  <BedTile key={b.bedId} bed={b} />
                ))}
              </div>
            )}
          </Card>
        ))
      )}

      {board.unlisted.length > 0 && (
        <Card className="border-[var(--color-warning)]/30 p-5">
          <h2 className="mb-1 font-semibold text-[var(--color-fg)]">
            Admitted in an uncatalogued bed
          </h2>
          <p className="mb-3 text-xs text-[var(--color-fg-muted)]">
            These stays record a bed the inventory does not know — add that ward and bed so they
            appear on the board.
          </p>
          <ul className="space-y-1.5 text-sm">
            {board.unlisted.map((u) => (
              <li key={u.encounterId} className="flex flex-wrap justify-between gap-2">
                <span className="font-medium text-[var(--color-fg)]">
                  {u.patientName}{" "}
                  <span className="font-mono text-xs text-[var(--color-fg-subtle)]">{u.uhid}</span>
                </span>
                <span className="text-[var(--color-fg-muted)]">
                  {u.ward} · {u.bedCode} · day {daysIn(u.admittedAt)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/* ── the inventory (manage) ──────────────────────────────────────────────────── */

function WardForm({
  initial,
  onSubmit,
  saving,
  error,
}: {
  initial?: Ward;
  onSubmit: (f: { name: string; kind: WardKind; tariffCode: string }) => void;
  saving: boolean;
  error?: unknown;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState<WardKind>(initial?.kind ?? "general");
  const [tariffCode, setTariffCode] = useState(initial?.tariffCode ?? "BED_GEN");
  return (
    <form
      className="space-y-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSubmit({ name: name.trim(), kind, tariffCode: tariffCode.trim() });
      }}
    >
      {error != null && <ErrorAlert error={error} fallback="Could not save the ward." />}
      <Field
        label="Ward name"
        name="name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="General Ward"
        required
      />
      <Select label="Kind" value={kind} onChange={(v) => setKind(v as WardKind)}>
        {WARD_KINDS.map((k) => (
          <option key={k.value} value={k.value}>
            {k.label}
          </option>
        ))}
      </Select>
      <Field
        label="Default bed-day tariff"
        name="tariffCode"
        value={tariffCode}
        onChange={(e) => setTariffCode(e.target.value.toUpperCase())}
        hint="The tariff code the bed-day bills at — e.g. BED_GEN, BED_ICU. A bed can override it."
        required
      />
      <div className="flex justify-end">
        <Button type="submit" loading={saving}>
          {initial ? "Save ward" : "Add ward"}
        </Button>
      </div>
    </form>
  );
}

function BedForm({
  wardId,
  initial,
  onSubmit,
  saving,
  error,
}: {
  wardId: string;
  initial?: InventoryBed;
  onSubmit: (f: { wardId: string; code: string; room?: string; tariffCode?: string }) => void;
  saving: boolean;
  error?: unknown;
}) {
  const [code, setCode] = useState(initial?.code ?? "");
  const [room, setRoom] = useState(initial?.room ?? "");
  const [tariffCode, setTariffCode] = useState(initial?.tariffCode ?? "");
  return (
    <form
      className="space-y-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSubmit({
          wardId,
          code: code.trim(),
          ...(room.trim() ? { room: room.trim() } : {}),
          ...(tariffCode.trim() ? { tariffCode: tariffCode.trim() } : {}),
        });
      }}
    >
      {error != null && <ErrorAlert error={error} fallback="Could not save the bed." />}
      <Field
        label="Bed code"
        name="code"
        value={code}
        onChange={(e) => setCode(e.target.value.toUpperCase())}
        placeholder="A-12"
        required
      />
      <Field
        label="Room / bay (optional)"
        name="room"
        value={room}
        onChange={(e) => setRoom(e.target.value)}
        placeholder="Room 4"
      />
      <Field
        label="Tariff override (optional)"
        name="tariffCode"
        value={tariffCode}
        onChange={(e) => setTariffCode(e.target.value.toUpperCase())}
        hint="Leave blank to bill at the ward's rate."
      />
      <div className="flex justify-end">
        <Button type="submit" loading={saving}>
          {initial ? "Save bed" : "Add bed"}
        </Button>
      </div>
    </form>
  );
}

type ModalState =
  | { kind: "ward-create" }
  | { kind: "ward-edit"; ward: Ward }
  | { kind: "bed-create"; wardId: string; wardName: string }
  | { kind: "bed-edit"; bed: InventoryBed }
  | null;

function Manage() {
  const { api } = useAuth();
  const [wards, setWards] = useState<Ward[]>([]);
  const [beds, setBeds] = useState<InventoryBed[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<unknown>(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([api.listWards(), api.listBeds()])
      .then(([w, b]) => {
        setWards(w);
        setBeds(b);
      })
      .catch((e: unknown) => setError(e))
      .finally(() => setLoading(false));
  }, [api]);

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

  function toggleBed(b: InventoryBed) {
    if (b.status === "available") {
      const reason = window.prompt(
        "Why is this bed out of service? (cleaning, maintenance, reserved)",
      );
      if (!reason || !reason.trim()) return;
      void run(() => api.updateBed(b.id, { status: "blocked", blockedReason: reason.trim() }));
    } else {
      void run(() => api.updateBed(b.id, { status: "available" }));
    }
  }

  if (loading)
    return <p className="py-8 text-center text-sm text-[var(--color-fg-muted)]">Loading…</p>;

  return (
    <div className="space-y-6">
      {error != null && <ErrorAlert error={error} fallback="Could not load the inventory." />}

      <div className="flex justify-end">
        <Button
          onClick={() => {
            setFormError(null);
            setModal({ kind: "ward-create" });
          }}
        >
          Add ward
        </Button>
      </div>

      {wards.length === 0 ? (
        <Card className="p-10 text-center">
          <p className="text-sm text-[var(--color-fg-muted)]">
            No wards yet. Add one to start building the inventory.
          </p>
        </Card>
      ) : (
        wards.map((w) => {
          const wardBeds = beds.filter((b) => b.wardId === w.id);
          return (
            <Card key={w.id} className={`p-5 ${w.status === "inactive" ? "opacity-60" : ""}`}>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <h2 className="font-semibold text-[var(--color-fg)]">{w.name}</h2>
                  <Badge tone="neutral">{kindLabel(w.kind)}</Badge>
                  <span className="font-mono text-xs text-[var(--color-fg-subtle)]">
                    {w.tariffCode}
                  </span>
                  {w.status === "inactive" && <Badge tone="warning">Retired</Badge>}
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setFormError(null);
                      setModal({ kind: "ward-edit", ward: w });
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setFormError(null);
                      setModal({ kind: "bed-create", wardId: w.id, wardName: w.name });
                    }}
                  >
                    Add bed
                  </Button>
                </div>
              </div>
              {wardBeds.length === 0 ? (
                <p className="py-3 text-center text-sm text-[var(--color-fg-subtle)]">
                  No beds yet.
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {wardBeds.map((b) => (
                    <div
                      key={b.id}
                      className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-3 py-2"
                    >
                      <span className="font-mono text-xs font-semibold text-[var(--color-fg)]">
                        {b.code}
                      </span>
                      {b.room && (
                        <span className="text-xs text-[var(--color-fg-subtle)]">{b.room}</span>
                      )}
                      {b.status === "blocked" && <Badge tone="neutral">Blocked</Badge>}
                      <button
                        className="text-xs text-[var(--color-brand-600)] hover:underline"
                        onClick={() => {
                          setFormError(null);
                          setModal({ kind: "bed-edit", bed: b });
                        }}
                      >
                        Edit
                      </button>
                      <button
                        className="text-xs text-[var(--color-fg-muted)] hover:underline"
                        onClick={() => toggleBed(b)}
                      >
                        {b.status === "available" ? "Block" : "Unblock"}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          );
        })
      )}

      {modal?.kind === "ward-create" && (
        <Modal title="Add ward" onClose={() => setModal(null)}>
          <WardForm
            saving={saving}
            error={formError}
            onSubmit={(f) => void run(() => api.createWard(f))}
          />
        </Modal>
      )}
      {modal?.kind === "ward-edit" && (
        <Modal title={`Edit ${modal.ward.name}`} onClose={() => setModal(null)}>
          <WardForm
            initial={modal.ward}
            saving={saving}
            error={formError}
            onSubmit={(f) => void run(() => api.updateWard(modal.ward.id, f))}
          />
          <div className="mt-4 border-t border-[var(--color-border)] pt-4">
            <Button
              variant="ghost"
              onClick={() =>
                void run(() =>
                  api.updateWard(modal.ward.id, {
                    status: modal.ward.status === "active" ? "inactive" : "active",
                  }),
                )
              }
            >
              {modal.ward.status === "active" ? "Retire this ward" : "Reactivate this ward"}
            </Button>
          </div>
        </Modal>
      )}
      {modal?.kind === "bed-create" && (
        <Modal title={`Add bed to ${modal.wardName}`} onClose={() => setModal(null)}>
          <BedForm
            wardId={modal.wardId}
            saving={saving}
            error={formError}
            onSubmit={(f) => void run(() => api.createBed(f))}
          />
        </Modal>
      )}
      {modal?.kind === "bed-edit" && (
        <Modal title={`Edit bed ${modal.bed.code}`} onClose={() => setModal(null)}>
          <BedForm
            wardId={modal.bed.wardId}
            initial={modal.bed}
            saving={saving}
            error={formError}
            onSubmit={(f) =>
              void run(() =>
                api.updateBed(modal.bed.id, {
                  code: f.code,
                  room: f.room ?? "",
                  tariffCode: f.tariffCode ?? "",
                }),
              )
            }
          />
        </Modal>
      )}
    </div>
  );
}

/* ── page ──────────────────────────────────────────────────────────────────── */

function BedsPage() {
  const { api, can } = useAuth();
  const canManage = can("bed:manage");
  const [view, setView] = useState<"board" | "manage">("board");
  const [board, setBoard] = useState<BedBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const loadBoard = useCallback(() => {
    setLoading(true);
    api
      .bedBoard()
      .then(setBoard)
      .catch((e: unknown) => setError(e))
      .finally(() => setLoading(false));
  }, [api]);

  useEffect(() => {
    if (view === "board") loadBoard();
  }, [view, loadBoard]);

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-fg)]">Bed board</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            Which beds are free, who is in the taken ones, and which are out of service.
          </p>
        </div>
        {canManage && (
          <div className="inline-flex rounded-lg border border-[var(--color-border)] p-0.5">
            <button
              onClick={() => setView("board")}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${view === "board" ? "bg-[var(--color-brand-50)] text-[var(--color-brand-700)]" : "text-[var(--color-fg-muted)]"}`}
            >
              Board
            </button>
            <button
              onClick={() => setView("manage")}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${view === "manage" ? "bg-[var(--color-brand-50)] text-[var(--color-brand-700)]" : "text-[var(--color-fg-muted)]"}`}
            >
              Wards &amp; beds
            </button>
          </div>
        )}
      </div>

      {view === "manage" && canManage ? (
        <Manage />
      ) : loading ? (
        <p className="py-8 text-center text-sm text-[var(--color-fg-muted)]">Loading…</p>
      ) : error != null ? (
        <ErrorAlert error={error} fallback="Could not load the bed board." />
      ) : board ? (
        <Board board={board} />
      ) : null}
    </div>
  );
}

export default function Page() {
  return (
    <Protected>
      <BedsPage />
    </Protected>
  );
}
