/**
 * The one `AppState` subscription in the app (M0 §15).
 *
 * Screens do not subscribe. If they did, each would decide for itself what a resume means and the
 * fourth one written would forget to stop its poller — the failure mode this hook exists to make
 * structurally impossible.
 *
 * The DECISIONS live in `src/lib/lifecycle.ts` as pure functions, tested by calling them. What is
 * here is only the wiring: listen, measure the absence, perform.
 */
import { useEffect, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { useRuntime } from "../providers/RuntimeProvider.js";
import { actionsOnPhase, actionsOnResume, type AppPhase } from "../lib/lifecycle.js";

export interface LifecycleState {
  /** True while the app is not fully foregrounded — the privacy overlay follows this exactly. */
  obscured: boolean;
  /** Set when the absence was long enough to require a re-unlock. M2 acts on it; M1 records it. */
  lockRequired: boolean;
}

function toPhase(status: AppStateStatus): AppPhase {
  if (status === "active") return "active";
  // Android has no `inactive`; `background` covers both transitions there.
  return status === "background" ? "background" : "inactive";
}

export function useAppLifecycle(): LifecycleState {
  const runtime = useRuntime();
  const [state, setState] = useState<LifecycleState>({ obscured: false, lockRequired: false });
  const leftAt = useRef<number | undefined>(undefined);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (status) => {
      const phase = toPhase(status);

      if (phase !== "active") {
        const { showOverlay, stopPolling } = actionsOnPhase(phase);
        // The overlay goes up on `inactive`, BEFORE the OS snapshot for the app switcher is
        // taken. Waiting for `background` is too late — the picture already exists.
        setState((previous) => ({ ...previous, obscured: showOverlay }));
        if (stopPolling) {
          leftAt.current = Date.now();
          // In-flight mutations are deliberately left alone: cancelling a payment mid-flight
          // creates exactly the ambiguity `Idempotency-Key` exists to resolve.
          void runtime.queryClient.cancelQueries({ type: "active", fetchStatus: "fetching" });
        }
        return;
      }

      const awayMs = leftAt.current === undefined ? 0 : Date.now() - leftAt.current;
      leftAt.current = undefined;
      const actions = actionsOnResume(awayMs);

      setState({ obscured: !actions.hideOverlay, lockRequired: actions.requireUnlock });

      if (actions.refetchActive) void runtime.queryClient.invalidateQueries({ type: "active" });
      if (actions.revalidateSession || actions.revalidateBranches) {
        void revalidate(runtime, actions.revalidateBranches);
      }
    });

    return () => subscription.remove();
  }, [runtime]);

  return state;
}

/**
 * Re-reads identity and, when the absence was long, the branch list. Failures are swallowed on
 * purpose: a resume that cannot reach the network must not throw the user out — the next real
 * request will produce a proper, explained error.
 */
async function revalidate(
  runtime: ReturnType<typeof useRuntime>,
  branches: boolean,
): Promise<void> {
  try {
    const me = await runtime.api.me();
    runtime.session.getState().setUser(me);
    runtime.session.getState().setPermissions(me.permissions ?? []);
    if (branches) await runtime.branches.restore(me.id);
  } catch {
    runtime.logger.warn("resume revalidation failed", { tenantSlug: runtime.profile.slug });
  }
}
