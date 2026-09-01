# SCHEDULER CATALOG

Registry of **every** scheduled/recurring background job. A cron/repeatable job not listed here is a defect (Guidelines §4). All jobs: idempotent, tenant-iterating jobs use the master registry and process per-tenant with concurrency caps, carry `traceId`, emit success/failure metrics, and alert on consecutive failures.

**Conventions:** BullMQ repeatable jobs; schedules in UTC unless "tenant-local" (resolved per branch timezone); `singleton` = lock via `lock:job:{name}` so overlapping runs are impossible.

| Job                          | Schedule                              | Queue         | Scope               | What it does                                                                                                                                          | Failure handling                                                                                                                |
| ---------------------------- | ------------------------------------- | ------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `backup.tenant-db`           | 01:00 daily + PITR continuous (Atlas) | ops           | per tenant DB       | snapshot/verify per-tenant backup; record in `backups`                                                                                                | page on miss; DR runbook §2                                                                                                     |
| `backup.master-db`           | hourly                                | ops           | master              | registry/billing snapshot                                                                                                                             | page on miss                                                                                                                    |
| `reminder.appointments`      | every 5 min                           | reminders     | tenant-local        | send T-24h and T-2h reminders per template config                                                                                                     | skip-and-log per recipient; no retries past appointment time                                                                    |
| `reminder.medication-refill` | 09:00 tenant-local                    | reminders     | per tenant          | patient refill nudges (flag-gated)                                                                                                                    | log                                                                                                                             |
| `reminder.followups`         | 08:00 tenant-local                    | reminders     | per tenant          | due follow-up notifications to patients/doctors                                                                                                       | log                                                                                                                             |
| `cleanup.expired-sessions`   | 03:00 daily                           | maintenance   | per tenant + master | purge expired sessions/refresh tokens beyond TTL-index safety                                                                                         | log                                                                                                                             |
| `cleanup.temp-files`         | 03:30 daily                           | maintenance   | platform            | delete unclaimed uploads > 48h                                                                                                                        | log                                                                                                                             |
| `cleanup.stale-locks`        | every 10 min                          | maintenance   | platform            | release orphaned `lock:*` past TTL                                                                                                                    | log                                                                                                                             |
| `retry.outbox-sweeper`       | every 1 min                           | events        | per tenant          | re-enqueue stuck `outboxEvents` (status pending > 2 min) — the outbox safety net                                                                      | alert if backlog > threshold                                                                                                    |
| `audit.seal-chain` ✅        | 02:00 daily (`singleton`)             | maintenance   | per tenant          | seal new `auditLogs` entries into a hash-chained `auditAnchors` record — tamper evidence (Doc 09 §9). Idempotent; seals only entries older than 2 min | **alert, do not retry blindly** — a seal that fails repeatedly means the trail is not being anchored, which is a compliance gap |
| `audit.verify-chain` ✅      | 03:00 daily                           | maintenance   | per tenant          | recompute every leaf hash and anchor root; report holes in `seq`                                                                                      | **page** — a trail that stops verifying is an incident, not a report                                                            |
| `retry.webhook-redelivery`   | backoff schedule                      | webhooks      | per tenant          | redeliver failed webhooks (5 attempts/72h) → mark dead                                                                                                | notify tenant admin on dead                                                                                                     |
| `report.scheduled-reports`   | per `reportSchedules`                 | reports       | per tenant          | run + deliver scheduled reports (email/portal)                                                                                                        | notify owner on failure                                                                                                         |
| `report.kpi-snapshots`       | every 15 min                          | analytics     | per tenant          | refresh `kpiSnapshots`/read models incrementally                                                                                                      | alert if lag > 60 s budget                                                                                                      |
| `report.daily-census`        | 23:59 tenant-local                    | analytics     | per tenant          | midnight census (occupancy, admissions/discharges) — statutory                                                                                        | must-run: page on failure                                                                                                       |
| `archive.cold-data`          | 02:00 Sunday                          | archival      | per tenant          | move aged auditLogs/vitals/closed bills to cold storage per DATA_RETENTION_POLICY                                                                     | resume-safe cursors                                                                                                             |
| `archive.downsample-vitals`  | 04:00 daily                           | archival      | per tenant          | downsample time-series vitals > 90 days                                                                                                               | resume-safe                                                                                                                     |
| `billing.saas-invoices`      | 00:30 on 1st                          | saas-billing  | master              | generate tenant subscription invoices + usage overages                                                                                                | singleton; page on failure                                                                                                      |
| `billing.dunning`            | 09:00 daily                           | saas-billing  | master              | payment reminders, grace handling, suspension flags per policy                                                                                        | human approval gate before suspension                                                                                           |
| `billing.ip-room-charges`    | 00:05 tenant-local                    | billing       | per tenant          | post daily bed/room charges to open admissions                                                                                                        | idempotent per admission+date; alert on partial failure                                                                         |
| `billing.package-expiry`     | 06:00 daily                           | billing       | per tenant          | expire lapsed packages/wallet promos                                                                                                                  | log                                                                                                                             |
| `notify.limit-thresholds`    | hourly                                | metering      | master              | evaluate usage vs plan limits → `platform.limit.thresholdReached`                                                                                     | dedupe per metric+period                                                                                                        |
| `notify.license-expiry`      | 07:00 daily                           | notifications | per tenant          | licenses/accreditations/calibrations expiring (30/7/1 days)                                                                                           | log                                                                                                                             |
| `notify.expiry-stock`        | 07:30 daily                           | notifications | per tenant          | medicine batch expiry alerts (90/30/7 days)                                                                                                           | log                                                                                                                             |
| `cache.warmer`               | post-deploy + 06:00                   | maintenance   | platform            | warm tenant registry/flags/tariffs (CACHE_STRATEGY)                                                                                                   | log                                                                                                                             |
| `health.dlq-monitor`         | every 5 min                           | ops           | platform            | DLQ depth check across queues → alert                                                                                                                 | page at threshold                                                                                                               |
| `health.dr-drill-reminder`   | quarterly                             | ops           | platform            | open a DR-drill task per runbook                                                                                                                      | log                                                                                                                             |
| `push.deliver` ✅            | on delivery of a staff in-app message | notifications | per tenant          | fan one delivered `inapp` notification out to its recipient's registered handsets via Expo Push (M4)                                                  | retries with backoff when the whole batch failed; a handset Expo reports `DeviceNotRegistered` is retired, never retried        |

## `reminder.appointments` is implemented as a DELAYED JOB, not a 5-minute sweep (A6, 2026-07-14)

The row above describes a cron that wakes every 5 minutes and asks each tenant's database whether anything is due. What shipped instead: when an appointment is booked, the consumer schedules ONE delayed BullMQ job for T-24h (`core/events/taskQueue.ts`, `jobId: reminder:{tenantId}:{appointmentId}`).

**Why.** The sweep costs 288 empty scans a day per tenant on a clinic with a quiet Tuesday, and it is the same work either way. The delayed job is scheduled at the moment its cause occurs.

**The sweep's one real advantage is recovery of lost schedules — and we do not need it.** The EVENT that schedules the reminder is durable in the outbox, so a job lost with its Redis instance is rescheduled when that event is redelivered. Durability lives in the outbox, once, instead of in every consumer.

**Cancellation is not handled, on purpose.** Nothing cancels or reschedules the job when the appointment changes. The job carries an appointment id, and the handler RE-READS the appointment when it fires: if it no longer `occupiesSlot()` (cancelled, rescheduled, completed, no-showed), it sends nothing. The delayed job is a trigger; the database is the truth. Keeping the decision in two places — a durable database and a volatile queue — and requiring them to agree is how a patient gets reminded to attend an appointment they cancelled last week.

T-2h reminders are not built. When they are, they are a second `delayMs` on the same mechanism.

**Correction, 2026-08-20 — the job id above was wrong, and no reminder was ever scheduled.** BullMQ
builds its Redis keys as `bull:<queue>:<jobId>` and REJECTS a custom id containing a colon
(`Custom Id cannot contain :`). `reminder:{tenantId}:{appointmentId}` therefore made `add()` reject
every time — inside an awaited call in a consumer, so it surfaced as an ordinary job retry and
nothing ever said so. It is `reminder-{tenantId}-{appointmentId}` now, and `scheduleTask` refuses a
colon up front rather than leaving it to the queue. Found by an M4 test that asserted on the QUEUED
JOB rather than on `scheduleTask` having been called (`taskQueue.test.ts`).

## `push.deliver` — the knock on the door after the message is already safe (M4, 2026-08-20)

Not a cron and not a sweep: the task is scheduled by `notification.service.ts` the moment a staff
`inapp` message is marked `sent`, with `jobId: push-{notificationId}`.

**The ledger row is the message; this is a delivery optimisation.** It runs on the queue rather than
inline because `order.critical` is sent SYNCHRONOUSLY inside the request that recorded the result,
and an HTTP call to Expo inside that request would put a third party's latency between a technician
and a saved critical value. A push that never arrives changes nothing about what the doctor sees
when they next open the app.

**Push is not a `Channel`.** `dedupeKey` is unique per tenant, so a template delivered on two
channels collides on `one_message_per_cause` and the second is dropped as a duplicate — the problem
`COMMUNICATION_POLICY.md` records for email-plus-inapp. Hanging the fan-out off the in-app delivery
avoids it entirely and keeps one row per message.

**What it does NOT retry:** a handset Expo reports as `DeviceNotRegistered` is deactivated on the
spot, and a partial failure does not re-push to the handsets that already buzzed. Only a batch that
failed entirely, for a reason other than a dead token, throws for the queue to retry.

## Implementation status (A5)

✅ = implemented. Everything else is planned.

**The outbox relay is NOT a scheduled job today, and that is a deliberate deviation from `retry.outbox-sweeper` above.**

It runs as an in-process poll loop inside `apps/api` (`core/events/outboxRelay.ts`, every 2 s), elected by the Redis lock `lock:outbox-relay`, because the relay must read _every tenant's database_ — which requires the tenant registry, the Connection Manager and the Mongoose stack, none of which exist in `apps/workers`. Putting it there today would mean duplicating the database layer, or extracting it into a package before anything needs it.

The API therefore **produces** (relay → BullMQ `events` queue) and the workers **consume**. `retry.outbox-sweeper` remains the target shape: its reclaim behaviour (stuck `processing` rows older than 60 s are re-claimed) is already implemented inside the relay loop, so moving it is a relocation, not a redesign.

**Extraction trigger** (written down so it is a decision, not a matter of taste): when relay lag becomes a scaling concern of its own, lift the DB layer into `packages/db` and move the loop to `apps/workers`. Nothing about the events changes — that is what the seam is for.

`audit.seal-chain` and `audit.verify-chain` exist today as the CLI `pnpm --filter @medicore/api audit:chain -- --seal|--verify [--slug X]`. They are CLIs rather than routes on purpose: sealing is single-writer (two concurrent sealers would fork the chain), and an HTTP endpoint is exactly the sort of thing that gets called twice. Wiring them to cron is an ops task, not a code one.

## Adding a job

Add the row here + implement with: singleton lock (if needed), idempotency (natural key: e.g., `admission+date` for room charges), metrics (`job_runs_total`, `job_duration`, `job_failures_total`), and an alert rule. Jobs that mutate financial/clinical data require the same review rigor as API endpoints.
