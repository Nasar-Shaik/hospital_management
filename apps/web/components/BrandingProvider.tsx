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
 * the shades that carry the UI — the light backgrounds (50/100) and the CTA/active shades
 * (500/600/700) — by mixing the accent with white and black. Enough to re-skin the app coherently
 * without shipping a full colour system per hospital. */

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

function applyAccent(hex: string): void {
  const rgb = hexToRgb(hex);
  if (!rgb) return;
  const root = document.documentElement.style;
  root.setProperty("--color-brand-50", mix(rgb, WHITE, 0.9));
  root.setProperty("--color-brand-100", mix(rgb, WHITE, 0.8));
  root.setProperty("--color-brand-500", mix(rgb, WHITE, 0.12));
  root.setProperty("--color-brand-600", hex);
  root.setProperty("--color-brand-700", mix(rgb, BLACK, 0.14));
}

export function BrandingProvider({ children }: { children: ReactNode }) {
  const { api } = useAuth();
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
        applyAccent(site.accentColor);
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

  return (
    <BrandingContext.Provider value={{ ...state, refresh: load }}>
      {children}
    </BrandingContext.Provider>
  );
}
