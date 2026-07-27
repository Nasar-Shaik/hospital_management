"use client";

/**
 * Departments — the hospital's organisational units and their hierarchy (Modules B2/B3).
 *
 * Where an administrator shapes the org chart: the departments a hospital has, and which sits under
 * which. A department is never deleted — encounters and reports reference it — so one that closes is
 * set inactive, which drops it from the routing pickers while keeping its past readable.
 *
 * Reading the list needs only `patient:read` (everyone who routes or reads a patient); creating and
 * editing needs `department:manage`.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  type Department,
  type DepartmentKind,
  type CreateDepartmentInput,
} from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import { Protected } from "../../components/Protected";
import { Badge, Button, DataTable, Field, Modal, type Column } from "../../components/ui";
import { ErrorAlert } from "../../components/ui";

type TreeRow = { dept: Department; depth: number };

const KINDS: { value: DepartmentKind; label: string }[] = [
  { value: "clinical", label: "Clinical" },
  { value: "diagnostic", label: "Diagnostic" },
  { value: "nursing", label: "Nursing" },
  { value: "pharmacy", label: "Pharmacy" },
  { value: "support", label: "Support" },
  { value: "administrative", label: "Administrative" },
];

const kindLabel = (k: DepartmentKind) => KINDS.find((x) => x.value === k)?.label ?? k;

interface DeptForm {
  name: string;
  code: string;
  kind: DepartmentKind;
  parentId: string;
  description: string;
}

function DeptFormFields({
  mode,
  initial,
  parentOptions,
  onSubmit,
  saving,
  error,
}: {
  mode: "create" | "edit";
  initial?: Department;
  /** Departments a new/edited row may be parented under — never itself. */
  parentOptions: Department[];
  onSubmit: (f: DeptForm) => void;
  saving: boolean;
  error?: unknown;
}) {
  const [f, setF] = useState<DeptForm>(() => ({
    name: initial?.name ?? "",
    code: initial?.code ?? "",
    kind: initial?.kind ?? "clinical",
    parentId: initial?.parentId ?? "",
    description: initial?.description ?? "",
  }));
  const set = (patch: Partial<DeptForm>) => setF((prev) => ({ ...prev, ...patch }));

  return (
    <form
      className="space-y-5"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSubmit(f);
      }}
    >
      {error != null && <ErrorAlert error={error} fallback="Could not save the department." />}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Name"
          name="name"
          value={f.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="Cardiology"
          required
        />
        <Field
          label="Code"
          name="code"
          value={f.code}
          onChange={(e) => set({ code: e.target.value.toUpperCase() })}
          disabled={mode === "edit"}
          hint={mode === "edit" ? "The code cannot change — records carry it." : "e.g. CARD"}
          required
        />
        <label className="block text-sm">
          <span className="mb-1.5 block font-medium text-[var(--color-fg)]">Kind</span>
          <select
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[var(--color-fg)]"
            value={f.kind}
            onChange={(e) => set({ kind: e.target.value as DepartmentKind })}
          >
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1.5 block font-medium text-[var(--color-fg)]">Parent department</span>
          <select
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[var(--color-fg)]"
            value={f.parentId}
            onChange={(e) => set({ parentId: e.target.value })}
          >
            <option value="">— None (top level) —</option>
            {parentOptions.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.code})
              </option>
            ))}
          </select>
        </label>
      </div>
      <Field
        label="Description"
        name="description"
        value={f.description}
        onChange={(e) => set({ description: e.target.value })}
        hint="Optional — what this unit does."
      />
      <div className="flex justify-end">
        <Button type="submit" loading={saving}>
          {mode === "create" ? "Add department" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}

/** Orders departments so children immediately follow their parent, with a depth for indentation. */
function asTree(items: Department[]): { dept: Department; depth: number }[] {
  const childrenOf = new Map<string, Department[]>();
  const roots: Department[] = [];
  for (const d of items) {
    if (d.parentId && items.some((x) => x.id === d.parentId)) {
      const arr = childrenOf.get(d.parentId) ?? [];
      arr.push(d);
      childrenOf.set(d.parentId, arr);
    } else {
      roots.push(d);
    }
  }
  const out: { dept: Department; depth: number }[] = [];
  const walk = (dept: Department, depth: number) => {
    out.push({ dept, depth });
    for (const c of childrenOf.get(dept.id) ?? []) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return out;
}

function DepartmentsPage() {
  const { api, can } = useAuth();
  const canManage = can("department:manage");

  const [items, setItems] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const [modal, setModal] = useState<"create" | "edit" | null>(null);
  const [active, setActive] = useState<Department | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<unknown>(null);

  const load = useCallback(() => {
    setLoading(true);
    api
      .listDepartments()
      .then(setItems)
      .catch((e: unknown) => setError(e))
      .finally(() => setLoading(false));
  }, [api]);

  useEffect(load, [load]);

  const tree = useMemo(() => asTree(items), [items]);

  // A department cannot be its own parent (the API also refuses cycles; this keeps them out of the
  // picker in the first place). Active departments only — you do not route new work under a retired one.
  const parentOptions = useMemo(
    () => items.filter((d) => d.status === "active" && d.id !== active?.id),
    [items, active],
  );

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

  function submitCreate(f: DeptForm) {
    const input: CreateDepartmentInput = {
      name: f.name.trim(),
      code: f.code.trim(),
      kind: f.kind,
      ...(f.parentId ? { parentId: f.parentId } : {}),
      ...(f.description.trim() ? { description: f.description.trim() } : {}),
    };
    void run(() => api.createDepartment(input));
  }

  function submitEdit(f: DeptForm) {
    if (!active) return;
    void run(() =>
      api.updateDepartment(active.id, {
        name: f.name.trim(),
        kind: f.kind,
        // Empty string in the picker means "detach" — send null, not undefined.
        parentId: f.parentId ? f.parentId : null,
        description: f.description.trim(),
      }),
    );
  }

  function toggleActive(d: Department) {
    void run(() =>
      api.updateDepartment(d.id, { status: d.status === "active" ? "inactive" : "active" }),
    );
  }

  const columns: Column<TreeRow>[] = [
    {
      key: "name",
      header: "Department",
      cellClassName: "font-medium text-[var(--color-fg)]",
      render: ({ dept: d, depth }) => (
        <span style={{ paddingLeft: `${depth * 1.5}rem` }} className="inline-block">
          {depth > 0 && <span className="mr-1 text-[var(--color-fg-subtle)]">└</span>}
          {d.name}
        </span>
      ),
    },
    {
      key: "code",
      header: "Code",
      cellClassName: "font-mono text-xs text-[var(--color-fg-muted)]",
      render: ({ dept }) => dept.code,
    },
    {
      key: "kind",
      header: "Kind",
      cellClassName: "text-[var(--color-fg-muted)]",
      render: ({ dept }) => kindLabel(dept.kind),
    },
    {
      key: "status",
      header: "Status",
      render: ({ dept }) => (
        <Badge tone={dept.status === "active" ? "success" : "neutral"} dot>
          {dept.status === "active" ? "Active" : "Inactive"}
        </Badge>
      ),
    },
    ...(canManage
      ? ([
          {
            key: "actions",
            header: "Actions",
            align: "right",
            render: ({ dept: d }) => (
              <div className="flex justify-end gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setActive(d);
                    setFormError(null);
                    setModal("edit");
                  }}
                >
                  Edit
                </Button>
                <Button variant="ghost" size="sm" onClick={() => toggleActive(d)}>
                  {d.status === "active" ? "Deactivate" : "Reactivate"}
                </Button>
              </div>
            ),
          },
        ] as Column<TreeRow>[])
      : []),
  ];

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-fg)]">Departments</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            Your hospital&rsquo;s organisational units and the hierarchy between them. Patients are
            routed into a department at registration, and reports group by it.
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
            Add department
          </Button>
        )}
      </div>

      {error != null && <ErrorAlert error={error} fallback="Could not load departments." />}

      <DataTable<TreeRow>
        columns={columns}
        rows={tree}
        keyOf={(r) => r.dept.id}
        loading={loading}
        empty="No departments yet."
        rowClassName={(r) => (r.dept.status === "active" ? "" : "opacity-60")}
      />

      {modal === "create" && (
        <Modal title="Add department" onClose={() => setModal(null)}>
          <DeptFormFields
            mode="create"
            parentOptions={parentOptions}
            onSubmit={submitCreate}
            saving={saving}
            error={formError}
          />
        </Modal>
      )}
      {modal === "edit" && active && (
        <Modal title={`Edit ${active.name}`} onClose={() => setModal(null)}>
          <DeptFormFields
            mode="edit"
            initial={active}
            parentOptions={parentOptions}
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
      <DepartmentsPage />
    </Protected>
  );
}
