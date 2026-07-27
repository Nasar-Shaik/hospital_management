"use client";

/**
 * Branches — the hospital's physical sites (needs `branch:manage`, ADR-0015).
 *
 * Where an administrator lists their sites, adds one (up to the edition's cap), and edits or retires
 * one. A branch is never deleted — years of operational records are stamped with it — so a site that
 * closes is set inactive, which drops it from the switcher while keeping its past readable.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { type Branch } from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import { Protected } from "../../components/Protected";
import { Badge, Button, DataTable, Field, Modal, type Column } from "../../components/ui";
import { ErrorAlert } from "../../components/ui";

interface BranchForm {
  name: string;
  code: string;
  address: string;
  contactPhone: string;
  contactEmail: string;
  gstin: string;
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

  const columns: Column<Branch>[] = [
    {
      key: "name",
      header: "Branch",
      cellClassName: "font-medium text-[var(--color-fg)]",
      render: (b) => (
        <>
          {b.name}
          {b.isMain && (
            <span className="ml-2 align-middle">
              <Badge tone="brand">Main</Badge>
            </span>
          )}
        </>
      ),
    },
    {
      key: "code",
      header: "Code",
      cellClassName: "font-mono text-xs text-[var(--color-fg-muted)]",
      render: (b) => b.code,
    },
    {
      key: "contact",
      header: "Contact",
      cellClassName: "text-[var(--color-fg-muted)]",
      render: (b) => b.contactPhone || b.contactEmail || "—",
    },
    {
      key: "status",
      header: "Status",
      render: (b) => (
        <Badge tone={b.status === "active" ? "success" : "neutral"} dot>
          {b.status === "active" ? "Active" : "Inactive"}
        </Badge>
      ),
    },
    ...(canManage
      ? ([
          {
            key: "actions",
            header: "Actions",
            align: "right",
            render: (b) => (
              <div className="flex justify-end gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setActive(b);
                    setFormError(null);
                    setModal("edit");
                  }}
                >
                  Edit
                </Button>
                {!b.isMain && (
                  <Button variant="ghost" size="sm" onClick={() => toggleActive(b)}>
                    {b.status === "active" ? "Deactivate" : "Reactivate"}
                  </Button>
                )}
              </div>
            ),
          },
        ] as Column<Branch>[])
      : []),
  ];

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

      <DataTable<Branch>
        columns={columns}
        rows={items}
        keyOf={(b) => b.id}
        loading={loading}
        empty="No branches yet."
        rowClassName={(b) => (b.status === "active" ? "" : "opacity-60")}
      />

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
