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
  {
    id: "0005-identity-auth",
    description:
      "Identity & auth (ADR-0009/0010): users, credentials, roles, sessions, refresh tokens, MFA",
    up: async (db) => {
      for (const name of [
        "users",
        "credentials",
        "passwordHistory",
        "roles",
        "userRoles",
        "sessions",
        "refreshTokens",
        "mfaSecrets",
        "loginAttempts",
      ]) {
        await db.createCollection(name).catch(() => undefined);
      }

      // Email is the login identifier — uniqueness is enforced by the database,
      // not by a read-then-write race in the service (Doc 03 §4).
      await db
        .collection("users")
        .createIndex({ tenantId: 1, email: 1 }, { unique: true, background: true });

      await db
        .collection("credentials")
        .createIndex({ tenantId: 1, userId: 1 }, { unique: true, background: true });
      await db
        .collection("passwordHistory")
        .createIndex({ tenantId: 1, userId: 1, createdAt: -1 }, { background: true });

      await db
        .collection("roles")
        .createIndex({ tenantId: 1, code: 1 }, { unique: true, background: true });
      await db
        .collection("userRoles")
        .createIndex({ tenantId: 1, userId: 1, roleId: 1 }, { unique: true, background: true });

      // Refresh lookups are by digest and must be a single indexed hit.
      await db
        .collection("refreshTokens")
        .createIndex({ tenantId: 1, tokenHash: 1 }, { unique: true, background: true });
      // Reuse detection revokes a whole family at once.
      await db
        .collection("refreshTokens")
        .createIndex({ tenantId: 1, family: 1 }, { background: true });
      await db.collection("sessions").createIndex({ tenantId: 1, userId: 1 }, { background: true });
      await db
        .collection("sessions")
        .createIndex({ tenantId: 1, family: 1 }, { unique: true, background: true });

      await db
        .collection("mfaSecrets")
        .createIndex({ tenantId: 1, userId: 1 }, { unique: true, background: true });

      // Lockout counts recent failures for an email.
      await db
        .collection("loginAttempts")
        .createIndex({ tenantId: 1, email: 1, at: -1 }, { background: true });

      // TTL: expired sessions, spent refresh tokens and the attempt ledger are
      // reaped by Mongo. Without this, `refreshTokens` grows without bound —
      // every rotation writes a row (DATA_RETENTION_POLICY).
      for (const name of ["sessions", "refreshTokens", "loginAttempts"]) {
        await db
          .collection(name)
          .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, background: true });
      }
    },
    down: async (db) => {
      for (const name of [
        "users",
        "credentials",
        "passwordHistory",
        "roles",
        "userRoles",
        "sessions",
        "refreshTokens",
        "mfaSecrets",
        "loginAttempts",
      ]) {
        await db
          .collection(name)
          .drop()
          .catch(() => undefined);
      }
    },
  },
  {
    id: "0006-rbac-permissions",
    description: "Permission catalog + role grants (ADR-0010) — layer 2 of authorization",
    up: async (db) => {
      for (const name of ["permissions", "rolePermissions"]) {
        await db.createCollection(name).catch(() => undefined);
      }

      await db
        .collection("permissions")
        .createIndex({ tenantId: 1, code: 1 }, { unique: true, background: true });

      // One grant per (role, permission) — the unique index is what makes
      // re-seeding idempotent instead of duplicating every grant on each deploy.
      await db
        .collection("rolePermissions")
        .createIndex(
          { tenantId: 1, roleId: 1, permissionId: 1 },
          { unique: true, background: true },
        );

      // The hot authorization query: role ids → permission codes.
      await db
        .collection("rolePermissions")
        .createIndex({ tenantId: 1, roleId: 1, permissionCode: 1 }, { background: true });
    },
    down: async (db) => {
      for (const name of ["permissions", "rolePermissions"]) {
        await db
          .collection(name)
          .drop()
          .catch(() => undefined);
      }
    },
  },
  {
    id: "0007-audit-chain-outbox",
    description:
      "Audit sequencing + hash-chain anchors (Doc 09 §9) and the outbox relay index (ADR-0007)",
    up: async (db) => {
      for (const name of ["auditAnchors", "counters"]) {
        await db.createCollection(name).catch(() => undefined);
      }

      /**
       * The gap-free sequence is what makes a DELETED audit entry visible: without
       * a unique index there is nothing to stop a second entry claiming a hole's
       * number, and a re-used seq is indistinguishable from an honest one.
       */
      await db
        .collection("auditLogs")
        .createIndex({ tenantId: 1, seq: 1 }, { unique: true, background: true });

      // The compliance officer's actual query: "what happened, newest first",
      // filtered by category (PHI vs money vs security).
      await db.collection("auditLogs").createIndex({ tenantId: 1, at: -1 }, { background: true });
      await db
        .collection("auditLogs")
        .createIndex({ tenantId: 1, category: 1, at: -1 }, { background: true });

      await db
        .collection("auditAnchors")
        .createIndex({ tenantId: 1, index: 1 }, { unique: true, background: true });

      /**
       * The relay's claim query: due, unsent, oldest first. Without this index the
       * relay scans the whole outbox on every poll — including the `sent` rows,
       * which is every event the hospital has ever published.
       */
      await db
        .collection("outboxEvents")
        .createIndex({ tenantId: 1, status: 1, availableAt: 1 }, { background: true });

      // Consumers dedupe on eventId; so does BullMQ's jobId. A duplicate here
      // would mean two different events claiming the same identity.
      await db
        .collection("outboxEvents")
        .createIndex({ eventId: 1 }, { unique: true, background: true });
    },
    down: async (db) => {
      for (const name of ["auditAnchors", "counters"]) {
        await db
          .collection(name)
          .drop()
          .catch(() => undefined);
      }
      // `auditLogs` is NOT dropped here. Migration 0003 created it and a `down`
      // that deletes the audit trail is a compliance incident wearing a rollback
      // costume — the indexes go, the evidence stays.
      for (const index of ["tenantId_1_seq_1", "tenantId_1_at_-1", "tenantId_1_category_1_at_-1"]) {
        await db
          .collection("auditLogs")
          .dropIndex(index)
          .catch(() => undefined);
      }
    },
  },
  {
    id: "0008-patients",
    description: "Patient master + MPI (Doc 02 C1) — the first PHI collection",
    up: async (db) => {
      await db.createCollection("patients").catch(() => undefined);

      /**
       * The UHID is the hospital's promise that this number means this person, and
       * only the database can keep that promise. A service-level "check then
       * insert" loses the race between two clerks registering at the same instant
       * — and two patients sharing a UHID is not a bug you can fix afterwards,
       * because you can no longer tell which records belonged to whom.
       */
      await db
        .collection("patients")
        .createIndex({ tenantId: 1, uhid: 1 }, { unique: true, background: true });

      // The MPI's `$or`: each arm needs its own index or the duplicate check
      // degrades into a collection scan — run on every registration, at a desk,
      // with a patient standing there.
      await db
        .collection("patients")
        .createIndex({ tenantId: 1, nameKey: 1 }, { background: true });
      await db
        .collection("patients")
        .createIndex({ tenantId: 1, "contact.phone": 1 }, { background: true });
      await db.collection("patients").createIndex({ tenantId: 1, dob: 1 }, { background: true });

      // The patient list: active first, newest first, branch-scoped.
      await db
        .collection("patients")
        .createIndex({ tenantId: 1, status: 1, createdAt: -1 }, { background: true });
      await db
        .collection("patients")
        .createIndex({ tenantId: 1, branchId: 1, status: 1 }, { background: true });
    },
    down: async (db) => {
      /**
       * This drops a collection of PATIENT RECORDS. It exists because Doc 09 §14
       * requires every migration to have a `down`, and it is honest about what it
       * does — but rolling this back on a live hospital destroys clinical data
       * that is under a statutory retention period (DATA_RETENTION_POLICY). The
       * real rollback for a bad patients release is a code revert, not this.
       */
      await db
        .collection("patients")
        .drop()
        .catch(() => undefined);
    },
  },
  {
    id: "0009-role-branch-scope",
    description:
      "Explicit branch scope on role bindings (ADR-0010) — an empty list stops meaning two things",
    up: async (db) => {
      /**
       * Backfills `branchScope` on every existing binding, from what its branch
       * list already implied:
       *
       *   branchIds empty     → "all"       nobody has been confined to a branch,
       *                                     because branches are not a feature yet
       *                                     (B1–B3). This is every user today.
       *   branchIds non-empty → "branches"  confined to exactly those.
       *
       * This preserves today's behaviour EXACTLY and grants nobody anything they
       * did not already have. Before P2 there was no `branch`-scoped resource, so
       * every user effectively reached their whole hospital; this writes that fact
       * down so `scopeFilter` no longer has to infer it from an empty array.
       *
       * Ordered AFTER 0008 because that is the migration that made the ambiguity
       * reachable — `patients` is the first branch-scoped collection.
       */
      await db.collection("userRoles").updateMany(
        {
          branchScope: { $exists: false },
          $or: [{ branchIds: { $size: 0 } }, { branchIds: { $exists: false } }],
        },
        { $set: { branchScope: "all" } },
      );

      await db
        .collection("userRoles")
        .updateMany({ branchScope: { $exists: false } }, { $set: { branchScope: "branches" } });
    },
    down: async (db) => {
      await db.collection("userRoles").updateMany({}, { $unset: { branchScope: "" } });
    },
  },
];
