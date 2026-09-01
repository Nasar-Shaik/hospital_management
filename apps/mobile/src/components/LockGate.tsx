/**
 * The lock screen (M2 K) — what a resumed phone shows before it shows a patient.
 *
 * ── IT REPLACES THE APP, IT DOES NOT COVER IT ───────────────────────────────
 * Mounted at the ROOT, above the navigator, in the same position and for the same reason as
 * `PrivacyCover`: no screen can forget it, and no screen added later has to remember it. But where
 * the privacy overlay is a lid over a rendered tree, this returns `null` for everything beneath —
 * because a cover can be defeated by anything that draws above it (a toast, a system alert, a
 * screenshot taken in the half-frame before it mounts), and the point of the gate is that the
 * chart is not on the screen at all.
 *
 * ── IT NEVER TOUCHES THE SESSION, EXCEPT ONCE ───────────────────────────────
 * A failed scan costs an attempt and nothing else: the refresh token stays in the Keychain, the
 * cache stays warm, and the doctor tries again. That is deliberate and it is the difference
 * between a gate people keep switched on and one they turn off after the first wet thumb —
 * `lib/lock.ts` sets out the reasoning. Only `MAX_ATTEMPTS` failures end the session, which is the
 * shape that matches the actual threat: a stranger with a found phone runs out of tries, and the
 * owner never gets near the limit.
 *
 * "Sign out" is offered from the first render, so nobody is ever trapped behind a sensor.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Button } from "./Button";
import { useLock, useSession } from "../hooks/useStores";
import { useTheme } from "../hooks/useTheme";
import { requireRuntime, useRuntime } from "../providers/RuntimeProvider";
import { unlockMethod } from "../state/lock";
import { afterAttempt, attemptMessage, MAX_ATTEMPTS } from "../lib/lock";
import { radius, space, typography } from "../theme/tokens";

/** What the OS prompt says. Names the app and the act, because the OS sheet has no other context. */
const PROMPT = "Unlock MediCore";

function Lock(): React.JSX.Element {
  const theme = useTheme();
  const runtime = useRuntime();
  const locked = useLock((s) => s.state === "locked");
  const failures = useLock((s) => s.failures);
  const method = useLock(unlockMethod);
  const name = useSession((s) => s.user?.name);

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);

  /**
   * One prompt at a time, and only one automatic one per lock.
   *
   * Without the guard the effect below re-fires on every store change — including the capability
   * probe landing — and the OS stacks a second sheet on the first. On Android that is two dialogs;
   * on iOS the second silently cancels the first, which the policy reads as a cancellation the
   * user never made.
   */
  const prompted = useRef(false);
  useEffect(() => {
    if (!locked) prompted.current = false;
  }, [locked]);

  const attempt = useCallback(async () => {
    const authenticator = runtime.biometrics;
    if (!authenticator || busy) return;

    setBusy(true);
    try {
      const result = await authenticator.authenticate(PROMPT);
      const state = runtime.lock.getState();
      const outcome = afterAttempt(result, state.failures);

      switch (outcome.outcome) {
        case "unlocked":
          state.unlock();
          setMessage(undefined);
          break;
        case "password":
          // The sensor cannot answer — locked out by the OS, not enrolled, or the user asked for
          // the other door. Stop offering it rather than looping on a prompt that cannot succeed.
          state.usePassword();
          setMessage(undefined);
          break;
        case "retry":
          if (result === "failed") state.recordFailure();
          setMessage(attemptMessage(outcome.attemptsLeft));
          break;
        case "signOut":
          /**
           * The one path that ends a session. `signOut` clears the token and navigates, and the
           * runtime's `onSessionEnded` resets this gate — so the user lands on the login screen
           * rather than on a lock screen with no way past it.
           */
          state.recordFailure();
          await runtime.auth.signOut();
          break;
      }
    } finally {
      setBusy(false);
    }
  }, [runtime, busy]);

  /**
   * Prompt as soon as the gate goes up, without waiting for a tap.
   *
   * A doctor who picks the phone back up expects the sensor to be listening already — that is how
   * every other app on the device behaves, and an extra tap in front of a ward round is the kind
   * of friction that gets a security control disabled.
   */
  useEffect(() => {
    if (!locked || prompted.current || method !== "biometric") return;
    prompted.current = true;
    void attempt();
  }, [locked, method, attempt]);

  if (!locked) return <View style={styles.hidden} />;

  const attemptsLeft = MAX_ATTEMPTS - failures;

  return (
    <View
      accessibilityViewIsModal
      style={[StyleSheet.absoluteFill, styles.gate, { backgroundColor: theme.colors.bg }]}
    >
      <Text style={[typography.title, { color: theme.colors.brandStrong }]}>MediCore</Text>

      <View style={styles.body}>
        <Text style={[typography.heading, styles.centre, { color: theme.colors.fg }]}>
          {name ? `Welcome back, ${name}` : "Locked"}
        </Text>
        <Text style={[typography.body, styles.centre, { color: theme.colors.fgMuted }]}>
          {method === "biometric"
            ? "Unlock to return to your patients."
            : "This device has no fingerprint or face set up. Sign in again to continue."}
        </Text>

        {/* The warning appears only when it is worth knowing — see `attemptMessage`. */}
        {message ? (
          <Text
            accessibilityRole="alert"
            style={[typography.caption, styles.centre, { color: theme.colors.danger }]}
          >
            {message}
          </Text>
        ) : null}
      </View>

      <View style={styles.actions}>
        {method === "biometric" ? (
          <Button
            label={busy ? "Waiting for the sensor…" : "Unlock"}
            loading={busy}
            disabled={busy || attemptsLeft <= 0}
            onPress={() => void attempt()}
          />
        ) : null}

        {/**
         * Always present, from the first render. A gate with no exit is an app a doctor cannot
         * open on a phone whose sensor has stopped reading — and the exit is the ordinary one:
         * sign out, sign back in with the password that the server will check properly.
         */}
        <Button label="Sign out" variant="secondary" onPress={() => void runtime.auth.signOut()} />
      </View>
    </View>
  );
}

/**
 * The mounted form. Guarded like `PrivacyCover`, and renders nothing without a runtime — there is
 * no session before one exists, so there is nothing to lock.
 */
export const LockGate = requireRuntime(Lock, null);

const styles = StyleSheet.create({
  hidden: { display: "none" },
  /**
   * `zIndex` above the privacy overlay's 1000: when the app resumes, both are briefly mounted, and
   * the gate is the one that must win. The overlay dropping first would flash the chart underneath.
   */
  gate: {
    zIndex: 1100,
    alignItems: "center",
    justifyContent: "center",
    gap: space[6],
    padding: space[6],
  },
  body: { gap: space[2], maxWidth: 320 },
  centre: { textAlign: "center" },
  actions: { alignSelf: "stretch", gap: space[2], maxWidth: 360, borderRadius: radius.md },
});
