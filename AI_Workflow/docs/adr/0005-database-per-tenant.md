# ADR-0005: Master DB + Dedicated Database per Tenant

**Status:** Accepted · **Date:** 2026-07-12 (owner decision; supersedes the blueprint's earlier shared-collection row-isolation default — ruling N8)

## Context
Hospitals demand hard isolation guarantees, per-tenant backup/restore, data-residency pinning, and a story for "our data on our own server." The earlier design used shared collections + `tenantId` row isolation.

## Decision
- One master database **`paperlesstech_master`**: tenant registry (`hospitalName, slug, databaseName, dbUri?, customDomain, subscription, status`), plans, feature flags, SaaS billing, usage counters, licenses, SaaS support tickets, global settings. No PHI ever.
- One dedicated database per tenant: **`hms_<slug>`**, identical schema fleet-wide.
- A **Connection Manager** resolves subdomain/custom domain → registry (Redis-cached) → cached tenant connection (Doc 04 §2.2.1). JWT `tenantId` must match the host-resolved tenant.
- Placement tiers: shared cluster → dedicated server/cluster by changing `dbUri` — zero code change.

## Consequences
- Physical isolation ends cross-tenant query-bug risk; per-tenant backup/restore/erasure/residency become trivial; noisy neighbors contained.
- Costs accepted: fleet-wide migrations must iterate every tenant DB (per-tenant migration runner, Doc 04 §7); connection management needs LRU caps; cross-tenant analytics (SaaS-level) must aggregate via pipelines, not joins.
- `tenantId` stays stamped on every document as defense-in-depth and consolidation insurance.

## Alternatives considered
**Shared collections + row isolation** (cheapest ops; rejected by owner for isolation/sales/compliance reasons). **Schema-per-tenant in PostgreSQL** (ties to ADR-0001 alternative). **Cluster-per-tenant for all** (cost-prohibitive for small clinics; retained as the top placement tier only).
