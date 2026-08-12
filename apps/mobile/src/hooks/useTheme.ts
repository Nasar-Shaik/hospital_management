import { useColorScheme } from "react-native";
import { useStore } from "zustand";
import { createThemeStore, resolveScheme } from "../state/theme.js";
import { themes, type Theme } from "../theme/tokens.js";

/**
 * One store for the whole app. Theme is the one piece of state that legitimately outlives a
 * hospital switch — it is a property of the person holding the phone, not of the hospital — so it
 * lives here rather than inside the runtime.
 */
export const themeStore = createThemeStore();

export function useTheme(): Theme {
  const preference = useStore(themeStore, (s) => s.preference);
  const system = useColorScheme();
  return themes[resolveScheme(preference, system)];
}
