# CACHE STRATEGY

Governed Redis keyspace (ADR-0006). **Every key pattern must be registered here** with owner, TTL, and invalidation; unregistered patterns are review blockers. Redis is never a source of truth — a flushed Redis degrades latency, never correctness.

**Global conventions:** keys are `scope:identifier[:sub]`; all tenant-related keys embed `tenantId` (or slug); values are JSON (small) — no unbounded lists/hashes; every key has a TTL (no immortal keys except counters with day-scope semantics).

## Key Registry

| Pattern                                         | Owner module           | Strategy                              | TTL                                          | Invalidation                                                                |
| ----------------------------------------------- | ---------------------- | ------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------- |
| `tenant:{slug}` / `tenant:domain:{host}`        | tenants (master)       | read-through                          | 5 min                                        | explicit on registry change + Redis pub/sub `tenant.invalidate` to all pods |
| `ff:{tenantId}` (flags+entitlements bundle)     | subscriptions          | read-through                          | 5 min                                        | explicit on plan/flag change (`platform.subscription.changed`)              |
| `sess:{userId}` / `perm:{userId}`               | auth/rbac              | write-through on login                | access-token TTL                             | explicit on role change, logout, revocation                                 |
| `revoked:{jti}`                                 | auth                   | write-only blocklist                  | token remaining TTL                          | expires naturally                                                           |
| `tariff:{tenantId}:{serviceId}`                 | billing masters        | read-through                          | 10 min                                       | explicit on tariff edit                                                     |
| `ref:icd:{query-hash}` etc. (reference lookups) | reference              | read-through                          | 24 h                                         | version-stamped key on reference data reload                                |
| `queue:{tenantId}:{queueId}:token`              | appointments           | counter (INCR)                        | end of day                                   | daily reset job; final state persisted to Mongo                             |
| `board:beds:{tenantId}:{branchId}`              | beds                   | read-through snapshot for board loads | 30 s                                         | event-driven refresh on `bed.bed.statusChanged`                             |
| `rl:{tenantId}:{userOrKey}:{class}`             | gateway/middleware     | sliding-window counters               | window                                       | expires naturally                                                           |
| `idem:{tenantId}:{key}`                         | idempotency middleware | write-once                            | 24 h                                         | expires naturally                                                           |
| `lock:{name}`                                   | core/redis             | leader election (`SET NX PX`)         | 30 s, renewed by the holder                  | released on shutdown; expires if the holder dies                            |
| `report:{tenantId}:{defHash}:{paramsHash}`      | reports                | read-through                          | configurable per definition (default 10 min) | explicit on definition change; params in key                                |
| `dash:{tenantId}:{key}`                         | dashboards             | read-through over read models         | 60 s                                         | time-based only (read models already async)                                 |
| `lock:{resource}:{id}`                          | various                | distributed lock (SET NX PX)          | operation timeout                            | released by owner; TTL is the safety net                                    |

## Policies

- **Read-through** is the default: `get → miss → load from Mongo → set with TTL`. Single-flight (per-pod promise dedupe) prevents stampedes on hot keys.
- **Write-through** only where staleness is unacceptable _and_ writes are rare (sessions/permissions).
- **Never cache:** PHI clinical content (results, notes), anything patient-identifiable beyond IDs in board snapshots, financial balances. These always read from Mongo.
- **Invalidation discipline:** whoever writes the source data invalidates the key **in the same service method** (not fire-and-forget in a controller). Cross-pod invalidation via Redis pub/sub.
- **Cache warming:** on tenant activation and after deploys, a warmer job (SCHEDULER_CATALOG) pre-loads `tenant:*`, `ff:*`, and top tariffs for active tenants — protects post-deploy latency.
- **Sizing/eviction:** `maxmemory-policy volatile-lru`; alerts at 75% memory (OBSERVABILITY_GUIDE); per-key value cap 512 KB (review blocker above).
- **Failure mode:** Redis down → middleware falls back to master/tenant DB reads with a circuit breaker + degraded-mode log/alert; rate limiting fails open for authenticated users, closed for anonymous (see DR runbook §1).
- **Locks are an efficiency measure, never a correctness one.** A single-node Redis lock can be lost to a GC pause or a failover, so two holders can briefly coexist. `lock:outbox-relay` stops N pods from doing the same relay work N times — the relay stays correct under concurrent holders anyway, because the claim is an atomic compare-and-set and consumers are idempotent. **Never guard money, PHI, or a uniqueness rule with a Redis lock**; use a transaction or a unique index.
