# OBSERVABILITY GUIDE

How we see the system. Stack (Doc 04 §8): OpenTelemetry → Prometheus/Grafana (metrics), Loki (logs), Tempo/Jaeger (traces), Sentry (errors), synthetic checks + status page.

## 1. Metrics (Prometheus)

**Golden signals per service (api, workers, web-edge):** request rate, error rate, duration histograms (by route class), saturation (event-loop lag, CPU, memory, connection-pool usage).

**Domain metrics (labels always include `tenant` — bounded by tenant count, and `branch` only on low-cardinality boards):**
- `hms_appointments_booked_total`, `hms_queue_wait_seconds`
- `hms_lab_tat_seconds` (order→approved), `hms_panic_alerts_total` + `hms_panic_ack_seconds`
- `hms_payments_captured_total{mode}`, `hms_payment_failures_total{gateway}`
- `hms_outbox_lag_seconds`, `hms_dlq_depth{queue}`, `hms_job_failures_total{job}`
- `hms_tenant_connections_open`, `hms_tenant_resolution_seconds`, `hms_cache_hit_ratio{key_class}`
- `hms_readmodel_lag_seconds`, `hms_migration_pending{tenant}`

**Cardinality rule:** never label by patientId/userId/path-with-ids.

## 2. Logs (Loki, structured JSON via pino)
Mandatory fields: `ts, level, msg, traceId, tenantId, module, userId?`. PHI redaction at the logger (schema-driven, Doc 09 §8). Retention: 30 d hot / 13 mo archived (audit logs are a separate, immutable store — not Loki).

## 3. Tracing (OTel)
Trace every request end-to-end: gateway → middleware (tenant-resolution span!) → service → Mongo/Redis/integration spans → queue producer; workers continue the trace via `traceId` in job payloads. `traceId` returned in every error envelope so support can jump from ticket → trace.

## 4. SLI / SLO / SLA

| SLI | SLO (internal) | SLA (contractual, Doc 07) |
|-----|----------------|---------------------------|
| API availability (5xx ratio) | 99.95% monthly | 99.5–99.95% by edition |
| API latency | PERFORMANCE_BUDGET p95s | — |
| Panic-alert delivery | < 5 s p99 | — (patient-safety internal) |
| Notification delivery (reminder class) | 99% < 5 min | — |
| Read-model freshness | < 60 s | — |
| Per-tenant backup success | 100% daily | RPO ≤ 5 min / RTO ≤ 30 min |

Error budgets: burn-rate alerts at 2%/1h (page) and 5%/6h (ticket). Budget exhausted ⇒ feature freeze for reliability work (Constitution-level policy).

## 5. Alerts (Alertmanager → on-call)

**Page (now):** availability burn, tenant DB unreachable, master DB/Redis down, DLQ depth > threshold, panic-alert pipeline failure, backup miss, payment-gateway error spike, certificate expiry < 7 d.
**Ticket (next business day):** cache hit ratio drop, read-model lag, single-tenant error anomaly, job retry elevation, disk > 70%.
Every page alert links to its runbook section (DISASTER_RECOVERY_RUNBOOK).

## 6. Dashboards (Grafana, provisioned as code in `infra/`)
1. **Platform overview** — golden signals, error budget, active tenants.
2. **Tenant drill-down** — per-tenant traffic/errors/latency/connections (support's first stop).
3. **Queues & jobs** — depth, DLQ, job success/duration.
4. **Data layer** — Mongo ops/latency per cluster, Redis memory/hit-ratio, connection manager pool.
5. **Business pulse** — bookings, revenue captured, lab TAT, notification delivery (product/ops).
6. **Clinical safety** — panic alert delivery + acknowledgment times (reviewed weekly).

## 7. Synthetics & Status
Blackbox probes: login flow, booking flow, patient-portal report fetch — per region, every minute. Public status page auto-driven by probe state; tenant-facing incident comms templates in support playbooks.

**Rule:** new feature ⇒ ask "how will we know it's broken?" — if the answer isn't a metric/alert here, add it (Guidelines §4).
