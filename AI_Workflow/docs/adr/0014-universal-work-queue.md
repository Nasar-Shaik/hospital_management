# ADR-0014: One Work-Queue Engine — as a Projection, not a Source of Truth

**Status:** Accepted · **Date:** 2026-07-14 · **Extends:** ADR-0007 (BullMQ), ADR-0013 (Encounter)

## Context

Every department in a hospital consumes work from a list: the doctor's waiting patients, the phlebotomy queue, the radiology worklist, the pharmacy dispensing counter, the billing desk, the admission desk, the insurance pre-auth team.

The blueprint scattered these. `queues` and `tokens` were specified **inside the Appointments module** (Doc 02 E1), while lab worklists, radiology worklists and dispensing lists were each left to their own module to invent. That produces six incompatible queue implementations, six ways to set a priority, six ways to claim an item, and no way to answer "what is waiting in this hospital right now?"

It also means a hospital that never books appointments cannot have a queue.

## Decision

**One queue engine, consumed by every department, with different queue types, priorities, permissions and routing rules.**

And the part that matters more than the engine:

> **The queue is a PROJECTION of domain state. It is never the source of truth.**

### Why a projection, and not an authoritative table

If `workItems` were authoritative, then placing a lab order would mean writing the **order** and writing the **queue row** — a dual write to two systems that cannot commit together. A crash between them yields either an order nobody performs, or a queue entry for an order that does not exist.

That is exactly the failure the transactional outbox (ADR-0007) was built to eliminate, and reintroducing it **at the centre of the clinical workflow** — where a dropped write is a blood test that never happens — would be indefensible.

So:

1. **Source of truth stays in the domain**: `orders`, `encounters`, `invoices`, `admissions`.
2. **`workItems` is a read model**, maintained by outbox consumers (`order.placed` → a lab work item; `encounter.arrived` → a doctor work item), **idempotent on `(sourceType, sourceId)`** because delivery is at-least-once.
3. **The projection is rebuildable.** A `queue.rebuild` job reconstructs every work item from the domain. **A queue you can rebuild from the truth is a queue you can trust**; a queue that has drifted and cannot be rebuilt is a hospital running on a lie.

Eventual consistency is bounded by the relay poll (~2 s). For a worklist a human reads, that is invisible.

### What the work item owns

Only **queue state** — never clinical state:

- `queueType` (doctor, lab, radiology, pharmacy, billing, admission, insurance…)
- `targetKind` + `targetId` — who must act (a department, a room, a doctor, a role)
- `priority` — `routine | urgent | stat | emergency` (triage sets this, and it is the whole reason a single ordering rule is not enough)
- `status` — `waiting | claimed | in_progress | done | cancelled`
- `claimedBy` + `claimedAt` — a **lease**, so two technicians cannot silently take the same sample. Same mechanism as the notification ledger and the outbox relay; a stale lease is reclaimable.
- `encounterId`, `patientId` — for the board and for row-scoping

Clinical state (the result, the report, the dispense record) stays on the **order**. A work item is a _pointer with a priority_, not a chart.

### It is a PLATFORM module

The engine contains **no clinical vocabulary** (PLATFORM_STRATEGY Rule P1). It routes _work items_ to _targets_ by _priority_ — nothing in it knows what a patient is.

That makes it inheritable: School ERP gets admission-approval queues and fee-escalation queues from the same engine, unchanged. The clinical meaning lives in the modules that own the events (`order.consumers.ts`, `encounter.consumers.ts`), exactly as the HMS meaning of a notification lives outside the notifications module.

## Consequences

- **Tokens leave the Appointments module.** A token is a queue concern (`workItems` / encounter), not a scheduling concern. A walk-in gets a token without anything called an appointment existing.
- One Queue Board serves the whole hospital, filtered by permission and row scope.
- Priority is uniform, so `stat` means the same thing at the lab bench as it does at the doctor's door.
- **Accepted cost:** ~2 s of eventual consistency between the domain write and the queue row, and one rebuild job to own. Both are cheap; a dual write is not.

## Alternatives considered

**A queue table per department.** Rejected: six implementations, six priority schemes, no hospital-wide view, and every new department re-litigates it.

**An authoritative `workItems` table written in the same transaction as the domain object.** Tempting — it removes the lag — but it makes every domain module import the queue module and write to it, which couples the entire clinical estate to one collection and re-creates the dual-write problem the moment a queue lives in another service. Rejected.

**BullMQ as the work queue.** Rejected, and worth stating because the name misleads: BullMQ is for _machine_ work (send an email, generate a report) — jobs that are invisible, retried and discarded. A hospital work queue is _human_ work: it must be visible, sortable, claimable, re-assignable, auditable, and it must survive a Redis flush. It belongs in MongoDB. BullMQ moves the _events_ that build the projection; it does not hold the worklist.
