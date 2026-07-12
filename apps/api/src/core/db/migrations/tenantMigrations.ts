/**
 * The tenant-database migration set. Every tenant DB converges to this.
 *
 * Rules (Doc 09 §14): ids are monotonic and never renumbered; every migration has
 * an `up` and a `down`; index builds are background so they never block a live
 * hospital.
 *
 * Phase 1A ships only the platform-level collections that exist today. Business
 * collections (patients, appointments, …) are added by their own modules in
 * later phases — each as a NEW migration, never by editing an applied one.
 */
import type { Migration } from "./runner.js";

export const tenantMigrations: Migration[] = [
  {
    id: "0001-counters",
    description: "Business numbering sequences (Doc 03 §5.1) — UHIDs, invoice numbers, tokens",
    up: async (db) => {
      await db.createCollection("counters").catch(() => undefined);
    },
    down: async (db) => {
      await db
        .collection("counters")
        .drop()
        .catch(() => undefined);
    },
  },
  {
    id: "0002-outbox-events",
    description: "Transactional outbox (Doc 03 §5.2) — the single event-publishing seam",
    up: async (db) => {
      await db.createCollection("outboxEvents").catch(() => undefined);
      await db
        .collection("outboxEvents")
        .createIndex({ tenantId: 1, status: 1, createdAt: 1 }, { background: true });
    },
    down: async (db) => {
      await db
        .collection("outboxEvents")
        .drop()
        .catch(() => undefined);
    },
  },
  {
    id: "0003-audit-logs",
    description: "Append-only audit trail (Doc 09 §9) — every PHI/financial mutation",
    up: async (db) => {
      await db.createCollection("auditLogs").catch(() => undefined);
      await db
        .collection("auditLogs")
        .createIndex({ tenantId: 1, resource: 1, resourceId: 1, at: -1 }, { background: true });
      await db
        .collection("auditLogs")
        .createIndex({ tenantId: 1, actorId: 1, at: -1 }, { background: true });
    },
    down: async (db) => {
      await db
        .collection("auditLogs")
        .drop()
        .catch(() => undefined);
    },
  },
  {
    id: "0004-idempotency-keys",
    description: "Idempotency keys with TTL (Doc 03 §5.2) — money-moving POSTs",
    up: async (db) => {
      await db.createCollection("idempotencyKeys").catch(() => undefined);
      await db
        .collection("idempotencyKeys")
        .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, background: true });
    },
    down: async (db) => {
      await db
        .collection("idempotencyKeys")
        .drop()
        .catch(() => undefined);
    },
  },
];
