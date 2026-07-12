# FEATURE ROLLOUT

How features go from merged-dark to generally available. Flags are the mechanism (Constitution §3.7); this defines the process.

## 1. Flag Taxonomy

| Kind | Naming | Lifetime | Example |
|------|--------|----------|---------|
| **Entitlement flags** (edition capabilities) | `module.<domain>.<name>`, `specialty.*`, `platform.*` | permanent (product packaging, Doc 07) | `module.clinical.dialysis` |
| **Rollout flags** (temporary, protect a release) | `rollout.<feature>` | ≤ 90 days, then removed | `rollout.new-billing-engine` |
| **Ops kill switches** | `ops.<subsystem>.enabled` | permanent, default on | `ops.ai-suggestions.enabled` |

Rollout flags carry an owner + expiry in the flag record; the flag registry report lists overdue flags — stale rollout flags are debt (tracked in PROJECT_MEMORY §5).

## 2. Dark Launch
Merged code ships disabled (`rollout.*` off). Where valuable, **shadow mode**: new path runs alongside old, results compared/logged, old result served (used for: billing engine changes, search ranking, forecast models). Shadow-mode diffs must be zero (financial) or reviewed (heuristic) before exposure.

## 3. Progressive Exposure
Order: internal (staff tenants) → design partners (opt-in, named) → percentage rollout by **tenant** (5% → 25% → 50% → 100%, hashed on tenantId for stickiness — never per-request randomness; a hospital must have a consistent experience) → default-on.
Clinical-safety-relevant features additionally require: clinical SME sign-off + design-partner usage evidence before exceeding 25%.

## 4. Watch & Abort
Each rollout stage declares its guard metrics (error rate on the touched routes, domain metric, support tickets). Auto-abort (flag off) on guard breach; manual kill switch always available to on-call **without a deploy**. Aborts are incidents-lite: cause noted in PROJECT_MEMORY lessons if architectural.

## 5. Kill Switches
Standing `ops.*` switches for: AI features, outbound notifications (per channel), payment gateway (per provider), public API, online booking, heavy reports. Flipping one is an audited operator action with mandatory reason; on-call may flip without approval during an incident (documented after).

## 6. Rollback vs Roll-forward
Feature misbehaving ⇒ flag off (instant, no deploy). Code defect beneath a flag ⇒ normal release rollback (RELEASE_MANAGEMENT §6). Never "fix forward under pressure" on financial/clinical paths — disable first, fix calmly.

## 7. GA & Cleanup
GA checklist: docs updated (module docs + user-facing), support playbook entry, pricing/edition mapping confirmed (Doc 07), telemetry dashboards in place. Within 90 days of GA: remove the rollout flag and dead old path (a PR that only deletes — reviewers love it), keep the entitlement flag if it's packaging.
