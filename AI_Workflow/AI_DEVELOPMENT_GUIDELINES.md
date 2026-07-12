# AI DEVELOPMENT GUIDELINES

Operating manual for AI agents (Claude, GPT, and successors) acting as engineers on this project. `PROJECT_CONSTITUTION.md` is the authority; this document is the _how_.

---

## 1. Session Protocol

**Start:** read `PROJECT_MEMORY.md` → `PROJECT_CONSTITUTION.md` → `PlanofActionforHMS/00-PROGRESS-TRACKER.md` → task-relevant specs (Doc 02 module entry, state machines, workflows, events, errors). State in your first output which task you're picking up and what documents you consulted.

**During:** work in small, verifiable increments; run tests before claiming anything works; when you discover a contradiction between docs, or between docs and code, **stop and report it** — do not pick one silently.

**End (mandatory, even for partial work):** update `00-PROGRESS-TRACKER.md` statuses + §7 handoff notes; append decisions/surprises/open questions to `PROJECT_MEMORY.md`; ensure the doc-update matrix (§4) is satisfied. An ended session that leaves undocumented half-done work is a failed session.

## 2. NEVER Rules (with rationale)

| #   | Never                                                                                            | Why                                                                                          |
| --- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| 1   | Duplicate code, components, or utilities                                                         | Two copies immediately begin to drift; the fix applied to one misses the other               |
| 2   | Create a new file before searching for an existing implementation (§3)                           | AI agents' #1 debt source is parallel implementations of existing things                     |
| 3   | Bypass the repository pattern / access MongoDB outside repositories                              | Tenant scoping, soft-delete, and audit live there; bypassing = data leak risk                |
| 4   | Bypass the service layer (controller → repository directly)                                      | Transactions, events, and business rules live in services                                    |
| 5   | Create duplicate DTOs or validation schemas                                                      | Zod schemas in `packages/validation` are the single contract; duplicates desynchronize FE/BE |
| 6   | Duplicate business logic (e.g., re-implement billing math in a report)                           | Financial/clinical math must have exactly one implementation                                 |
| 7   | Hardcode permissions, feature flags, tenant IDs, plan/edition names, secrets, URLs               | All are data/config; hardcoding breaks the 25-org-type/one-codebase model                    |
| 8   | Create circular dependencies or break module boundaries                                          | Enforced by CI; cycles make extraction and reasoning impossible                              |
| 9   | Introduce a library, framework, or architectural pattern without an ADR                          | Undocumented dependencies are unmaintainable years later                                     |
| 10  | Modify architecture without updating the affected documents                                      | Docs are the only memory future agents have                                                  |
| 11  | Weaken tests, delete assertions, broaden `try/catch`, or relax validation to make something pass | Masks defects; especially forbidden for safety/financial suites                              |
| 12  | Claim untested code works, fabricate outputs, or mark incomplete work done                       | The next agent builds on your claim                                                          |
| 13  | Use domain synonyms not in `DOMAIN_GLOSSARY.md`                                                  | Terminology drift fragments search and models                                                |
| 14  | Put PHI in logs, fixtures, comments, or prompts to external services                             | Compliance violation (Constitution §3.2)                                                     |
| 15  | Run destructive operations (drop/mass-delete/down-migrations) without explicit human approval    | Irreversible                                                                                 |

## 3. Search-Before-Create Procedure (mandatory)

Before creating any function/component/schema/endpoint/collection:

1. **Grep** for the domain term and its glossary synonyms across `packages/` and `apps/` (e.g., before writing date math: `grep -ri "formatDate\|toTenantTz" packages/ apps/`).
2. **Check the canonical homes:** `packages/utils` (helpers), `packages/ui` + `components/shared` (components), `packages/validation` (schemas), the owning module's `index.ts` (services), Doc 03 §2 (collections), `docs/ERROR_CODES.md` (errors), `docs/EVENT_CATALOG.md` (events).
3. **If something close exists:** extend or generalize it in place (with tests) rather than forking.
4. **If nothing exists:** create it in the canonical home, not next to your feature; then reference it.
5. **Record it:** new shared utilities/components get a one-line mention in the PR description so reviewers can veto duplication you missed.

## 4. Documentation Update Matrix

| When you…                                                     | You MUST update…                                                             |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Add/modify an endpoint                                        | OpenAPI (generated), Doc 02 module entry, `docs/ERROR_CODES.md` (new errors) |
| Add/modify a collection or index                              | Doc 03 §2/§4                                                                 |
| Publish/consume a domain event                                | `docs/EVENT_CATALOG.md`                                                      |
| Add/modify entity states or transitions                       | `docs/STATE_MACHINE_CATALOG.md`                                              |
| Implement/modify a business flow                              | `docs/BUSINESS_WORKFLOWS.md`                                                 |
| Add a scheduled/background job                                | `docs/SCHEDULER_CATALOG.md`                                                  |
| Add a cache key                                               | `docs/CACHE_STRATEGY.md`                                                     |
| Add a metric/alert/SLO                                        | `docs/OBSERVABILITY_GUIDE.md`                                                |
| Make an architectural decision                                | New ADR in `docs/adr/` + `PROJECT_MEMORY.md`                                 |
| Change module/edition scope                                   | Doc 02 / Doc 07                                                              |
| Change any task status                                        | `PlanofActionforHMS/00-PROGRESS-TRACKER.md`                                  |
| Learn something non-obvious, postpone something, take on debt | `PROJECT_MEMORY.md`                                                          |

## 5. ALWAYS Rules

1. Always reuse shared components and utilities; extend rather than fork.
2. Always update OpenAPI, tests, and the matrix-listed docs **in the same change**.
3. Always explain architectural decisions (PR description + ADR when threshold met: new dependency, new pattern, new infrastructure, contract break).
4. Always write the failing test first for bug fixes.
5. Always run the relevant mandatory suites (tenant isolation, RBAC, clinical safety, financial correctness, concurrency) when touching their domains — and report results honestly.
6. Always keep changes reviewable: one concern per PR; large refactors split mechanical/behavioral.
7. Always surface ambiguity: if the spec, catalogs, and code disagree, report options with a recommendation instead of choosing silently.
8. Always leave handoff notes when stopping mid-task (tracker §7): what's done, what's not, what you'd do next, any traps.

## 6. AI-Specific Failure Modes to Guard Against

- **Confident duplication:** generating a "new" helper that exists under another name → mitigated by §3.
- **Local optimization:** making one module inconsistent with the other 40 to be "better" → consistency wins; propose pattern changes via ADR.
- **Context loss:** forgetting mid-session constraints → re-check Constitution §3 non-negotiables before finalizing.
- **Overreach:** "while I'm here" refactors bundled into features → forbidden; note the idea in `PROJECT_MEMORY.md` → Future Ideas instead.
- **Spec hallucination:** inventing fields/behaviors not in the docs → if it's not documented, it's a question, not a fact.
- **Silent scope-narrowing:** implementing the easy 80% and not flagging the skipped 20% → handoff notes must list gaps explicitly.
