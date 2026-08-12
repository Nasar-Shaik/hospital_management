/**
 * The runtime, handed down to the tree.
 *
 * ── A HOSPITAL SWITCH REBUILDS, IT DOES NOT MUTATE ──────────────────────────
 * `createRuntime` is called once per hospital profile and memoised on the slug, so switching
 * hospital replaces the client, the stores, the controllers and the query cache in one step.
 * Nothing survives the boundary — a much stronger guarantee than remembering to clear each piece,
 * and cross-tenant leakage is the one class of bug this product cannot have.
 *
 * ── WHY IT TOLERATES `profile: undefined` ───────────────────────────────────
 * On a fresh install there is no hospital yet, and the onboarding screen has to render inside the
 * same navigator as everything else. Rather than swapping the provider in and out — which would
 * remount the navigator and lose its state — the provider stays mounted and simply has nothing to
 * offer. `useRuntime()` then throws a message that names the actual mistake, and the one screen
 * that legitimately renders early uses `useOptionalRuntime()`.
 */
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRuntime, type MobileRuntime } from "../lib/runtime";
import type { HospitalProfile } from "../lib/tenant";
import type { SessionEndReason } from "../lib/session";
import { secureStore } from "../platform/secureStore";
import { preferences } from "../platform/preferences";
import { appConfig } from "../platform/config";
import { createLogger } from "../lib/log";

const RuntimeContext = createContext<MobileRuntime | undefined>(undefined);

export function RuntimeProvider({
  profile,
  onSessionEnded,
  children,
}: {
  profile: HospitalProfile | undefined;
  onSessionEnded: (reason: SessionEndReason) => void;
  children: ReactNode;
}): React.JSX.Element {
  /** A parked client for the pre-hospital case, so the provider below never changes shape. */
  const [idleClient] = useState(() => new QueryClient());

  const runtime = useMemo(() => {
    if (!profile) return undefined;
    return createRuntime({
      profile,
      secureStore,
      preferences,
      logger: createLogger({ verbose: appConfig.environment !== "production" }),
      onSessionEnded,
    });
    // Keyed on the slug alone: a new profile OBJECT with the same slug (a re-render, a label
    // edit) must not tear down a live session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.slug]);

  return (
    <RuntimeContext.Provider value={runtime}>
      <QueryClientProvider client={runtime?.queryClient ?? idleClient}>
        {children}
      </QueryClientProvider>
    </RuntimeContext.Provider>
  );
}

export function useRuntime(): MobileRuntime {
  const runtime = useContext(RuntimeContext);
  if (!runtime) {
    throw new Error(
      "useRuntime was called before a hospital was selected — use useOptionalRuntime",
    );
  }
  return runtime;
}

export function useOptionalRuntime(): MobileRuntime | undefined {
  return useContext(RuntimeContext);
}
