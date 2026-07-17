"use client";

/**
 * Change password.
 *
 * A successful change ends EVERY session, including this one — every existing
 * token was minted under the old secret. So we send the user straight back to the
 * login screen rather than leaving them on a page whose next click will fail.
 */
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ApiClientError } from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import { Protected } from "../../components/Protected";
import { Alert, Button, Card, Field } from "../../components/ui";

function ChangePassword() {
  const router = useRouter();
  const { api, user } = useAuth();

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

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
      setDone(true);
      // Give them a moment to read why they are being signed out.
      setTimeout(() => router.replace("/login"), 2500);
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

  if (done) {
    return (
      <div className="mx-auto max-w-md">
        <Alert tone="success" title="Password changed">
          For your security, every device has been signed out. Redirecting you to sign in again…
        </Alert>
      </div>
    );
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
  return (
    <Protected>
      <ChangePassword />
    </Protected>
  );
}
