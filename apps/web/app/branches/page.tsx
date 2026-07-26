"use client";

/**
 * Branches — the hospital's physical sites (needs `branch:manage`, ADR-0015).
 *
 * Where an administrator lists their sites, adds one (up to the edition's cap), and edits or retires
 * one. A branch is never deleted — years of operational records are stamped with it — so a site that
 * closes is set inactive, which drops it from the switcher while keeping its past readable.
 */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { type Branch } from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import { Protected } from "../../components/Protected";
import { Badge, Button, Card, Field } from "../../components/ui";
import { ErrorAlert } from "../../components/ui";

interface BranchForm {
  name: string;
  code: string;
  address: string;
  contactPhone: string;
  contactEmail: string;
  gstin: string;
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

function BranchFormFields({
  mode,
  initial,
  onSubmit,
  saving,
  error,
}: {
  mode: "create" | "edit";
  initial?: Branch;
  onSubmit: (f: BranchForm) => void;
  saving: boolean;
  error?: unknown;
}) {
  const [f, setF] = useState<BranchForm>(() => ({
    name: initial?.name ?? "",
    code: initial?.code ?? "",
    address: initial?.address ?? "",
    contactPhone: initial?.contactPhone ?? "",
    contactEmail: initial?.contactEmail ?? "",
    gstin: initial?.gstin ?? "",
  }));
  const set = (patch: Partial<BranchForm>) => setF((prev) => ({ ...prev, ...patch }));

  return (
    <form
      className="space-y-5"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSubmit(f);
      }}
    >
      {error != null && <ErrorAlert error={error} fallback="Could not save the branch." />}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Name"
          name="name"
          value={f.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="Apollo Chennai"
          required
        />
        <Field
          label="Code"
          name="code"
          value={f.code}
          onChange={(e) => set({ code: e.target.value.toUpperCase() })}
          disabled={mode === "edit"}
          hint={mode === "edit" ? "The code cannot change — records carry it." : "e.g. CHN"}
          required
        />
        <Field
          label="Phone"
          name="contactPhone"
          value={f.contactPhone}
          onChange={(e) => set({ contactPhone: e.target.value })}
        />
        <Field
          label="Email"
          name="contactEmail"
          type="email"
          value={f.contactEmail}
          onChange={(e) => set({ contactEmail: e.target.value })}
        />
        <Field
          label="GSTIN"
          name="gstin"
          value={f.gstin}
          onChange={(e) => set({ gstin: e.target.value.toUpperCase() })}
          hint="Each site is often a separate GST registration — its own invoice series."
        />
        <Field
          label="Address"
          name="address"
          value={f.address}
          onChange={(e) => set({ address: e.target.value })}
        />
      </div>
      <div className="flex justify-end">
        <Button type="submit" loading={saving}>
          {mode === "create" ? "Add branch" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}

function BranchesPage() {
  const { api, can } = useAuth();
  const canManage = can("branch:manage");

  const [items, setItems] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const [modal, setModal] = useState<"create" | "edit" | null>(null);
  const [active, setActive] = useState<Branch | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<unknown>(null);

  const load = useCallback(() => {
    setLoading(true);
    api
      .listBranches()
      .then(setItems)
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
      setActive(null);
      load();
    } catch (e) {
      setFormError(e);
    } finally {
      setSaving(false);
    }
  }

  function submitCreate(f: BranchForm) {
    void run(() =>
      api.createBranch({
        name: f.name.trim(),
        code: f.code.trim(),
        ...(f.address.trim() ? { address: f.address.trim() } : {}),
        ...(f.contactPhone.trim() ? { contactPhone: f.contactPhone.trim() } : {}),
        ...(f.contactEmail.trim() ? { contactEmail: f.contactEmail.trim() } : {}),
        ...(f.gstin.trim() ? { gstin: f.gstin.trim() } : {}),
      }),
    );
  }

  function submitEdit(f: BranchForm) {
    if (!active) return;
    void run(() =>
      api.updateBranch(active.id, {
        name: f.name.trim(),
        address: f.address.trim(),
        contactPhone: f.contactPhone.trim(),
        contactEmail: f.contactEmail.trim(),
        gstin: f.gstin.trim(),
      }),
    );
  }

  function toggleActive(b: Branch) {
    void run(() =>
      api.updateBranch(b.id, { status: b.status === "active" ? "inactive" : "active" }),
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-fg)]">Branches</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            Your hospital&rsquo;s physical sites. Switch between them from the header; every record
            is stamped with the branch it was created in.
          </p>
        </div>
        {canManage && (
          <Button
            onClick={() => {
              setActive(null);
              setFormError(null);
              setModal("create");
            }}
          >
            Add branch
          </Button>
        )}
      </div>

      {error != null && <ErrorAlert error={error} fallback="Could not load branches." />}

      <Card className="overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-[var(--color-border)] text-xs tracking-wide text-[var(--color-fg-subtle)] uppercase">
            <tr>
              <th className="px-4 py-3 font-medium">Branch</th>
              <th className="px-4 py-3 font-medium">Code</th>
              <th className="px-4 py-3 font-medium">Contact</th>
              <th className="px-4 py-3 font-medium">Status</th>
              {canManage && <th className="px-4 py-3 text-right font-medium">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {loading ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-[var(--color-fg-muted)]">
                  Loading…
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-[var(--color-fg-muted)]">
                  No branches yet.
                </td>
              </tr>
            ) : (
              items.map((b) => (
                <tr key={b.id} className={b.status === "active" ? "" : "opacity-60"}>
                  <td className="px-4 py-3 font-medium text-[var(--color-fg)]">
                    {b.name}
                    {b.isMain && (
                      <span className="ml-2 align-middle">
                        <Badge tone="brand">Main</Badge>
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-[var(--color-fg-muted)]">
                    {b.code}
                  </td>
                  <td className="px-4 py-3 text-[var(--color-fg-muted)]">
                    {b.contactPhone || b.contactEmail || "—"}
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={b.status === "active" ? "success" : "neutral"}>
                      {b.status === "active" ? "Active" : "Inactive"}
                    </Badge>
                  </td>
                  {canManage && (
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="secondary"
                          onClick={() => {
                            setActive(b);
                            setFormError(null);
                            setModal("edit");
                          }}
                        >
                          Edit
                        </Button>
                        {!b.isMain && (
                          <Button variant="ghost" onClick={() => toggleActive(b)}>
                            {b.status === "active" ? "Deactivate" : "Reactivate"}
                          </Button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Card>

      {modal === "create" && (
        <Modal title="Add branch" onClose={() => setModal(null)}>
          <BranchFormFields
            mode="create"
            onSubmit={submitCreate}
            saving={saving}
            error={formError}
          />
        </Modal>
      )}
      {modal === "edit" && active && (
        <Modal title={`Edit ${active.name}`} onClose={() => setModal(null)}>
          <BranchFormFields
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
  return (
    <Protected>
      <BranchesPage />
    </Protected>
  );
}
