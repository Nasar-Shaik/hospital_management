# ADR-0010: Authorization — RBAC + Fine-Grained Permissions + Scopes

**Status:** Accepted · **Date:** 2026-07-12

## Context

Hospitals have deep role hierarchies (doctor vs resident vs nurse vs cashier) with branch-scoped duties and patient-own data access; editions gate module availability separately.

## Decision

Three-layer authorization evaluated in order on every request:

1. **Feature flag/entitlement** — is the capability enabled for this tenant (edition)?
2. **Permission** — does the user hold `resource:action[:scope]` via role bindings (`userRoles` → `rolePermissions`)? Scopes: `own | branch | tenant | global`.
3. **Row scope** — repository-level filter by scope (own → `userId/patientId` binding; branch → `branchIds`).
   Roles are tenant-defined data (seeded defaults); permissions are a code-defined catalog (`packages/permissions`) — routes reference constants, never strings (Guidelines Never-rule 7). Effective permissions cached per session (Redis), invalidated on role change.

## Consequences

- UI gates (`PermissionGate`) are convenience; the server chain is the authority (Constitution §3.6).
- RBAC matrix test suite is release-gating (Doc 05 §4.2).
- ABAC/policy-engine (OPA-style) deliberately deferred — revisit if time-bound/consultant access rules outgrow scopes (noted in PROJECT_MEMORY §4 spirit).

## Alternatives considered

**Pure RBAC without scopes** (can't express "own patients"/branch limits). **OPA/Cedar policy engine** (powerful but opaque to non-experts and heavier to test; premature). **Per-record ACLs** (unmanageable at hospital scale).
