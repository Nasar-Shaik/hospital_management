# ADR-0016: Tenant Licensing — tenure, the branch cap, and custom domains

**Status:** Accepted · **Date:** 2026-07-26 · **Extends:** ADR-0005 (database-per-tenant), ADR-0015 (multi-branch)

## Context

Provisioning a hospital answered "what may this customer use" (the edition → entitlements, ADR-0010)
but not "**until when**". A hospital, once created, ran forever: there was a `status` machine with an
`expired` state but nothing that ever entered it, no expiry date, and no way for a super-admin to sell
a fixed term and have access stop when it lapsed. Separately, ADR-0015 added `limits.maxBranches` and
enforced it at branch creation, but **no provisioning or console path ever set it** — every hospital
was silently pinned to a single branch. And a hospital could only be reached at its subdomain; there
was a `customDomain` field the registry already resolved, but no way to attach one.

The sibling `school_management` platform had already solved all three (per-tenant licence with a grace
window, a super-admin branch cap that "locks" over-cap branches, and a Domain registry). We mirror its
model, adapted to HMS's single-tenant-DB + Redis-cached registry.

## Decision

**A licence is tenure, independent of both the edition and the operator-suspend status. It is enforced
at the request gate from the cached registry entry, and it self-heals on renewal.**

1. **The licence lives on the master tenant record** (`tenant.license`: `plan`, `status`, `validFrom`,
   `expiresAt`, `graceDays`, `lastRenewedAt`, `notes`) — never in the tenant DB, so a hospital cannot
   edit its own expiry. No `expiresAt` = **perpetual** (a deliberate operator choice, e.g. an internal
   account), never an accident: provisioning always seeds a licence (a default trial when none is
   given).

2. **Enforcement is a single integer compare on the hot path.** `toEntry` denormalises `expiresAt` and
   `expiresAt + graceDays` onto the cached `TenantRegistryEntry` as epoch milliseconds.
   `effectiveLicenseState()` — shared by the gate and the console so they never diverge — returns
   `ACTIVE | GRACE | EXPIRED`. `resolveTenant` blocks `EXPIRED` (past grace) with **HMS-TEN-005**,
   after the status gate and **independent** of it. No cron flips a status; expiry fires to the second
   from the date, and a renewal un-blocks the hospital on its **next request** (the registry write
   busts the cache).

3. **The tenant UI is warned before it is cut.** `resolveTenant` stamps `X-License-State`
   (`ACTIVE | EXPIRING | GRACE`, where `EXPIRING` = active but within `LICENSE_WARN_DAYS`) and
   `X-License-Days-Left` on every response. The web API client reads them and drives a dismissible
   renewal banner — no polling. A hard-`EXPIRED` licence never produces a normal response, so the
   banner only ever shows `EXPIRING`/`GRACE`.

4. **The branch cap is a sales control the console now sets.** `maxBranches` is threaded through
   provisioning and a dedicated `POST /hospitals/:id/limits`. Lowering it **deletes nothing** — the
   ADR-0015 create-time cap simply refuses new branches until it is raised again, which is how a branch
   is "stopped" (e.g. for non-payment) without data loss.

5. **A custom domain is just a second host.** `POST /hospitals/:id/domain` attaches / replaces / clears
   `customDomain` (refusing a host owned by another tenant, busting both host caches). We keep HMS's
   single-field model rather than porting school's multi-domain collection — a multi-domain table would
   be a redesign for no current need. DNS/TLS for the host is an operational step outside this call.

## Consequences

- Renewal, extension (`extendDays` never shortens an already-future licence), the branch cap, and the
  domain are all super-admin-only console actions, each written to the platform audit trail.
- **Existing hospitals provisioned before this ADR have no `license` ⇒ perpetual** — nothing breaks;
  the operator sets an expiry when a commercial term begins.
- The licence gate adds one integer compare and two header writes per request — no master round-trip.
- Rejected: a status-flipping cron (a date compare is simpler, fires to the second, and self-heals);
  db-per-branch locking semantics (over-cap branches are refused at creation, not hidden at read time —
  a deliberate smaller step than school's read-time locking).
