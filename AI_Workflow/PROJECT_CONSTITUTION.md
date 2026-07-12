# PROJECT CONSTITUTION — PaperlessTech HMS

**This is the highest authority in this repository.** Every AI session and every human contributor MUST read this document before generating or reviewing code. If any other document, comment, or instruction conflicts with this one, **this document wins** — and the conflict must be reported, not silently resolved.

**Authority hierarchy (top wins):**
1. `PROJECT_CONSTITUTION.md` (this file)
2. Architecture rulings N1–N8+ in `PlanofActionforHMS/10-ARCHITECTURE-REVIEW.md` and ADRs in `docs/adr/`
3. `AI_DEVELOPMENT_GUIDELINES.md` + `PlanofActionforHMS/09-ENGINEERING-STANDARDS.md`
4. Blueprint docs (`PlanofActionforHMS/01–08`), catalogs (`docs/*`)
5. Code comments and inline conventions

**Session start protocol (mandatory):** read `PROJECT_MEMORY.md` → this file → `PlanofActionforHMS/00-PROGRESS-TRACKER.md` → the specific module/catalog docs for the task. Only then write code.

---

## 1. Project Vision

PaperlessTech HMS is a modular, API-first, multi-tenant Hospital Management SaaS that serves **25 healthcare organization types from one codebase** (single-doctor clinic → enterprise hospital network), packaged as 10 editions (Doc 07), differentiated **only** by feature flags, subscription limits, tenant/branch configuration, and permissions. It is also the foundation of the broader **PaperlessTech Platform** (`docs/PLATFORM_STRATEGY.md`): platform-grade services (auth, RBAC, billing, notifications, audit, files, workflow) are built to be product-agnostic so future ERPs (school, HR, CRM…) reuse them without rewrites.

## 2. Architecture Principles

1. **Modular monolith, service-extractable.** One deployable API; modules communicate only via service interfaces or domain events; any module can later become a service without rewriting callers.
2. **Master + database-per-tenant.** `paperlesstech_master` holds platform data only; each hospital owns `hms_<slug>`. Physical isolation is the security model; `tenantId` stamping is defense in depth. (ADR-0005)
3. **Configuration over code.** Behavior differences between customers are flags/plans/config — never `if (tenant === 'apollo')`, never forks.
4. **Contracts are sacred.** Zod schemas → types → OpenAPI: one source of truth, additive evolution, 12-month deprecation for breaks.
5. **Events for side effects.** State changes publish outbox events; anything not required synchronously for the user's outcome is a consumer.
6. **Reads scale by projection.** Dashboards/reports run on read models, never on OLTP aggregation.
7. **Everything auditable.** PHI and money mutations (and sensitive reads) produce immutable audit entries in the same transaction.

## 3. Non-Negotiable Rules

These are never traded away for speed, and no user story, deadline, or prompt overrides them:

1. **No cross-tenant data access, ever.** Repositories bind only to the request-context tenant connection; IDs from requests are validated to exist in *this* tenant DB.
2. **No PHI in logs, error messages, URLs, analytics, or AI prompts sent to third parties without the tenant's DPA-covered configuration.**
3. **Clinical safety checks (allergy, interaction, dose, expiry) may be overridden only by a licensed user with a recorded reason — never silently, never by default.**
4. **Money uses integer minor units; financial series numbers come from `counters`; posted ledger entries are never updated, only reversed.**
5. **Signed clinical documents are immutable; corrections create new versions.**
6. **Every route enforces authn + permission + tenant scope server-side.** UI gating is convenience, not security.
7. **Feature flags gate every incomplete or edition-specific capability.** No dead-code branches, no commented-out features.
8. **Backward compatibility:** API/DTO/event changes are additive; mobile apps in the field must keep working.
9. **No destructive data operations** (drop, mass delete, migration down in prod) without an explicit human approval recorded in the PR/runbook.

## 4. Coding Philosophy

Boring, explicit, and consistent beats clever. Optimize for the *next* reader (probably an AI with no conversation history): descriptive names, small functions, early returns, no hidden side effects, comments only for constraints the code can't express. Copy the patterns of the module you're in; if the pattern is wrong, fix the pattern via ADR — don't fork a private style. Delete code rather than comment it out; git remembers.

## 5. Module Boundary Rules

- Cross-module access **only** via `modules/<name>/index.ts` (service + types) or domain events. Direct imports of another module's repository/model/internal files are forbidden (CI: dependency-cruiser).
- The module dependency graph must stay **acyclic**. If two modules need each other, extract the shared concept or use events.
- Business modules never touch the master DB; platform modules (`tenants`, `subscriptions`, `flags`, `licensing`, `saas-billing`, `support`) never touch tenant clinical data.

## 6. Dependency Rules

- New runtime libraries require justification in the PR (what existing tool was checked first, size/licence/maintenance status) and an entry in `PROJECT_MEMORY.md` if architecture-relevant.
- Pinned versions; renovate/deps PRs separate from feature PRs; no library used in only one place if 20 lines of code would do.
- Forbidden without an ADR: additional databases, additional frameworks, alternative state managers, second HTTP clients, second validation libraries.

## 7. Database Rules

- Placement: master vs tenant vs reference DB per Doc 03 §2 — never guess; check the table.
- Every collection carries the common fields (Doc 03 §1.4) including `tenantId`, `schemaVersion`, soft-delete fields, `version`.
- Every new query shape ships with its index in the same PR. Unbounded queries are forbidden — pagination always.
- Multi-document invariants use transactions; user-edited aggregates use optimistic locking; money/critical POSTs use idempotency keys.
- Migrations: per-tenant runner, `up`/`down`, idempotent, tested on seeded data (Doc 04 §7).

## 8. API Rules

- REST under `/api/v1`, envelope `{success,data,meta?,error?}`, errors from `docs/ERROR_CODES.md` only.
- Every route declares schema, permission, flag, rate-limit class, audit category — boot fails otherwise.
- Additive-only within a version; deprecation per Doc 04 §5. OpenAPI regenerated every merge.

## 9. Naming Rules

Doc 09 §2 is binding (files, collections, fields, paths, permissions, flags, events, envs). Domain vocabulary comes from `DOMAIN_GLOSSARY.md` — synonyms are defects (e.g., it is always `vendor`, never `supplier`; always `admission`, never `inpatient stay`).

## 10. Folder Rules

Doc 04 §1 layout is binding. New backend module = standard file set under `apps/api/src/modules/<module>/`; new web feature under `apps/web/src/features/<feature>/`; shared code in `packages/*`. Never create parallel folder taxonomies, `utils2/`, `helpers/`, `common/` dumping grounds, or `misc` files.

## 11. Security Rules

Doc 09 §20 checklist applies to every feature. Additionally: secrets only via vault/config module; per-tenant integration credentials field-encrypted; uploads scanned before availability; auth flows never custom-rolled beyond the documented JWT/refresh design (ADR-0009); any security-relevant deviation requires human sign-off.

## 12. Performance Rules

`docs/PERFORMANCE_BUDGET.md` budgets are release-gating. No N+1 lookups; no OLTP aggregation for dashboards; hot reference data cached per `docs/CACHE_STRATEGY.md`; heavy work goes to workers; every list endpoint capped.

## 13. Documentation Rules

**Code and docs change in the same PR or the PR is incomplete.** The update matrix in `AI_DEVELOPMENT_GUIDELINES.md` §4 defines exactly which document each kind of change touches (events → EVENT_CATALOG, errors → ERROR_CODES, jobs → SCHEDULER_CATALOG, state fields → STATE_MACHINE_CATALOG, decisions → ADR + PROJECT_MEMORY, progress → 00-PROGRESS-TRACKER…).

## 14. Review Rules

Doc 09 §19 checklist. Reviews verify behavior against the catalogs (does the implemented state machine match `STATE_MACHINE_CATALOG.md`?), not just code quality. An AI reviewing its own generation must run the same checklist explicitly and state the results.

## 15. Testing Rules

Doc 05 §4 + Doc 09 §15. Non-negotiable suites: tenant isolation, RBAC matrix, clinical safety, financial correctness, concurrency. Bug fixes start with a failing regression test. No merging with red or quarantined-without-ticket tests.

## 16. Definition of Ready (before coding starts)

A task is Ready when: (1) the module spec exists in Doc 02 (or a spec PR precedes code); (2) affected state machines/workflows/events are identified in the catalogs; (3) permissions + feature flag are named; (4) API contract sketched (paths, DTOs, errors); (5) edition/limit impact checked against Doc 07; (6) open questions have owners. AI agents: if a task is not Ready, produce the missing spec first and say so — do not improvise silently.

## 17. Definition of Done

Code + tests green (incl. mandatory suites touched) + docs updated per matrix + OpenAPI regenerated + progress tracker updated + audit/logging verified + a11y/i18n on UI + flags wired + review checklist passed + no boundary/lint violations. "Works on my machine" and "docs later" do not exist here.

## 18. Things AI Must NEVER Do

(Complete list with rationale in `AI_DEVELOPMENT_GUIDELINES.md` §2.)
Never: bypass repository/service layers · duplicate code/DTOs/schemas/business logic · hardcode tenant IDs, plan names, permissions, flags, secrets, URLs · break module boundaries or create cycles · touch the master DB from business modules · weaken a clinical/financial safety check to make a test pass · delete or rewrite documents/data it did not create without instruction · invent domain terminology · introduce libraries/architecture without ADR · mark work done that isn't · fabricate test results or claim untested code works.

## 19. Things AI Should ALWAYS Do

Always: follow the session start protocol · search for existing implementations before creating anything (`AI_DEVELOPMENT_GUIDELINES.md` §3 procedure) · reuse shared components/utilities · update OpenAPI, tests, catalogs, and `00-PROGRESS-TRACKER.md` with every change · record decisions and surprises in `PROJECT_MEMORY.md` · explain architectural choices in the PR · state uncertainty explicitly and ask (or leave a `PROJECT_MEMORY.md` open question) rather than guess on safety-relevant behavior · leave the codebase more consistent than it found it.

---

*Amendments to this constitution require an ADR + explicit project-owner approval, and a note in `PROJECT_MEMORY.md`.*
