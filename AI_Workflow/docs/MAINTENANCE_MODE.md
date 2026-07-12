# MAINTENANCE MODE

Hospitals run 24×7 — full downtime is a last resort. Maintenance is per-tenant wherever possible (DB-per-tenant makes this natural).

## 1. Modes

| Mode                   | Scope                               | Behavior                                                                                                                                                                                                                                                                                     |
| ---------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Normal**             | —                                   | —                                                                                                                                                                                                                                                                                            |
| **Read-only**          | platform or single tenant           | GETs served; mutations return `HMS-GEN-503` with `details.until`; UI shows banner + disables actions gracefully (Doc 08 error states). Exceptions that must keep working even read-only: panic-value acknowledgment, emergency patient lookup — these are tagged `maintenance-exempt` routes |
| **Tenant maintenance** | one tenant (restore/migration/move) | that tenant's requests get a branded maintenance page/503; all other tenants unaffected                                                                                                                                                                                                      |
| **Full maintenance**   | platform                            | static maintenance page at the gateway; API 503 with `Retry-After`; status page incident                                                                                                                                                                                                     |

## 2. Entering / Exiting

Flags in master (`globalSettings`: `maintenance.mode`, `maintenance.tenants[]`, `maintenance.message`, `maintenance.until`) — read via cached registry path, effective ≤ 60 s, no deploy needed. Every transition: audited (who/why), status page updated, tenant admins notified (except sub-5-minute tenant ops). Planned windows: announced ≥ 72 h ahead, scheduled in lowest-traffic hours **per tenant timezone**, never during known OPD peak (8–12 local).

## 3. Read-Only Implementation

Middleware short-circuits mutating verbs (POST/PATCH/PUT/DELETE) after tenant resolution (so exemptions and per-tenant scope work); workers pause mutating queues (queue-level pause), reminder sends continue if channel-safe; sockets stay connected (boards keep displaying, actions disabled client-side via pushed maintenance event).

## 4. Graceful Shutdown (every deploy/restart)

Sequence (Doc 04 §2.3): stop accepting new connections → drain HTTP (30 s budget) → finish in-flight jobs or checkpoint → close sockets with reconnect hint → flush logs/telemetry → close DB/Redis. Kubernetes: `preStop` + readiness-fail first; PM2: `pm2 reload` (cluster) only.

## 5. Mobile & Offline Behavior

Apps receiving 503+`Retry-After` enter a quiet retry state with a user banner; offline-capable flows (staff vitals/MAR) keep queueing locally — sync resumes post-window. Never lose queued clinical entries to a maintenance window.

## 6. Standing Rules

- Fleet migrations that exceed the 5-min budget (PERFORMANCE_BUDGET) run under tenant-maintenance per tenant, rolling, not platform downtime.
- Read-only drills: twice a year, part of DR drill calendar.
- The maintenance page never says "we're down" without a next-update time.
