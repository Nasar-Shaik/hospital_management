# ADR-0015: Multi-Branch — the Active-Branch Context

**Status:** Accepted · **Date:** 2026-07-23 · **Extends:** ADR-0005 (database-per-tenant), ADR-0010 (authorization)

## Context

A tenant is one hospital _organisation_ (Apollo Hospitals). A real organisation runs several physical
locations — Apollo Hyderabad, Chennai, Bangalore. The blueprint anticipated this: Doc 03 §1.4 lists
`branchId` as a standard field on operational documents, ADR-0010 defines a `branch` permission scope,
and the runtime already carries a per-user branch binding (`userRoles.branchScope` + `branchIds[]`),
publishes it into the request context, and applies it at read time (`scopeFilter`).

What the system never had was the **Branch entity itself** and, more importantly, a notion of _which
branch a request is acting in_. The context knew the branches a user was **allowed** to reach; it did
not know the one they were **working in right now**. So `branchId` was a field nobody wrote (every
create did `...(input.branchId ? … : {})` and nothing supplied it), a two-branch user saw both sites
merged, and there was no way to say "admit this patient **in Chennai**".

Branches are **not** separate tenants. They share one tenant database (ADR-0005 is unchanged), one
patient identity space, and one staff directory. The isolation between them is **logical** — a
`branchId` scoping dimension — because the product's headline requirement is cross-branch aggregation
("All Branches" reports for a medical director), which is trivial in one database and near-impossible
across many. A database-per-branch would also make shared staff and a single tenant-wide UHID
impossible. (The `school_management` platform reached the same conclusion independently.)

## Decision

**Introduce an _active branch_ per request, carried in the `X-Active-Branch` header, layered on top of
the existing scope machinery — not replacing it.**

1. **The Branch is a tenant-DB entity.** New `branches` collection and module; every tenant has at
   least one, `Main Branch`, created at provisioning. The number a tenant may create is capped by
   `limits.maxBranches` on the master tenant record (a platform control, set by the super-admin).

2. **Transport is a request header, `X-Active-Branch`.** It fits the stateless model (host = tenant,
   JWT = identity, header = active branch) and needs no new subdomain scheme. A new
   `resolveActiveBranch` middleware validates it against the caller's _live_ allowed set and publishes
   `ctx.activeBranchId` (a branch id, or `null` meaning **All**).

3. **Reads narrow; All aggregates.** `scopeFilter()` filters to `activeBranchId` when one is selected.
   When it is `null` (All mode, only offered to users whose binding reaches every branch, or several),
   it falls back to today's behaviour — the full allowed set. This makes shipping the middleware a
   **no-op** until a branch is actually selected: existing single-branch tenants are unaffected.

4. **Writes stamp the active branch, and All-mode cannot write.** A single choke point,
   `writeBranchId()`, returns the active branch for a create and throws `HMS-BRANCH-001` in All mode —
   you must pick a branch to create records in. This is both a data-integrity rule (every operational
   transaction knows its branch) and a clinical one (an admission must name a site).

5. **Patient identity stays tenant-level.** A patient has one UHID across all branches and may be
   treated at any of them (Domain Glossary: "stable across visits and branches"). `patient.branchId`
   is the _registering_ branch — provenance and the default list scope — **never** an ownership wall:
   lookup by UHID is tenant-wide, so a patient registered in Hyderabad is found in Chennai. Operational
   records (encounters, orders, bills, admissions) carry the _treating_ branch.

## Consequences

- **Backward compatible by construction.** No header ⇒ old behaviour. A migration creates `Main Branch`
  per tenant and backfills existing operational rows to it; `branchId` stays optional now and is made
  required only after the backfill is proven. Single-branch hospitals see no change; the switcher
  auto-hides.
- **`branchId` is written in exactly one way** (`writeBranchId()`), so "which branch created this?" has
  one answer and one test surface, mirroring how `tenantScopePlugin` centralises tenant stamping.
- **Statutory series go per-branch.** Invoice counters move from `invoice:{FY}` to
  `invoice:{branchId}:{FY}` — each branch is frequently a distinct GSTIN and must run its own series.
- **Scope is still read live, never from the token** (ADR-0010's rule): the active branch is validated
  against the current allowed set every request, so a staff member moved between branches cannot keep
  acting in the old one until their token expires.
- **No new authorization model.** `branch` scope, `branchScope`, and `scopeFilter` are the ones ADR-0010
  already defined; this ADR only adds the _active_ selection within the allowed set.

## Alternatives considered

- **Database-per-branch.** Rejected: breaks cross-branch aggregation, a single UHID, and shared staff;
  and contradicts ADR-0005's "tenant is the isolation boundary".
- **Subdomain per branch** (`hyd.apollo.hms.…`). Rejected: redundant with host-is-tenant, heavier DNS/
  cert surface, and no better than a header for an authenticated app.
- **Active branch stored server-side (session).** Rejected: reintroduces server session state the JWT
  design removed; a header is explicit, cacheable-per-tab, and testable.
- **Put the active branch in the JWT.** Rejected: switching branch would require re-issuing tokens, and
  the token would carry authority that must be validated live anyway.
