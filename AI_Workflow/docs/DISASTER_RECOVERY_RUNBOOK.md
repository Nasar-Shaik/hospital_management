# DISASTER RECOVERY RUNBOOK

Operator playbook. Targets: **RPO ≤ 5 min, RTO ≤ 30 min** (NFR). Every scenario: detection → immediate action → recovery → verification → post-incident. All actions are logged in the incident record; DR drills quarterly (`health.dr-drill-reminder`).

**First 5 minutes of ANY incident:** acknowledge page → open incident (severity, commander) → check Platform Overview dashboard → status page update if user-visible → do NOT restart things without reading the matching section below (Constitution: verify evidence before state-changing commands).

> ## ⚠️ READ §0 FIRST — the rest of this file is TARGET state
>
> Sections 1–7 describe the operational environment this platform is designed to reach: managed
> Redis with automatic failover, MongoDB PITR, an orchestrator with HPA, IaC re-provisioning,
> `infra/` restore scripts, dashboards and alert names. **Almost none of that exists in this
> repository today.** There is no `infra/` script directory, no PITR, no metrics endpoint, no
> alerting, and `infra/docker/docker-compose.yml` says "Dev environment" in its first line.
>
> Following sections 1–7 at pilot time would send an operator looking for tools that are not
> there, during an incident. **§0 is what is actually true and actually executable**, and it was
> verified end to end on 2026-08-17. Keep 1–7: they are the design, and each becomes true as its
> layer is built. Do not read them as instructions yet.

## 0. V1 PILOT: BACKUP AND RESTORE, AS IT ACTUALLY WORKS TODAY

### 0.1 What has to be backed up — and what does not

**Everything that matters is in MongoDB.** Clinical files are not on a disk or in object storage:
`reportFiles.data` and `documents.data` are BSON `Buffer` fields, capped at 10 MB per file by
`report.service.ts`. MinIO appears in the dev compose file and **the API never calls it** — no S3
client, no bucket, no signed URLs. So a Mongo backup is a COMPLETE backup, and there is no second
artefact to keep in step. That is worth knowing before someone adds object storage and silently
splits the recovery story in two.

Two kinds of database, and **both are required**:

| Database                      | Holds                                                   | Restore without the other?         |
| ----------------------------- | ------------------------------------------------------- | ---------------------------------- |
| `paperlesstech_master`        | The tenant registry, plans, licences, operator accounts | Registry pointing at nothing       |
| `hms_<slug>` (one per tenant) | That hospital's entire record, files included           | Orphaned data nothing can route to |

Redis holds no truth (ADR-0006) and is deliberately not backed up.

### 0.2 Backup

`mongodump` is **not on the host**; it ships inside the `mongo:7` image, so it is run through the
container. Nothing extra to install.

```bash
STAMP=$(date +%Y%m%d-%H%M%S)
docker exec medicore-hms-mongo-1 sh -c "mongodump --port 37018 --out /tmp/bk-$STAMP --quiet"
docker cp medicore-hms-mongo-1:/tmp/bk-$STAMP ./backups/
docker exec medicore-hms-mongo-1 rm -rf /tmp/bk-$STAMP
```

Dumping with no `--db` takes every database, which is what you want: one command that cannot
forget a tenant provisioned last week. **Copy the result off the box.** A backup on the VPS being
recovered is not a backup.

### 0.3 Restore

Restore the master FIRST, then the tenants — the registry is what makes a tenant database
reachable at all.

```bash
docker cp ./backups/bk-<stamp> medicore-hms-mongo-1:/tmp/restore
docker exec medicore-hms-mongo-1 sh -c "mongorestore --port 37018 --drop /tmp/restore --quiet"
```

To rehearse against live data without touching it, restore one tenant under another name — this is
the drill, and it is the only way §0.4 can be practised safely:

```bash
docker exec medicore-hms-mongo-1 sh -c \
  "mongorestore --port 37018 --nsFrom 'hms_<slug>.*' --nsTo 'hms_restore_probe.*' /tmp/restore --quiet"
```

### 0.4 Verification — a restore is not finished until this passes

**A backup that has not been restore-tested is not a backup**, and a restore that has not been
verified is not a recovery. Three checks, in this order:

1. **Indexes survived.** This is the one that matters clinically: the unique indexes ARE the
   safety rules, and a restore that silently dropped one leaves a hospital that will happily
   chart the same dose twice.

   ```bash
   docker exec medicore-hms-mongo-1 mongosh --quiet --port 37018 --eval '
     const d = db.getSiblingDB("hms_<slug>");
     ["medicationAdministrations","dispenses","orders","encounters","beds"].forEach(function (c) {
       print(c + ": " + d[c].getIndexes().map(function (i) { return i.name; }).sort().join(", "));
     });'
   ```

   Verified 2026-08-17 on a real dump/restore cycle: `one_administration_per_dose_slot` and its
   siblings come back intact, and `migrations` returned 49 documents on both sides.

2. **Migration history survived**, so the fleet gate can reason about the tenant at all:

   ```bash
   docker exec medicore-hms-mongo-1 mongosh --quiet --port 37018 \
     --eval 'print(db.getSiblingDB("hms_<slug>").migrations.countDocuments({}))'
   ```

3. **The clinical safety invariants are armed** — the authoritative check, because it inspects the
   named `CLINICAL_SAFETY_INVARIANTS` rather than a list somebody typed into this file:

   ```bash
   pnpm --silent seed:migrate --check --json | jq '.verdict, .tenants[] | {slug, code}'
   ```

   `READY` (exit 0) is the pass. Anything else: **do not put the hospital back into service.**
   NOT_READY names the tenant and its remedy; ERROR means the fleet could not be inspected, so
   nothing is known.

**Do not re-run `--all` to "fix" a restored tenant before looking at the output of `--check`.**
Migrations are idempotent, but a restore that landed on the wrong data is a question to answer,
not a state to converge over.

### 0.5 What is NOT covered, stated plainly

- **RPO is the age of the last dump.** There is no PITR and no oplog tailing, so the NFR at the
  top of this file (RPO ≤ 5 min) is **not met by this procedure** — the real RPO is your backup
  interval. For a single-site pilot on one VPS that is a decision to take deliberately, not a
  target to claim.
- **Nothing here is automated.** No cron, no rotation, no retention policy, no daily restore-test.
  The "standing" verification at the foot of this file describes a job that does not exist.
- **No off-site copy is configured.** §0.2's `docker cp` puts the dump beside the thing it
  protects until somebody moves it.

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

## Backup Verification (standing) — TARGET, not built

Daily automated restore-test of one rotating tenant DB into an isolated environment + checksum comparison; failure = page. A backup that hasn't been restore-tested is not a backup.

> **Not built.** There is no scheduler, no isolated environment and no page. §0.3/§0.4 give the
> manual equivalent, which a human can run in a few minutes and which has been executed once. The
> principle in the last sentence above is the reason §0.4 exists at all.
