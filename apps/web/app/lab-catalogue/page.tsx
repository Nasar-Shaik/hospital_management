"use client";

/**
 * Lab test catalogue (Module D6 / LIS depth) — the laboratory's service master.
 *
 * Each test is defined ONCE here, with its analytes and reference ranges, so ordering names a real
 * test and result entry pre-fills the grid and flags the numbers instead of a technician re-typing
 * ranges from memory. Reading is `order:read` (anyone who works a worklist); defining a test is the
 * pathologist's `lab:approve`.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { type LabTest, type Analyte } from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import { Badge, Button, Card, Field, ErrorAlert } from "../../components/ui";

type AnalyteRow = {
  code: string;
  label: string;
  unit: string;
  refLow: string;
  refHigh: string;
  refText: string;
};

const emptyRow: AnalyteRow = {
  code: "",
  label: "",
  unit: "",
  refLow: "",
  refHigh: "",
  refText: "",
};

function toRow(a: Analyte): AnalyteRow {
  return {
    code: a.code,
    label: a.label,
    unit: a.unit ?? "",
    refLow: a.refLow != null ? String(a.refLow) : "",
    refHigh: a.refHigh != null ? String(a.refHigh) : "",
    refText: a.refText ?? "",
  };
}

function toAnalyte(r: AnalyteRow): Analyte {
  const num = (s: string) => (s.trim() === "" ? undefined : Number(s));
  return {
    code: r.code.trim().toUpperCase(),
    label: r.label.trim(),
    ...(r.unit.trim() ? { unit: r.unit.trim() } : {}),
    ...(num(r.refLow) != null ? { refLow: num(r.refLow) } : {}),
    ...(num(r.refHigh) != null ? { refHigh: num(r.refHigh) } : {}),
    ...(r.refText.trim() ? { refText: r.refText.trim() } : {}),
  };
}

const cellInput =
  "rounded border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-2 py-1.5 text-xs text-[var(--color-fg)] outline-none focus:border-[var(--color-brand-500)]";

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
      <div className="w-full max-w-2xl rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-xl">
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
        <div className="max-h-[78vh] overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

function TestForm({
  initial,
  onSubmit,
  saving,
  error,
}: {
  initial?: LabTest;
  onSubmit: (v: { code: string; name: string; specimenType?: string; analytes: Analyte[] }) => void;
  saving: boolean;
  error?: unknown;
}) {
  const [code, setCode] = useState(initial?.code ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [specimen, setSpecimen] = useState(initial?.specimenType ?? "");
  const [rows, setRows] = useState<AnalyteRow[]>(
    initial && initial.analytes.length > 0 ? initial.analytes.map(toRow) : [emptyRow],
  );

  function setRow(i: number, patch: Partial<AnalyteRow>) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  return (
    <div className="space-y-4">
      {error != null && <ErrorAlert error={error} fallback="Could not save the test." />}
      <div className="grid grid-cols-3 gap-3">
        <Field
          label="Code"
          name="code"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="CBC"
          required
          disabled={Boolean(initial)}
        />
        <div className="col-span-2">
          <Field
            label="Name"
            name="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Complete Blood Count"
            required
          />
        </div>
      </div>
      <Field
        label="Specimen type"
        name="specimen"
        value={specimen}
        onChange={(e) => setSpecimen(e.target.value)}
        placeholder="Whole blood (EDTA)"
      />

      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-sm font-medium text-[var(--color-fg)]">Analytes</span>
          <button
            type="button"
            className="text-xs text-[var(--color-brand-600)] hover:underline"
            onClick={() => setRows((r) => [...r, { ...emptyRow }])}
          >
            + Add analyte
          </button>
        </div>
        <div className="mb-1 grid grid-cols-[1fr_2fr_1fr_1fr_1fr_1.3fr_auto] gap-1.5 text-[10px] tracking-wide text-[var(--color-fg-subtle)] uppercase">
          <span>Code</span>
          <span>Label</span>
          <span>Unit</span>
          <span>Low</span>
          <span>High</span>
          <span>Range text</span>
          <span />
        </div>
        {rows.map((r, i) => (
          <div
            key={i}
            className="mb-1.5 grid grid-cols-[1fr_2fr_1fr_1fr_1fr_1.3fr_auto] items-center gap-1.5"
          >
            <input
              value={r.code}
              onChange={(e) => setRow(i, { code: e.target.value.toUpperCase() })}
              placeholder="HB"
              className={cellInput}
            />
            <input
              value={r.label}
              onChange={(e) => setRow(i, { label: e.target.value })}
              placeholder="Haemoglobin"
              className={cellInput}
            />
            <input
              value={r.unit}
              onChange={(e) => setRow(i, { unit: e.target.value })}
              placeholder="g/dL"
              className={cellInput}
            />
            <input
              value={r.refLow}
              onChange={(e) => setRow(i, { refLow: e.target.value })}
              placeholder="12"
              inputMode="decimal"
              className={cellInput}
            />
            <input
              value={r.refHigh}
              onChange={(e) => setRow(i, { refHigh: e.target.value })}
              placeholder="15"
              inputMode="decimal"
              className={cellInput}
            />
            <input
              value={r.refText}
              onChange={(e) => setRow(i, { refText: e.target.value })}
              placeholder="auto"
              className={cellInput}
            />
            <button
              type="button"
              className="text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-danger)]"
              onClick={() => setRows((rs) => rs.filter((_, idx) => idx !== i))}
              aria-label="Remove analyte"
            >
              ✕
            </button>
          </div>
        ))}
        <p className="mt-1 text-xs text-[var(--color-fg-subtle)]">
          Leave &ldquo;range text&rdquo; blank to derive it from Low/High. Low &amp; High drive the
          auto-flag at result entry.
        </p>
      </div>

      <div className="flex justify-end">
        <Button
          loading={saving}
          disabled={!code.trim() || !name.trim()}
          onClick={() =>
            onSubmit({
              code: code.trim(),
              name: name.trim(),
              ...(specimen.trim() ? { specimenType: specimen.trim() } : {}),
              analytes: rows.filter((r) => r.code.trim() && r.label.trim()).map(toAnalyte),
            })
          }
        >
          {initial ? "Save test" : "Add test"}
        </Button>
      </div>
    </div>
  );
}

function LabCataloguePage() {
  const { api, can } = useAuth();
  const canManage = can("lab:approve");
  const [tests, setTests] = useState<LabTest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [modal, setModal] = useState<{ kind: "create" } | { kind: "edit"; test: LabTest } | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<unknown>(null);

  const load = useCallback(() => {
    setLoading(true);
    api
      .listLabTests(true)
      .then(setTests)
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

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-fg)]">Lab test catalogue</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            Tests defined once — their analytes and reference ranges pre-fill result entry.
          </p>
        </div>
        {canManage && (
          <Button
            onClick={() => {
              setFormError(null);
              setModal({ kind: "create" });
            }}
          >
            Add test
          </Button>
        )}
      </div>

      {error != null && <ErrorAlert error={error} fallback="Could not load the catalogue." />}

      {loading ? (
        <p className="py-8 text-center text-sm text-[var(--color-fg-muted)]">Loading…</p>
      ) : tests.length === 0 ? (
        <Card className="p-10 text-center">
          <p className="text-sm text-[var(--color-fg-muted)]">
            No tests yet. Add one to start the catalogue.
          </p>
        </Card>
      ) : (
        <div className="space-y-2">
          {tests.map((t) => (
            <Card key={t.id} className={`p-4 ${t.active ? "" : "opacity-60"}`}>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <div className="min-w-40 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs font-semibold text-[var(--color-fg)]">
                      {t.code}
                    </span>
                    <span className="font-medium text-[var(--color-fg)]">{t.name}</span>
                    {!t.active && <Badge tone="warning">Retired</Badge>}
                  </div>
                  <p className="mt-0.5 text-xs text-[var(--color-fg-subtle)]">
                    {t.analytes.length} analyte{t.analytes.length === 1 ? "" : "s"}
                    {t.specimenType ? ` · ${t.specimenType}` : ""}
                  </p>
                </div>
                {canManage && (
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setFormError(null);
                        setModal({ kind: "edit", test: t });
                      }}
                    >
                      Edit
                    </Button>
                    <button
                      className="text-xs text-[var(--color-fg-muted)] hover:underline"
                      onClick={() => void run(() => api.updateLabTest(t.id, { active: !t.active }))}
                    >
                      {t.active ? "Retire" : "Reactivate"}
                    </button>
                  </div>
                )}
              </div>
              {t.analytes.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {t.analytes.map((a) => (
                    <span
                      key={a.code}
                      className="rounded-md bg-[var(--color-bg-subtle)] px-2 py-0.5 text-xs text-[var(--color-fg-muted)]"
                    >
                      {a.label}
                      {a.refText ? ` (${a.refText}${a.unit ? ` ${a.unit}` : ""})` : ""}
                    </span>
                  ))}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {modal?.kind === "create" && (
        <Modal title="Add lab test" onClose={() => setModal(null)}>
          <TestForm
            saving={saving}
            error={formError}
            onSubmit={(v) => void run(() => api.createLabTest(v))}
          />
        </Modal>
      )}
      {modal?.kind === "edit" && (
        <Modal title={`Edit ${modal.test.code}`} onClose={() => setModal(null)}>
          <TestForm
            initial={modal.test}
            saving={saving}
            error={formError}
            onSubmit={(v) =>
              void run(() =>
                api.updateLabTest(modal.test.id, {
                  name: v.name,
                  ...(v.specimenType ? { specimenType: v.specimenType } : { specimenType: "" }),
                  analytes: v.analytes,
                }),
              )
            }
          />
        </Modal>
      )}
    </div>
  );
}

export default function Page() {
  return <LabCataloguePage />;
}
