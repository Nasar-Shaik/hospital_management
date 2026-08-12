/**
 * The refresh token's home: iOS Keychain / Android Keystore (M0 §15).
 *
 * This is one of two files permitted to import a storage native module (see the lint rule in
 * `eslint.config.mjs`). Everything else depends on the `SecureStorage` interface, which is what
 * lets the session tests run without a device.
 *
 * ── `WHEN_UNLOCKED_THIS_DEVICE_ONLY` ────────────────────────────────────────
 * Two properties, both wanted. *Unlocked*: the token is unreadable while the phone is locked, so a
 * background process on a locked device cannot reach it. *This device only*: it is excluded from
 * iCloud Keychain backup, so a hospital credential cannot be restored onto a personal phone from
 * a backup taken months earlier.
 *
 * ── EVERY READ CAN FAIL, AND THAT IS NOT AN ERROR ───────────────────────────
 * Keychain access fails while the device is locked, and after a restore onto new hardware. The
 * caller treats a rejection as "no credential", which sends the user to a login screen — the
 * correct outcome, and far better than a crash on launch.
 */
import * as SecureStore from "expo-secure-store";
import type { SecureStorage } from "../lib/storage.js";

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export const secureStore: SecureStorage = {
  async get(key) {
    return (await SecureStore.getItemAsync(key, OPTIONS)) ?? undefined;
  },
  async set(key, value) {
    await SecureStore.setItemAsync(key, value, OPTIONS);
  },
  async remove(key) {
    await SecureStore.deleteItemAsync(key, OPTIONS);
  },
};
