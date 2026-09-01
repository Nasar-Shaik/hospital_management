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
import { useRuntime } from "../providers/RuntimeProvider";
import { actionsOnPhase, actionsOnResume, type AppPhase } from "../lib/lifecycle";
import { LOCK_AFTER_MS, NO_BIOMETRICS, shouldLock } from "../lib/lock";

export interface LifecycleState {
  /** True while the app is not fully foregrounded — the privacy overlay follows this exactly. */
  obscured: boolean;
  /** Set when the absence was long enough to require a re-unlock. M2 K acts on it. */
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

      /**
       * ── THE GATE GOES UP BEFORE ANYTHING ELSE IS DONE (M2 K) ──────────────────
       * `shouldLock` decides; this only performs. It runs before the refetch and before the
       * revalidation deliberately: those are network round trips, and a chart must not be visible
       * for the second and a half they take. Raising the lock is synchronous, so the frame that
       * follows a resume is the gate — never the ward list that was on screen an hour ago.
       *
       * The capability probe IS async, so the lock is raised first with whatever the store already
       * knows and refined a tick later. Waiting for the probe would put a native round trip in
       * front of the gate, which is the one thing that must not be waited on.
       */
      const state = runtime.lock.getState();
      if (
        shouldLock(
          {
            enabled: state.enabled,
            hasSession: runtime.session.getState().user !== undefined,
            awayMs,
          },
          LOCK_AFTER_MS,
        )
      ) {
        state.lock(state.capability);
        void probeCapability(runtime);
      }

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
 * What this device can offer, asked of the device rather than remembered.
 *
 * Re-probed on every lock because the answer genuinely changes: a user can remove their last
 * fingerprint in Settings while the app is backgrounded, and a gate that then offered a biometric
 * prompt would show one that fails every time with no way past it.
 */
async function probeCapability(runtime: ReturnType<typeof useRuntime>): Promise<void> {
  const authenticator = runtime.biometrics;
  const capability = authenticator ? await authenticator.capability() : NO_BIOMETRICS;
  const state = runtime.lock.getState();
  // Only while the gate is still up: an unlock may have landed during the probe, and a stale
  // capability written over an unlocked store is noise. `setCapability`, never `lock` — see the
  // store, which explains why re-locking here would hand back a spent attempt.
  if (state.state === "locked") state.setCapability(capability);
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
