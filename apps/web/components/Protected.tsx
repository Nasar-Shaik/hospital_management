"use client";

/**
 * Wraps every signed-in page: waits for the session bootstrap, then renders the
 * shell. The middleware already redirected anyone with no cookie, but a cookie is
 * not a session — it may be expired, revoked, or from a family we burned. This is
 * where we find out, by actually exchanging it.
 */
import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "./AuthProvider";
import { AppShell } from "./AppShell";

export function Protected({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (loading || user) return;

    /**
     * `reason=expired` is not decoration. The middleware sees only that a cookie
     * EXISTS, so without this it sends us back to the page we just failed to load
     * and the two of us bounce the user between them forever. We are the only one
     * who knows the cookie is dead — we just tried it. Saying so is what lets them
     * reach the login form at all, and it is why they get told their session ended
     * instead of silently landing on a blank sign-in page.
     */
    const params = new URLSearchParams({ reason: "expired" });
    if (pathname && pathname !== "/") params.set("next", pathname);
    router.replace(`/login?${params.toString()}`);
  }, [loading, user, router, pathname]);

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
