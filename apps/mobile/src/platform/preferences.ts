/**
 * Ordinary storage for things that are not secrets (M0 §15).
 *
 * The second of the two files allowed to import a storage native module. What may live here is
 * defined by a single test: losing it, or leaking it, is inconvenient rather than dangerous.
 * Which hospital you last used, which branch you last worked at, whether you chose dark mode.
 *
 * **No token, ever.** AsyncStorage is unencrypted plaintext on disk, readable by anything with
 * filesystem access on a rooted device. The lint rule stops the import elsewhere; this comment
 * records why the rule exists.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Preferences } from "../lib/storage";

export const preferences: Preferences = {
  async get(key) {
    return (await AsyncStorage.getItem(key)) ?? undefined;
  },
  async set(key, value) {
    await AsyncStorage.setItem(key, value);
  },
  async remove(key) {
    await AsyncStorage.removeItem(key);
  },
};
