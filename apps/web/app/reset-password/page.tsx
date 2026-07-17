"use client";

/**
 * Reset password — set a new password from the emailed link.
 *
 * The token in the query string IS the credential; there is no session here. A valid, unspent,
 * unexpired token sets the new password and (server-side) logs every device out. An invalid or
 * expired one cannot be salvaged on this screen — the only remedy is a fresh link, so that is what
 * we point at, rather than letting the user retype into a form that can never succeed.
 */
import { Suspense, useState, type FormEvent, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ApiClientError } from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import { Alert, Button, Card, Field } from "../../components/ui";

function ResetForm() {
  const { api } = useAuth();
  const router = useRouter();
  const token = useSearchParams().get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A dead link cannot be fixed here; steer to a new one instead of a form that will only 400.
  const [linkDead, setLinkDead] = useState(false);

  const missingToken = token.length === 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.resetPassword(token, password);
      setDone(true);
    } catch (err) {
      if (err instanceof ApiClientError && err.code === "HMS-AUTH-002") {
        setLinkDead(true);
      } else if (err instanceof ApiClientError && err.code === "HMS-VAL-001") {
        // The server’s password policy refused it — surface the reasons it gave, if any.
        const reasons = (err.details as { password?: string[] } | undefined)?.password;
        setError(
          reasons && reasons.length > 0
            ? `That password ${reasons[0]}.`
            : "That password does not meet the requirements.",
        );
      } else {
        setError("Could not reset the password. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  const shell = (child: ReactNode) => (
    <main className="flex min-h-screen items-center justify-center bg-[var(--color-bg-subtle)] px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--color-brand-600)] text-lg font-bold text-[var(--color-on-accent)]">
            M
          </div>
          <h1 className="text-xl font-semibold text-[var(--color-fg)]">Choose a new password</h1>
        </div>
        <Card className="p-6 shadow-sm">{child}</Card>
      </div>
    </main>
  );

  if (done) {
    return shell(
      <div className="space-y-4">
        <Alert tone="success">
          Your password has been reset. For your security, every device was signed out — sign in
          again with your new password.
        </Alert>
        <Button className="w-full" onClick={() => router.replace("/login")}>
          Go to sign in
        </Button>
      </div>,
    );
  }

  if (missingToken || linkDead) {
    return shell(
      <div className="space-y-4">
        <Alert tone="danger">
          {missingToken
            ? "This page needs a reset link. Please open the link from your email."
            : "This reset link is invalid or has expired. Reset links last 60 minutes and work once."}
        </Alert>
        <a
          href="/forgot-password"
          className="block text-center text-sm text-[var(--color-brand-600)] hover:underline"
        >
          Request a new link
        </a>
      </div>,
    );
  }

  return shell(
    <form onSubmit={submit} className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}
      <Field
        label="New password"
        name="newPassword"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="new-password"
        autoFocus
        required
      />
      <Field
        label="Confirm new password"
        name="confirmPassword"
        type="password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        autoComplete="new-password"
        required
      />
      <Button type="submit" loading={busy} className="w-full">
        Reset password
      </Button>
      <a
        href="/login"
        className="block text-center text-sm text-[var(--color-fg-muted)] hover:underline"
      >
        Back to sign in
      </a>
    </form>,
  );
}

export default function ResetPasswordPage() {
  // `useSearchParams` needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={null}>
      <ResetForm />
    </Suspense>
  );
}
