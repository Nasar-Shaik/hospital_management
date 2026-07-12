# 08 — Design System

The UI contract for every surface (web app, admin console, patient/doctor/staff apps). Built on **Tailwind CSS tokens + Shadcn UI**; React Native mirrors the same token values through a shared `packages/ui-tokens`. Per-tenant branding (Doc 02 A8) overrides only the brand color ramp and logo — never spacing, typography scale, or semantic colors.

---

## 1. Design Principles

1. **Clinical clarity over decoration** — a nurse at 3 AM must parse a screen in one glance; density and hierarchy beat visual flourish.
2. **Never make the user guess state** — every async action shows loading, success, or a recoverable error; no silent failures.
3. **Destructive ≠ convenient** — irreversible actions (finalize bill, sign record, discharge) require explicit confirmation and are visually distinct.
4. **Safety colors are sacred** — red/amber/green communicate clinical and financial severity only; they are never used decoratively.
5. **Keyboard-first for high-volume operators** — registration, billing, and result-entry flows fully operable without a mouse.
6. **One system, every surface** — same tokens, naming, and behaviors on web and mobile; a doctor switching devices relearns nothing.
7. **Respect tenant branding, protect usability** — tenants recolor the brand ramp; contrast and semantic colors are enforced by the system.

## 2. Color Tokens

Semantic tokens (CSS variables; Tailwind maps to these — components never use raw palette values):

| Token | Usage |
|-------|-------|
| `--color-brand-{50…950}` | Tenant-brandable ramp (default: teal/blue medical neutral) |
| `--color-bg`, `--color-bg-subtle`, `--color-bg-elevated` | Page, section, card/popover backgrounds |
| `--color-fg`, `--color-fg-muted`, `--color-fg-subtle` | Primary/secondary/tertiary text |
| `--color-border`, `--color-border-strong` | Dividers, inputs |
| `--color-success` / `-bg` | Completed, paid, normal results |
| `--color-warning` / `-bg` | Pending, near-expiry, abnormal-flagged |
| `--color-danger` / `-bg` | Critical values, overdue, destructive actions, allergies |
| `--color-info` / `-bg` | Informational states |
| `--color-critical-clinical` | Reserved: panic lab values, code blue, severe allergy — highest visual priority, never overridden by branding |

Rules: semantic tokens only in components; brand ramp only for primary actions/navigation/accents; every fg/bg pair ships ≥ 4.5:1 contrast (validated in CI via token tests).

## 3. Spacing

4-px base grid: `space-1=4` `2=8` `3=12` `4=16` `5=20` `6=24` `8=32` `10=40` `12=48` `16=64`. Page gutter 24 (web) / 16 (mobile); card padding 16–24; form field vertical rhythm 16; table cell padding 12×16. No arbitrary pixel values in components — grid steps only.

## 4. Typography

- **Family:** Inter (web), system stack fallback; SF Pro / Roboto on native. Numeric tables use `font-variant-numeric: tabular-nums`.
- **Scale:** `xs 12/16` · `sm 14/20` (default UI) · `base 16/24` (forms, patient-facing) · `lg 18/28` (section titles) · `xl 20/28` (page titles) · `2xl 24/32` (dashboards) · `3xl 30/36` (KPI numbers).
- **Weights:** 400 body · 500 labels/nav · 600 headings/KPIs. Never below 12 px; patient-facing surfaces default to `base`.

## 5. Border Radius

`sm 4` (inputs, tags) · `md 8` (buttons, cards — default) · `lg 12` (modals, panels) · `full` (pills, avatars, status dots). One radius per component type; no mixing.

## 6. Tables

- Server-side pagination/sort/filter via the shared `DataTable` (Doc 04 §3.3); sticky header; row height 44 px (dense: 36).
- Column types: text, numeric (right-aligned, tabular), date (tenant timezone, `DD MMM YYYY HH:mm`), status (Badge), actions (kebab, max 3 inline).
- Bulk selection with a floating action bar; column show/hide persisted per user.
- Abnormal/critical values: cell-level semantic background + icon — never color alone (accessibility).
- Wide tables scroll horizontally inside the table container, first column pinned.

## 7. Forms

- React Hook Form + shared Zod schemas; label above field; required marker `*`; help text below; error text replaces help text in `--color-danger`.
- Validate on blur, revalidate on change after first error; submit disabled only while submitting (not while invalid — show errors instead).
- Sections of >8 fields split into titled groups; multi-step wizards for registration/admission with progress indicator and draft persistence.
- Autosave drafts for clinical notes every 10 s (visible "Saved · 12:04" indicator).
- Date/phone/ID inputs are masked; UHID/ABHA inputs include inline lookup.

## 8. Cards

`Card` = elevated surface (`--color-bg-elevated`, radius-md, border, no shadow in dense clinical views; shadow-sm on dashboards). Header (title + optional action) · body · optional footer. KPI card variant: label (sm, muted) + value (3xl, tabular) + delta chip.

## 9. Buttons

| Variant | Use |
|---------|-----|
| `primary` (brand) | One per view — the main action |
| `secondary` (outline) | Alternate actions |
| `ghost` | Toolbars, table row actions |
| `destructive` (danger) | Delete/void/cancel-bill — always with confirm dialog |
| `link` | Inline navigation |

Sizes `sm 32` `md 40` (default) `lg 48` (patient-facing/touch). Loading state = spinner + retained label; disabled always has a tooltip explaining why. Icon-only buttons require `aria-label`.

## 10. Dashboard Widgets

Grid: 12-col responsive; widgets snap to 4/6/12 col spans. Widget = Card with title, timeframe selector, refresh, drill-through link ("View report →"). Every widget handles its own loading (skeleton), empty, and error states. KPI tiles top row; charts below; tables last. Executive dashboard renders in < 2 s from `kpiSnapshots` read models — never live OLTP aggregation.

## 11. Charts

Follow the dataviz standard: categorical palette derived from brand + fixed semantic ramps for status; sequential ramps for heatmaps (bed occupancy); never red/green as the only differentiator. Line = trends (revenue, census); bar = comparisons (dept revenue); stacked bar = composition over time; donut only for ≤4-part composition; sparklines in KPI tiles. Axes always labeled with units; tooltips show exact values + date; charts render an accessible data-table alternative (`aria` + toggle).

## 12. Dark Mode

Class-based (`.dark` on root) driven by user preference (system default, user override persisted). All tokens have dark values; elevation expressed by lighter surfaces (not shadows). Clinical-critical colors keep AAA contrast in both modes. Charts re-theme via token lookup. Mobile apps follow OS scheme with in-app override.

## 13. Accessibility (WCAG 2.1 AA)

Contrast ≥ 4.5:1 text / 3:1 UI; full keyboard operability + visible focus ring (`ring-2 ring-brand-500 offset-2`); semantic landmarks; form fields programmatically labeled; status conveyed by icon+text, never color alone; `aria-live` for async results (lab values arriving, queue updates); focus trap + Escape in modals; axe-core in CI blocks regressions; touch targets ≥ 44×44 on mobile.

## 14. Responsive Rules

Breakpoints: `sm 640` `md 768` `lg 1024` `xl 1280` `2xl 1536`. Web app is desktop-first (operator workflows) but functional to 768; patient portal is mobile-first. Tables collapse to card lists below `md`; sidebars become drawers; sticky action bars on mobile forms. Print styles for invoices, prescriptions, reports (A4/A5, no chrome).

## 15. Loading States

Skeletons (not spinners) for page/section loads matching final layout; spinners only inside buttons and inline refreshes; progress bars with percentage for uploads/imports/report generation; optimistic UI for queue/MAR/vitals with rollback toast on failure. Never block the whole screen except during payment capture and e-sign.

## 16. Empty States

Every list/table/widget defines: icon + one-line explanation + primary action ("No appointments today — Book appointment"). First-run empties may include a short setup checklist. Filtered-empty ("No results for these filters") is distinct from true-empty and offers "Clear filters".

## 17. Error States

- **Field errors:** inline below field.
- **Form errors:** summary alert at top + focus moves to first invalid field.
- **Request errors:** toast with human message + `traceId` (support reference) + retry when idempotent.
- **Page errors:** error boundary with reload + report; never a white screen.
- **Offline (mobile):** banner + queued-mutation indicator; blocked actions explain "will sync when online".
- Error copy: what happened → why (if known) → what to do next. Never raw error codes alone.

## 18. Notification Guidelines

| Channel | Use | Rules |
|---------|-----|-------|
| Toast (4 s) | Action feedback | Max 1 visible; success auto-dismiss; errors persist until dismissed |
| Inline alert | Contextual warnings (allergy conflict, credit limit) | Not dismissible if safety-relevant |
| Notification center | Async outcomes (report ready, result approved) | Read/unread, deep links |
| Push/SMS/WhatsApp | Time-critical + patient engagement | Respect `notificationPreferences`, quiet hours, locale templates |
| Blocking modal | Only: destructive confirms, e-sign, panic-value acknowledgment | Requires explicit action |

Critical clinical alerts (panic values, allergy conflicts) bypass quiet-hours and require acknowledgment (audited).

## 19. Component Naming

PascalCase, domain-prefixed for feature components: `PatientSearchInput`, `BedBoardGrid`, `MarScheduleRow`. Shared primitives keep Shadcn names (`Button`, `Dialog`, `Badge`). Props: `variant`, `size`, `state` enums — no boolean prop explosions (`isSmallDanger` ❌). Files: `PascalCase.tsx` co-located with `ComponentName.test.tsx`. Storybook story per shared component is the acceptance artifact.

## 20. Icon Library

**Lucide** (web + RN via lucide-react-native). Sizes 16/20/24; stroke 1.5; inherit `currentColor`. Domain icon map is centralized (`packages/ui/icons.ts`): one canonical icon per concept (bed, lab, pharmacy, billing…) — no per-feature improvisation. Medical-specific glyphs (tooth chart, blood drop) added as custom SVGs in the same registry.

## 21. Animation Rules

Purposeful only: state transitions 150 ms ease-out (hover, focus), overlays 200 ms fade/scale, drawers 250 ms slide. No entrance animations on data tables or clinical values. Respect `prefers-reduced-motion` (all non-essential motion off). Skeleton shimmer ≤ 1.2 s cycle. Realtime updates (queue board, bed board) highlight-fade the changed row (600 ms) instead of moving content under the user's cursor.
