# RISK REGISTER

Living register. Score = Likelihood (1–5) × Impact (1–5). Review monthly (Sev ≥ 12 weekly). Every risk has an owner and a mitigation that is either **built** (architecture) or **scheduled** (tracker item). Append new risks; never delete — mark Retired with date.

> **§0 is different from the rest of this file.** Everything below §0 is a risk somebody _predicted_.
> §0 is a defect somebody _found_ — confirmed present in the code, with evidence. A prediction and
> a fact do not belong in one list, and the ones in §0 were all found by running the product rather
> than by reading it.

## 0. Confirmed open defects

Found by execution, reproducible, **not fixed**. Each names the evidence so the next person does not
re-investigate.

| ID  | Defect                                                                         | Sev | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Status                      |
| --- | ------------------------------------------------------------------------------ | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| D1  | **Vitals reads ignore row scope entirely** — cross-branch PHI                  | P2  | `vitals.repository.ts` contains **zero** `scopeFilter()` calls (`mar.repository.ts` has 5, `encounter.repository.ts` 7) yet the collection carries `branchId`. Probed 2026-08-14: a nurse with active branch B read a branch-A stay's vitals — **HTTP 200, 2 rows**, while schedule/administrations/notes on the same stay correctly returned 0. Writes are refused (404); reads are not. Because the filter is absent rather than merely un-narrowed, a **branch-confined** user is affected too. | **OPEN** — found 2026-08-14 |
| D2  | **Reception register resolves `?date=` in `env.DEFAULT_TIMEZONE`**             | P2  | [`encounter.controller.ts:44`](../../apps/api/src/modules/encounters/encounter.controller.ts#L44). Its own comment says "the HOSPITAL's timezone" — true when a hospital was one site. MAR, round, worklist and clinic hours were all moved to the branch's zone; this was not.                                                                                                                                                                                                                    | **OPEN** — found 2026-08-14 |
| D3  | **Bed-day billing counts calendar days in `env.DEFAULT_TIMEZONE`**             | P2  | [`billing.consumers.ts:393`](../../apps/api/src/modules/billing/billing.consumers.ts#L393) — `chargeBedDays` receives `branchId` and does not use it for the zone. Bed-days bill per calendar day started, so a stay at a differently-zoned site can be one night out. Money.                                                                                                                                                                                                                      | **OPEN** — found 2026-08-14 |
| D4  | **An unknown `X-Active-Branch` is silently ignored, widening the read**        | P3  | Probed 2026-08-14: garbage, a valid-but-not-a-branch ObjectId, and another tenant's branch id all returned **200 with total=45** (all sites) instead of 42 (branch A). It **cannot exceed the caller's binding** — a confined user stays confined — so this is a correctness/robustness issue, not an escalation. A stale id yields aggregate data under a header claiming one site.                                                                                                               | **OPEN** — found 2026-08-14 |
| D5  | **Nothing reconciles `limits.maxBranches` with the plan's catalogue limit**    | P3  | `provisionTenant` stamps no cap, so `DEFAULT_MAX_BRANCHES` (1) applies; `changePlan` writes only `subscription.planCode`. A hospital sold PLAN_HOSPITAL's 3 sites is capped at 1, and upgrading the plan does not change it. Worked around in `seed:demo`; the mismatch lives in the subscription module.                                                                                                                                                                                          | **OPEN** — found 2026-08-14 |
| D6  | **Migration 0048 cannot build over pre-existing duplicate idempotency claims** | P3  | It adds a unique index (`one_claim_per_idempotency_key`) over rows that were previously unconstrained. Observed 2026-08-14: the migration **failed** on `hms_sunrise` until duplicates were cleared. Any tenant already holding a duplicate will fail the same way, with no pre-flight check and no remediation path.                                                                                                                                                                              | **OPEN** — found 2026-08-14 |
| D7  | **`administeredBy` renders an identifier, not a name**                         | P3  | Confirmed on the MAR payload 2026-08-14. Needs API-side name expansion. Product decision, previously recorded.                                                                                                                                                                                                                                                                                                                                                                                     | **OPEN** — known            |

**Rated below P1 deliberately.** None of them creates, alters or loses clinical data, and none affects
medication safety: the duplicate-administration rule, the 409-as-answer payload, idempotent replay and
lost-response reconciliation were all verified working on 2026-08-14. D1 is the most serious because
cross-branch PHI is the exact class multi-branch Phase 0 existed to eliminate — rate it P1 if you hold
branch isolation to that standard.

## Technical

| ID  | Risk                                                               | L×I    | Mitigation                                                                                       | Status                                     |
| --- | ------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| T1  | Cross-tenant data exposure via mis-resolved connection or bug      | 2×5=10 | DB-per-tenant + host↔JWT match + tenantId stamping + isolation test suite on every route (CI)    | Built into design                          |
| T2  | Fleet migration failure leaves tenant DBs on mixed schema versions | 3×4=12 | Per-tenant migration tracking + convergence metric + expand/contract policy + resume-safe runner | 🔴 **MATERIALISED 2026-08-14 — see below** |
| T3  | Connection-pool exhaustion at tenant-count growth                  | 3×3=9  | LRU caps + metrics + load-test validation (PROJECT_MEMORY assumption A3)                         | Scheduled P9                               |
| T4  | Modular monolith decays into big-ball-of-mud                       | 3×4=12 | CI boundary enforcement (dep-cruiser) + review rules; never disable the lint                     | Built into CI from P0                      |
| T5  | Read-model drift vs OLTP truth                                     | 3×3=9  | Rebuildable projections + freshness metric + weekly reconciliation job                           | Design (Doc 03 §9)                         |
| T6  | Double-charging / duplicate financial postings under retries       | 2×5=10 | Idempotency keys + counters + `payment: pending_reconciliation` + financial test suite           | Built into design                          |
| T7  | Master DB becomes a single point of failure                        | 2×4=8  | Cache-first reads + TTL-extension emergency flag + hourly snapshots (DR §2c)                     | Designed                                   |

### 🔴 T2 materialised — 2026-08-14

**This register predicted it in July and the mitigation was never built.** On 2026-08-14 **all four**
local tenant databases were found two migrations behind: `0048-idempotency-key-claims` and
`0049-one-administration-per-dose-slot` had never been applied. `hms_sunrise` had 47 migrations and
**no unique index on `medicationAdministrations`**.

**Why it happened:** migrations run inside `provisionTenant`, and `seed:demo` skips provisioning for a
tenant that already exists. Nothing else converges a tenant on the current schema, and nothing warns.

**What it cost, concretely.** A safety probe run against that database reported seven catastrophic
failures — two nurses both charting the same dose, second attempts creating duplicates, every
idempotency replay creating a new row. **Every one was the absence of the safety mechanism, not a
defect in it.** After `pnpm seed:migrate --all`, all seven passed. A human working the M3 checklist
would have raised duplicate administration as a P0 and been wrong.

**Partially controlled, 2026-08-16.** `seed:validation` (both the seeding run and `--verify`) now
refuses to touch a tenant that cannot enforce the clinical invariants, checking the canonical
`pendingCount()` **and** the actual indexes — because a migration record is weaker evidence than the
constraint, and a dropped index leaves the record behind. Proven by falsification: disabling the
index inspection turns four controls red. **This gates ONE tenant at validation time and is not the
metric T2 asks for**; it cannot see the fleet and must not be described as if it could.

It also exposed a sharp edge worth knowing: when a constraint is gone but its record remains,
`pnpm seed:migrate` **skips the migration and prints "tenant converged" while changing nothing**
(measured: `migrationsApplied: []`, index still absent). The block message now gives that case its
own remedy — clear the record, then converge — because the obvious instruction is wrong for it.

**The predicted mitigation is still the right one and is still missing:** a _convergence metric_ —
something that answers "is every tenant on the current schema?" without being asked. Until it exists:

- `pnpm seed:migrate --all` is a **precondition of any validation run** (now stated in both device
  checklists and `SEED.md`).
- A tenant that fails to converge must be treated as invalidating every result taken against it.

**Do not treat this as closed by the manual step.** The step is a workaround for a missing control,
and the register scored this 12 for a reason.

## Business

| ID  | Risk                                                                    | L×I    | Mitigation                                                                                        | Status                                  |
| --- | ----------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------- | --------------------------------------- |
| B1  | Editions mispriced → small clinics unprofitable / hospitals underserved | 3×4=12 | Usage metering from day 1; pricing placeholders reviewed with design partners before GA           | Open — owner input (PROJECT_MEMORY §10) |
| B2  | 25-org-type promise creates unbounded specialty scope                   | 4×3=12 | Flag-gated specialty wave is post-hospital-core; edition demand pulls modules, not sales promises | Governance (Doc 05)                     |
| B3  | Incumbent lock-in (data migration fear) blocks sales                    | 4×3=12 | Import tooling (P9) + migration playbooks as first-class product                                  | Scheduled                               |
| B4  | Design partners shape product toward one hospital's quirks              | 3×3=9  | Config-first rule (Constitution §2.3): partner needs become flags/config, never hardcode          | Standing rule                           |

## Operational

| ID  | Risk                                                         | L×I    | Mitigation                                                                           | Status                                  |
| --- | ------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------ | --------------------------------------- |
| O1  | On-call gaps in small team during incidents                  | 3×4=12 | Runbooks (DR), auto-remediation-first alerts, managed services (Atlas)               | Partially designed                      |
| O2  | Hospital go-lives fail on data quality (bad masters/imports) | 4×4=16 | Import validation tooling + golden master templates + go-live checklist w/ sign-offs | Scheduled P9 — **top operational risk** |
| O3  | Support can't distinguish tenant-specific vs platform issues | 3×3=9  | Tenant drill-down dashboard + traceId in every error                                 | Designed                                |
| O4  | Untested backups                                             | 2×5=10 | Daily rotating restore-verification (DR §Backup)                                     | Designed                                |

## Security

| ID  | Risk                                    | L×I    | Mitigation                                                                           | Status                    |
| --- | --------------------------------------- | ------ | ------------------------------------------------------------------------------------ | ------------------------- |
| S1  | PHI breach (external attack)            | 2×5=10 | Field-level encryption, WAF, pen-tests, scanning pipeline, least-privilege infra     | Scheduled P9 + continuous |
| S2  | Insider misuse (staff browsing records) | 3×4=12 | Access-event auditing + anomaly reports (accounting of disclosures)                  | Designed (Doc 09 §9)      |
| S3  | Compromised tenant admin account        | 3×4=12 | MFA enforcement for privileged roles, session anomaly detection, impersonation audit | Designed                  |
| S4  | Supply-chain (dependency) compromise    | 2×4=8  | Lockfiles, scanning, SBOM, minimal-dependency rule (Constitution §6)                 | Built into CI             |

## AI-Specific

| ID  | Risk                                                                | L×I    | Mitigation                                                                                                                            | Status                           |
| --- | ------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| A1  | AI agent introduces duplicate/divergent implementations over months | 4×3=12 | Guidelines §3 search-before-create + review checklist + this governance layer                                                         | **This layer is the mitigation** |
| A2  | AI-generated code silently weakens a safety/financial check         | 2×5=10 | Never-rule 11 + mandatory suites can't be edited in the same PR as features touching them (review rule)                               | Standing rule                    |
| A3  | Clinical AI feature harms a patient (wrong suggestion accepted)     | 2×5=10 | Advisory-only + licensed-user sign-off + guardrail audits (Doc 01 P8); no autonomous clinical action ever (PROJECT_MEMORY assumption) | Constitutional                   |
| A4  | PHI leaked into third-party model prompts                           | 2×5=10 | Redaction layer before provider calls + DPA-gated provider config + prompt audit log                                                  | Designed (Doc 02 J1)             |
| A5  | Doc/code drift makes AI agents confidently wrong                    | 4×3=12 | Doc-update matrix (Guidelines §4) + PR checklist + drift = defect culture                                                             | Standing rule                    |
