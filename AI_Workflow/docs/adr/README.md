# Architecture Decision Records

Every major architectural decision gets an ADR **before or with** the change (Constitution §6, Guidelines §4). ADRs are immutable once Accepted — supersede, don't edit.

**Format:** `NNNN-title.md` → Status (Proposed/Accepted/Superseded-by-NNNN) · Date · Context · Decision · Consequences · Alternatives considered.

| #    | Title                                                                                          | Status             |
| ---- | ---------------------------------------------------------------------------------------------- | ------------------ |
| 0001 | [MongoDB as primary datastore](0001-mongodb.md)                                                | Accepted           |
| 0002 | [Express modular monolith](0002-express-modular-monolith.md)                                   | Accepted           |
| 0003 | [React 19 + Vite SPA (not Next.js)](0003-react-vite-spa.md)                                    | Superseded by 0012 |
| 0004 | [Tailwind CSS + Shadcn UI](0004-tailwind-shadcn.md)                                            | Accepted           |
| 0005 | [Master DB + dedicated database per tenant](0005-database-per-tenant.md)                       | Accepted           |
| 0006 | [Redis for cache, sessions, queues, pub/sub](0006-redis.md)                                    | Accepted           |
| 0007 | [BullMQ for background jobs](0007-bullmq.md)                                                   | Accepted           |
| 0008 | [Socket.IO for realtime](0008-socketio.md)                                                     | Accepted           |
| 0009 | [JWT access + rotating refresh authentication](0009-authentication.md)                         | Accepted           |
| 0010 | [RBAC + fine-grained permissions authorization](0010-authorization.md)                         | Accepted           |
| 0011 | [Configuration-first extensibility (no code plugins v1)](0011-extensibility.md)                | Accepted           |
| 0012 | [Next.js (App Router) + React 19 for all web frontends](0012-nextjs-app-router.md)             | Accepted           |
| 0013 | [Encounter is the central clinical object (not Appointment)](0013-encounter-central-object.md) | Accepted           |
| 0014 | [One work-queue engine, as a projection](0014-universal-work-queue.md)                         | Accepted           |

New ADR: copy the format, take the next number, add a row here, note it in `PROJECT_MEMORY.md`.
