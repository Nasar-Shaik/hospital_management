# SCHEDULER CATALOG

Registry of **every** scheduled/recurring background job. A cron/repeatable job not listed here is a defect (Guidelines §4). All jobs: idempotent, tenant-iterating jobs use the master registry and process per-tenant with concurrency caps, carry `traceId`, emit success/failure metrics, and alert on consecutive failures.

**Conventions:** BullMQ repeatable jobs; schedules in UTC unless "tenant-local" (resolved per branch timezone); `singleton` = lock via `lock:job:{name}` so overlapping runs are impossible.

| Job | Schedule | Queue | Scope | What it does | Failure handling |
|-----|----------|-------|-------|--------------|------------------|
| `backup.tenant-db` | 01:00 daily + PITR continuous (Atlas) | ops | per tenant DB | snapshot/verify per-tenant backup; record in `backups` | page on miss; DR runbook §2 |
| `backup.master-db` | hourly | ops | master | registry/billing snapshot | page on miss |
| `reminder.appointments` | every 5 min | reminders | tenant-local | send T-24h and T-2h reminders per template config | skip-and-log per recipient; no retries past appointment time |
| `reminder.medication-refill` | 09:00 tenant-local | reminders | per tenant | patient refill nudges (flag-gated) | log |
| `reminder.followups` | 08:00 tenant-local | reminders | per tenant | due follow-up notifications to patients/doctors | log |
| `cleanup.expired-sessions` | 03:00 daily | maintenance | per tenant + master | purge expired sessions/refresh tokens beyond TTL-index safety | log |
| `cleanup.temp-files` | 03:30 daily | maintenance | platform | delete unclaimed uploads > 48h | log |
| `cleanup.stale-locks` | every 10 min | maintenance | platform | release orphaned `lock:*` past TTL | log |
| `retry.outbox-sweeper` | every 1 min | events | per tenant | re-enqueue stuck `outboxEvents` (status pending > 2 min) — the outbox safety net | alert if backlog > threshold |
| `retry.webhook-redelivery` | backoff schedule | webhooks | per tenant | redeliver failed webhooks (5 attempts/72h) → mark dead | notify tenant admin on dead |
| `report.scheduled-reports` | per `reportSchedules` | reports | per tenant | run + deliver scheduled reports (email/portal) | notify owner on failure |
| `report.kpi-snapshots` | every 15 min | analytics | per tenant | refresh `kpiSnapshots`/read models incrementally | alert if lag > 60 s budget |
| `report.daily-census` | 23:59 tenant-local | analytics | per tenant | midnight census (occupancy, admissions/discharges) — statutory | must-run: page on failure |
| `archive.cold-data` | 02:00 Sunday | archival | per tenant | move aged auditLogs/vitals/closed bills to cold storage per DATA_RETENTION_POLICY | resume-safe cursors |
| `archive.downsample-vitals` | 04:00 daily | archival | per tenant | downsample time-series vitals > 90 days | resume-safe |
| `billing.saas-invoices` | 00:30 on 1st | saas-billing | master | generate tenant subscription invoices + usage overages | singleton; page on failure |
| `billing.dunning` | 09:00 daily | saas-billing | master | payment reminders, grace handling, suspension flags per policy | human approval gate before suspension |
| `billing.ip-room-charges` | 00:05 tenant-local | billing | per tenant | post daily bed/room charges to open admissions | idempotent per admission+date; alert on partial failure |
| `billing.package-expiry` | 06:00 daily | billing | per tenant | expire lapsed packages/wallet promos | log |
| `notify.limit-thresholds` | hourly | metering | master | evaluate usage vs plan limits → `platform.limit.thresholdReached` | dedupe per metric+period |
| `notify.license-expiry` | 07:00 daily | notifications | per tenant | licenses/accreditations/calibrations expiring (30/7/1 days) | log |
| `notify.expiry-stock` | 07:30 daily | notifications | per tenant | medicine batch expiry alerts (90/30/7 days) | log |
| `cache.warmer` | post-deploy + 06:00 | maintenance | platform | warm tenant registry/flags/tariffs (CACHE_STRATEGY) | log |
| `health.dlq-monitor` | every 5 min | ops | platform | DLQ depth check across queues → alert | page at threshold |
| `health.dr-drill-reminder` | quarterly | ops | platform | open a DR-drill task per runbook | log |

## Adding a job
Add the row here + implement with: singleton lock (if needed), idempotency (natural key: e.g., `admission+date` for room charges), metrics (`job_runs_total`, `job_duration`, `job_failures_total`), and an alert rule. Jobs that mutate financial/clinical data require the same review rigor as API endpoints.
