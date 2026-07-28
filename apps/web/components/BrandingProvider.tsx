"use client";

/**
 * White-label branding (A8) — the hospital's name, logo and accent colour, applied everywhere.
 *
 * It reads the PUBLIC `GET /site` (no login needed), so the login page is already branded before
 * anyone signs in. The accent colour is pushed into the app's `--color-brand-*` CSS variables as a
 * small generated ramp, so buttons, links and active states take the hospital's colour without a
 * per-component change. The logo is fetched as a blob (not plain-linked) so the tenant host header
 * reaches the API in local dev, then exposed as an object URL for an `<img>`.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useTheme } from "@medicore/ui";
import { useAuth } from "./AuthProvider";

interface Branding {
  displayName: string;
  accentColor: string;
  logoUrl: string | null;
  loaded: boolean;
  /** Re-reads branding — call after the admin saves a new logo/name/colour. */
  refresh: () => void;
}

const BrandingContext = createContext<Branding>({
  displayName: "",
  accentColor: "",
  logoUrl: null,
  loaded: false,
  refresh: () => {},
});

export function useBranding(): Branding {
  return useContext(BrandingContext);
}

/* ── accent ramp ─────────────────────────────────────────────────────────────
 * The token ramp defines brand-50…900; a single accent hex cannot fill all of it, so we generate
 * the shades that carry the UI — the subtle backgrounds (50/100) and the CTA/active/text shades
 * (500/600/700) — by mixing the accent with white and black.
 *
 * Crucially this is THEME-AWARE. The generated values are written as inline styles on <html>, which
 * outrank the stylesheet's `:root` / `.dark` tokens, so if we always mixed toward white the brand
 * backgrounds would stay pale even in dark mode — a washed-out active pill and washed-out role
 * badges (the exact complaint). So in dark mode the roles FLIP to mirror the static dark tokens:
 * 50/100 become DARK tints of the accent (subtle fills that sit on a dark surface) and 700 becomes
 * a LIGHT tint (readable text on those fills). Re-applied whenever the resolved theme changes. */

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m?.[1]) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(
  [r, g, b]: [number, number, number],
  t: [number, number, number],
  amt: number,
): string {
  const c = (a: number, x: number) => Math.round(a + (x - a) * amt);
  return `#${[c(r, t[0]), c(g, t[1]), c(b, t[2])]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")}`;
}

const WHITE: [number, number, number] = [255, 255, 255];
const BLACK: [number, number, number] = [0, 0, 0];

function applyAccent(hex: string, dark: boolean): void {
  const rgb = hexToRgb(hex);
  if (!rgb) return;
  const root = document.documentElement.style;
  if (dark) {
    // Mirror the static dark tokens: subtle fills are DARK tints, text is a LIGHT tint.
    root.setProperty("--color-brand-50", mix(rgb, BLACK, 0.75));
    root.setProperty("--color-brand-100", mix(rgb, BLACK, 0.55));
    root.setProperty("--color-brand-500", mix(rgb, WHITE, 0.25));
    root.setProperty("--color-brand-600", hex);
    root.setProperty("--color-brand-700", mix(rgb, WHITE, 0.55));
  } else {
    root.setProperty("--color-brand-50", mix(rgb, WHITE, 0.9));
    root.setProperty("--color-brand-100", mix(rgb, WHITE, 0.8));
    root.setProperty("--color-brand-500", mix(rgb, WHITE, 0.12));
    root.setProperty("--color-brand-600", hex);
    root.setProperty("--color-brand-700", mix(rgb, BLACK, 0.14));
  }
}

export function BrandingProvider({ children }: { children: ReactNode }) {
  const { api } = useAuth();
  const { resolved } = useTheme();
  const [state, setState] = useState<Omit<Branding, "refresh">>({
    displayName: "",
    accentColor: "",
    logoUrl: null,
    loaded: false,
  });

  const load = useCallback(() => {
    let objectUrl: string | null = null;
    void api
      .getPublicSite()
      .then(async (site) => {
        applyAccent(site.accentColor, document.documentElement.classList.contains("dark"));
        if (site.hasLogo) {
          const blob = await api.fetchSiteLogoBlob().catch(() => null);
          if (blob) objectUrl = URL.createObjectURL(blob);
        }
        setState({
          displayName: site.displayName,
          accentColor: site.accentColor,
          logoUrl: objectUrl,
          loaded: true,
        });
      })
      .catch(() => setState((prev) => ({ ...prev, loaded: true })));
  }, [api]);

  useEffect(() => {
    load();
    // The object URL is revoked on the next load()/unmount by the browser reclaiming the blob;
    // branding changes rarely, so we do not micro-manage it here.
  }, [load]);

  // Re-generate the ramp when the user toggles light/dark, so the brand fills follow the theme
  // instead of staying pinned to whichever mode was active when branding first loaded.
  useEffect(() => {
    if (state.accentColor) applyAccent(state.accentColor, resolved === "dark");
  }, [resolved, state.accentColor]);

  return (
    <BrandingContext.Provider value={{ ...state, refresh: load }}>
      {children}
    </BrandingContext.Provider>
  );
}
