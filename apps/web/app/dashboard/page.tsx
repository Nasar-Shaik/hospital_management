"use client";

/**
 * Dashboard.
 *
 * Honest by design: it shows what the platform actually knows today — who you
 * are, what you may do, and what is running — rather than fabricating charts of
 * patients and revenue that do not exist yet. A demo that invents data is a demo
 * that lies, and someone will eventually believe it.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "../../components/AuthProvider";
import { Protected } from "../../components/Protected";
import { Alert, Badge, Card } from "../../components/ui";

function Dashboard() {
  const { user, permissions, api } = useAuth();
  const [apiVersion, setApiVersion] = useState<string | null>(null);

  useEffect(() => {
    void api
      .health()
      .then((h) => setApiVersion(`v${h.version}`))
      .catch(() => setApiVersion(null));
  }, [api]);

  if (!user) return null;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-[var(--color-fg)]">
          Good day, {user.name.split(" ")[0]}
        </h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          You are signed in to {typeof window !== "undefined" ? window.location.hostname : ""}.
        </p>
      </div>

      {user.mustChangePassword && (
        <Alert tone="warning" title="Change your password">
          You are using a temporary password.{" "}
          <Link href="/change-password" className="underline">
            Set your own now
          </Link>
          .
        </Alert>
      )}

      {!user.mfaEnabled && (
        <Alert tone="info" title="Two-step verification is off">
          Adding a second factor is the single biggest improvement you can make to the security of a
          clinical account.
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="p-5">
          <p className="text-xs font-medium tracking-wide text-[var(--color-fg-subtle)] uppercase">
            Your roles
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {user.roles.length > 0 ? (
              user.roles.map((role) => (
                <Badge key={role} tone="brand">
                  {role}
                </Badge>
              ))
            ) : (
              <span className="text-sm text-[var(--color-fg-muted)]">No role assigned</span>
            )}
          </div>
        </Card>

        <Card className="p-5">
          <p className="text-xs font-medium tracking-wide text-[var(--color-fg-subtle)] uppercase">
            Permissions
          </p>
          <p className="mt-2 text-2xl font-semibold text-[var(--color-fg)]">{permissions.length}</p>
          <p className="text-xs text-[var(--color-fg-muted)]">granted to you</p>
        </Card>

        <Card className="p-5">
          <p className="text-xs font-medium tracking-wide text-[var(--color-fg-subtle)] uppercase">
            API
          </p>
          <p className="mt-2 flex items-center gap-2 text-sm font-medium">
            <span
              className={`h-2 w-2 rounded-full ${apiVersion ? "bg-[var(--color-success)]" : "bg-[var(--color-danger)]"}`}
            />
            {apiVersion ? `Connected ${apiVersion}` : "Unreachable"}
          </p>
        </Card>
      </div>

      <Card className="p-6">
        <h2 className="text-sm font-semibold text-[var(--color-fg)]">What you can do here today</h2>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          The platform foundation is complete: multi-tenancy, authentication and permissions.
          Patient and clinical modules are next — the greyed-out items in the sidebar are not built
          yet, and are shown so you can see the shape of the product.
        </p>
        <ul className="mt-4 space-y-2 text-sm text-[var(--color-fg-muted)]">
          <li>• Add colleagues and give them roles, under Staff.</li>
          <li>• Review which roles exist and what each one grants.</li>
          <li>• Change your password and see where you are signed in.</li>
        </ul>
      </Card>
    </div>
  );
}

export default function Page() {
  return (
    <Protected>
      <Dashboard />
    </Protected>
  );
}
