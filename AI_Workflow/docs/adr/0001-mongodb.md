# ADR-0001: MongoDB as Primary Datastore

**Status:** Accepted · **Date:** 2026-07-12

## Context
The HMS stores heterogeneous clinical documents (notes, flowsheets, specialty templates), financial records, and operational data for many isolated tenants. The tenancy model (ADR-0005) requires cheap creation of per-tenant databases with identical schemas.

## Decision
MongoDB (Mongoose ODM) is the primary datastore for master, reference, and all tenant databases.

## Consequences
- Document model fits variable clinical shapes and specialty templates without migration churn; `schemaVersion` enables lazy evolution.
- Database-per-tenant is a first-class, low-cost Mongo pattern (`useDb`); Atlas provides managed backup/PITR per DB.
- We take on: no foreign-key enforcement (repositories validate refs), transactions require replica sets (dev compose runs one), and financial integrity relies on our own patterns (transactions, counters, append-only journal — Doc 03 §5, §9).
- Relational-style reporting is served by read models, not ad-hoc joins.

## Alternatives considered
**PostgreSQL** (strong integrity, but per-tenant DB provisioning/ops heavier at our scale and clinical document shapes fight the relational model; JSONB hybrid loses both worlds' tooling clarity). **One DB per service** (premature; we're a monolith).
