/**
 * Theme preference — follow the OS, or override it (M0 §1, Doc 08).
 *
 * Following the system is the default because a ward at night is a different room from a clinic at
 * noon, and the phone already knows which one it is in. The override exists because some staff
 * keep their device in light mode and still want the app dark on a night shift.
 */
import { createStore, type StoreApi } from "zustand/vanilla";

export type ThemePreference = "system" | "light" | "dark";

export interface ThemeState {
  preference: ThemePreference;
  setPreference(preference: ThemePreference): void;
}

export type ThemeStore = StoreApi<ThemeState>;

export function createThemeStore(initial: ThemePreference = "system"): ThemeStore {
  return createStore<ThemeState>((set) => ({
    preference: initial,
    setPreference: (preference) => set({ preference }),
  }));
}

/**
 * Resolves the preference against what the OS reports.
 *
 * The parameter is deliberately wider than `"light" | "dark"`: React Native's `ColorSchemeName`
 * also carries `null` and `"unspecified"`, and on Android the value is `null` for a moment during
 * startup. Anything that is not explicitly dark resolves to light, so the first frame is never a
 * flash of the wrong theme.
 */
export function resolveScheme(
  preference: ThemePreference,
  systemScheme: string | null | undefined,
): "light" | "dark" {
  if (preference !== "system") return preference;
  return systemScheme === "dark" ? "dark" : "light";
}
