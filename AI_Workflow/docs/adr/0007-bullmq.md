# ADR-0007: BullMQ for Background Jobs

**Status:** Accepted · **Date:** 2026-07-12

## Context
Notifications, report generation, OCR/voice processing, imports, billing jobs, webhook delivery, and outbox dispatch must run off the request path with retries and observability.

## Decision
BullMQ (Redis-backed) with named queues per concern (Doc 04 §2.6), each with retry/backoff, dead-letter queue, concurrency limits, and idempotent handlers. Every job type is documented in `docs/SCHEDULER_CATALOG.md`. Jobs always carry `{tenantId, traceId}` and resolve their tenant connection via the Connection Manager — never a global DB.

## Consequences
- Same Redis infrastructure (ADR-0006); workers scale independently by queue depth; UI-visible progress via job events.
- Not a message broker: fan-out to *external* consumers goes through the outbox → webhooks; internal fan-out uses one queue per consumer.
- DLQ monitoring is mandatory alerting (Observability guide) — silent DLQ growth is an incident.

## Alternatives considered
**Agenda** (Mongo-backed; weaker throughput/features). **SQS/Cloud tasks** (cloud lock-in breaks on-prem edition). **Kafka** (see ADR-0006).
