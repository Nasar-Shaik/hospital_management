/**
 * Design tokens — the same palette the web renders, as values React Native can use (Doc 08).
 *
 * ── WHY TRANSCRIBED AND NOT IMPORTED ────────────────────────────────────────
 * `packages/ui/src/tokens.css` is CSS custom properties. React Native has no CSS engine, no
 * `var()`, no `color-mix()` and no media queries, so there is nothing to import — a build step
 * that parsed the CSS would be a lot of machinery for two dozen hex values that change once a
 * year. The values are copied deliberately, with this note, and a divergence is a review comment
 * rather than a silent drift.
 *
 * ── `onAccent` FLIPS, AND THAT IS THE INTERESTING TOKEN ─────────────────────
 * It cannot be hardcoded white. The accent fills INVERT in lightness between themes: light mode
 * fills with deep teal, where white text is crisp; dark mode fills with BRIGHT teal, where white
 * text lands at roughly 2:1 and fails WCAG AA. So the foreground flips to near-black and every
 * filled control stays readable without a single component knowing which theme it is in.
 */

export interface ThemeColors {
  bg: string;
  bgSubtle: string;
  bgElevated: string;
  fg: string;
  fgMuted: string;
  fgSubtle: string;
  border: string;
  borderStrong: string;
  brand: string;
  brandStrong: string;
  onAccent: string;
  success: string;
  successBg: string;
  warning: string;
  warningBg: string;
  danger: string;
  dangerBg: string;
  info: string;
  infoBg: string;
  /** Reserved for a critical result or a panic value — never used decoratively. */
  criticalClinical: string;
}

export const lightColors: ThemeColors = {
  bg: "#ffffff",
  bgSubtle: "#f8fafc",
  bgElevated: "#ffffff",
  fg: "#0f172a",
  fgMuted: "#475569",
  fgSubtle: "#94a3b8",
  border: "#e2e8f0",
  borderStrong: "#cbd5e1",
  brand: "#14b8a6",
  brandStrong: "#0d9488",
  onAccent: "#ffffff",
  success: "#15803d",
  successBg: "#f0fdf4",
  warning: "#b45309",
  warningBg: "#fffbeb",
  danger: "#b91c1c",
  dangerBg: "#fef2f2",
  info: "#1d4ed8",
  infoBg: "#eff6ff",
  criticalClinical: "#dc2626",
};

export const darkColors: ThemeColors = {
  bg: "#0b1220",
  bgSubtle: "#0f172a",
  bgElevated: "#1e293b",
  fg: "#f1f5f9",
  fgMuted: "#94a3b8",
  fgSubtle: "#64748b",
  border: "#1e293b",
  borderStrong: "#334155",
  brand: "#2dd4bf",
  brandStrong: "#14b8a6",
  onAccent: "#0b1220",
  // Re-picked for contrast against a dark surface, not merely darkened. The `-bg` tints are deep,
  // low-saturation washes: a light tint would be a glowing slab that outshouts its own alert.
  success: "#4ade80",
  successBg: "#052e16",
  warning: "#fbbf24",
  warningBg: "#2e1e05",
  danger: "#f87171",
  dangerBg: "#2e0a0a",
  info: "#60a5fa",
  infoBg: "#0a1c33",
  criticalClinical: "#ff6b6b",
};

/** The 4px grid from Doc 08 §3. */
export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32 } as const;

export const radius = { sm: 4, md: 8, lg: 12, xl: 16, full: 9999 } as const;

/**
 * Type scale. `44` is the minimum touch target — Apple's HIG says 44pt, Android's Material says
 * 48dp, and a nurse tapping with a gloved hand needs the larger of the two, so controls use 48.
 */
export const size = { touchTarget: 48, icon: 24 } as const;

export const typography = {
  title: { fontSize: 24, fontWeight: "700" },
  heading: { fontSize: 18, fontWeight: "600" },
  body: { fontSize: 16, fontWeight: "400" },
  label: { fontSize: 14, fontWeight: "600" },
  caption: { fontSize: 13, fontWeight: "400" },
} as const;

export interface Theme {
  scheme: "light" | "dark";
  colors: ThemeColors;
}

export const themes: Record<"light" | "dark", Theme> = {
  light: { scheme: "light", colors: lightColors },
  dark: { scheme: "dark", colors: darkColors },
};
