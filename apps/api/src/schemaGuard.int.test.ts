/**
 * THE VALIDATION GATE — does it refuse a database that cannot enforce the rules?
 *
 * ── WHY THIS SUITE EXISTS ───────────────────────────────────────────────────
 * `seed:validation --verify` reported READY on 2026-08-14 against a tenant with no unique index on
 * `medicationAdministrations`. It checked nineteen facts about the DATA and nothing about the
 * SCHEMA, so it certified an environment in which two nurses could chart the same dose. The probe
 * that followed reported seven catastrophic safety failures which were all the absence of the
 * mechanism rather than a fault in it.
 *
 * A guard is only worth having if it goes RED when the thing it guards is gone. So this suite does
 * not assert that a healthy database passes — that proves almost nothing. It **removes the
 * constraint and requires the guard to notice**, then puts it back and requires the guard to be
 * satisfied again.
 *
 * ── SAFETY OF THE TEST ITSELF ───────────────────────────────────────────────
 * It runs against its own throwaway tenant (`test_schemaguard_*`) through the repository's existing
 * isolated-Mongo harness, and it drops indexes only there. It never touches a development database
 * and it weakens no production constraint: `dropIndex` here is the falsification instrument, and the
 * migration that owns the index puts it straight back.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertMongoReachable, dropDatabases, TEST_MONGO_URI } from "./test/mongoTestEnv.js";

process.env.MONGO_URI = TEST_MONGO_URI;
process.env.MONGO_MASTER_DB = "test_schemaguard_master";
process.env.TENANT_BASE_DOMAIN = "medicore.test";

const { provisionTenant } = await import("./modules/tenants/index.js");
const { getTenantConnection, closeAllTenantConnections } =
  await import("./core/db/connectionManager.js");
const { closeMaster } = await import("./core/db/masterDb.js");
const { closeRedis } = await import("./core/redis/redis.js");
const { tenantMigrations } = await import("./core/db/migrations/tenantMigrations.js");
const { verifyTenantSchema, schemaBlockedMessage, CLINICAL_SAFETY_INVARIANTS } =
  await import("./seed/schemaGuard.js");

const SLUG = "test-schemaguard";
let db: Awaited<ReturnType<typeof getTenantConnection>>;

beforeAll(async () => {
  await assertMongoReachable();
  await dropDatabases([`hms_${SLUG}`, "test_schemaguard_master"]);

  const { tenant } = await provisionTenant({
    hospitalName: "Schema Guard Test",
    slug: SLUG,
    planCode: "PLAN_HOSPITAL",
    organizationType: "private_hospital",
  });
  db = await getTenantConnection({
    id: tenant.id,
    databaseName: tenant.databaseName,
    ...(tenant.dbUri ? { dbUri: tenant.dbUri } : {}),
  });
}, 60_000);

afterAll(async () => {
  await closeAllTenantConnections().catch(() => undefined);
  await closeMaster().catch(() => undefined);
  await closeRedis().catch(() => undefined);
});

describe("1. a freshly provisioned tenant", () => {
  it("is schema-converged and every safety invariant is armed", async () => {
    const verdict = await verifyTenantSchema(db, tenantMigrations);

    expect(verdict.pending).toEqual([]);
    expect(verdict.missing).toEqual([]);
    expect(verdict.ok).toBe(true);
  });
});

/**
 * THE CONTROLS. Each removes exactly one thing and requires the guard to name it.
 *
 * Every case restores what it broke, so the suite's own order cannot matter and a failure here
 * cannot cascade into the next test.
 */
describe("2. falsification — the guard must refuse what it is there to refuse", () => {
  it("CONTROL 1 · the dose-slot index is dropped → BLOCKED, and it says which rule died", async () => {
    const dose = CLINICAL_SAFETY_INVARIANTS[0];
    if (!dose) throw new Error("expected a dose-slot invariant");

    await db.collection(dose.collection).dropIndex("one_administration_per_dose_slot");
    try {
      const verdict = await verifyTenantSchema(db, tenantMigrations);

      expect(verdict.ok).toBe(false);
      expect(verdict.missing).toHaveLength(1);
      expect(verdict.missing[0]?.invariant.rule).toBe(dose.rule);
      expect(verdict.missing[0]?.found).toBe("no index on those fields");

      // The migration record still SAYS applied — which is the whole reason this check reads the
      // database instead of trusting the record.
      expect(verdict.pending).toEqual([]);

      const message = schemaBlockedMessage(SLUG, verdict);
      expect(message).toContain("VALIDATION BLOCKED");
      expect(message).toContain("the same scheduled dose cannot be charted twice");
      expect(message).toContain("0049-one-administration-per-dose-slot");
      expect(message).toContain(`pnpm seed:migrate --slug ${SLUG}`);
      // The consequence, not just the cause.
      expect(message).toContain("two nurses charting the same round both succeed");

      /**
       * The remediation must be TRUE for this case, and the obvious one is not.
       *
       * The record still says applied, so `migrateTenantDb` skips 0049 and `seed:migrate` reports
       * "tenant converged" while changing nothing — measured on a real tenant on 2026-08-14. A
       * message that only said "run seed:migrate" would send the reader away believing they had
       * fixed an unenforceable database.
       */
      expect(message).toContain("will skip it and report success without changing anything");
      expect(message).toContain('db.migrations.deleteOne({ _id: "0049');
    } finally {
      await db.collection(dose.collection).createIndex(dose.key, {
        unique: true,
        ...(dose.partialFilterExpression
          ? { partialFilterExpression: dose.partialFilterExpression }
          : {}),
        name: "one_administration_per_dose_slot",
      });
    }
  });

  it("CONTROL 2 · the index exists on the right fields but is NOT unique → still BLOCKED", async () => {
    const dose = CLINICAL_SAFETY_INVARIANTS[0];
    if (!dose) throw new Error("expected a dose-slot invariant");

    await db.collection(dose.collection).dropIndex("one_administration_per_dose_slot");
    await db.collection(dose.collection).createIndex(dose.key, { name: "impostor_not_unique" });
    try {
      const verdict = await verifyTenantSchema(db, tenantMigrations);

      expect(verdict.ok).toBe(false);
      // The dangerous case: something that LOOKS right in a listing and enforces nothing.
      expect(verdict.missing[0]?.found).toContain("does not enforce the rule");
      expect(verdict.missing[0]?.found).toContain("unique=false");
    } finally {
      await db.collection(dose.collection).dropIndex("impostor_not_unique");
      await db.collection(dose.collection).createIndex(dose.key, {
        unique: true,
        ...(dose.partialFilterExpression
          ? { partialFilterExpression: dose.partialFilterExpression }
          : {}),
        name: "one_administration_per_dose_slot",
      });
    }
  });

  it("CONTROL 3 · the partial filter is missing → BLOCKED, because PRN doses would be refused", async () => {
    const dose = CLINICAL_SAFETY_INVARIANTS[0];
    if (!dose) throw new Error("expected a dose-slot invariant");

    await db.collection(dose.collection).dropIndex("one_administration_per_dose_slot");
    // Unique on the right fields, but covering every row — this would refuse a legitimate second
    // PRN dose, which is a worse defect than the one 0049 fixes.
    await db
      .collection(dose.collection)
      .createIndex(dose.key, { unique: true, name: "too_greedy" });
    try {
      const verdict = await verifyTenantSchema(db, tenantMigrations);

      expect(verdict.ok).toBe(false);
      expect(verdict.missing[0]?.found).toContain("does not enforce the rule");
    } finally {
      await db.collection(dose.collection).dropIndex("too_greedy");
      await db.collection(dose.collection).createIndex(dose.key, {
        unique: true,
        ...(dose.partialFilterExpression
          ? { partialFilterExpression: dose.partialFilterExpression }
          : {}),
        name: "one_administration_per_dose_slot",
      });
    }
  });

  it("CONTROL 4 · the idempotency claim index is dropped → BLOCKED", async () => {
    const claim = CLINICAL_SAFETY_INVARIANTS[1];
    if (!claim) throw new Error("expected an idempotency invariant");

    await db.collection(claim.collection).dropIndex("one_claim_per_idempotency_key");
    try {
      const verdict = await verifyTenantSchema(db, tenantMigrations);

      expect(verdict.ok).toBe(false);
      expect(verdict.missing[0]?.invariant.migration).toBe("0048-idempotency-key-claims");
      expect(schemaBlockedMessage(SLUG, verdict)).toContain(
        "writes a SECOND administration or observation",
      );
    } finally {
      await db
        .collection(claim.collection)
        .createIndex(claim.key, { unique: true, name: "one_claim_per_idempotency_key" });
    }
  });

  it("CONTROL 5 · a migration is un-recorded → BLOCKED and NAMED, not merely counted", async () => {
    // The 2026-08-14 shape: the tenant is simply behind. Deleting the record makes the canonical
    // runner consider it pending, exactly as it would on a database that never ran it.
    await db.collection("migrations").deleteOne({ _id: "0049-one-administration-per-dose-slot" });
    try {
      const verdict = await verifyTenantSchema(db, tenantMigrations);

      expect(verdict.ok).toBe(false);
      expect(verdict.pending).toEqual(["0049-one-administration-per-dose-slot"]);

      // The OTHER remedy: nothing is recorded, so `seed:migrate` genuinely does fix this one and
      // the message must say so plainly rather than sending the reader to edit the database.
      const message = schemaBlockedMessage(SLUG, verdict);
      expect(message).toContain("0049-one-administration-per-dose-slot");
      expect(message).toContain(`pnpm seed:migrate --slug ${SLUG}`);
      expect(message).not.toContain("deleteOne");
    } finally {
      await db.collection("migrations").insertOne({
        _id: "0049-one-administration-per-dose-slot",
        description: "restored by schemaGuard.int.test",
        appliedAt: new Date(),
      } as never);
    }
  });

  it("restores cleanly — the guard is satisfied again", async () => {
    const verdict = await verifyTenantSchema(db, tenantMigrations);
    expect(verdict.ok).toBe(true);
  });
});

/**
 * The guard's own blind spot, stated as a test so nobody assumes otherwise.
 */
describe("3. what this guard does NOT claim", () => {
  it("speaks for ONE tenant only — it is not a fleet convergence metric (T2 stays open)", async () => {
    const verdict = await verifyTenantSchema(db, tenantMigrations);

    // It is handed a single connection and returns a verdict about that connection. There is no
    // path by which it could know about another tenant, and it must never be described as if
    // there were.
    expect(verdict.ok).toBe(true);
    expect(Object.keys(verdict)).toEqual(["ok", "pending", "missing"]);
  });
});
