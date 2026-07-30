"use client";

/**
 * Medical Records (Module MRD) — the ICD-10 code master and the disease register.
 *
 * The master is the coder's picker (define it once); the register is the payoff — how many cases of
 * each diagnosis in a period, the morbidity/notifiable-disease return a hospital must file. Coding a
 * visit happens on the patient's profile (the doctor's Coding tab); this page owns the reference
 * data and the aggregate. Managing codes is `mrd:manage`; reading the register is `mrd:register:view`.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { type IcdCode, type DiseaseRegisterRow } from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import { Badge, Button, Card, Field, ErrorAlert } from "../../components/ui";

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function iso(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00`).toISOString();
}
function isoNextDay(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return d.toISOString();
}

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
      <div className="w-full max-w-md rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-xl">
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
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

function IcdForm({
  initial,
  onSubmit,
  saving,
  error,
}: {
  initial?: IcdCode;
  onSubmit: (v: { code: string; title: string; chapter?: string }) => void;
  saving: boolean;
  error?: unknown;
}) {
  const [code, setCode] = useState(initial?.code ?? "");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [chapter, setChapter] = useState(initial?.chapter ?? "");

  return (
    <div className="space-y-4">
      {error != null && <ErrorAlert error={error} fallback="Could not save the code." />}
      <Field
        label="ICD-10 code"
        name="code"
        value={code}
        onChange={(e) => setCode(e.target.value.toUpperCase())}
        placeholder="J18.9"
        required
        disabled={Boolean(initial)}
      />
      <Field
        label="Title"
        name="title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Pneumonia, unspecified organism"
        required
      />
      <Field
        label="Chapter / block (optional)"
        name="chapter"
        value={chapter}
        onChange={(e) => setChapter(e.target.value)}
        placeholder="Diseases of the respiratory system"
      />
      <div className="flex justify-end">
        <Button
          loading={saving}
          disabled={!code.trim() || !title.trim()}
          onClick={() =>
            onSubmit({
              code: code.trim(),
              title: title.trim(),
              ...(chapter.trim() ? { chapter: chapter.trim() } : {}),
            })
          }
        >
          {initial ? "Save" : "Add code"}
        </Button>
      </div>
    </div>
  );
}

function MrdPage() {
  const { api, can } = useAuth();
  const canManage = can("mrd:manage");
  const canRegister = can("mrd:register:view");

  const [search, setSearch] = useState("");
  const [codes, setCodes] = useState<IcdCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [modal, setModal] = useState<{ kind: "create" } | { kind: "edit"; code: IcdCode } | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<unknown>(null);

  const loadCodes = useCallback(() => {
    setLoading(true);
    api
      .listIcdCodes(search || undefined, true)
      .then(setCodes)
      .catch((e: unknown) => setError(e))
      .finally(() => setLoading(false));
  }, [api, search]);
  useEffect(loadCodes, [loadCodes]);

  async function run(fn: () => Promise<unknown>) {
    setSaving(true);
    setFormError(null);
    try {
      await fn();
      setModal(null);
      loadCodes();
    } catch (e) {
      setFormError(e);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-8 p-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-fg)]">Medical records</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          The ICD-10 code master and the disease register. Visits are coded from the patient&apos;s
          Coding tab.
        </p>
      </div>

      {canRegister && <DiseaseRegister />}

      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-[var(--color-fg)]">ICD-10 code master</h2>
          {canManage && (
            <Button
              onClick={() => {
                setFormError(null);
                setModal({ kind: "create" });
              }}
            >
              Add code
            </Button>
          )}
        </div>

        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search code or title…"
          className="w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm text-[var(--color-fg)]"
        />

        {error != null && <ErrorAlert error={error} fallback="Could not load codes." />}

        {loading ? (
          <p className="py-8 text-center text-sm text-[var(--color-fg-muted)]">Loading…</p>
        ) : codes.length === 0 ? (
          <Card className="p-8 text-center">
            <p className="text-sm text-[var(--color-fg-muted)]">
              {search ? "No codes match." : "No codes yet. Add the ones this hospital uses."}
            </p>
          </Card>
        ) : (
          <div className="space-y-1.5">
            {codes.map((c) => (
              <Card
                key={c.id}
                className={`flex flex-wrap items-center gap-x-4 gap-y-1 p-3 ${c.active ? "" : "opacity-60"}`}
              >
                <span className="font-mono text-sm font-semibold text-[var(--color-fg)]">
                  {c.code}
                </span>
                <span className="min-w-40 flex-1 text-sm text-[var(--color-fg)]">
                  {c.title}
                  {c.chapter ? (
                    <span className="ml-2 text-xs text-[var(--color-fg-subtle)]">{c.chapter}</span>
                  ) : null}
                </span>
                {!c.active && <Badge tone="warning">Retired</Badge>}
                {canManage && (
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setFormError(null);
                        setModal({ kind: "edit", code: c });
                      }}
                    >
                      Edit
                    </Button>
                    <button
                      className="text-xs text-[var(--color-fg-muted)] hover:underline"
                      onClick={() => void run(() => api.updateIcdCode(c.id, { active: !c.active }))}
                    >
                      {c.active ? "Retire" : "Reactivate"}
                    </button>
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </section>

      {modal?.kind === "create" && (
        <Modal title="Add ICD-10 code" onClose={() => setModal(null)}>
          <IcdForm
            saving={saving}
            error={formError}
            onSubmit={(v) => void run(() => api.createIcdCode(v))}
          />
        </Modal>
      )}
      {modal?.kind === "edit" && (
        <Modal title={`Edit ${modal.code.code}`} onClose={() => setModal(null)}>
          <IcdForm
            initial={modal.code}
            saving={saving}
            error={formError}
            onSubmit={(v) =>
              void run(() =>
                api.updateIcdCode(modal.code.id, {
                  title: v.title,
                  ...(v.chapter ? { chapter: v.chapter } : { chapter: "" }),
                }),
              )
            }
          />
        </Modal>
      )}
    </div>
  );
}

function DiseaseRegister() {
  const { api } = useAuth();
  const now = new Date();
  const [fromStr, setFromStr] = useState(ymd(new Date(now.getFullYear(), now.getMonth(), 1)));
  const [toStr, setToStr] = useState(ymd(now));
  const [rows, setRows] = useState<DiseaseRegisterRow[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api
      .mrdDiseaseRegister({ from: iso(fromStr), to: isoNextDay(toStr) })
      .then(setRows)
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [api, fromStr, toStr]);
  useEffect(load, [load]);

  const total = rows.reduce((s, r) => s + r.cases, 0);

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-[var(--color-fg)]">Disease register</h2>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-xs text-[var(--color-fg-muted)]">
          From
          <input
            type="date"
            value={fromStr}
            max={toStr}
            onChange={(e) => setFromStr(e.target.value)}
            className="mt-1 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-1.5 text-sm text-[var(--color-fg)]"
          />
        </label>
        <label className="flex flex-col text-xs text-[var(--color-fg-muted)]">
          To
          <input
            type="date"
            value={toStr}
            min={fromStr}
            onChange={(e) => setToStr(e.target.value)}
            className="mt-1 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-1.5 text-sm text-[var(--color-fg)]"
          />
        </label>
        <span className="text-xs text-[var(--color-fg-subtle)]">
          {total} coded case{total === 1 ? "" : "s"}
        </span>
      </div>
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-[var(--color-border)] text-xs tracking-wide text-[var(--color-fg-subtle)] uppercase">
              <tr>
                <th className="px-4 py-3 font-medium">Code</th>
                <th className="px-4 py-3 font-medium">Diagnosis</th>
                <th className="px-4 py-3 text-right font-medium">Cases</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {loading ? (
                <tr>
                  <td colSpan={3} className="px-4 py-8 text-center text-[var(--color-fg-muted)]">
                    Loading…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-4 py-8 text-center text-[var(--color-fg-muted)]">
                    No coded diagnoses in this period.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.code} className="hover:bg-[var(--color-bg-subtle)]">
                    <td className="px-4 py-2.5 font-mono text-xs text-[var(--color-fg)]">
                      {r.code}
                    </td>
                    <td className="px-4 py-2.5 text-[var(--color-fg)]">{r.title}</td>
                    <td className="px-4 py-2.5 text-right font-medium tabular-nums text-[var(--color-fg)]">
                      {r.cases}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </section>
  );
}

export default function Page() {
  return <MrdPage />;
}
