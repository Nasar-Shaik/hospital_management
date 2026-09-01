"use client";

/**
 * Change password.
 *
 * A successful change ends EVERY session, including this one — every existing token was minted
 * under the old secret. So we send the user straight back to the login screen rather than leaving
 * them on a page whose next click will fail.
 *
 * ── LEAVING IS `endSession`, NOT A `router.replace` ─────────────────────────
 * This page used to show a "redirecting…" card and navigate on a 2.5s timer, and the effect on a
 * new hire with a temporary password was that it appeared not to redirect at all. Two reasons,
 * both from the same omission — the client never cleared its own session:
 *
 *   1. `user` stayed in state and the in-memory access token stayed usable, so /dashboard rendered
 *      perfectly well. The sign-out only surfaced later, on the first request that 401'd, which is
 *      why it looked like "it redirects when I click something else".
 *   2. Any surviving cookie makes the route guard bounce /login straight back to /dashboard — it
 *      sees a cookie's presence, never its validity (middleware.ts).
 *
 * `endSession` drops the token and the user in the same tick, and `?reason=` is the guard's hatch
 * as well as the login form's cue to say something true. There is no interstitial: the message
 * belongs on the page they are going to, not on one they are leaving.
 */
import { useState, type FormEvent } from "react";
import { ApiClientError } from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import { Alert, Button, Card, Field } from "../../components/ui";

function ChangePassword() {
  const { api, user, endSession } = useAuth();

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setErrors([]);

    if (next !== confirm) {
      setError("The two new passwords do not match.");
      return;
    }

    setBusy(true);
    try {
      await api.changePassword(current, next);
      // Straight out, in this tick. See the header for what waiting used to cost.
      endSession("/login?reason=password-changed");
      return;
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.code === "HMS-AUTH-001") {
          setError("Your current password is not right.");
        } else {
          const fields = err.fieldErrors.password ?? [];
          if (fields.length > 0) setErrors(fields);
          else setError(err.message);
        }
      } else {
        setError("Could not change your password.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-md space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-[var(--color-fg)]">Change password</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Changing it signs you out everywhere.
        </p>
      </div>

      {user?.mustChangePassword && (
        <Alert tone="warning">
          You are using a temporary password that someone else has seen. Please replace it.
        </Alert>
      )}

      {error && <Alert tone="danger">{error}</Alert>}

      {errors.length > 0 && (
        <Alert tone="danger" title="That password is not strong enough">
          <ul className="mt-1 list-disc pl-4">
            {errors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </Alert>
      )}

      <Card className="p-6">
        <form onSubmit={submit} className="space-y-4">
          <Field
            label="Current password"
            name="current"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
          />
          <Field
            label="New password"
            name="next"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            hint="At least 12 characters, with upper and lower case, a digit and a symbol."
            required
          />
          <Field
            label="Confirm new password"
            name="confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
          <Button type="submit" loading={busy} className="w-full">
            Change password
          </Button>
        </form>
      </Card>
    </div>
  );
}

export default function Page() {
  return <ChangePassword />;
}
