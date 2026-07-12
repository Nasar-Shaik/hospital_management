# ADR-0006: Redis for Cache, Sessions, Queues, Pub/Sub, Rate Limiting

**Status:** Accepted · **Date:** 2026-07-12

## Context
The platform needs: tenant-registry and entitlement caching on every request (ADR-0005 makes this hot-path), session/permission caches, queue backing (ADR-0007), Socket.IO horizontal scaling (ADR-0008), rate limiting, and token counters.

## Decision
One Redis (cluster in prod) serves all of these, with a governed keyspace documented in `docs/CACHE_STRATEGY.md` — every key pattern has an owner, TTL, and invalidation rule.

## Consequences
- Single infrastructure dependency covers five needs; ops surface stays small; on-prem deploys need only Mongo+Redis+object storage.
- Redis is **never a source of truth**: everything in it is rebuildable from Mongo. A cold Redis start degrades latency, not correctness (see DR runbook).
- Risks managed: key sprawl (catalog + review rule), noisy tenants (per-tenant rate-limit keys), memory (TTLs mandatory, eviction `volatile-lru`).

## Alternatives considered
**Memcached** (no queues/pubsub). **In-process cache** (breaks horizontal scaling). **Kafka for events** (overkill now; outbox+BullMQ suffices — revisit at platform scale).
