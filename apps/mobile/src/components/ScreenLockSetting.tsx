/**
 * The Settings control for the lock (M2 K).
 *
 * ── IT REPORTS WHAT THE DEVICE CAN DO, RATHER THAN GUESSING ─────────────────
 * The capability is probed when this renders, not remembered from an earlier session: a user can
 * enrol a fingerprint, or remove their last one, at any point between two visits to this screen.
 * A toggle that promised biometrics on a phone with none would produce a lock nobody could pass by
 * the method it advertised.
 *
 * ── AND IT IS HONEST ABOUT THE PASSWORD FALLBACK ────────────────────────────
 * With no sensor the gate still works — it just asks for a sign-in instead (`methodFor`). That is
 * said here, plainly, because "turn this on and it will ask for your password after 15 minutes" is
 * a different offer from "turn this on and it will use your fingerprint", and a user who expected
 * the second would experience the first as a bug.
 */
import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Button } from "./Button";
import { useLock } from "../hooks/useStores";
import { useTheme } from "../hooks/useTheme";
import { useRuntime } from "../providers/RuntimeProvider";
import { storageKeys } from "../lib/storage";
import {
  LOCK_AFTER_MS,
  NO_BIOMETRICS,
  canUseBiometrics,
  writeLockPreference,
  type BiometricCapability,
} from "../lib/lock";
import { space, typography } from "../theme/tokens";

const MINUTES = Math.round(LOCK_AFTER_MS / 60_000);

export function ScreenLockSetting(): React.JSX.Element {
  const theme = useTheme();
  const runtime = useRuntime();
  const enabled = useLock((s) => s.enabled);
  const [capability, setCapability] = useState<BiometricCapability | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const probe = async (): Promise<void> => {
      const found = runtime.biometrics ? await runtime.biometrics.capability() : NO_BIOMETRICS;
      if (!cancelled) setCapability(found);
    };
    void probe();
    return () => {
      cancelled = true;
    };
  }, [runtime]);

  const biometric = capability !== undefined && canUseBiometrics(capability);

  const toggle = (next: boolean): void => {
    runtime.lock.getState().setEnabled(next);
    /**
     * Written to PREFERENCES, not the Keychain. It is a setting, not a secret — and a value read
     * from the Keychain is only readable while the device is unlocked, which is precisely the
     * condition this gate has to work under (`lib/lock.ts`).
     *
     * Fire and forget: the store is the source of truth for this session, and a failed write costs
     * the setting on the NEXT launch rather than this one. Blocking a toggle on a disk write, or
     * rolling it back on failure, would be worse than the thing it protects against.
     */
    void runtime.preferences
      .set(storageKeys.screenLock(runtime.profile.slug), writeLockPreference(next))
      .catch(() => {
        runtime.logger.warn("could not persist the lock preference", {
          tenantSlug: runtime.profile.slug,
        });
      });
  };

  return (
    <View style={styles.block}>
      <Text style={[typography.body, { color: theme.colors.fg }]}>
        {enabled ? "Locks after inactivity" : "Off"}
      </Text>

      <Text style={[typography.caption, { color: theme.colors.fgMuted }]}>
        {enabled
          ? `Away for more than ${String(MINUTES)} minutes and this app hides itself until you unlock it. ` +
            (biometric
              ? "Your fingerprint or face opens it."
              : "This device has no fingerprint or face set up, so it will ask you to sign in again.")
          : `When on, the app hides itself after ${String(MINUTES)} minutes away and asks you to unlock it. ` +
            "Your session is not signed out — patients stay one tap away."}
      </Text>

      {/* Only worth saying while it is off; once on, the line above already says what will happen. */}
      {!enabled && capability !== undefined && !biometric ? (
        <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>
          {capability.hasHardware
            ? "No fingerprint or face is set up on this device yet — add one in the device settings to unlock with it."
            : "This device has no fingerprint or face sensor, so unlocking will use your password."}
        </Text>
      ) : null}

      <Button
        label={enabled ? "Turn off screen lock" : "Turn on screen lock"}
        variant={enabled ? "secondary" : "primary"}
        onPress={() => toggle(!enabled)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: space[2] },
});
