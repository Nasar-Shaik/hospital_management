# DISASTER RECOVERY RUNBOOK

Operator playbook. Targets: **RPO ≤ 5 min, RTO ≤ 30 min** (NFR). Every scenario: detection → immediate action → recovery → verification → post-incident. All actions are logged in the incident record; DR drills quarterly (`health.dr-drill-reminder`).

**First 5 minutes of ANY incident:** acknowledge page → open incident (severity, commander) → check Platform Overview dashboard → status page update if user-visible → do NOT restart things without reading the matching section below (Constitution: verify evidence before state-changing commands).

## 1. Redis Failure
**Detection:** redis_up=0 alert, latency spike, rate-limit/cache errors.
**Impact:** degraded latency (cache-miss storm), queues paused, sockets drop, rate limiting degraded. **No data loss** — Redis holds no truth (ADR-0006).
**Action:** managed Redis → verify automatic failover; self-hosted → promote replica (sentinel) or restart.
**Recovery:** run `cache.warmer`; BullMQ resumes automatically (jobs persisted in Redis AOF — if Redis storage lost, replay: outbox sweeper re-enqueues events; scheduled jobs re-register at worker boot; in-flight job loss is tolerated by idempotency).
**Verify:** hit-ratio recovering, queue depths draining, socket reconnects, no elevated 5xx.

## 2. MongoDB Failure
**2a. Replica-set primary loss:** automatic election (~10 s); app retries via driver. Verify writes resume; investigate cause.
**2b. Tenant DB corruption/accidental damage:** isolate tenant (suspend via registry → their requests get `HMS-TEN-004` maintenance response) → restore that tenant's DB via PITR to a verified point → run migrations → checksum/count verification → reactivate. **Blast radius = one tenant** — that's the point of DB-per-tenant.
**2c. Master DB down:** cached tenant registry keeps existing traffic flowing (5-min TTL — extend TTL via emergency flag `registry.cache.extend=true`); new logins/provisioning/billing pause. Restore master from hourly snapshot + oplog. This is a page-immediately incident.
**2d. Whole cluster loss:** restore cluster from snapshots (master first, then tenant DBs by tier: Enterprise/Hospital editions first, per contractual SLA); RTO scales with tenant count — parallel restore procedure documented in `infra/` scripts.

## 3. Server / Pod Failure
API/worker pods: orchestrator reschedules; verify HPA capacity; no action beyond capacity check. Single-VM (PM2) deploys: PM2 auto-restarts; if host lost, re-provision from IaC + attach managed DB — the VM is stateless by design (files in object storage).

## 4. Region Failure
Region-pinned tenants (residency) fail over **within region** (multi-AZ) — a true region-wide outage for pinned tenants is an accepted-risk contractual scenario (communicated SLA carve-out) until multi-region DR is built (PROJECT_MEMORY §4 postponed). Non-pinned platform services (status page, docs) run multi-region already. Action: status page, tenant comms, monitor provider ETA, restore-from-backup into alternate region only with tenant's residency consent.

## 5. Payment Gateway Failure
**Detection:** `hms_payment_failures_total{gateway}` spike, webhook silence.
**Action:** circuit breaker opens → UI offers alternate modes (cash/other gateway if configured); queued webhook reconciliation catches late captures (`payment: pending_reconciliation`).
**Recovery:** reconcile `pending_reconciliation` payments against gateway reports **before** closing the incident — no unresolved money states. Never manually mark payments captured without gateway evidence.

## 6. Worker / Queue Failure
**Detection:** queue depth growth, `hms_job_failures_total`, DLQ alerts.
**Action:** check worker logs; scale workers if backlog-only; poison message → move to DLQ, fix handler, replay DLQ (replay tool is idempotency-safe).
**Special cases:** reminder backlog past send-window → drop stale (job guard does this) — never late-send 3 AM reminders; billing job partial failure → per-tenant retry list from job report; outbox backlog → check sweeper + consumer health first (it's usually a consumer).

## 7. Connection Manager Exhaustion (DB-per-tenant specific)
**Detection:** `hms_tenant_connections_open` at cap, connect timeouts on long-tail tenants.
**Action:** raise cap within pod memory budget or scale API pods; check for connection leaks (connections not LRU-evicting); verify no tenant is flapping (rapid evict/reconnect).
**Prevention:** load test validates cap assumptions (PROJECT_MEMORY §3).

## Backup Verification (standing)
Daily automated restore-test of one rotating tenant DB into an isolated environment + checksum comparison; failure = page. A backup that hasn't been restore-tested is not a backup.
