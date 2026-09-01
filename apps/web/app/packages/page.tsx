"use client";

/**
 * Care packages (Module F5 / package billing) — the fixed-price bundle catalogue.
 *
 * A package (a maternity bundle, a health check) is defined ONCE here with its price and the tariff
 * codes it covers. Enrolling a visit charges the price once; the covered services then post at ₹0
 * against it, so the bundle is billed once and its contents are not double-charged. Reading is
 * `billing:read` (the counter that enrols); defining a package is the tariff owner's `tariff:manage`.
 *
 * ── AND IT IS A MODULE A HOSPITAL BUYS ──────────────────────────────────────
 * `module.finance.packages` — Day Care, Hospital Plus and Enterprise. Until 2026-08-20 the API
 * gated these routes on `module.ops.opd` like the rest of billing, so every hospital had them.
 * Now that the gate is real, this page can be reached by a hospital that never bought it, and
 * "Add package" over "No packages yet" would read as an empty catalogue rather than as a module
 * the plan does not include (D20) — so it says which one it is.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { type CarePackage } from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import { Badge, Button, Card, Field, ErrorAlert } from "../../components/ui";
import { ModuleNotInEdition } from "../../components/ModuleNotInEdition";
import { isFeatureUnavailable } from "../../lib/errors";
import { rupees, toPaise } from "../../lib/money";

/** Codes typed as a comma/newline list → a clean, upper-cased array; and back for editing. */
function parseCodes(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((c) => c.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
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
      <div className="w-full max-w-xl rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-xl">
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

function PackageForm({
  initial,
  onSubmit,
  saving,
  error,
}: {
  initial?: CarePackage;
  onSubmit: (v: {
    code: string;
    name: string;
    description?: string;
    price: number;
    includedCodes: string[];
  }) => void;
  saving: boolean;
  error?: unknown;
}) {
  const [code, setCode] = useState(initial?.code ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [price, setPrice] = useState(initial ? (initial.price / 100).toFixed(2) : "");
  const [codes, setCodes] = useState((initial?.includedCodes ?? []).join(", "));

  const parsed = parseCodes(codes);

  return (
    <div className="space-y-4">
      {error != null && <ErrorAlert error={error} fallback="Could not save the package." />}
      <div className="grid grid-cols-3 gap-3">
        <Field
          label="Code"
          name="code"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="MATERNITY_NORMAL"
          required
          disabled={Boolean(initial)}
        />
        <div className="col-span-2">
          <Field
            label="Name"
            name="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Normal delivery package"
            required
          />
        </div>
      </div>
      <Field
        label="Price (₹)"
        name="price"
        value={price}
        onChange={(e) => setPrice(e.target.value)}
        placeholder="35000"
        inputMode="decimal"
        required
      />
      <Field
        label="Description (optional)"
        name="description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Room, delivery, consults and medicines for a normal delivery"
      />
      <div>
        <label className="mb-1 block text-sm font-medium text-[var(--color-fg)]">
          Covered service codes
        </label>
        <textarea
          value={codes}
          onChange={(e) => setCodes(e.target.value)}
          rows={3}
          placeholder="BED_GENERAL, DELIVERY_NORMAL, CONSULT_OBG"
          className="w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm text-[var(--color-fg)]"
        />
        <p className="mt-1 text-xs text-[var(--color-fg-subtle)]">
          The tariff codes this bundle covers (comma or space separated). While a visit is enrolled,
          each of these posts at ₹0 against the package. {parsed.length} code
          {parsed.length === 1 ? "" : "s"}.
        </p>
      </div>

      <div className="flex justify-end">
        <Button
          loading={saving}
          disabled={!code.trim() || !name.trim() || !price.trim()}
          onClick={() =>
            onSubmit({
              code: code.trim(),
              name: name.trim(),
              price: toPaise(price),
              includedCodes: parsed,
              ...(description.trim() ? { description: description.trim() } : {}),
            })
          }
        >
          {initial ? "Save package" : "Add package"}
        </Button>
      </div>
    </div>
  );
}

function PackagesPage() {
  const { api, can } = useAuth();
  const canManage = can("tariff:manage");
  const [packages, setPackages] = useState<CarePackage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [modal, setModal] = useState<
    { kind: "create" } | { kind: "edit"; pkg: CarePackage } | null
  >(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<unknown>(null);

  const load = useCallback(() => {
    setLoading(true);
    api
      .listPackages(true)
      .then(setPackages)
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

  /**
   * The plan refused the catalogue: no table, no empty state and no "Add package" — every one of
   * them would be refused too, and together they would say "you have this and it is empty".
   */
  if (isFeatureUnavailable(error)) {
    return (
      <div className="mx-auto max-w-4xl space-y-6 p-6">
        <h1 className="text-xl font-semibold text-[var(--color-fg)]">Care packages</h1>
        <ModuleNotInEdition module="Care packages" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-fg)]">Care packages</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            Fixed-price bundles — one price covers the services inside. Enrol a visit from the
            patient&apos;s Bills tab.
          </p>
        </div>
        {canManage && (
          <Button
            onClick={() => {
              setFormError(null);
              setModal({ kind: "create" });
            }}
          >
            Add package
          </Button>
        )}
      </div>

      {error != null && <ErrorAlert error={error} fallback="Could not load packages." />}

      {loading ? (
        <p className="py-8 text-center text-sm text-[var(--color-fg-muted)]">Loading…</p>
      ) : packages.length === 0 ? (
        <Card className="p-10 text-center">
          <p className="text-sm text-[var(--color-fg-muted)]">
            No packages yet. Add one to start the catalogue.
          </p>
        </Card>
      ) : (
        <div className="space-y-2">
          {packages.map((p) => (
            <Card key={p.id} className={`p-4 ${p.active ? "" : "opacity-60"}`}>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <div className="min-w-40 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs font-semibold text-[var(--color-fg)]">
                      {p.code}
                    </span>
                    <span className="font-medium text-[var(--color-fg)]">{p.name}</span>
                    {!p.active && <Badge tone="warning">Retired</Badge>}
                  </div>
                  <p className="mt-0.5 text-xs text-[var(--color-fg-subtle)]">
                    {rupees(p.price)} · covers {p.includedCodes.length} service
                    {p.includedCodes.length === 1 ? "" : "s"}
                    {p.description ? ` · ${p.description}` : ""}
                  </p>
                </div>
                <div className="text-right text-lg font-semibold text-[var(--color-fg)]">
                  {rupees(p.price)}
                </div>
                {canManage && (
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setFormError(null);
                        setModal({ kind: "edit", pkg: p });
                      }}
                    >
                      Edit
                    </Button>
                    <button
                      className="text-xs text-[var(--color-fg-muted)] hover:underline"
                      onClick={() => void run(() => api.updatePackage(p.id, { active: !p.active }))}
                    >
                      {p.active ? "Retire" : "Reactivate"}
                    </button>
                  </div>
                )}
              </div>
              {p.includedCodes.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {p.includedCodes.map((c) => (
                    <span
                      key={c}
                      className="rounded-md bg-[var(--color-bg-subtle)] px-2 py-0.5 font-mono text-xs text-[var(--color-fg-muted)]"
                    >
                      {c}
                    </span>
                  ))}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {modal?.kind === "create" && (
        <Modal title="Add care package" onClose={() => setModal(null)}>
          <PackageForm
            saving={saving}
            error={formError}
            onSubmit={(v) => void run(() => api.createPackage(v))}
          />
        </Modal>
      )}
      {modal?.kind === "edit" && (
        <Modal title={`Edit ${modal.pkg.code}`} onClose={() => setModal(null)}>
          <PackageForm
            initial={modal.pkg}
            saving={saving}
            error={formError}
            onSubmit={(v) =>
              void run(() =>
                api.updatePackage(modal.pkg.id, {
                  name: v.name,
                  price: v.price,
                  includedCodes: v.includedCodes,
                  ...(v.description ? { description: v.description } : { description: "" }),
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
  return <PackagesPage />;
}
