/**
 * @medicore/ui — design tokens (Doc 08) + the shared theme machinery.
 *
 * Both frontends import from here, so "what colour is this product" has exactly
 * one answer. Tokens are the CSS side (`@medicore/ui/tokens.css`); this is the
 * React side that decides WHICH set of tokens is live.
 */
export {
  ThemeProvider,
  ThemeToggle,
  useTheme,
  themeInitScript,
  THEME_MODES,
  type ThemeMode,
  type ResolvedTheme,
} from "./theme.js";
