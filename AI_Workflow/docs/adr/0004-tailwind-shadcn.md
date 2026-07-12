# ADR-0004: Tailwind CSS + Shadcn UI

**Status:** Accepted · **Date:** 2026-07-12

## Context
Six app surfaces need one design system (Doc 08) with per-tenant branding (brand ramp only) and dark mode, maintainable by AI agents without visual drift.

## Decision
Tailwind CSS with a token layer (CSS variables mapped in the Tailwind config) + Shadcn UI as the component base, extended in `packages/ui`. React Native mirrors token values via `packages/ui-tokens`.

## Consequences
- Shadcn components are **owned source code**, not a dependency — customizable for clinical density, and AI agents can read them.
- Semantic tokens (Doc 08 §2) keep tenant branding from breaking contrast/safety colors; utility classes keep styles co-located and greppable.
- Risk: utility-class sprawl → mitigated by shared components being the only place complex class compositions live.

## Alternatives considered
**MUI/Ant** (heavy theme systems fight per-tenant tokens; harder to enforce clinical patterns). **CSS Modules/vanilla-extract** (more ceremony, less AI-ergonomic). **Chakra** (runtime styling cost).
