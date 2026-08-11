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

## Addendum — Phase 1 (2026-08-11): what shipping it actually took

The decision above stood. Five things it left implicit had to be made explicit, each because the
implementation had quietly diverged from it.

### The entity classification, settled

| Scope                                                  | Entities                                                                                                                                                                                                  | Why                                                                                                                                                                                                        |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tenant-wide**                                        | departments, medicines (the formulary), serviceItems, notificationTemplates, roles, featureFlags, walletAccounts                                                                                          | Configuration and master data. A hospital stocks a drug and defines a department; a site does not.                                                                                                         |
| **Tenant-wide, deliberately**                          | patients (hybrid — see §5 above), allergies                                                                                                                                                               | Identity and safety. An allergy that does not follow the patient to another site can kill them.                                                                                                            |
| **Branch-scoped**                                      | encounters, appointments, orders, prescriptions, dispenses, invoices, charges, wards, rooms, beds, doctorSchedules, doctorAvailability, theatres, ambulances, assets, and the rest of the operational set | The record of something that happened, or a thing that physically sits, at one site.                                                                                                                       |
| **Branch-stamped, tenant-read** (the _ledger pattern_) | walletEntries, stockMovements                                                                                                                                                                             | The row records WHERE the money or the stock moved; the running balance it belongs to is tenant-wide. Filtering these reads by branch would produce a ledger that does not reconcile with its own balance. |
| **Split**                                              | notifications (branch-stamped delivery records) vs notificationTemplates (tenant-wide configuration)                                                                                                      | The message that went out happened somewhere; the template it was rendered from did not.                                                                                                                   |
| **Tenant-wide, fail-safe**                             | doctorLeave                                                                                                                                                                                               | A doctor who is away is away from the whole hospital. Suppressing slots everywhere is the safe reading of an absence.                                                                                      |

### Uniqueness is branch-aware where identity is per-site (migration 0046)

`{tenantId, name}` on wards, and `{tenantId, doctorId, weekday}` on schedules and rosters, both
encoded "one hospital, one site". Widened to lead with `branchId`. Ward names and **bed occupancy
had to move together**: an admission records its bed as text (`bed.ward`), so the moment two sites
may each own an "ICU", a tenant-wide `one_open_stay_per_bed` refuses a real patient a real bed.

The effective schedule is therefore **doctor + branch + weekday**, and availability is computed for
the site being worked at.

### `branchId` is required where it can be (Phase 1)

Enforced on: encounters, appointments, orders, prescriptions, wards, rooms, beds, doctorSchedules,
doctorAvailability. Still optional, each for a stated reason: patients and allergies (above), the
tenant-wide set (nothing to require), and the **event-driven writers** — charges, invoices,
notifications, dispenses, walletEntries, stockMovements — which take their branch off an event
payload. Failing those closed before every publisher is proven to propagate `branchId` would wedge
the outbox on a retry loop rather than surface a bug.

This was only possible after a latent defect was fixed: `tenantScopePlugin` re-declared `branchId`
via `schema.add`, silently overwriting all 29 models' own declarations, so `required: true` on a
model compiled, read correctly, and enforced **nothing**.

### A hospital is not provisioned until it has a site

`seedMainBranch` moved into `provisionTenant`. It had been called by the CLI and not by the operator
console, so a console-provisioned hospital had no branch at all and wrote branchless rows for ever
after — silently, since `writeBranchId()` simply returns `undefined` when there is no candidate.

### The backfill may not guess

Adopting an unstamped row into the Main Branch is the inference "there was only one site". It is
therefore **refused once a tenant has more than one branch**, and the rows are reported instead.
Where a parent knows the answer — a wallet debit's invoice, a stock movement's dispense — migration
0047 derives it. Nothing else is assigned.

## Alternatives considered

- **Database-per-branch.** Rejected: breaks cross-branch aggregation, a single UHID, and shared staff;
  and contradicts ADR-0005's "tenant is the isolation boundary".
- **Subdomain per branch** (`hyd.apollo.hms.…`). Rejected: redundant with host-is-tenant, heavier DNS/
  cert surface, and no better than a header for an authenticated app.
- **Active branch stored server-side (session).** Rejected: reintroduces server session state the JWT
  design removed; a header is explicit, cacheable-per-tab, and testable.
- **Put the active branch in the JWT.** Rejected: switching branch would require re-issuing tokens, and
  the token would carry authority that must be validated live anyway.
