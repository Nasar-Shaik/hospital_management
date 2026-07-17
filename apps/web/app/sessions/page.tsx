"use client";

/**
 * Active sessions (Doc 02 A3 "Active Sessions").
 *
 * "Where am I signed in, and sign that one out." Revoking a session kills its
 * whole refresh family, so the device it belonged to cannot quietly renew itself.
 */
import { useCallback, useEffect, useState } from "react";
import { ApiClientError, type Session } from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import { Protected } from "../../components/Protected";
import { Alert, Button, Card } from "../../components/ui";

function describeDevice(session: Session): string {
  const agent = session.device ?? session.userAgent ?? "";
  if (/iphone|android|mobile/i.test(agent)) return "Mobile device";
  if (/mac/i.test(agent)) return "Mac";
  if (/windows/i.test(agent)) return "Windows PC";
  if (/linux/i.test(agent)) return "Linux";
  return "Unknown device";
}

function Sessions() {
  const { api } = useAuth();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSessions(await api.sessions());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not load your sessions.");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(id: string) {
    try {
      await api.revokeSession(id);
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not sign that device out.");
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-[var(--color-fg)]">Active sessions</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Everywhere you are currently signed in. If you do not recognise one, sign it out and
          change your password.
        </p>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      <Card>
        <ul className="divide-y divide-[var(--color-border)]">
          {loading && (
            <li className="p-6 text-center text-sm text-[var(--color-fg-muted)]">Loading…</li>
          )}

          {!loading &&
            sessions.map((session) => (
              <li key={session.id} className="flex items-center justify-between gap-4 p-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[var(--color-fg)]">
                    {describeDevice(session)}
                  </p>
                  <p className="text-xs text-[var(--color-fg-muted)]">
                    {session.ip ?? "unknown address"} · last active{" "}
                    {new Date(session.lastSeenAt).toLocaleString()}
                  </p>
                </div>
                <Button variant="secondary" onClick={() => void revoke(session.id)}>
                  Sign out
                </Button>
              </li>
            ))}
        </ul>
      </Card>
    </div>
  );
}

export default function Page() {
  return (
    <Protected>
      <Sessions />
    </Protected>
  );
}
