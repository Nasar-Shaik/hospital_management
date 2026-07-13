"use client";

/**
 * Staff directory (Doc 02 A3 "Staff Directory" page).
 *
 * The screen where RBAC becomes real: add a colleague, give them a role, and the
 * permissions apply on their very next request.
 *
 * The temporary password is shown ONCE, in a panel that says so. We store only
 * its hash, so there is no "show it again" — pretending otherwise would be a lie
 * we could not honour.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiClientError, type Role, type StaffMember } from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import { Protected } from "../../components/Protected";
import { Alert, Badge, Button, Card, Field, PermissionGate } from "../../components/ui";

function statusTone(status: StaffMember["status"]): "success" | "danger" | "neutral" {
  if (status === "active") return "success";
  if (status === "disabled" || status === "locked") return "danger";
  return "neutral";
}

function StaffDirectory() {
  const { api, can, user } = useAuth();

  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", role: "" });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<{ email: string; password?: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const page = await api.listStaff({ limit: 50, ...(query ? { q: query } : {}) });
      setStaff(page.items);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not load staff.");
    } finally {
      setLoading(false);
    }
  }, [api, query]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    // Only an admin can read the role list; a plain viewer simply gets no dropdown.
    if (!can("role:manage")) return;
    void api
      .listRoles()
      .then(setRoles)
      .catch(() => setRoles([]));
  }, [api, can]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFieldErrors({});
    setError(null);
    try {
      const result = await api.createStaff({
        name: form.name,
        email: form.email,
        ...(form.role ? { roles: [form.role] } : {}),
      });
      setCreated({
        email: result.user.email,
        ...(result.temporaryPassword ? { password: result.temporaryPassword } : {}),
      });
      setForm({ name: "", email: "", role: "" });
      setShowForm(false);
      await load();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setFieldErrors(err.fieldErrors);
        if (Object.keys(err.fieldErrors).length === 0) setError(err.message);
      } else {
        setError("Could not create the account.");
      }
    } finally {
      setSaving(false);
    }
  }

  async function toggleStatus(member: StaffMember) {
    const next = member.status === "active" ? "disabled" : "active";
    try {
      await api.setStaffStatus(member.id, next);
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not update the account.");
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--color-fg)]">Staff</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            Everyone with an account at this hospital.
          </p>
        </div>
        <PermissionGate can={can} permission="user:create">
          <Button onClick={() => setShowForm((s) => !s)}>
            {showForm ? "Cancel" : "Add someone"}
          </Button>
        </PermissionGate>
      </div>

      {created && (
        <Alert tone="success" title="Account created">
          <p>
            <strong>{created.email}</strong> can sign in now.
          </p>
          {created.password && (
            <div className="mt-2">
              <p className="mb-1">
                Give them this temporary password. It is shown <strong>once</strong> — we store only
                its hash, so it cannot be retrieved again. They must change it at first sign-in.
              </p>
              <code className="mt-1 inline-block rounded-md bg-white px-3 py-1.5 font-mono text-sm">
                {created.password}
              </code>
            </div>
          )}
          <button onClick={() => setCreated(null)} className="mt-2 text-xs underline" type="button">
            Dismiss
          </button>
        </Alert>
      )}

      {error && <Alert tone="danger">{error}</Alert>}

      {showForm && (
        <Card className="p-6">
          <h2 className="mb-4 text-sm font-semibold">New staff account</h2>
          <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Full name"
              name="name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              error={fieldErrors.name?.[0]}
              required
            />
            <Field
              label="Email"
              name="email"
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              error={fieldErrors.email?.[0]}
              required
            />
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium">Role</span>
              <select
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}
                className="w-full rounded-lg border border-[var(--color-border-strong)] bg-white px-3.5 py-2.5 text-sm"
              >
                <option value="">No role (can sign in, can do nothing)</option>
                {roles.map((role) => (
                  <option key={role.id} value={role.code}>
                    {role.name}
                  </option>
                ))}
              </select>
              <span className="mt-1.5 block text-xs text-[var(--color-fg-muted)]">
                A password is generated and shown once.
              </span>
            </label>
            <div className="flex items-end">
              <Button type="submit" loading={saving}>
                Create account
              </Button>
            </div>
          </form>
        </Card>
      )}

      <Card>
        <div className="border-b border-[var(--color-border)] p-4">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or email…"
            className="w-full max-w-xs rounded-lg border border-[var(--color-border-strong)] px-3.5 py-2 text-sm outline-none focus:border-[var(--color-brand-500)]"
          />
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-[var(--color-border)] text-xs tracking-wide text-[var(--color-fg-subtle)] uppercase">
              <tr>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Roles</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {loading && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-[var(--color-fg-muted)]">
                    Loading…
                  </td>
                </tr>
              )}

              {!loading && staff.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-[var(--color-fg-muted)]">
                    Nobody matches that search.
                  </td>
                </tr>
              )}

              {staff.map((member) => (
                <tr key={member.id} className="hover:bg-[var(--color-bg-subtle)]">
                  <td className="px-4 py-3">
                    <p className="font-medium text-[var(--color-fg)]">{member.name}</p>
                    <p className="text-xs text-[var(--color-fg-muted)]">{member.email}</p>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {member.roles.length > 0 ? (
                        member.roles.map((role) => (
                          <Badge key={role} tone="brand">
                            {role}
                          </Badge>
                        ))
                      ) : (
                        <span className="text-xs text-[var(--color-fg-subtle)]">none</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={statusTone(member.status)}>{member.status}</Badge>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <PermissionGate can={can} permission="user:deactivate">
                      {/* You cannot lock yourself out of your own hospital. */}
                      {member.id !== user?.id && (
                        <Button
                          variant="ghost"
                          onClick={() => void toggleStatus(member)}
                          className="text-xs"
                        >
                          {member.status === "active" ? "Disable" : "Enable"}
                        </Button>
                      )}
                    </PermissionGate>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

export default function Page() {
  return (
    <Protected>
      <StaffDirectory />
    </Protected>
  );
}
