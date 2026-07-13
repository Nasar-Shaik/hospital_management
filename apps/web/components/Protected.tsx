"use client";

/**
 * Wraps every signed-in page: waits for the session bootstrap, then renders the
 * shell. The middleware already redirected anyone with no cookie, but a cookie is
 * not a session — it may be expired, revoked, or from a family we burned. This is
 * where we find out, by actually exchanging it.
 */
import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "./AuthProvider";
import { AppShell } from "./AppShell";

export function Protected({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--color-bg-subtle)]">
        <span
          aria-label="Loading"
          className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--color-brand-600)] border-t-transparent"
        />
      </div>
    );
  }

  if (!user) return null; // redirecting

  return <AppShell>{children}</AppShell>;
}
