"use client";

/**
 * Theme (light / dark / system) — shared by the hospital app and the operator
 * console, so there is ONE implementation of "what colour is this product".
 *
 * ── THREE STATES, NOT TWO ────────────────────────────────────────────────────
 * `system` is a real choice and the default, not a fallback. A user who has set
 * their OS to switch at sunset has already expressed a preference; a product that
 * ignores it and pins itself to light is overriding them. And `system` is not the
 * same as "light" — it TRACKS, so a night-shift laptop that flips to dark at 8pm
 * flips this app with it, without anyone touching a setting.
 *
 * ── WHY THE INLINE SCRIPT EXISTS (AND WHY IT IS UGLY ON PURPOSE) ─────────────
 * React state cannot decide the theme, because React runs after the first paint.
 * The sequence without a blocking script is: server sends light HTML → browser
 * paints WHITE → React hydrates → theme flips to dark. That white flash is at its
 * worst exactly where it matters most — a dark-adapted eye on a night shift,
 * hit with a full-screen white flash on every navigation.
 *
 * So `themeInitScript` runs synchronously in <head>, before the body renders,
 * reads localStorage, and stamps <html>. It is a string of hand-written JS because
 * that is the only thing that can run at that moment. It must stay dependency-free
 * and total: if it throws, the page renders unthemed, so every branch is guarded.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export const THEME_MODES = ["light", "dark", "system"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

/** What the user actually SEES — `system` has already been resolved to one of these. */
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "medicore.theme";

/**
 * Applies a mode to the document. The single place <html> is touched.
 *
 * Sets BOTH `data-theme` (which the design tokens key off) and the `dark` class
 * (which Tailwind's `dark:` variant keys off), so either mechanism works and the
 * two can never disagree. `colorScheme` is what makes native scrollbars, form
 * controls and the browser's own UI follow along — without it you get a dark page
 * with a bright white scrollbar down the side.
 */
function applyTheme(mode: ThemeMode): ResolvedTheme {
  const prefersDark =
    typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;

  const resolved: ResolvedTheme = mode === "system" ? (prefersDark ? "dark" : "light") : mode;

  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;

  return resolved;
}

function readStoredMode(): ThemeMode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return THEME_MODES.includes(saved as ThemeMode) ? (saved as ThemeMode) : "system";
  } catch {
    // Private browsing, or storage disabled by policy. Not a reason to crash the app.
    return "system";
  }
}

interface ThemeContextValue {
  /** What the user CHOSE — including `system`. */
  mode: ThemeMode;
  /** What they SEE — `system` resolved against the OS right now. */
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({ children }: { children: ReactNode }) {
  /**
   * Initialized to `system` on BOTH server and client, deliberately. Reading
   * localStorage in this initializer would make the server and the first client
   * render disagree, which is a hydration error. The DOM is already correct by
   * this point — the inline script stamped it before paint — so this state only
   * needs to catch up, which it does in the effect below. Nothing flashes, because
   * nothing here decides what is painted.
   */
  const [mode, setModeState] = useState<ThemeMode>("system");
  const [resolved, setResolved] = useState<ResolvedTheme>("light");

  useEffect(() => {
    const stored = readStoredMode();
    setModeState(stored);
    setResolved(applyTheme(stored));
  }, []);

  /**
   * Follow the OS while the user is on `system`. Without this, someone who leaves
   * the app open across their machine's sunset switch keeps the old theme until
   * they reload — the one case `system` exists to handle.
   */
  useEffect(() => {
    if (mode !== "system") return;

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (): void => setResolved(applyTheme("system"));

    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [mode]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    setResolved(applyTheme(next));
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Preference is lost on reload; the app still works. Never throw over this.
    }
  }, []);

  const value = useMemo(() => ({ mode, resolved, setMode }), [mode, resolved, setMode]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside a <ThemeProvider>");
  return ctx;
}

/**
 * Runs in <head> BEFORE the first paint. See the header note — this is what stops
 * the white flash, and it is the reason it cannot be a React component.
 *
 * Note it does NOT write to localStorage: it only reads. A user who has never
 * chosen stays on `system` forever, tracking their OS, rather than being silently
 * pinned to whatever their OS happened to be the first time they visited.
 */
export const themeInitScript = `
(function () {
  try {
    var stored = localStorage.getItem("${STORAGE_KEY}");
    var mode = (stored === "light" || stored === "dark" || stored === "system") ? stored : "system";
    var dark = mode === "dark" ||
      (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    var root = document.documentElement;
    root.dataset.theme = dark ? "dark" : "light";
    root.classList.toggle("dark", dark);
    root.style.colorScheme = dark ? "dark" : "light";
  } catch (e) {
    /* Storage unavailable or matchMedia missing — fall through to the light default. */
  }
})();
`;

/**
 * The control. A three-way segmented switch rather than a two-way toggle, because
 * a plain toggle cannot express `system` — and collapsing three states into two
 * means silently discarding the user's OS preference the first time they click.
 */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const { mode, setMode } = useTheme();

  const options: { value: ThemeMode; label: string; title: string }[] = [
    { value: "light", label: "☀", title: "Light" },
    { value: "dark", label: "☾", title: "Dark" },
    { value: "system", label: "◐", title: "Match system" },
  ];

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className={className}
      style={{
        display: "inline-flex",
        gap: "2px",
        padding: "2px",
        borderRadius: "var(--radius-md)",
        border: "1px solid var(--color-border)",
        background: "var(--color-bg-subtle)",
      }}
    >
      {options.map((option) => {
        const active = mode === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={option.title}
            onClick={() => setMode(option.value)}
            style={{
              cursor: "pointer",
              border: "none",
              borderRadius: "var(--radius-sm)",
              padding: "4px 8px",
              fontSize: "13px",
              lineHeight: 1.2,
              background: active ? "var(--color-bg-elevated)" : "transparent",
              color: active ? "var(--color-fg)" : "var(--color-fg-subtle)",
              boxShadow: active ? "var(--shadow-sm)" : "none",
            }}
          >
            <span aria-hidden>{option.label}</span>
            <span
              style={{
                position: "absolute",
                width: 1,
                height: 1,
                overflow: "hidden",
                clip: "rect(0 0 0 0)",
                whiteSpace: "nowrap",
              }}
            >
              {option.title}
            </span>
          </button>
        );
      })}
    </div>
  );
}
