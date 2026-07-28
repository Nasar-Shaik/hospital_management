"use client";

/**
 * API keys (Module A9) — where an admin issues and revokes programmatic access to the API.
 *
 * A key is shown in FULL exactly once, at creation: there is no path to read it again, so the page
 * makes copying it unmissable and warns that closing the panel loses it. A key acts with the
 * creator's own permissions — that is stated plainly, because a powerful key handed to an
 * integration is a powerful thing to lose.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiClientError, type ApiKeyMeta, type CreatedApiKey } from "@medicore/api-client";
import { useAuth } from "../../../components/AuthProvider";
import { Alert, Badge, Button, Card, Field } from "../../../components/ui";

function fmtDate(iso?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function ApiKeysPage() {
  const { api, can } = useAuth();
  const allowed = can("apikey:manage");

  const [keys, setKeys] = useState<ApiKeyMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const [name, setName] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [justCreated, setJustCreated] = useState<CreatedApiKey | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api
      .listApiKeys()
      .then(setKeys)
      .catch((e: unknown) => setError(e))
      .finally(() => setLoading(false));
  }, [api]);

  useEffect(() => {
    if (allowed) load();
    else setLoading(false);
  }, [allowed, load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const created = await api.createApiKey({
        name: name.trim(),
        ...(expiresOn ? { expiresOn } : {}),
      });
      setJustCreated(created);
      setCopied(false);
      setName("");
      setExpiresOn("");
      load();
    } catch (err) {
      setCreateError(err instanceof ApiClientError ? err.message : "Could not create the key.");
    } finally {
      setCreating(false);
    }
  }

  async function revoke(k: ApiKeyMeta) {
    if (!window.confirm(`Revoke "${k.name}"? Any integration using it stops working immediately.`))
      return;
    try {
      await api.revokeApiKey(k.id);
      load();
    } catch {
      /* best-effort */
    }
  }

  function copyKey() {
    if (!justCreated) return;
    void navigator.clipboard?.writeText(justCreated.key).then(() => setCopied(true));
  }

  if (!allowed) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Alert tone="warning" title="No access">
          You need the <strong>apikey:manage</strong> permission to manage API keys.
        </Alert>
      </div>
    );
  }

  const statusOf = (k: ApiKeyMeta): { label: string; tone: "success" | "neutral" | "warning" } => {
    if (k.revokedAt) return { label: "Revoked", tone: "neutral" };
    if (k.expiresAt && new Date(k.expiresAt).getTime() <= Date.now())
      return { label: "Expired", tone: "warning" };
    return { label: "Active", tone: "success" };
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-fg)]">API keys</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Programmatic access to your hospital&rsquo;s API. A key acts with{" "}
          <strong>your own permissions</strong>, so treat it like a password — anyone who has it can
          do what you can.
        </p>
      </div>

      {justCreated && (
        <Card className="border-[var(--color-success)]/40 p-5">
          <h2 className="font-semibold text-[var(--color-fg)]">Copy your new key now</h2>
          <p className="mt-1 mb-3 text-sm text-[var(--color-fg-muted)]">
            This is the only time it is shown. If you lose it, revoke it and make a new one.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-3 py-2 font-mono text-sm break-all select-all">
              {justCreated.key}
            </code>
            <Button variant="secondary" onClick={copyKey}>
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <div className="mt-3">
            <Button variant="ghost" onClick={() => setJustCreated(null)}>
              Done — I&rsquo;ve saved it
            </Button>
          </div>
        </Card>
      )}

      <Card className="p-5">
        <h2 className="mb-3 font-semibold text-[var(--color-fg)]">Create a key</h2>
        {createError && (
          <div className="mb-3">
            <Alert tone="danger">{createError}</Alert>
          </div>
        )}
        <form onSubmit={create} className="flex flex-wrap items-end gap-3">
          <div className="min-w-[200px] flex-1">
            <Field
              label="Name"
              name="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Billing export"
              required
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-[var(--color-fg)]">
              Expires on (optional)
            </label>
            <input
              type="date"
              value={expiresOn}
              onChange={(e) => setExpiresOn(e.target.value)}
              className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2.5 text-sm outline-none focus:border-[var(--color-brand-500)]"
            />
          </div>
          <Button type="submit" loading={creating} disabled={name.trim().length === 0}>
            Create key
          </Button>
        </form>
      </Card>

      {error != null && <Alert tone="danger">Could not load your API keys.</Alert>}

      <Card className="overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-[var(--color-border)] text-xs tracking-wide text-[var(--color-fg-subtle)] uppercase">
            <tr>
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Key</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Last used</th>
              <th className="px-4 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {loading ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-[var(--color-fg-muted)]">
                  Loading…
                </td>
              </tr>
            ) : keys.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-[var(--color-fg-muted)]">
                  No API keys yet.
                </td>
              </tr>
            ) : (
              keys.map((k) => {
                const status = statusOf(k);
                return (
                  <tr key={k.id} className={k.revokedAt ? "opacity-60" : ""}>
                    <td className="px-4 py-3 font-medium text-[var(--color-fg)]">{k.name}</td>
                    <td className="px-4 py-3 font-mono text-xs text-[var(--color-fg-muted)]">
                      ••••{k.last4}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </td>
                    <td className="px-4 py-3 text-[var(--color-fg-muted)]">
                      {fmtDate(k.lastUsedAt)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {!k.revokedAt && (
                        <button
                          className="text-xs text-[var(--color-danger)] hover:underline"
                          onClick={() => void revoke(k)}
                        >
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

export default function Page() {
  return <ApiKeysPage />;
}
