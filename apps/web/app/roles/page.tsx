"use client";

/**
 * Roles (Doc 02 A4 "Roles List").
 *
 * Read-only for now: the permission-matrix editor is a substantial screen and
 * belongs with the rest of the RBAC admin UI. Showing the roles that exist, and
 * marking which are ours (system) versus the hospital's own, is the honest
 * half-step — and it is what an administrator needs before assigning anyone.
 */
import { useEffect, useState } from "react";
import { ApiClientError, type Role } from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import { Protected } from "../../components/Protected";
import { Alert, Badge, Card } from "../../components/ui";

function Roles() {
  const { api } = useAuth();
  const [roles, setRoles] = useState<Role[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .listRoles()
      .then(setRoles)
      .catch((err: unknown) => {
        setError(
          err instanceof ApiClientError && err.isForbidden
            ? "You do not have permission to manage roles."
            : "Could not load roles.",
        );
      });
  }, [api]);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-[var(--color-fg)]">Roles &amp; permissions</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          What each kind of person is allowed to do here.
        </p>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      <div className="grid gap-3 sm:grid-cols-2">
        {roles.map((role) => (
          <Card key={role.id} className="p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium text-[var(--color-fg)]">{role.name}</p>
                <code className="text-xs text-[var(--color-fg-subtle)]">{role.code}</code>
              </div>
              {role.isSystem && <Badge>system</Badge>}
            </div>
            {role.description && (
              <p className="mt-2 text-sm text-[var(--color-fg-muted)]">{role.description}</p>
            )}
          </Card>
        ))}
      </div>

      <Alert tone="info">
        System roles ship with the product and cannot be edited — a hospital that stripped its own
        administrator role of <code>role:manage</code> would lock itself out permanently. Custom
        roles and the permission-matrix editor are next.
      </Alert>
    </div>
  );
}

export default function Page() {
  return (
    <Protected>
      <Roles />
    </Protected>
  );
}
