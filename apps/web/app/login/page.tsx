"use client";

/**
 * Login (Doc 02 A3 "Login" page).
 *
 * Two steps, because the API has two: password, then — only if the account has
 * MFA — a 6-digit code. The password step succeeding is NOT a session; the MFA
 * challenge token it returns is worthless anywhere except the verify endpoint.
 *
 * The error copy is deliberately identical for every failure the API collapses
 * into HMS-AUTH-001 (unknown email, wrong password, disabled, locked). Being
 * helpful here — "no such user" — would turn this form into a way to discover who
 * works at the hospital.
 */
import { Suspense, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ApiClientError, isMfaChallenge } from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import { apiTarget } from "../../lib/api";
import { Alert, Button, Card, Field } from "../../components/ui";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { login, completeMfa } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(
    params.get("reason") === "expired" ? "Your session expired. Please sign in again." : null,
  );
  const [busy, setBusy] = useState(false);

  const destination = params.get("next") ?? "/dashboard";

  /**
   * A NON-ApiClientError means the request never got an answer: DNS, the wrong
   * host, a dead API. "Check your connection" is useless advice for the most
   * common cause by far, which is that the address itself is wrong — and the
   * hostname IS the hospital here, so a wrong address is not a typo, it is a
   * request aimed at another machine entirely.
   *
   * `apiTarget()` reports where the browser actually TRIED to go. That single
   * fact turns a mystery into a diagnosis, and it is the difference between
   * "the app is broken" and "I am on the wrong URL". (It cost us a support
   * round-trip to learn this; the answer belongs on the screen, not in a doc.)
   */
  function describe(err: unknown): string {
    if (!(err instanceof ApiClientError)) {
      const target = apiTarget();
      return target
        ? `Could not reach the hospital's server at ${target}. If you are running this locally, check the web address — it must be a hospital hostname such as demo.localhost:3000.`
        : "Could not reach the server. Check your connection and try again.";
    }
    switch (err.code) {
      case "HMS-AUTH-001":
        // One message for every credential failure — see the note above.
        return "Incorrect email or password.";
      case "HMS-TEN-001":
        return "This address does not belong to any hospital. Check the web address.";
      case "HMS-TEN-002":
        return "This hospital's account is suspended. Please contact support.";
      case "HMS-AUTH-002":
        return "That took too long. Please start again.";
      default:
        return err.message;
    }
  }

  async function submitPassword(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await login(email, password);
      if (isMfaChallenge(result)) {
        setMfaToken(result.mfaToken);
      } else {
        // A user handed a temporary password must replace it before doing anything.
        router.replace(result.user.mustChangePassword ? "/change-password" : destination);
      }
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitMfa(e: FormEvent) {
    e.preventDefault();
    if (!mfaToken) return;
    setBusy(true);
    setError(null);
    try {
      await completeMfa(mfaToken, code.trim());
      router.replace(destination);
    } catch (err) {
      setError(
        err instanceof ApiClientError && err.code === "HMS-AUTH-001"
          ? "That code is not right. Codes change every 30 seconds."
          : describe(err),
      );
      setCode("");
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
          <h1 className="text-xl font-semibold text-[var(--color-fg)]">
            {mfaToken ? "Two-step verification" : "Sign in"}
          </h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            {mfaToken
              ? "Enter the 6-digit code from your authenticator app."
              : "Use your hospital account."}
          </p>
        </div>

        <Card className="p-6 shadow-sm">
          {error && (
            <div className="mb-4">
              <Alert tone="danger">{error}</Alert>
            </div>
          )}

          {mfaToken ? (
            <form onSubmit={submitMfa} className="space-y-4">
              <Field
                label="Verification code"
                name="code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="000000"
                maxLength={16}
                autoFocus
                required
                hint="You can also use one of your recovery codes."
              />
              <Button type="submit" loading={busy} className="w-full">
                Verify
              </Button>
              <button
                type="button"
                onClick={() => {
                  setMfaToken(null);
                  setCode("");
                  setError(null);
                }}
                className="w-full text-center text-sm text-[var(--color-fg-muted)] hover:underline"
              >
                Back
              </button>
            </form>
          ) : (
            <form onSubmit={submitPassword} className="space-y-4">
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
              <Field
                label="Password"
                name="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
              <Button type="submit" loading={busy} className="w-full">
                Sign in
              </Button>
            </form>
          )}
        </Card>

        <p className="mt-6 text-center text-xs text-[var(--color-fg-subtle)]">
          Forgotten your password? Ask an administrator to reset it.
        </p>
      </div>
    </main>
  );
}

export default function LoginPage() {
  // `useSearchParams` needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
