# ADR-0012: Next.js (App Router) + React 19 for All Web Frontends

**Status:** Accepted · **Date:** 2026-07-12 · **Supersedes:** ADR-0003

## Context

ADR-0003 chose React 19 + Vite SPAs on the premise that all web surfaces were operator consoles behind login (SEO irrelevant, static hosting simplest). The platform scope has since been made explicit and larger: PaperlessTech is an enterprise multi-tenant SaaS platform whose web estate includes **public hospital websites, marketing/landing pages, SEO-facing online appointment booking, patient/doctor/staff portals, white-label deployments on custom domains**, and — beyond HMS — School ERP, College ERP, HRMS, CRM, and Finance ERP products sharing the same platform kernel (docs/PLATFORM_STRATEGY.md). The backend is unchanged: **Express remains the only API**; MongoDB/Redis/BullMQ/Socket.IO/Docker/K8s are untouched.

## Decision

All web frontends are **Next.js (App Router) + React 19**, with Tailwind + Shadcn UI, TanStack Query, Zustand, RHF+Zod, and the shared typed API client. Next.js is **presentation-tier only**:

1. **Express is the single API and authorization authority.** Next.js never talks to MongoDB/Redis, never contains business logic, and defines no business API routes. Its server side may only render, guard routes (middleware), and proxy/exchange auth cookies.
2. **Rendering strategy by surface:** public pages (hospital sites, landing, booking entry) = SSR/ISR server components for SEO and first-paint; operator dashboards and portals = client components ("SPA mode") behind server-component shells — the interactive patterns from ADR-0003 carry over unchanged.
3. **White-label:** Next.js middleware reads `Host` → resolves tenant branding/theme (cached, via API) → per-tenant public sites and portals from one deployment, mirroring the backend Connection-Manager resolution.
4. **Route groups** partition the estate in one app: `(public)` marketing/booking, `(portal)` patient portal, `(app)` operator dashboard, with nested layouts per section. `apps/admin` is a second, smaller Next.js app.

## Why React + Vite was rejected (now)

The Vite-SPA premise — "no public/SEO surfaces" — is no longer true. Delivering public sites would have required either a second framework (two stacks to govern, style, and secure) or client-rendered public pages (poor SEO/first-paint, unacceptable for hospital marketing sites and booking landing pages). Static hosting for on-prem remains possible with Next.js standalone output (a Node process — already required for the API on the same box).

## Why Next.js was selected

One framework covers the whole estate: **App Router** nested layouts and route groups fit shell-per-section UIs; **middleware** gives per-host white-label resolution and auth route-guarding before render; **server components** cut bundle size on content-heavy public pages; **ISR** makes per-tenant public sites cheap at scale (hundreds of hospital sites from one deployment); built-in image optimization, fonts, metadata API for SEO; first-class code splitting per route; the largest React ecosystem/hiring pool; and React Native shares the same React 19 ecosystem and shared packages.

## Advantages

Single frontend framework across 6+ future products · SEO-capable public surfaces · per-domain white-label at request time (no per-tenant builds for web) · smaller public-page bundles · standardized routing/layout conventions AI agents can follow mechanically · Vercel-class self-hosting patterns well documented (we self-host on our own Node containers).

## Trade-offs (accepted)

- Web apps become **Node services** (standalone output), not static files: one more running process per deployment, including on-prem (mitigated: same Node runtime the API already needs; ~100–200 MB container).
- **RSC mental model** (server/client boundary) adds rules AI agents must follow — codified in Doc 09 §12 (business/data code stays behind the API; `"use client"` for interactivity; no secrets in client components; `NEXT_PUBLIC_` only for public config).
- Framework coupling to Vercel's roadmap; build times heavier than Vite (mitigated: Turborepo caching).
- Auth handling gains a cookie hop: refresh token in httpOnly cookie scoped to the app host; middleware checks presence for route guarding; **verification stays in Express**.

## Future Impact

- Public marketing/website builder for tenants becomes a natural ISR feature rather than a separate product.
- School/College ERP etc. inherit the same app skeleton (route groups + middleware + shared packages).
- Vite **remains** in the repo only as tooling: Vitest (unit test runner) and the `packages/ui` component playground/Storybook builder. It is no longer an application framework choice.
- If Next.js governance ever becomes untenable, the escape hatch is that all business logic lives in Express and shared packages — the presentation tier is replaceable by construction.

## Alternatives considered

**Keep Vite SPA + separate static-site generator (Astro) for public pages** — two frameworks, duplicated theming/auth/i18n, higher AI-agent error surface; rejected. **Remix/React Router v7 framework mode** — capable, smaller ecosystem, weaker ISR story for per-tenant sites; rejected. **Next.js Pages Router** — legacy; App Router is the supported direction.
