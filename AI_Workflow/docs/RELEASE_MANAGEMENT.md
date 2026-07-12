# RELEASE MANAGEMENT

How code reaches production. Complements Doc 04 §7 (pipeline) and FEATURE_ROLLOUT (flags).

## 1. Branching

Trunk-based (Doc 09 §16): `main` always deployable; short-lived `feat/*`, `fix/*`, `chore/*`; `hotfix/*` from the production tag. Squash-merge; conventional commit titles; branch protection (reviews + green CI required).

## 2. Versioning

- **Platform:** semver `vMAJOR.MINOR.PATCH` tags on main. MINOR = weekly release train; PATCH = hotfix; MAJOR = breaking public-API version (rare, paired with `/v2`).
- **Mobile apps:** independent semver per app + build number; OTA (Expo Updates) for JS-only changes, store releases for native changes; server keeps compatibility with the two most recent store versions (Constitution §3.8).
- **Per-tenant DB schema:** migration version per tenant DB (`migrations` collection); fleet convergence tracked by `hms_migration_pending` metric.

## 3. Release Train

Weekly: cut from main → staging (auto) → full regression + migration dry-run on staging fleet → manual approval → production (canary). Release notes auto-assembled from conventional commits; customer-visible notes curated per edition.

## 4. Deployment Strategies

- **Blue-green** for risky releases (schema-coupled changes): stand up green → run migrations (expand-only, see §6) → shift traffic → keep blue warm for the rollback window.
- **Canary** (default): 5% of API pods → error/latency watch (auto-abort on burn-rate) → 25% → 100% over ≤ 2 h.
- Workers deploy after API is at 100% (queue payloads are versioned, additive).
- Single-VM (PM2) tenants: maintenance-window rolling restart via deploy script; Government on-prem follows a signed-release delivery process.

## 5. Hotfix

`hotfix/*` from prod tag → minimal diff + regression test → expedited review (still: tests + security checklist) → canary skipped only for sev-1 with owner approval → tag PATCH → cherry-pick to main **immediately** (unmerged hotfixes are the classic drift bug).

## 6. Migrations & Rollback

- **Expand → migrate → contract:** releases N adds new fields/indexes (compatible with old code), N+1 removes old ones. A release must never require its own migration to serve traffic.
- Rollback = redeploy previous images (always compatible with current schema thanks to expand/contract). Data rollbacks are restores (DR runbook), never `down` migrations in production without owner approval (Constitution §3.9).
- Every release records: images, migration versions, flag defaults changed → `releaseRecords` (queryable "what changed when" for support).

## 7. Release Gates (all must pass)

CI suites green (incl. mandatory HMS suites) · perf gate vs budgets · security scans clean · migration dry-run on staging fleet · OpenAPI diff reviewed (no breaking) · rollback plan stated in the release PR · on-call aware.
