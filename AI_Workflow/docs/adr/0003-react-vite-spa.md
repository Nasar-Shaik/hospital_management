# ADR-0003: React 19 + Vite SPA (not Next.js)

**Status:** ~~Accepted~~ **Superseded by [ADR-0012](0012-nextjs-app-router.md)** · **Date:** 2026-07-12 (superseded same day)

> **Why superseded:** the platform scope expanded to first-class public websites, marketing pages, SEO-facing booking, and white-label custom-domain surfaces (see ADR-0012 Context). This ADR's premise — "all surfaces are behind login" — no longer holds. Its final line ("revisit only if a public content-heavy surface becomes a product goal") is exactly what happened.

## Context
The web surfaces are operator consoles behind login (hospital staff, admin) plus a patient portal. React Native (Expo) apps share patterns and the typed API client.

## Decision
React 19 + TypeScript + Vite **single-page apps** (`apps/web`, `apps/admin`) consuming the REST API via the shared typed client. No SSR framework.

## Consequences
- Simple mental model for AI agents: one API contract, one rendering mode, no server/client component split, no data-fetching duality.
- Static builds deploy to CDN/Nginx everywhere including on-prem (Government edition) with no Node server for the frontend.
- SEO is irrelevant behind login; the public booking page (C6) is a small separate static/lightweight page if marketing SEO is ever needed.
- We forgo Next.js niceties (image optimization, RSC streaming); acceptable for dashboard-class UIs.

## Alternatives considered
**Next.js** (SSR/RSC complexity buys nothing for authenticated operator apps; complicates on-prem). **Remix** (same reasoning). Revisit only if a public content-heavy surface becomes a product goal.
