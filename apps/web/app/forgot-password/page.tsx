"use client";

/**
 * Forgot password — request a reset link.
 *
 * The confirmation is DELIBERATELY the same whether or not the email belongs to an account: the
 * API never says "no such user" (that would turn this box into a way to discover who works at the
 * hospital), and neither does this screen. On submit we always show the same "check your inbox"
 * message — the honest reflection of a server that tells us nothing either way.
 */
import { useState, type FormEvent } from "react";
import { ApiClientError } from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import { apiTarget } from "../../lib/api";
import { Alert, Button, Card, Field } from "../../components/ui";

export default function ForgotPasswordPage() {
  const { api } = useAuth();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.forgotPassword(email.trim());
      setSent(true);
    } catch (err) {
      // Only a transport/validation failure reaches here — the request itself never reveals whether
      // the account exists. A bad email format is a 400; anything else is a connection problem.
      if (!(err instanceof ApiClientError)) {
        const target = apiTarget();
        setError(
          target
            ? `Could not reach the hospital's server at ${target}. Check the web address.`
            : "Could not reach the server. Check your connection and try again.",
        );
      } else {
        setError("Please enter a valid email address.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--color-bg-subtle)] px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--color-brand-600)] text-lg font-bold text-[var(--color-on-accent)]">
            M
          </div>
          <h1 className="text-xl font-semibold text-[var(--color-fg)]">Reset your password</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            We&apos;ll email you a link to choose a new one.
          </p>
        </div>

        <Card className="p-6 shadow-sm">
          {sent ? (
            <div className="space-y-4">
              <Alert tone="success">
                If an account exists for <span className="font-medium">{email}</span>, a reset link
                is on its way. The link is valid for 60 minutes and can be used once.
              </Alert>
              <p className="text-sm text-[var(--color-fg-muted)]">
                Didn&apos;t get it? Check your spam folder, or try again with the email your account
                uses.
              </p>
              <a
                href="/login"
                className="block text-center text-sm text-[var(--color-brand-600)] hover:underline"
              >
                Back to sign in
              </a>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              {error && <Alert tone="danger">{error}</Alert>}
              <Field
                label="Email"
                name="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                placeholder="you@hospital.com"
                autoFocus
                required
              />
              <Button type="submit" loading={busy} className="w-full">
                Send reset link
              </Button>
              <a
                href="/login"
                className="block text-center text-sm text-[var(--color-fg-muted)] hover:underline"
              >
                Back to sign in
              </a>
            </form>
          )}
        </Card>
      </div>
    </main>
  );
}
