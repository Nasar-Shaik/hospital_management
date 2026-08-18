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
  {
    id: "0010-appointments",
    description: "Appointment book + doctor schedules (Doc 02 E1/D2)",
    up: async (db) => {
      for (const name of ["appointments", "doctorSchedules"]) {
        await db.createCollection(name).catch(() => undefined);
      }

      /**
       * ── THE DOUBLE-BOOKING INVARIANT ────────────────────────────────────────
       * This index IS the rule "a doctor cannot be in two places at once". It is
       * not a performance index that happens to be unique — it is the only thing
       * that actually prevents the race, and no service-level check can replace it:
       * two receptionists both read "10:30 is free" and both write, and only the
       * database can arbitrate between them.
       *
       * PARTIAL, on `occupies`, because a cancelled appointment must RELEASE its
       * slot while a booked one holds it. `partialFilterExpression` cannot express
       * `status: {$in: [...]}`, which is why the occupying states are collapsed
       * into that one boolean (appointment.model.ts).
       *
       * If you ever find yourself dropping this to fix a bug, the bug is elsewhere.
       */
      await db.collection("appointments").createIndex(
        { tenantId: 1, doctorId: 1, startAt: 1 },
        {
          unique: true,
          partialFilterExpression: { occupies: { $eq: true } },
          background: true,
          name: "one_doctor_one_slot",
        },
      );

      // The two screens that exist: a doctor's day, and a patient's history.
      await db
        .collection("appointments")
        .createIndex({ tenantId: 1, doctorId: 1, startAt: 1, status: 1 }, { background: true });
      await db
        .collection("appointments")
        .createIndex({ tenantId: 1, patientId: 1, startAt: -1 }, { background: true });
      await db
        .collection("appointments")
        .createIndex({ tenantId: 1, branchId: 1, startAt: 1 }, { background: true });

      // One active template per doctor per weekday — the upsert key. Widened to include
      // `branchId` by migration 0046: a doctor may hold a Monday clinic at more than one site.
      await db
        .collection("doctorSchedules")
        .createIndex({ tenantId: 1, doctorId: 1, weekday: 1 }, { unique: true, background: true });
    },
    down: async (db) => {
      for (const name of ["appointments", "doctorSchedules"]) {
        await db
          .collection(name)
          .drop()
          .catch(() => undefined);
      }
    },
  },

  {
    id: "0011-notifications",
    description: "Notification ledger + template catalog (Doc 02 A6)",
    up: async (db) => {
      for (const name of ["notifications", "notificationTemplates"]) {
        await db.createCollection(name).catch(() => undefined);
      }

      /**
       * ── THE IDEMPOTENCY INVARIANT ───────────────────────────────────────────
       * This index IS the rule "one message per cause". It is not a lookup index
       * that happens to be unique — it is the only thing that actually stops a
       * patient receiving two confirmations for one booking.
       *
       * Delivery is at-least-once by design (ADR-0007): the relay redelivers rather
       * than risk losing an event, so the consumer WILL see `appointment.booked`
       * twice. No service-level "have we already sent this?" check can arbitrate
       * that — two handlers on two pods both read "no" and both send. Only the
       * database can decide, and this is where it does.
       *
       * The caller supplies `dedupeKey` from the message's CAUSE
       * (`appointment.confirmation:{id}`), never from its content — so a redelivery,
       * a DLQ replay, or a restore all collide here and lose.
       */
      await db
        .collection("notifications")
        .createIndex(
          { tenantId: 1, dedupeKey: 1 },
          { unique: true, background: true, name: "one_message_per_cause" },
        );

      // "Did they get it?" — the ledger's reason to exist, asked at a front desk
      // with a patient on the phone. Newest first, per recipient.
      await db
        .collection("notifications")
        .createIndex({ tenantId: 1, recipientId: 1, createdAt: -1 }, { background: true });

      // The operator's view: what is stuck, what bounced, what never had an address.
      await db
        .collection("notifications")
        .createIndex({ tenantId: 1, status: 1, createdAt: -1 }, { background: true });

      // The key the code renders by — and the upsert key the seed writes through.
      await db
        .collection("notificationTemplates")
        .createIndex({ tenantId: 1, key: 1 }, { unique: true, background: true });
    },
    down: async (db) => {
      for (const name of ["notifications", "notificationTemplates"]) {
        await db
          .collection(name)
          .drop()
          .catch(() => undefined);
      }
    },
  },

  {
    id: "0012-encounters",
    description: "Encounter + Episode of Care — the central clinical object (ADR-0013)",
    up: async (db) => {
      for (const name of ["encounters", "episodesOfCare"]) {
        await db.createCollection(name).catch(() => undefined);
      }

      /**
       * ── THE ONE-OPEN-ENCOUNTER INVARIANT ────────────────────────────────────
       * This index IS the rule "a patient cannot be in the building twice at once".
       *
       * It exists to make the commonest data-quality disaster in an OPD physically
       * impossible: a patient goes to the lab, comes back, and a clerk who cannot
       * see that their visit is still open registers them AGAIN. One visit becomes
       * two — the census double-counts them, the bill splits across two records
       * that no longer reconcile, and the doctor's history has a hole in it.
       *
       * No service-level check can prevent it: two desks both read "no open
       * encounter" and both write. Only the database can arbitrate, and this is
       * where it does. The service catches the duplicate-key error and hands the
       * clerk back the encounter that already exists — which is what they actually
       * wanted, because the patient is already here.
       *
       * PARTIAL, on `open`, because a patient must be able to come back TOMORROW.
       * `partialFilterExpression` cannot express `status: {$in: [...]}`, which is
       * why the live states collapse into that one boolean (encounter.model.ts) —
       * exactly as `appointments.occupies` does for the double-booking index.
       */
      await db.collection("encounters").createIndex(
        { tenantId: 1, patientId: 1 },
        {
          unique: true,
          partialFilterExpression: { open: { $eq: true } },
          background: true,
          name: "one_open_encounter_per_patient",
        },
      );

      // The queue board: who is waiting, in token order, for this doctor/department.
      await db
        .collection("encounters")
        .createIndex({ tenantId: 1, doctorId: 1, status: 1, token: 1 }, { background: true });
      await db
        .collection("encounters")
        .createIndex({ tenantId: 1, departmentId: 1, status: 1, token: 1 }, { background: true });

      // The patient's history, newest first.
      await db
        .collection("encounters")
        .createIndex({ tenantId: 1, patientId: 1, arrivedAt: -1 }, { background: true });

      // The care story: every encounter in one episode (ADR-0013 §4). This is the
      // read that makes an admission inherit the OP consultation that preceded it.
      await db
        .collection("encounters")
        .createIndex({ tenantId: 1, episodeId: 1, arrivedAt: 1 }, { background: true });

      await db
        .collection("episodesOfCare")
        .createIndex({ tenantId: 1, patientId: 1, startedAt: -1 }, { background: true });
    },
    down: async (db) => {
      for (const name of ["encounters", "episodesOfCare"]) {
        await db
          .collection(name)
          .drop()
          .catch(() => undefined);
      }
    },
  },
  {
    id: "0013-orders",
    description: "Orders — the spine that carries work between departments (ADR-0013 §3)",
    up: async (db) => {
      await db.createCollection("orders").catch(() => undefined);

      /**
       * ── THE DEPARTMENT WORKLIST INDEX ───────────────────────────────────────
       * This index IS the lab's worklist, and the radiology worklist, and the
       * pharmacy's. "Doctor orders appear automatically in the destination
       * department" is not a hand-off somebody has to build — it is this query
       * being fast.
       *
       * `priorityRank` before `orderedAt` is deliberate and it is clinical: sickest
       * first, then oldest. A worklist sorted purely by arrival time is a worklist
       * in which the emergency troponin waits behind the routine cholesterol.
       */
      await db
        .collection("orders")
        .createIndex(
          { tenantId: 1, category: 1, status: 1, priorityRank: 1, orderedAt: 1 },
          { background: true, name: "department_worklist" },
        );

      /**
       * ── THE IDEMPOTENCY INDEX ───────────────────────────────────────────────
       * A doctor double-clicking "Order CBC" must not draw two tubes of blood from a
       * real arm and raise two bills for it. Nor must a client retrying after a
       * timeout — and that is the case a disabled button cannot save you from,
       * because the first request may well have succeeded before the connection
       * dropped.
       *
       * PARTIAL, because `requestId` is optional: a `curl` without one still works,
       * and without the partial filter every such order would collide on `null`.
       */
      await db.collection("orders").createIndex(
        { tenantId: 1, requestId: 1 },
        {
          unique: true,
          partialFilterExpression: { requestId: { $exists: true } },
          background: true,
          name: "one_order_per_request_id",
        },
      );

      // "Is anything still owed on this visit?" — the question that decides whether a
      // patient parked in `awaiting_results` can be called back in to the doctor.
      await db
        .collection("orders")
        .createIndex({ tenantId: 1, encounterId: 1, status: 1 }, { background: true });

      // The patient's investigations, newest first — and the episode read that makes
      // an admission inherit the OP consultation's tests (ADR-0013 §4).
      await db
        .collection("orders")
        .createIndex({ tenantId: 1, patientId: 1, orderedAt: -1 }, { background: true });
      await db
        .collection("orders")
        .createIndex({ tenantId: 1, episodeId: 1, orderedAt: 1 }, { background: true });

      // "What have I ordered, and what has come back?" — the doctor's own list.
      await db
        .collection("orders")
        .createIndex({ tenantId: 1, orderedBy: 1, status: 1, orderedAt: -1 }, { background: true });
    },
    down: async (db) => {
      await db
        .collection("orders")
        .drop()
        .catch(() => undefined);
    },
  },
  {
    id: "0014-billing",
    description: "Tariff, charge ledger and invoices (Doc 02 F-group)",
    up: async (db) => {
      for (const name of ["serviceItems", "charges", "invoices"]) {
        await db.createCollection(name).catch(() => undefined);
      }

      // One tariff entry per code. A price list with two `CBC` rows silently charges
      // whichever one the query happened to reach first.
      await db
        .collection("serviceItems")
        .createIndex({ tenantId: 1, code: 1 }, { unique: true, background: true });
      await db
        .collection("serviceItems")
        .createIndex({ tenantId: 1, category: 1, name: 1 }, { background: true });

      /**
       * ── THE DOUBLE-BILLING INVARIANT ────────────────────────────────────────
       * The outbox is at-least-once BY DESIGN, so the consumer that charges for a lab
       * order WILL run twice. Without this index the patient pays for two blood tests
       * and only had one — and they find out at the counter, in front of a queue.
       *
       * PARTIAL, because a manual charge has no `sourceId` and a cashier must be able
       * to post two identical items (two dressings, same visit) on purpose.
       */
      await db.collection("charges").createIndex(
        { tenantId: 1, sourceId: 1, code: 1 },
        {
          unique: true,
          partialFilterExpression: { sourceId: { $exists: true } },
          background: true,
          name: "one_charge_per_cause",
        },
      );

      // The bill: every charge on this visit, oldest first.
      await db
        .collection("charges")
        .createIndex({ tenantId: 1, encounterId: 1, postedAt: 1 }, { background: true });
      await db
        .collection("charges")
        .createIndex({ tenantId: 1, patientId: 1, postedAt: -1 }, { background: true });

      // One live invoice per visit.
      await db
        .collection("invoices")
        .createIndex({ tenantId: 1, encounterId: 1 }, { background: true });
      // The invoice number is a statutory identifier: two bills numbered INV-2026-0042
      // is a tax problem, not a display bug.
      await db.collection("invoices").createIndex(
        { tenantId: 1, number: 1 },
        {
          unique: true,
          partialFilterExpression: { number: { $exists: true } },
          background: true,
          name: "one_invoice_per_number",
        },
      );
      await db
        .collection("invoices")
        .createIndex({ tenantId: 1, status: 1, createdAt: -1 }, { background: true });
    },
    down: async (db) => {
      for (const name of ["serviceItems", "charges", "invoices"]) {
        await db
          .collection(name)
          .drop()
          .catch(() => undefined);
      }
    },
  },

  {
    id: "0015-prescriptions",
    description: "Prescriptions + dispensing — what the doctor ordered and what was handed over",
    up: async (db) => {
      /**
       * The chart's view: every prescription on this visit, newest first. This is what the
       * doctor's Rx pad and the pharmacist's screen both read.
       */
      await db
        .collection("prescriptions")
        .createIndex({ tenantId: 1, encounterId: 1, prescribedAt: -1 }, { background: true });

      // The patient's medication history across every visit (ADR-0013 §4: the episode's
      // timeline is a read model, and this is one of the queries behind it).
      await db
        .collection("prescriptions")
        .createIndex({ tenantId: 1, patientId: 1, prescribedAt: -1 }, { background: true });

      // Resolving the pharmacy worklist entry back to the drugs it carries. One
      // prescription raises at most one `pharmacy` order (`requestId: rx:<id>`), so this
      // is a lookup, not a scan.
      await db
        .collection("prescriptions")
        .createIndex(
          { tenantId: 1, orderId: 1 },
          { background: true, partialFilterExpression: { orderId: { $exists: true } } },
        );

      /**
       * ── THE DOUBLE-HANDOVER INVARIANT ───────────────────────────────────────
       * A pharmacist double-clicking "Dispense", or a client retrying after a timeout on a
       * request that had already succeeded, must not hand over — and bill for — a second
       * lot of the same drugs. With a controlled substance that is not a billing error, it
       * is a diversion, and the ledger would show it never happened.
       *
       * PARTIAL, because `requestId` is optional: a handover recorded by an internal
       * caller with no client to generate a key is still a legitimate handover, and a
       * plain unique index would collapse every one of those onto a single null.
       */
      await db.collection("dispenses").createIndex(
        { tenantId: 1, requestId: 1 },
        {
          unique: true,
          partialFilterExpression: { requestId: { $exists: true } },
          background: true,
          name: "one_dispense_per_request_id",
        },
      );

      // The handover ledger for one prescription, oldest first — "who gave what, when".
      // The `dispensedQty` on each line is a SUM of these rows, and this index is what
      // makes that sum re-derivable rather than merely asserted.
      await db
        .collection("dispenses")
        .createIndex({ tenantId: 1, prescriptionId: 1, dispensedAt: 1 }, { background: true });

      // What this patient has actually been given, across visits. The question a
      // pharmacist asks when somebody says they lost their tablets.
      await db
        .collection("dispenses")
        .createIndex({ tenantId: 1, patientId: 1, dispensedAt: -1 }, { background: true });
    },
    down: async (db) => {
      for (const name of ["prescriptions", "dispenses"]) {
        await db
          .collection(name)
          .drop()
          .catch(() => undefined);
      }
    },
  },

  {
    id: "0016-admissions",
    description: "Ward notes + the discharge summary — the record of an inpatient stay",
    up: async (db) => {
      /**
       * The ward round: this admission's chart, oldest first.
       */
      await db
        .collection("wardNotes")
        .createIndex({ tenantId: 1, encounterId: 1, at: 1 }, { background: true });

      /**
       * ── ONE ADMISSION, ONE DISCHARGE SUMMARY ────────────────────────────────
       * Two summaries for one stay means the patient goes home holding one document while
       * the hospital's record says another, and nothing anywhere says which is current.
       * The next doctor reads whichever they happen to find.
       *
       * PARTIAL on the type, because there are MANY progress notes per admission and that
       * is the entire point of them.
       */
      await db.collection("wardNotes").createIndex(
        { tenantId: 1, encounterId: 1, type: 1 },
        {
          unique: true,
          partialFilterExpression: { type: "discharge_summary" },
          background: true,
          name: "one_discharge_summary_per_admission",
        },
      );

      // The patient's notes across every stay — the question asked when somebody is
      // readmitted and nobody can remember what happened last time.
      await db
        .collection("wardNotes")
        .createIndex({ tenantId: 1, patientId: 1, at: -1 }, { background: true });

      /**
       * The ward round's list: everyone in a bed, in the order a doctor walks.
       *
       * PARTIAL on `open`, matching `one_open_encounter_per_patient` — a discharged
       * encounter carries no `open` key at all, so it drops out of this index entirely
       * rather than sitting in it forever making the ward list slower every year.
       */
      await db.collection("encounters").createIndex(
        { tenantId: 1, "bed.ward": 1, "bed.bedCode": 1 },
        {
          partialFilterExpression: { open: { $eq: true } },
          background: true,
          name: "ward_round",
        },
      );
    },
    down: async (db) => {
      await db
        .collection("wardNotes")
        .drop()
        .catch(() => undefined);
      await db
        .collection("encounters")
        .dropIndex("ward_round")
        .catch(() => undefined);
    },
  },
  {
    id: "0017-allergies",
    description: "The allergy list — what the prescribing safety check screens against",
    up: async (db) => {
      /**
       * A patient's allergies, most recent first — the read behind both the management
       * screen and the prescribing check. Keyed on the patient and NOT the branch, because
       * an allergy follows the person across every branch of the hospital (allergy.model.ts).
       */
      await db
        .collection("allergies")
        .createIndex({ tenantId: 1, patientId: 1, notedAt: -1 }, { background: true });

      /**
       * ── ONE ACTIVE ROW PER ALLERGEN, PER PATIENT ────────────────────────────
       * Two "active penicillin allergy" rows are not more information; they are one fact
       * entered twice, and they would make the prescribing alert fire in duplicate and clutter
       * the list a clinician has to read in a hurry.
       *
       * PARTIAL on `status: "active"`, so a REFUTED penicillin allergy does not block a later,
       * correctly re-recorded active one — the patient's history can hold both "was thought
       * allergic, ruled out" and a fresh finding, which is exactly the record a real allergy
       * work-up produces.
       */
      await db.collection("allergies").createIndex(
        { tenantId: 1, patientId: 1, allergen: 1 },
        {
          unique: true,
          partialFilterExpression: { status: "active" },
          background: true,
          name: "one_active_allergy_per_allergen",
        },
      );
    },
    down: async (db) => {
      await db
        .collection("allergies")
        .drop()
        .catch(() => undefined);
    },
  },
  {
    id: "0018-report-files",
    description: "Uploaded diagnostic report files (stored in the tenant DB)",
    up: async (db) => {
      // The doctor's cross-visit report view: everything for a patient, newest visit first.
      await db
        .collection("reportFiles")
        .createIndex({ tenantId: 1, patientId: 1, visitDate: -1 }, { background: true });
      // The reports answering one order (a test can produce more than one document).
      await db
        .collection("reportFiles")
        .createIndex({ tenantId: 1, orderId: 1 }, { background: true });
    },
    down: async (db) => {
      await db
        .collection("reportFiles")
        .drop()
        .catch(() => undefined);
    },
  },
  {
    id: "0019-medicine-master",
    description: "Pharmacy medicine master and its stock-movement ledger",
    up: async (db) => {
      // One medicine per code per hospital — the code is the key a dispense matches on, so a
      // duplicate would make the decrement ambiguous. Unique per tenant.
      await db
        .collection("medicines")
        .createIndex(
          { tenantId: 1, code: 1 },
          { unique: true, name: "one_medicine_per_code", background: true },
        );
      // The master list, ordered by name (only the active ones, but the sort is the same).
      await db.collection("medicines").createIndex({ tenantId: 1, name: 1 }, { background: true });
      // The low-stock report scans stock against the reorder level.
      await db
        .collection("medicines")
        .createIndex({ tenantId: 1, stockUnits: 1 }, { background: true });

      // The movement history for one medicine, newest first.
      await db
        .collection("stockMovements")
        .createIndex({ tenantId: 1, medicineId: 1, createdAt: -1 }, { background: true });
      // IDEMPOTENCY: a dispense may move a medicine exactly once, however many times the
      // `medication.dispensed` event is redelivered. Partial — only dispense rows carry a
      // dispenseId, and receipts/adjustments must be free to repeat.
      await db.collection("stockMovements").createIndex(
        { tenantId: 1, dispenseId: 1, medicineCode: 1 },
        {
          unique: true,
          name: "one_stock_move_per_dispense_line",
          background: true,
          partialFilterExpression: { dispenseId: { $exists: true } },
        },
      );
    },
    down: async (db) => {
      await db
        .collection("medicines")
        .drop()
        .catch(() => undefined);
      await db
        .collection("stockMovements")
        .drop()
        .catch(() => undefined);
    },
  },
  {
    id: "0020-bed-occupancy",
    description: "One open inpatient stay per bed — no two patients recorded in the same bed",
    up: async (db) => {
      /**
       * A bed holds one patient at a time. Among OPEN encounters that record a bed — i.e. the
       * current inpatients — the ward + bedCode must be unique, so the database refuses the
       * double-occupancy the ward screen could not (PROJECT_MEMORY §5). Exactly the shape of
       * `one_open_encounter_per_patient`: a unique PARTIAL index on `open`, so a discharged stay
       * frees the bed the instant its `open` key is removed, and OP encounters (which carry no
       * bed) are never in scope.
       *
       * Scoped by ward AND bedCode because a bedCode is only unique within its ward — `ICU / A-12`
       * and `General / A-12` are two different beds. If this index cannot be built because two open
       * stays already share a bed, that is the very defect it exists to prevent: move one patient
       * to a free bed, then re-run.
       *
       * SUPERSEDED by migration 0046: once two branches may each own an "ICU", the site is part of
       * the bed's identity too, and this key is replaced by `one_open_stay_per_bed_per_branch`.
       */
      await db.collection("encounters").createIndex(
        { tenantId: 1, "bed.ward": 1, "bed.bedCode": 1 },
        {
          unique: true,
          partialFilterExpression: { open: { $eq: true }, "bed.bedCode": { $exists: true } },
          background: true,
          name: "one_open_stay_per_bed",
        },
      );
    },
    down: async (db) => {
      await db
        .collection("encounters")
        .dropIndex("one_open_stay_per_bed")
        .catch(() => undefined);
    },
  },
  {
    id: "0021-password-reset-tokens",
    description: "Single-use password-reset tokens (forgot-password)",
    up: async (db) => {
      // A hash resolves to exactly one token — the lookup on reset is by hash, and two rows sharing
      // one would make "which token is this?" ambiguous.
      await db
        .collection("passwordResetTokens")
        .createIndex(
          { tenantId: 1, tokenHash: 1 },
          { unique: true, name: "one_reset_token_per_hash", background: true },
        );
      // Invalidate-then-issue reads a user's outstanding tokens by id.
      await db
        .collection("passwordResetTokens")
        .createIndex({ tenantId: 1, userId: 1 }, { background: true });
      // TTL: an expired reset token is rubbish — MongoDB reaps it at its own expiry. Bearer secrets
      // must not linger in the database after they can no longer be used.
      await db
        .collection("passwordResetTokens")
        .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, background: true });
    },
    down: async (db) => {
      await db
        .collection("passwordResetTokens")
        .drop()
        .catch(() => undefined);
    },
  },
  {
    id: "0022-site-settings",
    description: "Public website content — one settings document per hospital",
    up: async (db) => {
      // A hospital has exactly ONE public site. The unique index on tenantId is what makes the
      // collection a singleton: the repository queries with no id and upserts, trusting this to
      // reject a second document rather than silently keeping two competing sites.
      await db
        .collection("siteSettings")
        .createIndex(
          { tenantId: 1 },
          { unique: true, name: "one_site_per_tenant", background: true },
        );
    },
    down: async (db) => {
      await db
        .collection("siteSettings")
        .drop()
        .catch(() => undefined);
    },
  },
  {
    id: "0023-patient-wallet",
    description: "Patient wallet — one advance-balance account per patient, plus its ledger",
    up: async (db) => {
      // ONE wallet per patient. The unique index is what makes the deposit upsert a singleton:
      // the repository upserts on `{ tenantId, patientId }` and trusts this to reject a second
      // account rather than silently keeping two competing balances (the same shape as
      // `one_site_per_tenant`). If it cannot build because two accounts already share a patient,
      // that is the very corruption it exists to prevent — fold one into the other and re-run.
      await db
        .collection("walletAccounts")
        .createIndex(
          { tenantId: 1, patientId: 1 },
          { unique: true, name: "one_wallet_per_patient", background: true },
        );
      // The statement read is "this patient's movements, newest first".
      await db
        .collection("walletEntries")
        .createIndex({ tenantId: 1, patientId: 1, at: -1 }, { background: true });
    },
    down: async (db) => {
      await db
        .collection("walletAccounts")
        .drop()
        .catch(() => undefined);
      await db
        .collection("walletEntries")
        .drop()
        .catch(() => undefined);
    },
  },
  {
    id: "0024-consultation-follow-up",
    description: "Index the free-follow-up lookup: this patient's paid consultations with a doctor",
    up: async (db) => {
      /**
       * Every OP registration now asks "has this patient already paid to see this doctor inside
       * the tariff's validity window?" — so that question is on the hot path of the busiest action
       * in the hospital and must not be a collection scan. The key order matches the query's shape
       * (equality on patient + doctor + category, then a range on the date, sorted newest first).
       *
       * Partial on `doctorId` because only consultation charges carry one: the index then covers
       * a small slice of `charges` rather than every bed-night and drug ever billed.
       */
      await db.collection("charges").createIndex(
        { tenantId: 1, patientId: 1, doctorId: 1, category: 1, postedAt: -1 },
        {
          name: "consultation_follow_up_lookup",
          partialFilterExpression: { doctorId: { $exists: true } },
          background: true,
        },
      );
    },
    down: async (db) => {
      await db
        .collection("charges")
        .dropIndex("consultation_follow_up_lookup")
        .catch(() => undefined);
    },
  },
  {
    id: "0025-vitals",
    description: "Vitals chart — observations per visit, and a patient's trend across visits",
    up: async (db) => {
      // "The chart for this visit", oldest first. The sort is ascending in the repository, but
      // an index serves either direction, so one index covers both reads.
      await db
        .collection("vitals")
        .createIndex({ tenantId: 1, encounterId: 1, recordedAt: 1 }, { background: true });
      // "This person's trend", newest first, across every visit and branch.
      await db
        .collection("vitals")
        .createIndex({ tenantId: 1, patientId: 1, recordedAt: -1 }, { background: true });
    },
    down: async (db) => {
      await db
        .collection("vitals")
        .drop()
        .catch(() => undefined);
    },
  },
  {
    id: "0026-branches",
    description:
      "Branches — a tenant's physical sites (ADR-0015). The Main Branch is SEEDED, not " +
      "created here, because a migration has no tenant context; this owns only the collection " +
      "and its indexes.",
    up: async (db) => {
      await db.createCollection("branches").catch(() => undefined);
      // Branch codes are the human key on a report and must be unique within a hospital.
      await db
        .collection("branches")
        .createIndex(
          { tenantId: 1, code: 1 },
          { unique: true, name: "one_code_per_tenant", background: true },
        );
      // The switcher and the "which is home?" lookup both read by tenant + main flag.
      await db.collection("branches").createIndex({ tenantId: 1, isMain: 1 }, { background: true });
    },
    down: async (db) => {
      await db
        .collection("branches")
        .drop()
        .catch(() => undefined);
    },
  },
  {
    id: "0027-bed-inventory",
    description:
      "Bed inventory (B4) — the catalogue of wards and beds, so admission becomes 'pick a free " +
      "bed'. Occupancy is NOT stored here; it stays on the encounter. This owns only the two " +
      "collections and their indexes.",
    up: async (db) => {
      await db.createCollection("wards").catch(() => undefined);
      await db.createCollection("beds").catch(() => undefined);

      /**
       * A ward name is unique per tenant. SUPERSEDED by migration 0046, which widens this to
       * `{tenantId, branchId, name}` so two sites can each have an ICU — left as written because
       * a migration records what it did on the day, and 0046 is the one that undoes it.
       * If this cannot build because two wards already share a name, fold one into the other.
       */
      await db
        .collection("wards")
        .createIndex(
          { tenantId: 1, name: 1 },
          { unique: true, name: "one_ward_name_per_tenant", background: true },
        );

      /** A bed code is unique WITHIN its ward — `ICU / A-12` and `General / A-12` are two beds. */
      await db
        .collection("beds")
        .createIndex(
          { tenantId: 1, wardId: 1, code: 1 },
          { unique: true, name: "one_bed_code_per_ward", background: true },
        );
      // The board and the admit picker list a ward's beds — read by tenant + ward.
      await db.collection("beds").createIndex({ tenantId: 1, wardId: 1 }, { background: true });
    },
    down: async (db) => {
      await db
        .collection("wards")
        .drop()
        .catch(() => undefined);
      await db
        .collection("beds")
        .drop()
        .catch(() => undefined);
    },
  },
  {
    id: "0028-patient-documents",
    description:
      "Patient documents (A7) — ID proofs, consents, insurance cards and referral letters, stored " +
      "as capped binary in the tenant DB. This owns only the collection and its index.",
    up: async (db) => {
      await db.createCollection("documents").catch(() => undefined);
      // The Documents tab reads "this patient's files, newest first".
      await db
        .collection("documents")
        .createIndex({ tenantId: 1, patientId: 1, uploadedAt: -1 }, { background: true });
    },
    down: async (db) => {
      await db
        .collection("documents")
        .drop()
        .catch(() => undefined);
    },
  },
  {
    id: "0029-api-keys",
    description:
      "API keys (A9) — programmatic access bound to a user. Stores only the key's digest. This " +
      "owns the collection and its indexes.",
    up: async (db) => {
      await db.createCollection("apiKeys").catch(() => undefined);
      // Every request with a key looks it up by digest; it must be unique so the lookup is exact.
      await db
        .collection("apiKeys")
        .createIndex(
          { tenantId: 1, keyHash: 1 },
          { unique: true, name: "one_key_per_hash", background: true },
        );
      // The management list reads a tenant's keys newest-first.
      await db
        .collection("apiKeys")
        .createIndex({ tenantId: 1, createdAt: -1 }, { background: true });
    },
    down: async (db) => {
      await db
        .collection("apiKeys")
        .drop()
        .catch(() => undefined);
    },
  },
  {
    id: "0030-departments",
    description:
      "Departments (B2/B3) — the tenant-wide catalogue of organisational units and their " +
      "parent/child hierarchy. This owns only the collection and its indexes.",
    up: async (db) => {
      await db.createCollection("departments").catch(() => undefined);

      /**
       * A department code is unique PER TENANT — a service line spans every site, so the code is a
       * tenant-wide human key (the same shape as `one_code_per_tenant` on `branches`). If this
       * cannot build because two departments already share a code, fold one into the other and
       * re-run.
       */
      await db
        .collection("departments")
        .createIndex(
          { tenantId: 1, code: 1 },
          { unique: true, name: "one_department_code_per_tenant", background: true },
        );
      // The children-of lookup and the tree read filter by parent.
      await db
        .collection("departments")
        .createIndex({ tenantId: 1, parentId: 1 }, { background: true });
      // The admin list sorts by name.
      await db
        .collection("departments")
        .createIndex({ tenantId: 1, name: 1 }, { background: true });
    },
    down: async (db) => {
      await db
        .collection("departments")
        .drop()
        .catch(() => undefined);
    },
  },
  {
    id: "0031-operation-theatres",
    description:
      "Operation theatres (B5) — the registry of theatres and the procedures booked on them. " +
      "ICU/ER are beds (B4), not here. This owns the two collections and their indexes.",
    up: async (db) => {
      await db.createCollection("theatres").catch(() => undefined);
      await db.createCollection("otBookings").catch(() => undefined);

      // A theatre code is unique per tenant — the human key on the board.
      await db
        .collection("theatres")
        .createIndex(
          { tenantId: 1, code: 1 },
          { unique: true, name: "one_theatre_code_per_tenant", background: true },
        );

      /**
       * ── THE DOUBLE-BOOKING RACE BACKSTOP ────────────────────────────────────
       * Overlap is enforced in the service (windows have duration; a unique key cannot express an
       * overlap). This index closes the one thing the service check races on: two IDENTICAL
       * bookings submitted at the same instant on the same theatre. Among OCCUPYING bookings the
       * `(theatre, exact start)` pair is unique, so the second writer gets a duplicate-key error
       * the service turns into the same "already booked" conflict (theatre.model.ts).
       *
       * PARTIAL on `occupies`, so a cancelled/completed booking frees the slot the instant its
       * `occupies` key is removed — exactly like `appointments.one_doctor_one_slot`.
       */
      await db.collection("otBookings").createIndex(
        { tenantId: 1, theatreId: 1, scheduledStart: 1 },
        {
          unique: true,
          partialFilterExpression: { occupies: { $eq: true } },
          background: true,
          name: "one_booking_per_theatre_start",
        },
      );

      // The board: a theatre's day, in time order. Serves the overlap query too (equality on
      // theatre, range on the window).
      await db
        .collection("otBookings")
        .createIndex(
          { tenantId: 1, theatreId: 1, scheduledStart: 1, scheduledEnd: 1 },
          { background: true },
        );
      // The patient's procedure history, newest first.
      await db
        .collection("otBookings")
        .createIndex({ tenantId: 1, patientId: 1, scheduledStart: -1 }, { background: true });
    },
    down: async (db) => {
      await db
        .collection("theatres")
        .drop()
        .catch(() => undefined);
      await db
        .collection("otBookings")
        .drop()
        .catch(() => undefined);
    },
  },
  {
    id: "0032-ambulance-fleet",
    description:
      "Ambulance fleet (B6) — the registry of vehicles and the trips dispatched on them. " +
      "Owns the two collections and their indexes; mirrors the theatre booking shape (0031).",
    up: async (db) => {
      await db.createCollection("ambulances").catch(() => undefined);
      await db.createCollection("ambulanceTrips").catch(() => undefined);

      // An ambulance code is unique per tenant — the human key on the board.
      await db
        .collection("ambulances")
        .createIndex(
          { tenantId: 1, code: 1 },
          { unique: true, name: "one_ambulance_code_per_tenant", background: true },
        );

      /**
       * ── THE DOUBLE-DISPATCH RACE BACKSTOP ───────────────────────────────────
       * Overlap is enforced in the service (windows have duration; a unique key cannot express an
       * overlap). This index closes the one thing the service check races on: two IDENTICAL trips
       * submitted at the same instant on the same vehicle. Among OCCUPYING trips the
       * `(ambulance, exact start)` pair is unique, so the second writer gets a duplicate-key error
       * the service turns into the same "already out" conflict (ambulance.model.ts).
       *
       * PARTIAL on `occupies`, so a cancelled/completed trip frees the slot the instant its
       * `occupies` key is removed — exactly like `otBookings.one_booking_per_theatre_start`.
       */
      await db.collection("ambulanceTrips").createIndex(
        { tenantId: 1, ambulanceId: 1, scheduledStart: 1 },
        {
          unique: true,
          partialFilterExpression: { occupies: { $eq: true } },
          background: true,
          name: "one_trip_per_ambulance_start",
        },
      );

      // The board: a vehicle's day, in time order. Serves the overlap query too (equality on
      // vehicle, range on the window).
      await db
        .collection("ambulanceTrips")
        .createIndex(
          { tenantId: 1, ambulanceId: 1, scheduledStart: 1, scheduledEnd: 1 },
          { background: true },
        );
      // A linked patient's transport history, newest first. Sparse: most trips near a scene have no
      // patientId, and those should not sit in this index.
      await db
        .collection("ambulanceTrips")
        .createIndex(
          { tenantId: 1, patientId: 1, scheduledStart: -1 },
          { background: true, sparse: true },
        );
    },
    down: async (db) => {
      await db
        .collection("ambulances")
        .drop()
        .catch(() => undefined);
      await db
        .collection("ambulanceTrips")
        .drop()
        .catch(() => undefined);
    },
  },
  {
    id: "0033-hospital-profile",
    description:
      "Hospital profile (B1) — the hospital's own official identity as a singleton settings " +
      "document. One unique index on tenantId enforces exactly one profile per hospital.",
    up: async (db) => {
      await db.createCollection("hospitalProfile").catch(() => undefined);
      await db
        .collection("hospitalProfile")
        .createIndex(
          { tenantId: 1 },
          { unique: true, name: "one_profile_per_tenant", background: true },
        );
    },
    down: async (db) => {
      await db
        .collection("hospitalProfile")
        .drop()
        .catch(() => undefined);
    },
  },
  {
    id: "0034-rooms",
    description:
      "Rooms (B4) — the optional commercial level between a ward and its beds (ward → room → bed). " +
      "A room carries the room-class tariff; a bed may reference one. Occupancy is NOT stored here " +
      "either. This owns only the `rooms` collection and its indexes; beds gain an optional roomId " +
      "with no schema change needed (Mongo is schemaless — the field is simply set when present).",
    up: async (db) => {
      await db.createCollection("rooms").catch(() => undefined);

      /** A room name is unique WITHIN its ward — `General / Room 4` and `ICU / Room 4` are distinct. */
      await db
        .collection("rooms")
        .createIndex(
          { tenantId: 1, wardId: 1, name: 1 },
          { unique: true, name: "one_room_name_per_ward", background: true },
        );
      // The catalogue lists a ward's rooms — read by tenant + ward.
      await db.collection("rooms").createIndex({ tenantId: 1, wardId: 1 }, { background: true });
      // The board joins beds to their room by id — read by tenant + room.
      await db.collection("beds").createIndex({ tenantId: 1, roomId: 1 }, { background: true });
    },
    down: async (db) => {
      await db
        .collection("rooms")
        .drop()
        .catch(() => undefined);
      await db
        .collection("beds")
        .dropIndex("tenantId_1_roomId_1")
        .catch(() => undefined);
    },
  },
  {
    id: "0035-doctor-management",
    description:
      "Doctor management (D2) — the simple session ROSTER (`doctorAvailability`: which sessions a " +
      "doctor holds each weekday) and LEAVE (`doctorLeave`: whole-day ranges a doctor is away). " +
      "Distinct from the slot-based `doctorSchedules`; this owns the two new collections + indexes.",
    up: async (db) => {
      await db.createCollection("doctorAvailability").catch(() => undefined);
      await db.createCollection("doctorLeave").catch(() => undefined);

      /**
       * One roster row per doctor per weekday — the sessions they are in that day. Widened to
       * include `branchId` by migration 0046, for the same reason as the slot template.
       */
      await db
        .collection("doctorAvailability")
        .createIndex(
          { tenantId: 1, doctorId: 1, weekday: 1 },
          { unique: true, name: "one_roster_row_per_doctor_weekday", background: true },
        );

      /**
       * Leave is queried by "does any range cover this day?" — `fromDate <= day <= toDate`.
       * The index leads with the range's start so the doctor's ranges are found together.
       */
      await db
        .collection("doctorLeave")
        .createIndex({ tenantId: 1, doctorId: 1, fromDate: 1 }, { background: true });
    },
    down: async (db) => {
      await db
        .collection("doctorAvailability")
        .drop()
        .catch(() => undefined);
      await db
        .collection("doctorLeave")
        .drop()
        .catch(() => undefined);
    },
  },
  {
    id: "0036-assets",
    description:
      "Asset register + maintenance (B7) — the equipment a hospital owns (`assets`) and every " +
      "service done on it (`assetMaintenance`). Estate configuration, no PHI. This owns the two " +
      "collections and their indexes.",
    up: async (db) => {
      await db.createCollection("assets").catch(() => undefined);
      await db.createCollection("assetMaintenance").catch(() => undefined);

      /** An asset tag is the human key on the register — unique per tenant. */
      await db
        .collection("assets")
        .createIndex(
          { tenantId: 1, assetTag: 1 },
          { unique: true, name: "one_asset_tag_per_tenant", background: true },
        );
      // The register filters by working state and by kind.
      await db.collection("assets").createIndex({ tenantId: 1, status: 1 }, { background: true });
      await db.collection("assets").createIndex({ tenantId: 1, category: 1 }, { background: true });
      // An asset's history is read newest-first by asset.
      await db
        .collection("assetMaintenance")
        .createIndex({ tenantId: 1, assetId: 1, performedOn: -1 }, { background: true });
    },
    down: async (db) => {
      await db
        .collection("assets")
        .drop()
        .catch(() => undefined);
      await db
        .collection("assetMaintenance")
        .drop()
        .catch(() => undefined);
    },
  },
  {
    id: "0037-feedback",
    description:
      "Feedback & complaints (B10) — one register (`feedbackTickets`) for compliments and " +
      "grievances, each moving through a small status lifecycle. This owns the collection and its " +
      "indexes.",
    up: async (db) => {
      await db.createCollection("feedbackTickets").catch(() => undefined);
      // The desk works its list by kind + status, newest first.
      await db
        .collection("feedbackTickets")
        .createIndex({ tenantId: 1, kind: 1, status: 1, createdAt: -1 }, { background: true });
      // "My assigned tickets" and per-patient history.
      await db
        .collection("feedbackTickets")
        .createIndex({ tenantId: 1, assignedTo: 1, status: 1 }, { background: true });
      await db
        .collection("feedbackTickets")
        .createIndex({ tenantId: 1, patientId: 1, createdAt: -1 }, { background: true });
    },
    down: async (db) => {
      await db
        .collection("feedbackTickets")
        .drop()
        .catch(() => undefined);
    },
  },
  {
    id: "0038-insurance",
    description:
      "Patient insurance — policies (`insurancePolicies`) and the claims filed against them " +
      "(`insuranceClaims`, each moving through a status lifecycle). This owns the two collections " +
      "and their indexes.",
    up: async (db) => {
      await db.createCollection("insurancePolicies").catch(() => undefined);
      await db.createCollection("insuranceClaims").catch(() => undefined);

      // A patient's policies are read on their profile.
      await db
        .collection("insurancePolicies")
        .createIndex({ tenantId: 1, patientId: 1, status: 1 }, { background: true });
      // A patient's claims, newest first; and the claim desk works its list by status.
      await db
        .collection("insuranceClaims")
        .createIndex({ tenantId: 1, patientId: 1, createdAt: -1 }, { background: true });
      await db
        .collection("insuranceClaims")
        .createIndex({ tenantId: 1, policyId: 1 }, { background: true });
      await db
        .collection("insuranceClaims")
        .createIndex({ tenantId: 1, status: 1, createdAt: -1 }, { background: true });
    },
    down: async (db) => {
      await db
        .collection("insurancePolicies")
        .drop()
        .catch(() => undefined);
      await db
        .collection("insuranceClaims")
        .drop()
        .catch(() => undefined);
    },
  },
  {
    id: "0039-consultation-notes",
    description:
      "Consultation notes (D3 / EMR depth) — the structured note for a visit (chief complaint, " +
      "history, examination, typed diagnoses, plan). ONE per encounter. This owns the collection " +
      "and its unique index.",
    up: async (db) => {
      await db.createCollection("consultationNotes").catch(() => undefined);
      // One note per encounter — the note is 1:1 with the visit, written by upsert.
      await db
        .collection("consultationNotes")
        .createIndex(
          { tenantId: 1, encounterId: 1 },
          { unique: true, name: "one_note_per_encounter", background: true },
        );
      // A patient's notes across visits, for the profile.
      await db
        .collection("consultationNotes")
        .createIndex({ tenantId: 1, patientId: 1, createdAt: -1 }, { background: true });
    },
    down: async (db) => {
      await db
        .collection("consultationNotes")
        .drop()
        .catch(() => undefined);
    },
  },
  {
    id: "0040-medication-administrations",
    description:
      "Medication Administration Record (D5 / nursing) — one row per dose given to an inpatient " +
      "against a signed prescription line. This owns the collection and its indexes.",
    up: async (db) => {
      await db.createCollection("medicationAdministrations").catch(() => undefined);
      // The ward chart / handover reads a visit's MAR, most recent first.
      await db
        .collection("medicationAdministrations")
        .createIndex({ tenantId: 1, encounterId: 1, administeredAt: -1 }, { background: true });
      // Reconciliation reads what was given against a prescription.
      await db
        .collection("medicationAdministrations")
        .createIndex({ tenantId: 1, prescriptionId: 1 }, { background: true });
    },
    down: async (db) => {
      await db
        .collection("medicationAdministrations")
        .drop()
        .catch(() => undefined);
    },
  },
  {
    id: "0041-lab-test-catalogue",
    description:
      "Lab test catalogue (D6 / LIS) — the laboratory's service master (`labTests`: each test with " +
      "its analytes + reference ranges). This owns the collection and its unique code index.",
    up: async (db) => {
      await db.createCollection("labTests").catch(() => undefined);
      // A test code is the human key ordering + result entry look up — unique per tenant.
      await db
        .collection("labTests")
        .createIndex(
          { tenantId: 1, code: 1 },
          { unique: true, name: "one_lab_test_code_per_tenant", background: true },
        );
    },
    down: async (db) => {
      await db
        .collection("labTests")
        .drop()
        .catch(() => undefined);
    },
  },
  {
    id: "0042-medicolegal-records",
    description:
      "Medico-legal records (C3): `consents` (structured informed consent, withdrawable) and " +
      "`deathRecords` (statutory death capture — cause-of-death chain, manner, medico-legal flag). " +
      "One death record per encounter, enforced by a unique index.",
    up: async (db) => {
      await db.createCollection("consents").catch(() => undefined);
      await db.createCollection("deathRecords").catch(() => undefined);

      // A patient's consents, newest first — the Consent tab's read.
      await db
        .collection("consents")
        .createIndex({ tenantId: 1, patientId: 1, signedAt: -1 }, { background: true });

      // A death is recorded once per stay — the unique key that refuses a second.
      await db
        .collection("deathRecords")
        .createIndex(
          { tenantId: 1, encounterId: 1 },
          { unique: true, name: "one_death_record_per_encounter", background: true },
        );
      await db
        .collection("deathRecords")
        .createIndex({ tenantId: 1, patientId: 1, diedAt: -1 }, { background: true });
    },
    down: async (db) => {
      await db
        .collection("consents")
        .drop()
        .catch(() => undefined);
      await db
        .collection("deathRecords")
        .drop()
        .catch(() => undefined);
    },
  },
  {
    id: "0043-care-packages",
    description:
      "Care packages (F5): `servicePackages` (fixed-price bundle definitions, unique code) and " +
      "`packageEnrollments` (a package on a visit — snapshots price + covered codes, points at its " +
      "charge). Enrolling charges the bundle once; covered services then post at ₹0.",
    up: async (db) => {
      await db.createCollection("servicePackages").catch(() => undefined);
      await db.createCollection("packageEnrollments").catch(() => undefined);

      // A package code is the human key enrollment looks up — unique per tenant.
      await db
        .collection("servicePackages")
        .createIndex(
          { tenantId: 1, code: 1 },
          { unique: true, name: "one_package_code_per_tenant", background: true },
        );
      // The coverage check reads the active enrollment on a visit — index the hot path.
      await db
        .collection("packageEnrollments")
        .createIndex({ tenantId: 1, encounterId: 1, status: 1 }, { background: true });
    },
    down: async (db) => {
      await db
        .collection("servicePackages")
        .drop()
        .catch(() => undefined);
      await db
        .collection("packageEnrollments")
        .drop()
        .catch(() => undefined);
    },
  },
  {
    id: "0044-mrd-coding",
    description:
      "MRD (medical records): `icdCodes` (the ICD-10 master, unique code) and `encounterCodings` " +
      "(the coded diagnoses on a visit — one per encounter, feeds the disease register).",
    up: async (db) => {
      await db.createCollection("icdCodes").catch(() => undefined);
      await db.createCollection("encounterCodings").catch(() => undefined);

      await db
        .collection("icdCodes")
        .createIndex(
          { tenantId: 1, code: 1 },
          { unique: true, name: "one_icd_code_per_tenant", background: true },
        );
      // One coding per encounter — the upsert key.
      await db
        .collection("encounterCodings")
        .createIndex(
          { tenantId: 1, encounterId: 1 },
          { unique: true, name: "one_coding_per_encounter", background: true },
        );
      // The disease register aggregates by coding date.
      await db
        .collection("encounterCodings")
        .createIndex({ tenantId: 1, codedAt: -1 }, { background: true });
    },
    down: async (db) => {
      await db
        .collection("icdCodes")
        .drop()
        .catch(() => undefined);
      await db
        .collection("encounterCodings")
        .drop()
        .catch(() => undefined);
    },
  },
  {
    id: "0045-mortuary-register",
    description:
      "Mortuary: `mortuaryRegister` (the body custody log — one entry per encounter, from receipt " +
      "into storage to release).",
    up: async (db) => {
      await db.createCollection("mortuaryRegister").catch(() => undefined);

      // One body per stay — the register is keyed on the encounter, and a second entry is a mistake.
      await db
        .collection("mortuaryRegister")
        .createIndex(
          { tenantId: 1, encounterId: 1 },
          { unique: true, name: "one_body_per_encounter", background: true },
        );
      // The occupancy board reads the currently-stored bodies, newest first.
      await db
        .collection("mortuaryRegister")
        .createIndex({ tenantId: 1, status: 1, receivedAt: -1 }, { background: true });
    },
    down: async (db) => {
      await db
        .collection("mortuaryRegister")
        .drop()
        .catch(() => undefined);
    },
  },
  {
    id: "0046-branch-aware-uniqueness",
    description:
      "Multi-branch (ADR-0015): four tenant-wide unique keys become branch-aware, so a hospital " +
      "with two sites can have an ICU at each and a doctor can hold Monday clinics at both.",
    /**
     * ── WHY THESE FOUR MOVE TOGETHER, AND WHY THIS IS SAFE ──────────────────────
     * A ward name was unique per TENANT (`one_ward_name_per_tenant`, 0027), which is a rule that
     * reads as sensible right up to the day the hospital opens a second site: Hyderabad has an
     * ICU, Chennai wants one, and the database says no. The same is true of a doctor's weekday
     * template (0010) and roster row (0035) — one Monday per doctor, hospital-wide, so a second
     * site's Monday silently OVERWROTE the first through the upsert.
     *
     * Ward names and bed occupancy cannot move separately. `one_open_stay_per_bed` (0020) keys
     * occupancy on `{tenantId, bed.ward, bed.bedCode}` — the ward NAME, not its id, because an
     * admission records the bed as text. The instant two branches may both own an "ICU", that key
     * would refuse to admit Chennai's ICU/A-12 patient because Hyderabad's ICU/A-12 is occupied:
     * a real patient turned away by a stale invariant. So occupancy becomes branch-aware in the
     * SAME migration, and 0027's header note (which explains why they were coupled) is superseded.
     *
     * Every change here WIDENS a unique key by prepending a field. A widened unique key cannot be
     * violated by data that satisfied the narrower one, so none of these creations can fail on
     * existing data — which is why no pre-flight conflict scan is needed. Rows with no `branchId`
     * index as `null` and keep colliding with each other exactly as they do today.
     *
     * Created BEFORE the old one is dropped, so an interrupted run leaves the STRICTER key in
     * place rather than no key at all. Both indexes may coexist mid-run; that is a temporary
     * over-constraint, never a gap.
     */
    up: async (db) => {
      /* Wards: `ICU` at Hyderabad and `ICU` at Chennai are two different wards. */
      await db
        .collection("wards")
        .createIndex(
          { tenantId: 1, branchId: 1, name: 1 },
          { unique: true, name: "one_ward_name_per_branch", background: true },
        );
      await db
        .collection("wards")
        .dropIndex("one_ward_name_per_tenant")
        .catch(() => undefined);

      /* Occupancy: a bed is identified by its site as well as its ward and code. */
      await db.collection("encounters").createIndex(
        { tenantId: 1, branchId: 1, "bed.ward": 1, "bed.bedCode": 1 },
        {
          unique: true,
          partialFilterExpression: { open: { $eq: true }, "bed.bedCode": { $exists: true } },
          background: true,
          name: "one_open_stay_per_bed_per_branch",
        },
      );
      await db
        .collection("encounters")
        .dropIndex("one_open_stay_per_bed")
        .catch(() => undefined);

      /* The slot template: one Monday clinic per doctor PER SITE. */
      await db
        .collection("doctorSchedules")
        .createIndex(
          { tenantId: 1, branchId: 1, doctorId: 1, weekday: 1 },
          { unique: true, name: "one_schedule_per_doctor_weekday_branch", background: true },
        );
      // Created unnamed in 0010, so it carries Mongo's derived name.
      await db
        .collection("doctorSchedules")
        .dropIndex("tenantId_1_doctorId_1_weekday_1")
        .catch(() => undefined);

      /* The session roster: same key, same reason. */
      await db
        .collection("doctorAvailability")
        .createIndex(
          { tenantId: 1, branchId: 1, doctorId: 1, weekday: 1 },
          { unique: true, name: "one_roster_row_per_doctor_weekday_branch", background: true },
        );
      await db
        .collection("doctorAvailability")
        .dropIndex("one_roster_row_per_doctor_weekday")
        .catch(() => undefined);
    },
    /**
     * Best-effort, and it says so. Restoring a NARROWER unique key fails if the data has since
     * used the freedom this migration granted — two branches with an ICU, one doctor with two
     * Monday clinics. That is not a fault to be swallowed: the `catch` keeps the rollback moving
     * for the collections that can be narrowed, and the ones that cannot are exactly the ones a
     * human must look at before going back.
     */
    down: async (db) => {
      await db
        .collection("wards")
        .createIndex(
          { tenantId: 1, name: 1 },
          { unique: true, name: "one_ward_name_per_tenant", background: true },
        )
        .catch(() => undefined);
      await db
        .collection("wards")
        .dropIndex("one_ward_name_per_branch")
        .catch(() => undefined);

      await db
        .collection("encounters")
        .createIndex(
          { tenantId: 1, "bed.ward": 1, "bed.bedCode": 1 },
          {
            unique: true,
            partialFilterExpression: { open: { $eq: true }, "bed.bedCode": { $exists: true } },
            background: true,
            name: "one_open_stay_per_bed",
          },
        )
        .catch(() => undefined);
      await db
        .collection("encounters")
        .dropIndex("one_open_stay_per_bed_per_branch")
        .catch(() => undefined);

      await db
        .collection("doctorSchedules")
        .createIndex({ tenantId: 1, doctorId: 1, weekday: 1 }, { unique: true, background: true })
        .catch(() => undefined);
      await db
        .collection("doctorSchedules")
        .dropIndex("one_schedule_per_doctor_weekday_branch")
        .catch(() => undefined);

      await db
        .collection("doctorAvailability")
        .createIndex(
          { tenantId: 1, doctorId: 1, weekday: 1 },
          { unique: true, name: "one_roster_row_per_doctor_weekday", background: true },
        )
        .catch(() => undefined);
      await db
        .collection("doctorAvailability")
        .dropIndex("one_roster_row_per_doctor_weekday_branch")
        .catch(() => undefined);
    },
  },
  {
    id: "0047-ledger-branch-from-parent",
    description:
      "Multi-branch (ADR-0015): give a branchless ledger row the branch of the record it answers " +
      "to — a wallet movement its encounter or invoice, a stock movement its dispense.",
    /**
     * ── DERIVED, NEVER GUESSED ──────────────────────────────────────────────────
     * `seedMainBranch` adopts unstamped rows into the Main Branch, and that adoption rests on
     * "there was only one site, so it happened there". It therefore refuses outright once a
     * hospital has two branches — which leaves exactly the rows this migration is for.
     *
     * A ledger row is not orphaned in the same way. A wallet DEBIT settles an invoice, and that
     * invoice was raised somewhere; a stock DISPENSE answers a dispense, and that dispense
     * crossed a counter somewhere. The parent already knows, so this is a lookup, not an
     * inference, and it is correct no matter how many branches the hospital has.
     *
     * What it deliberately does NOT touch: a wallet DEPOSIT or REFUND with no invoice and no
     * encounter (cash at a desk, and which desk is genuinely unrecorded), a stock RECEIPT or
     * ADJUSTMENT (the defect that produced them never captured a branch — see
     * `medicine.service.ts`), and a doctor's pre-branch schedule. Those rows stay branchless and
     * are reported by the audit. Inventing a site for them would put a number in a financial
     * ledger that nobody can defend, which is worse than a gap that is visible.
     *
     * Row-at-a-time on purpose: these sets are tens of rows, not millions (an `$lookup`-and-merge
     * pipeline would be faster and much harder to read), and each update is independent, so an
     * interrupted run simply resumes — the filter only ever matches what is still unstamped.
     */
    up: async (db) => {
      /* A wallet movement belongs where the visit or the bill it settles belongs. */
      const entries = await db
        .collection("walletEntries")
        .find({
          branchId: { $exists: false },
          $or: [{ encounterId: { $exists: true } }, { invoiceId: { $exists: true } }],
        })
        .toArray();
      for (const entry of entries) {
        const parent = entry.encounterId
          ? await db
              .collection("encounters")
              .findOne({ _id: entry.encounterId }, { projection: { branchId: 1 } })
          : await db
              .collection("invoices")
              .findOne({ _id: entry.invoiceId }, { projection: { branchId: 1 } });
        if (parent?.branchId) {
          await db
            .collection("walletEntries")
            .updateOne({ _id: entry._id }, { $set: { branchId: parent.branchId } });
        }
      }

      /* A stock movement caused by a dispense belongs to the pharmacy that dispensed. */
      const movements = await db
        .collection("stockMovements")
        .find({ branchId: { $exists: false }, dispenseId: { $exists: true } })
        .toArray();
      for (const movement of movements) {
        const dispense = await db
          .collection("dispenses")
          .findOne({ _id: movement.dispenseId }, { projection: { branchId: 1 } });
        if (dispense?.branchId) {
          await db
            .collection("stockMovements")
            .updateOne({ _id: movement._id }, { $set: { branchId: dispense.branchId } });
        }
      }
    },
    /**
     * Intentionally a no-op. The rows this set are indistinguishable from rows that were always
     * stamped, so an inverse would have to `$unset` branches that are CORRECT — turning a
     * rollback into data loss. Re-running `up` is harmless, which is the property that matters.
     */
    down: async () => undefined,
  },
  {
    id: "0048-idempotency-key-claims",
    description:
      "Idempotency-Key (Doc 04 §5.1): the unique claim key that makes two simultaneous " +
      "identical money requests execute exactly once.",
    /**
     * ── WHAT 0004 LEFT UNFINISHED ───────────────────────────────────────────────
     * Migration 0004 created `idempotencyKeys` and its TTL index in the very first week, and for
     * forty-four migrations nothing ever wrote a row to it. A collection with a TTL and no
     * uniqueness is not idempotency — it is a cache with an expiry policy, and it would have let
     * two simultaneous payments both insert a "claim" and both proceed.
     *
     * This is the index that does the actual work. `(tenantId, userId, key)` is the identity of a
     * claim, and it is unique, so of two identical requests in flight EXACTLY ONE insert survives
     * — the database arbitrates the race rather than the application, which is the only place it
     * can be arbitrated correctly (`if (!exists) create()` loses by construction).
     *
     * Each field earns its place:
     *   tenantId — a hospital can never see, replay, or block another hospital's keys. The
     *              collection already lives in the tenant's own database; this is the second lock
     *              on the same door, in the house style.
     *   userId   — two cashiers on two counters will both invent `"receipt-1"`. Without this they
     *              would collide, and the second cashier would be handed the first one's receipt
     *              while the second patient's money was never taken.
     *   key      — the client's name for its intent.
     *
     * The ENDPOINT is deliberately NOT part of the key. It lives in the request fingerprint
     * instead, so reusing one key across two endpoints is a loud 409 rather than two independent
     * executions — a client that does that has a bug, and the useful answer is to say so.
     *
     * The TTL index from 0004 stays exactly as it is: `expiresAt` is re-stamped on completion, so
     * a stored response lives 24 hours from the answer (Doc 03 §7), and nothing has to run a
     * cleanup job.
     */
    /**
     * ── PREFLIGHT: THIS ONE *CAN* FAIL ON EXISTING DATA (risk register D6) ────
     *
     * It lives here, as a read-only function, rather than as a throw inside `up`. Two callers need
     * the same answer and only one of them may act: `migrateTenantDb` runs it immediately before
     * `up`, so the refusal below is exactly the refusal a real convergence would hit; and
     * `migrate --check` runs it to say "this tenant is behind AND converging it will fail" during
     * the deploy window rather than at 02:00, without writing anything.
     */
    preflight: async (db) => {
      /**
       * 0049 below can reason that it cannot fail — its key includes a field the same change
       * introduced, so its partial filter covers zero historical rows. This migration has no such
       * property. `idempotencyKeys` has existed since 0004 with a TTL and NO uniqueness, and the
       * `idempotent()` middleware writes to it, so any tenant that served traffic before this
       * migration landed may already hold two rows with the same identity.
       *
       * Without this check Mongo answers `Index build failed: <uuid>`, which names a collection
       * most people have never heard of and no remedy at all. The runner correctly records
       * nothing, so the tenant is not falsely converged — it just stops, two migrations behind,
       * and whoever is paged has to work out why from a UUID. Observed on `hms_sunrise`,
       * 2026-08-14.
       *
       * It REFUSES rather than pruning. Deleting rows to make a migration pass is a destructive
       * operation (Constitution §3.9), and duplicate claims mean something already went wrong —
       * an operator should see that rather than have it tidied away underneath them.
       */
      const collisions = await db
        .collection("idempotencyKeys")
        .aggregate([
          {
            $group: {
              _id: { tenantId: "$tenantId", userId: "$userId", key: "$key" },
              n: { $sum: 1 },
            },
          },
          { $match: { n: { $gt: 1 } } },
          { $count: "groups" },
        ])
        .toArray();

      const groups = Number((collisions[0] as { groups?: number } | undefined)?.groups ?? 0);
      if (groups === 0) return null;

      return [
        `0048 cannot build \`one_claim_per_idempotency_key\`: ${String(groups)} ` +
          "(tenantId, userId, key) group(s) in `idempotencyKeys` already hold more than one " +
          "claim, and the index is unique.",
        "",
        "These rows are a REPLAY CACHE, not a record. Every one carries `expiresAt` and the",
        "TTL from 0004 removes it within 24 hours of being written, so neither remedy below",
        "loses anything a hospital can see:",
        "",
        "  WAIT   let the TTL drain them, then re-run. Safest; up to 24 hours.",
        "  PRUNE  keep one row per identity and delete the rest, then re-run:",
        "",
        "    db.idempotencyKeys.aggregate([",
        "      { $sort: { completedAt: -1, claimedAt: -1 } },",
        "      { $group: { _id: { tenantId: '$tenantId', userId: '$userId', key: '$key' },",
        "                  ids: { $push: '$_id' } } },",
        "      { $match: { 'ids.1': { $exists: true } } }",
        "    ]).forEach(g => { g.ids.shift(); db.idempotencyKeys.deleteMany({ _id: { $in: g.ids } }); })",
        "",
        "The `$sort` puts the most recently COMPLETED claim first and `shift()` keeps it: that",
        "is the row holding the stored response a retry replays, and dropping it would turn a",
        "replay back into a second execution.",
        "",
        "Nothing has been recorded. This tenant is still behind and `pnpm seed:migrate` will",
        "retry it once the collisions are gone.",
      ].join("\n");
    },
    up: async (db) => {
      await db.createCollection("idempotencyKeys").catch(() => undefined);

      // The uniqueness itself. `preflight` above has already refused if existing rows would make
      // this build fail, so by here the only remaining failure is an infrastructure one.
      await db
        .collection("idempotencyKeys")
        .createIndex(
          { tenantId: 1, userId: 1, key: 1 },
          { unique: true, background: true, name: "one_claim_per_idempotency_key" },
        );
    },
    /**
     * Drops only the index this migration added. The collection and its TTL belong to 0004 and
     * dropping them here would roll back a migration this one did not perform.
     */
    down: async (db) => {
      await db
        .collection("idempotencyKeys")
        .dropIndex("one_claim_per_idempotency_key")
        .catch(() => undefined);
    },
  },
  {
    id: "0049-one-administration-per-dose-slot",
    description:
      "MAR safety (M3-S1): a scheduled dose slot may hold at most ONE administration. Closes the " +
      "defect where two nurses charting the same round wrote two `given` rows, silently, for ever.",
    /**
     * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
     * `medicationAdministrations` shipped with two indexes (0040), both NON-unique, and no
     * uniqueness at any other layer either — not the model, not the schema, not the service. The
     * service proved the prescription was real, signed and for this encounter, then wrote a row
     * unconditionally, however many times it was asked. Two nurses on two phones both charting the
     * 14:00 antibiotic produced TWO `given` rows. The chart then reads as a double dose, nothing
     * flags it, and because the MAR is append-only neither row can be withdrawn.
     *
     * `Idempotency-Key` (0048) does not help: it dedupes ONE client replaying ONE request. Two
     * nurses send two different keys, and both are honoured. Only the database can arbitrate
     * between two processes, which is why the fix is an index and not a service check.
     *
     * ── WHY THIS CANNOT FAIL ON EXISTING DATA ───────────────────────────────────
     * The key includes `scheduledFor`, a field introduced by the same change. **No historical row
     * has it**, and the partial filter admits only rows that do — so at creation time the index
     * covers ZERO existing documents and there is nothing for it to conflict with. The safety
     * argument is structural, not a hope that production happens to be clean.
     *
     * Historical duplicates therefore survive untouched, outside the index, which is the correct
     * outcome: they are real clinical history and a migration must not rewrite them to make an
     * index build succeed. `mar.int.test.ts` seeds pre-existing duplicates and runs this migration
     * over them, so "safe on dirty data" is proved rather than asserted.
     *
     * ── WHY THE PARTIAL FILTER IS LOAD-BEARING ──────────────────────────────────
     * A PRN (`SOS`) dose has NO slot and may legitimately be given many times a day. Constraining
     * it would refuse the second real dose — a worse defect than the one being fixed, and one that
     * lands on a patient in pain. Rows with no `scheduledFor` stay unconstrained, deliberately.
     *
     * `lineIndex`, not `drugCode`: a prescription may carry the same drug twice (a QID round and a
     * SOS line for breakthrough), and `prescription.schema.ts` places no uniqueness rule on lines.
     * See `mar.model.ts` for why a line's POSITION is a safe identity.
     */
    up: async (db) => {
      await db.collection("medicationAdministrations").createIndex(
        { tenantId: 1, prescriptionId: 1, lineIndex: 1, scheduledFor: 1 },
        {
          unique: true,
          partialFilterExpression: { scheduledFor: { $exists: true } },
          background: true,
          name: "one_administration_per_dose_slot",
        },
      );
    },
    /** Drops only what this migration added; 0040 still owns the collection and its two reads. */
    down: async (db) => {
      await db
        .collection("medicationAdministrations")
        .dropIndex("one_administration_per_dose_slot")
        .catch(() => undefined);
    },
  },
  {
    id: "0050-notification-inbox",
    description: "The staff inbox — read state, and the index the unread badge is counted on",
    /**
     * ── THE LEDGER HAD A READER-SHAPED HOLE ─────────────────────────────────────
     * Migration 0011 already built `{tenantId, recipientId, createdAt: -1}` for the question "did
     * they get it?", asked at a front desk. What it could not answer is "how many have I not
     * opened?" — the badge, rendered for every signed-in user on every page load, which makes it
     * the most frequent query this collection will ever serve.
     *
     * ── THE PARTIAL FILTER IS ON `status`, NOT ON `readAt` ──────────────────────
     * The obvious index is a partial one over the unread rows themselves, and **MongoDB refuses
     * it**: `partialFilterExpression: { readAt: { $exists: false } }` is rejected with
     * "Expression not supported in partial index: $not", because `$exists: false` desugars to a
     * negation and partial filters admit only positive predicates. Worth writing down — it is the
     * first thing anyone will try, and the error names `$not` for an expression that does not
     * contain the word.
     *
     * So the filter is `status: "sent"`, which is an equality and is supported, and which happens
     * to be exactly the right restriction anyway: the inbox reads delivered messages only (see
     * `listForRecipient`), so the pending, failed, unreachable and suppressed rows have no reason
     * to be in this index at all. `readAt` then sits in the KEY, where a scan for the unread ones
     * is a narrow range rather than a walk through a consultant's entire correspondence.
     *
     * ── SAFE ON EXISTING DATA ───────────────────────────────────────────────────
     * `readAt` is new, so every historical row lacks it and sorts as unread. That is the correct
     * outcome and not an accident: messages sent before there was an inbox genuinely have not
     * been read by anybody. A hospital upgrading sees its existing alerts arrive unread, which is
     * what its staff would expect — the alternative is silently marking a year of critical
     * results as "seen".
     *
     * Not unique. Nothing here arbitrates a race: two tabs opening the same message is not a
     * conflict, it is the same fact written twice (see `markRead`).
     */
    up: async (db) => {
      await db.createCollection("notifications").catch(() => undefined);

      await db.collection("notifications").createIndex(
        { tenantId: 1, recipientId: 1, readAt: 1, createdAt: -1 },
        {
          partialFilterExpression: { status: "sent" },
          background: true,
          name: "inbox_per_recipient",
        },
      );
    },
    /** Drops only what this migration added; 0011 still owns the collection and its three indexes. */
    down: async (db) => {
      await db
        .collection("notifications")
        .dropIndex("inbox_per_recipient")
        .catch(() => undefined);
    },
  },
];
