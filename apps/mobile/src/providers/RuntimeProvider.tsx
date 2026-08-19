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
import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { Redirect } from "expo-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRuntime, type MobileRuntime } from "../lib/runtime";
import type { HospitalProfile } from "../lib/tenant";
import type { SessionEndReason } from "../lib/session";
import { secureStore } from "../platform/secureStore";
import { preferences } from "../platform/preferences";
import { pushNotifications } from "../platform/pushNotifications";
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
      /**
       * The notification service (M4). A phone that cannot mint a token — a simulator, Expo Go, a
       * declined permission, a build with no EAS project — registers nothing and behaves exactly
       * as it did before, because the inbox is the message.
       */
      push: pushNotifications,
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

/**
 * Guards a route that cannot render without a hospital. **Every route module except `/hospital`
 * and `+not-found` needs this**, including the `(app)` layout, which covers the group beneath it.
 *
 * ── WHY A WRAPPER AND NOT A CHECK INSIDE THE SCREEN ─────────────────────────
 * `useRuntime`, `useSession`, `useBranch` and `useCapabilities` all read the runtime, they all run
 * before the screen's first `return`, and hooks cannot be conditional. By the time a screen could
 * test for the runtime it has already thrown. The redirect therefore has to happen in a PARENT
 * component — one whose only hook is the optional read.
 *
 * ── AND WHY NOT AN EFFECT ───────────────────────────────────────────────────
 * On a fresh install the first URL is `/`, which Expo Router resolves to `(app)/index`. The
 * signed-in layout mounted and threw on the very first render — before the effect that was meant
 * to send the user to `/hospital` ever ran. A gate that only closes after paint is not a gate.
 *
 * @param whenMissing what to render instead. A route wants the default redirect; something mounted
 *   ALONGSIDE the navigator — the privacy cover — wants `null`, because redirecting from a sibling
 *   of the router would move a user who was not going anywhere.
 */
export function requireRuntime<P extends object>(
  Screen: ComponentType<P>,
  whenMissing: ReactNode = <Redirect href="/hospital" />,
): ComponentType<P> {
  function Guarded(props: P): ReactNode {
    const runtime = useOptionalRuntime();
    if (!runtime) return whenMissing;
    return <Screen {...props} />;
  }
  Guarded.displayName = `requireRuntime(${Screen.displayName ?? Screen.name ?? "Screen"})`;
  return Guarded;
}
