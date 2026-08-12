/**
 * A clinical tone, resolved to the two colours a badge needs.
 *
 * ── `criticalClinical` IS SPENT ONCE ────────────────────────────────────────
 * The token's own comment reserves it for "a critical result or a panic value — never used
 * decoratively". This is the file that keeps that promise: `critical` is the only tone that reaches
 * it, and only `results.ts` returns `critical`, and only for a RELEASED result the server marked
 * so. Everything else that is merely wrong-looking — an out-of-range observation, a STAT priority —
 * gets `warning`. A ward where four things are red is a ward where nothing is.
 */
import type { Theme } from "./tokens";
import type { ClinicalTone } from "../clinical/encounters";

export interface ToneColors {
  fg: string;
  bg: string;
}

export function toneColors(theme: Theme, tone: ClinicalTone): ToneColors {
  const c = theme.colors;
  switch (tone) {
    case "critical":
      return { fg: c.criticalClinical, bg: c.dangerBg };
    case "warning":
      return { fg: c.warning, bg: c.warningBg };
    case "active":
      return { fg: c.brandStrong, bg: c.infoBg };
    case "waiting":
      return { fg: c.info, bg: c.infoBg };
    case "done":
      return { fg: c.success, bg: c.successBg };
    case "neutral":
    default:
      return { fg: c.fgMuted, bg: c.bgSubtle };
  }
}
