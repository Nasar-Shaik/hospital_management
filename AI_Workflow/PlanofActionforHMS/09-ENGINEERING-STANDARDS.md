# 09 — Engineering Standards

The rulebook every contributor (human or AI) follows. Architecture lives in Doc 04; this document is **how we write, review, and ship code**. CI enforces everything marked *(CI)*.

---

## 1. Folder Structure

Monorepo layout is normative in Doc 04 §1. Rules:
- New backend code goes in `apps/api/src/modules/<module>/` with the standard file set: `*.routes.ts`, `*.controller.ts`, `*.service.ts`, `*.repository.ts`, `*.schema.ts` (Zod), `*.model.ts` (Mongoose), `index.ts` (public interface: service + types ONLY).
- New web features go in `apps/web/src/features/<feature>/` (`components/ pages/ hooks/ api.ts types.ts`).
- Shared code must live in `packages/*` — copy-paste across apps is a review blocker.
- Module boundary rule (Doc 04 §2.4): cross-module imports only via `modules/<name>/index.ts` or domain events. *(CI: dependency-cruiser)*

## 2. Naming Convention

| Thing | Convention | Example |
|-------|-----------|---------|
| Files (TS) | kebab-case; React components PascalCase | `lab-order.service.ts`, `BedBoardGrid.tsx` |
| Classes / types / interfaces / enums | PascalCase (no `I` prefix) | `LabOrderService`, `PatientStatus` |
| Variables / functions | camelCase, verb-first functions | `calculateNetAmount()` |
| Constants | SCREAMING_SNAKE | `MAX_PAGE_SIZE` |
| Mongo collections | camelCase plural | `labOrders` |
| Mongo fields | camelCase | `admittedAt` |
| API paths | kebab-case plural nouns | `/api/v1/lab-orders` |
| Query params | camelCase | `?patientId=&from=` |
| Permissions | `resource:action[:scope]` | `billing:refund:approve` |
| Feature flags | dot-namespaced | `module.clinical.dialysis` |
| Events (outbox) | `domain.entity.action` past tense | `billing.invoice.finalized` |
| Env vars | SCREAMING_SNAKE, app-prefixed | `API_JWT_SECRET` |
| DB names | master `paperlesstech_master`; tenant `hms_<slug>`; reference `paperlesstech_reference` | `hms_apollo` |

Domain vocabulary is fixed by Doc 10 rulings (N1 vendors, N2 assets, …) — synonyms in code are review blockers.

## 3. Coding Standards (TypeScript)

- `strict: true`; `any` forbidden (*(CI)* `@typescript-eslint/no-explicit-any`); use `unknown` + narrowing.
- No implicit null flows: model optionality in types; never `!` non-null assertions outside tests.
- Pure domain logic (billing math, tax, MAR schedules, payroll) in dependency-free functions — unit-testable without DB.
- Money: **integer minor units** (paise/cents) + currency code; never floats. Dates: UTC in storage, tenant timezone at the edge; `date-fns`/`Temporal` — no `moment`.
- Early returns over nesting; max function length ~40 lines before extraction is expected.
- Comments explain *constraints and why*, not what the next line does.
- Prettier + ESLint shared config from `packages/config` *(CI)*.

## 4. API Standards

- REST resource-oriented; conventions in Doc 04 §5 are binding (envelope, pagination, idempotency, versioning/deprecation).
- Every route declares: Zod request/response schema, permission, feature flag, rate-limit class, audit category. Route registration fails at boot if any is missing.
- Response envelope: `{ success, data, meta?, error? }`; errors `{ code, message, details?, traceId }`; HTTP codes: 400 validation, 401 authn, 403 authz/tenant mismatch, 404 not-found-in-tenant, 409 conflict/version, 402 plan-limit, 422 domain rule, 429 rate limit.
- Lists: `page/limit` (max 100) or cursor for feeds; always `meta: { total?, page, limit, hasMore }`.
- Breaking change = new `/v2` route; `/v1` kept per the 12-month sunset policy (Doc 04 §5.1). OpenAPI regenerated on every merge *(CI)*.

## 5. DTO Standards

- DTOs are **Zod schemas in `packages/validation`** — single source shared FE/BE; TypeScript types are `z.infer<>` of them, never hand-written duplicates.
- Three shapes per resource: `CreateXInput`, `UpdateXInput` (partial, no server-managed fields), `XResponse` (explicit allowlist — **never** the Mongoose document; `passwordHash`, internal flags, other-tenant refs can never leak by construction).
- Mapping in one place: `toXResponse(model): XResponse` per module.
- PHI fields tagged in schema metadata (`.describe("phi")`) — drives masking in logs and audit redaction.

## 6. Validation Standards

- Validate at the boundary (middleware, from `*.schema.ts`); services assume valid input; repositories never re-validate.
- Whitelist strategy: `.strict()` objects — unknown keys rejected.
- Domain rules (bed already occupied, insufficient stock, duplicate UHID) are **service-layer** errors (422), not schema errors.
- Clinical safety validations (allergy conflict, dose range, expiry) can be **warned-and-overridden only with reason + audit**, never silently bypassed.
- File uploads: MIME + magic-byte check, size caps per plan, virus-scan hook before availability.

## 7. Error Handling

- `AppError` hierarchy (`code`, `httpStatus`, `details`, `isOperational`); modules throw typed errors; the single global error middleware maps to the envelope. No `res.status().json()` in controllers for errors.
- Never swallow errors; never `catch {}`. Re-throw with context (`cause`).
- Unexpected errors: log full + Sentry + generic client message (no internals leak).
- Workers: retries with backoff → DLQ; DLQ items alert; handlers idempotent.
- Integration calls: timeout + retry (idempotent only) + circuit breaker; failures degrade gracefully (queue for later) rather than failing the user action when safe.

## 8. Logging

- Structured JSON (pino) only; `console.*` banned outside bootstrap *(CI)*.
- Every log carries `traceId`, `tenantId`, `userId?`, `module`. Levels: `error` (actionable), `warn` (degraded), `info` (state changes), `debug` (dev only).
- **Never log PHI or secrets** — schema-driven redaction (from DTO PHI tags) applied at the logger; phone/UHID appear masked (`98•••••210`).
- Request log: method, path, status, duration, tenant — no bodies at info level.

## 9. Audit Logging

- Separate from operational logs, non-negotiable: every mutation of PHI or financial data writes an `auditLogs` entry `{actorId, action, resource, resourceId, before, after, ip, at}` via the Mongoose audit plugin — automatic, not per-developer discipline.
- Append-only; no update/delete path exists in code; periodic hash-chain anchoring for tamper evidence.
- Reads of sensitive records (EMR opens, report downloads) are also audited (`access` events) — HIPAA accounting-of-disclosures.
- Audit failures fail the transaction (same session) — no unaudited mutations.

## 10. Repository Pattern

- Only repositories touch Mongoose; services never import models *(CI: lint boundary)*.
- Repositories obtain models from the **request-context tenant connection** (Doc 04 §2.2.1) — constructing a model from a global connection is forbidden.
- Standard interface per aggregate: `findById`, `findPaged(filter, page)`, `create`, `updateWithVersion(id, version, patch)` (optimistic lock), `softDelete`. Raw aggregations live in the repository with named methods.
- All queries assume the soft-delete partial filter; explicit `withDeleted()` escape hatch requires permission.

## 11. Service Pattern

- Services own business logic, transactions (`withTransaction(session => …)`), and event publishing (outbox in the same transaction).
- One service per module; cross-module calls via the other module's `index.ts` service interface or events — never its repository.
- Side effects (notifications, exports, integration calls) are events/queue jobs, not inline awaits, unless the user outcome depends on them synchronously (payment capture).
- Services are framework-free (no `req`/`res`) — context comes from ALS; this keeps them unit-testable.

## 12. React / Next.js Guidelines (ADR-0012)

**Next.js boundary rules (CI-lintable, non-negotiable):**
- Next.js is presentation-tier only: **no business logic, no DB/Redis access, no business `app/api/*` routes** — all data via `packages/api-client` → Express. The only permitted server handlers are framework plumbing (auth cookie exchange, health).
- **Server components by default** (public pages, portal reads, layout shells); `"use client"` only where interactivity requires it (all operator-dashboard workflows). Never import server-only code into client components (`server-only` package enforces).
- Secrets never in client components or `NEXT_PUBLIC_*`; client-visible config uses `NEXT_PUBLIC_*` exclusively, validated at build.
- Middleware guards route groups by auth-cookie **presence** and resolves `Host` → tenant branding; it redirects — it never authorizes (Express is the authority).
- Public tenant pages use ISR keyed by host; revalidation on branding/content change via API-triggered revalidate.

**React rules (unchanged from SPA design):**
- Client server-state in TanStack Query (keys: `[module, resource, params]`, invalidate by prefix); UI state in Zustand; no server data in Zustand; server components fetch directly via `api-client`.
- Components ≤ ~200 lines; extract hooks (`useLabOrderForm`) over render props; no business math in components — call shared domain utils.
- `PermissionGate`/`FeatureGate` wrap conditional UI; the server remains the authority.
- Forms: RHF + Zod resolver from `packages/validation` — never re-declared schemas.
- Suspense/error boundaries per route segment (`error.tsx`, `loading.tsx`); route groups give per-section code splitting; memoize only measured hot paths.
- Accessibility (Doc 08 §13) is part of Definition of Done, not a later pass.

## 13. Node Guidelines

- Async/await only — no callbacks/raw promise chains; no `sync` fs APIs at runtime.
- No blocking CPU work on the event loop — heavy work (PDF, OCR, exports) goes to workers.
- Graceful shutdown handled centrally (Doc 04 §2.3); every long-lived resource registers a disposer.
- Config only via validated `config/` module — `process.env` access outside it is banned *(CI)*.
- Timeouts on every outbound call; AbortController propagation for cancellable work.

## 14. Mongo Guidelines

- Every query runs against the tenant connection with `tenantId` stamped (defense in depth, Doc 03 §1.3).
- New query patterns require a supporting index in the same PR (`explain()` evidence for hot paths); unindexed collection scans are review blockers.
- Multi-document writes that must be atomic → transactions; single-aggregate design preferred to avoid them where reasonable.
- Optimistic locking (`version`) on all user-edited aggregates; last-write-wins is never acceptable for clinical/financial data.
- Business numbers only from `counters` (§Doc 03 5.1); migrations follow the per-tenant runner (Doc 04 §7); every migration has `up`/`down` and a test on seeded data.

## 15. Testing Standards

- Pyramid + targets per Doc 05 §4 (unit 80%+ on services/utils; integration on critical paths; E2E core journeys).
- Naming: `*.test.ts` co-located (unit), `*.int.test.ts` (integration, Testcontainers Mongo/Redis), `e2e/*.spec.ts` (Playwright).
- Every bug fix lands with a regression test reproducing it first.
- Mandatory suites (tenant isolation, RBAC matrix, clinical safety, financial correctness, concurrency) are release-gating *(CI)*.
- Test data via factories (`packages/test-factories`); no shared mutable fixtures; no real PHI ever.
- Flaky test policy: quarantine within 24 h, fix or delete within a sprint — never `retry: 3` as a fix.

## 16. Git Branch Strategy

- Trunk-based: `main` always deployable; short-lived branches `feat/<module>-<slug>`, `fix/…`, `chore/…`, `hotfix/…` (≤ ~3 days before merge/split).
- No direct pushes to `main` *(CI: branch protection)*; rebase on main before merge; squash-merge with a conventional title.
- Release = tag `v<semver>` from main; hotfix branches from the tag, merged back to main.
- Feature flags decouple deploy from release — incomplete work merges dark behind a flag rather than living in a long branch.

## 17. Commit Convention

Conventional Commits *(CI: commitlint)*:
`<type>(<scope>): <imperative summary ≤ 72 chars>` — types `feat fix refactor perf test docs chore build ci`; scope = module (`feat(lab): reflex testing rules`). Body: what + why. Footer: `BREAKING CHANGE:`, `Closes #123`. One logical change per commit; no `wip`/`fixes` noise in merged history (squash).

## 18. Pull Request Checklist (author)

- [ ] Scoped to one concern; description says what/why + screenshots for UI
- [ ] Tests added/updated; all suites green locally
- [ ] Zod schemas + OpenAPI updated for API changes; backward compatible (or `/v2` + deprecation plan)
- [ ] New queries have indexes; migration included and reversible
- [ ] Permissions + feature flag declared for new routes/UI
- [ ] Audit logging covers new mutations; logs redact PHI
- [ ] i18n keys (no hardcoded user-facing strings); a11y pass on new UI
- [ ] No secrets, no `console.log`, no `any`, boundaries clean (dep-cruiser green)
- [ ] Docs touched if behavior/contract changed; **00-PROGRESS-TRACKER.md updated if a roadmap item changed state**

## 19. Code Review Checklist (reviewer)

- Correctness: edge cases, concurrency (double-submit, parallel bed/stock ops), tz/currency handling
- Security: tenant scoping on every query, permission on every route, input validation, no PHI in logs/errors
- Data: index for every new query shape, transaction where atomicity is claimed, optimistic-lock respected
- Design: right module, boundary respected, no duplication of an existing util/component, naming per §2
- Failure modes: what happens when the DB/integration/queue call fails mid-flow?
- Tests: do they assert behavior (not implementation)? Would they catch the bug this PR could introduce?
- Performance: N+1 lookups, unbounded lists, payload size
- Backward compatibility: API/DTO/event changes additive; mobile clients in the field keep working

## 20. Security Checklist (per feature)

- [ ] AuthN required; permission enforced server-side (`resource:action:scope`)
- [ ] Tenant resolution → connection binding verified; no cross-tenant ID acceptance (IDs validated to exist *in this tenant DB*)
- [ ] Input validated (Zod strict); output allowlisted (DTO §5); no mass-assignment
- [ ] PHI encrypted at field level where designated; masked in logs/UI where partial display suffices
- [ ] Idempotency on money-moving/critical POSTs; rate-limit class assigned
- [ ] Files: type/size/scan enforced; signed URLs short-lived
- [ ] No secrets in code/env files committed; new secrets registered in the vault
- [ ] Audit events for create/update/delete/access of sensitive resources
- [ ] Error responses leak no stack traces/internal identifiers
- [ ] Dependency additions scanned (license + vulnerabilities) *(CI)*
