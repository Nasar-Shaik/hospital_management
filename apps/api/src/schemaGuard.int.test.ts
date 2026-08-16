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
import { readFile } from "node:fs/promises";
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
const { migrateTenantDb } = await import("./core/db/migrations/runner.js");
const { verifyTenantSchema, schemaBlockedMessage, CLINICAL_SAFETY_INVARIANTS } =
  await import("./seed/schemaGuard.js");
const { classify } = await import("./seed/deploymentGate.js");
const { NON_CLINICAL_UNIQUE_INDEXES } = await import("./core/db/clinicalInvariants.js");
const { SERVABLE_TENANT_STATUSES } = await import("./modules/tenants/tenant.model.js");

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
    expect(Object.keys(verdict)).toEqual(["ok", "pending", "missing", "history"]);
  });
});

/**
 * MIGRATION 0048 OVER A DATABASE THAT ALREADY HAS DUPLICATE CLAIMS — risk register D6.
 *
 * 0049 reasons explicitly about why it cannot fail on existing data: its key includes
 * `scheduledFor`, a field the same change introduced, and the partial filter admits only rows that
 * have it — so at creation the index covers zero historical documents. 0048 has no such property
 * and never claimed one.
 *
 * `idempotencyKeys` has existed since 0004 with a TTL and NO uniqueness, and the `idempotent()`
 * middleware writes to it. Any tenant that served traffic between that middleware shipping and
 * 0048 landing can therefore hold two rows with the same `(tenantId, userId, key)`. Building a
 * unique index over them fails, the runner records nothing, and the tenant stops there — two
 * migrations behind, with a raw `E11000` naming a collection most people have never heard of.
 *
 * Observed on `hms_sunrise` on 2026-08-14, where a probe's replays had produced exactly this.
 */
describe("4. migration 0048 meets a database that already holds duplicate claims", () => {
  const MIGRATION_ID = "0048-idempotency-key-claims";
  const only0048 = tenantMigrations.filter((m) => m.id === MIGRATION_ID);

  /** Puts the tenant back to "0048 has never run", with two colliding claims already stored. */
  async function poison(): Promise<void> {
    await db
      .collection("idempotencyKeys")
      .dropIndex("one_claim_per_idempotency_key")
      .catch(() => undefined);
    await db.collection("migrations").deleteOne({ _id: MIGRATION_ID });

    const shared = { tenantId: "t-1", userId: "u-1", key: "receipt-1" };
    await db.collection("idempotencyKeys").insertMany([
      {
        ...shared,
        fingerprint: "f1",
        operation: "POST /api/v1/invoices/1/payments",
        state: "completed",
        claimedAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
      {
        ...shared,
        fingerprint: "f2",
        operation: "POST /api/v1/invoices/1/payments",
        state: "in_progress",
        claimedAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    ]);
  }

  async function clean(): Promise<void> {
    await db.collection("idempotencyKeys").deleteMany({ key: "receipt-1" });
    await db.collection("migrations").deleteOne({ _id: MIGRATION_ID });
    await migrateTenantDb(db, only0048);
  }

  it("REFUSES with an answer rather than a raw duplicate-key error", async () => {
    await poison();
    try {
      // It still fails — that is correct, the index genuinely cannot be built. What changes is
      // whether the failure is readable: Mongo's own answer is `Index build failed: <uuid>`.
      await expect(migrateTenantDb(db, only0048)).rejects.toThrow(/one_claim_per_idempotency_key/);

      // The point of the preflight: the message has to be usable by whoever is holding the pager
      // at 2am, which `E11000 duplicate key error collection: ... index: ...` is not.
      let message = "";
      await migrateTenantDb(db, only0048).catch((e: unknown) => {
        message = e instanceof Error ? e.message : String(e);
      });

      expect(message).toContain("idempotencyKeys");
      expect(message).toContain("1"); // one colliding group
      // It must say what the rows ARE, because "delete some rows" is not an instruction anyone
      // will follow on a production database without knowing that.
      expect(message).toMatch(/24 hours|TTL|expire/i);
      // And it must give a deterministic remediation, not "resolve the duplicates".
      expect(message).toContain("aggregate");
    } finally {
      await clean();
    }
  });

  it("records NOTHING when it refuses, so the tenant is not left falsely converged", async () => {
    await poison();
    try {
      await migrateTenantDb(db, only0048).catch(() => undefined);

      const record = await db.collection("migrations").findOne({ _id: MIGRATION_ID });
      expect(record, "a refused migration must not be recorded as applied").toBeNull();

      // And the guard must agree — this is the state that has to stay visible.
      const verdict = await verifyTenantSchema(db, tenantMigrations);
      expect(verdict.ok).toBe(false);
    } finally {
      await clean();
    }
  });

  it("applies cleanly once the duplicates are gone", async () => {
    await poison();
    // The remediation, performed: keep one row per identity and drop the rest.
    await db.collection("idempotencyKeys").deleteOne({ key: "receipt-1", state: "in_progress" });

    const applied = await migrateTenantDb(db, only0048);
    expect(applied).toEqual([MIGRATION_ID]);

    const verdict = await verifyTenantSchema(db, tenantMigrations);
    expect(verdict.ok).toBe(true);

    await db.collection("idempotencyKeys").deleteMany({ key: "receipt-1" });
  });

  it("is a no-op on a database with no duplicates — the ordinary case is untouched", async () => {
    await db.collection("migrations").deleteOne({ _id: MIGRATION_ID });
    await db
      .collection("idempotencyKeys")
      .dropIndex("one_claim_per_idempotency_key")
      .catch(() => undefined);

    const applied = await migrateTenantDb(db, only0048);
    expect(applied).toEqual([MIGRATION_ID]);
  });
});

/**
 * THE DEPLOYMENT GATE, AGAINST A REAL DATABASE — the half that cannot be faked.
 *
 * `deploymentGate.test.ts` proves every judgement the gate makes about VALUES, in milliseconds and
 * without Docker. What it cannot prove is the claim the whole control rests on: that the answer is
 * read out of MongoDB rather than out of a record. These four are here for exactly that, and each
 * one is a state that `pendingCount` alone reports as converged or as ordinary lag.
 */
describe("5. the deployment gate, against a real tenant database", () => {
  /** Everything an inspection could conceivably disturb, in one comparable value. */
  async function snapshot(): Promise<string> {
    const names = (await db.db!.listCollections().toArray()).map((c) => c.name).sort();
    const state: Record<string, unknown> = {};
    for (const name of names) {
      state[name] = {
        count: await db.collection(name).countDocuments(),
        indexes: (await db.collection(name).indexes())
          .map((ix) => JSON.stringify({ key: ix.key, unique: ix.unique ?? false }))
          .sort(),
      };
    }
    return JSON.stringify({ names, state });
  }

  /**
   * ── THE PROPERTY THAT MAKES IT SAFE TO RUN IN A DEPLOY PIPELINE ───────────
   * A check that migrates while it looks cannot be run twice, cannot be run against production
   * during business hours, and cannot be trusted once — the first run would change the thing the
   * second run reports on. Asserted over collections, document counts AND index definitions,
   * because "it writes nothing" is a claim about all three.
   */
  it("inspects without mutating — every collection, count and index is identical afterwards", async () => {
    const before = await snapshot();

    await verifyTenantSchema(db, tenantMigrations);
    await verifyTenantSchema(db, tenantMigrations);

    expect(await snapshot()).toBe(before);
  });

  it("a tenant migrated by a NEWER release is READY, and the extra id is reported", async () => {
    // The rollback shape: this build is older than the schema. Expand→migrate→contract makes that
    // servable (RELEASE_MANAGEMENT §6), so failing it would make every rollback impossible.
    await db.collection("migrations").insertOne({
      _id: "0099-from-a-future-release",
      description: "inserted by schemaGuard.int.test",
      appliedAt: new Date(),
    } as never);
    try {
      const verdict = await verifyTenantSchema(db, tenantMigrations);

      expect(verdict.ok).toBe(true);
      expect(verdict.history.ahead).toEqual(["0099-from-a-future-release"]);
      expect(classify(verdict, SLUG).code).toBe("ready");
      expect(classify(verdict, SLUG).notes.join(" ")).toMatch(/NEWER schema/);
    } finally {
      await db.collection("migrations").deleteOne({ _id: "0099-from-a-future-release" as never });
    }
  });

  /**
   * The state that reads as ordinary lag and is not. `migrateTenantDb` would apply 0047 NOW, after
   * 0048 and 0049 have already run past it — so "run `migrate --all`" is the wrong instruction and
   * the gate must not give it.
   */
  it("a GAP is `history_inconsistent`, and is NOT told to converge", async () => {
    await db.collection("migrations").deleteOne({ _id: "0047-ledger-branch-from-parent" as never });
    try {
      const verdict = await verifyTenantSchema(db, tenantMigrations);

      expect(verdict.ok).toBe(false);
      expect(verdict.pending).toEqual(["0047-ledger-branch-from-parent"]);
      expect(verdict.history.inconsistent.join(" ")).toMatch(/out of order/);

      const readiness = classify(verdict, SLUG);
      expect(readiness.code).toBe("history_inconsistent");
      expect(readiness.remedy).toMatch(/Do NOT converge/);
      // The distinction is the whole point: a plain `behind` WOULD be told to run this.
      expect(readiness.remedy).not.toMatch(/pnpm seed:migrate/);
    } finally {
      await db.collection("migrations").insertOne({
        _id: "0047-ledger-branch-from-parent",
        description: "restored by schemaGuard.int.test",
        appliedAt: new Date(),
      } as never);
    }
  });

  /**
   * ── PREDICTING A FAILURE WITHOUT CAUSING ONE ──────────────────────────────
   * Before this, `--check` said "behind: 0048" and the operator found out it could not run by
   * running it — at whatever hour the deploy was scheduled for. The preflight is the migration's
   * own, called read-only, so the prediction and the real refusal cannot drift apart.
   */
  it("predicts that converging will FAIL, read-only, when 0048 would refuse", async () => {
    const MIGRATION_ID = "0048-idempotency-key-claims";
    const DOSE_SLOT = "0049-one-administration-per-dose-slot";
    await db
      .collection("idempotencyKeys")
      .dropIndex("one_claim_per_idempotency_key")
      .catch(() => undefined);
    /**
     * BOTH records go, not just 0048's. Removing 0048 alone leaves 0049 recorded above it, which
     * is a genuine GAP — and `history_inconsistent` rightly outranks a blocked preflight, so the
     * fixture would be testing the wrong thing while appearing to test this one. (It did, first
     * time round.) The honest shape of "0048 is next and it will refuse" is: nothing after it has
     * run either.
     */
    await db
      .collection("migrations")
      .deleteMany({ _id: { $in: [MIGRATION_ID, DOSE_SLOT] } as never });
    const shared = { tenantId: "t-gate", userId: "u-gate", key: "receipt-gate" };
    await db.collection("idempotencyKeys").insertMany([
      { ...shared, state: "in_progress", claimedAt: new Date() },
      { ...shared, state: "completed", claimedAt: new Date(), completedAt: new Date() },
    ] as never[]);

    try {
      const verdict = await verifyTenantSchema(db, tenantMigrations);

      // The FIRST outstanding migration is the one asked, and only it — a later one's preflight
      // would be answering about a database state that does not exist yet.
      expect(verdict.pending).toEqual([MIGRATION_ID, DOSE_SLOT]);
      expect(verdict.history.inconsistent).toEqual([]);
      expect(verdict.blockedBy?.migration).toBe(MIGRATION_ID);
      expect(verdict.blockedBy?.reason).toMatch(/1 \(tenantId, userId, key\) group/);

      const readiness = classify(verdict, SLUG);
      expect(readiness.code).toBe("preflight_blocked");
      expect(readiness.remedy).toMatch(/Converging will fail/);

      // And it really was a prediction: the duplicates are still there, un-pruned, and 0048 is
      // still unrecorded. Checking must never tidy up after itself.
      expect(await db.collection("idempotencyKeys").countDocuments({ key: "receipt-gate" })).toBe(
        2,
      );
      expect(await db.collection("migrations").countDocuments({ _id: MIGRATION_ID as never })).toBe(
        0,
      );

      // The prediction is the migration's own answer — prove it by letting the runner try.
      await expect(
        migrateTenantDb(
          db,
          tenantMigrations.filter((m) => m.id === MIGRATION_ID),
        ),
      ).rejects.toThrow(verdict.blockedBy!.reason.split("\n")[0]!);
    } finally {
      await db.collection("idempotencyKeys").deleteMany({ key: "receipt-gate" });
      await migrateTenantDb(
        db,
        tenantMigrations.filter((m) => m.id === MIGRATION_ID || m.id === DOSE_SLOT),
      );
    }
  });

  it("leaves the tenant exactly as it found it", async () => {
    const verdict = await verifyTenantSchema(db, tenantMigrations);
    expect(verdict.ok).toBe(true);
    expect(classify(verdict, SLUG).code).toBe("ready");
  });
});

/**
 * 6. THE REGISTRATION GAP — a future sole arbiter cannot be added without being classified.
 *
 * ── THE HOLE THIS CLOSES ────────────────────────────────────────────────────
 * `CLINICAL_SAFETY_INVARIANTS` protects what somebody remembered to declare. Until now nothing
 * stopped a migration from adding a unique index that IS a clinical sole arbiter and never
 * appearing there: no guard would exist, silently, and no test would notice. Every runtime slice
 * so far was found by a human reading write paths, which does not scale to the next developer.
 *
 * The control reads the indexes off a REAL freshly provisioned tenant rather than parsing the
 * migration source, so it cannot be fooled by formatting, by an index created outside
 * `tenantMigrations`, or by one created and then dropped. It fails in both directions: an
 * unclassified index is a gap, and a stale exemption is a list rotting into a rubber stamp.
 */
describe("6. every unique index is either a declared invariant or explicitly exempt", () => {
  interface LiveIndex {
    collection: string;
    name: string;
    key: Record<string, unknown>;
    unique?: boolean;
    partialFilterExpression?: unknown;
  }

  async function uniqueIndexes(): Promise<LiveIndex[]> {
    const collections = await db.db!.listCollections().toArray();
    const found: LiveIndex[] = [];
    for (const { name } of collections) {
      const indexes = (await db.collection(name).indexes()) as Omit<LiveIndex, "collection">[];
      for (const index of indexes) {
        if (index.unique) found.push({ ...index, collection: name });
      }
    }
    return found;
  }

  /** Same shape test the runtime inspector uses: these fields, in this order, unique. */
  function isDeclared(index: LiveIndex): boolean {
    return CLINICAL_SAFETY_INVARIANTS.some((invariant) => {
      if (invariant.collection !== index.collection) return false;
      const actual = Object.entries(index.key);
      const expected = Object.entries(invariant.key);
      if (actual.length !== expected.length) return false;
      if (!actual.every(([field, dir], i) => expected[i]?.[0] === field && Number(dir) === 1)) {
        return false;
      }
      return (
        JSON.stringify(index.partialFilterExpression ?? null) ===
        JSON.stringify(invariant.partialFilterExpression ?? null)
      );
    });
  }

  const isExempt = (index: LiveIndex): boolean =>
    NON_CLINICAL_UNIQUE_INDEXES.some(
      (e) => e.collection === index.collection && e.index === index.name,
    );

  it("finds a realistic number of unique indexes (a scan over nothing proves nothing)", async () => {
    const live = await uniqueIndexes();
    expect(live.length).toBeGreaterThan(30);
  });

  /**
   * THE GATE. A new unique index on a clinical collection stops CI until somebody has decided,
   * in writing, whether it is a sole arbiter — which is exactly the decision that was previously
   * left to whoever happened to read the migration.
   */
  it("classifies EVERY unique index — nothing is silently unprotected", async () => {
    const live = await uniqueIndexes();
    const unclassified = live
      .filter((index) => !isDeclared(index) && !isExempt(index))
      .map((index) => `${index.collection}.${index.name} ${JSON.stringify(index.key)}`);

    expect(
      unclassified,
      "Add this index to CLINICAL_SAFETY_INVARIANTS if a clinical rule rests on it, or to " +
        "NON_CLINICAL_UNIQUE_INDEXES with the reason it does not.",
    ).toEqual([]);
  });

  /** The other direction: an exemption for an index that no longer exists is a stale claim. */
  it("has no stale exemptions — every exempt index still exists", async () => {
    const live = await uniqueIndexes();
    const names = new Set(live.map((i) => `${i.collection}.${i.name}`));
    const stale = NON_CLINICAL_UNIQUE_INDEXES.filter(
      (e) => !names.has(`${e.collection}.${e.index}`),
    ).map((e) => `${e.collection}.${e.index}`);

    expect(stale).toEqual([]);
  });

  it("every exemption carries a reason somebody can argue with", () => {
    const thin = NON_CLINICAL_UNIQUE_INDEXES.filter((e) => e.reason.trim().length < 25);
    expect(thin.map((e) => e.index)).toEqual([]);
  });

  /** The eight declared invariants are all actually present on a converged tenant. */
  it("every declared invariant matches a real unique index", async () => {
    const live = await uniqueIndexes();
    const undeclaredButRequired = CLINICAL_SAFETY_INVARIANTS.filter(
      (invariant) =>
        !live.some((index) => index.collection === invariant.collection && isDeclared(index)),
    ).map((i) => i.rule);

    expect(undeclaredButRequired).toEqual([]);
  });
});

/**
 * 7. A NEW HOSPITAL IS NEVER SERVABLE BEFORE ITS SCHEMA EXISTS.
 *
 * ── THE QUESTION ────────────────────────────────────────────────────────────
 * Every runtime guard in this system assumes a tenant's indexes are present or provably absent.
 * That assumption has an obvious hole at the very beginning of a hospital's life: the registry row
 * is written BEFORE the database is created and migrated, so if a request could resolve a tenant
 * in that window it would reach a database with no collections at all.
 *
 * ── THE ANSWER, AND WHY IT IS ALREADY CORRECT ───────────────────────────────
 * `repo.create` writes `status: "provisioning"`, and `SERVABLE_TENANT_STATUSES` is
 * `["active", "trial"]` — so `resolveTenant` refuses the tenant for the whole window. The move to
 * active is the LAST statement of `provisionTenant`, after migrations, the Main Branch and the
 * code master. A migration that throws therefore leaves the hospital permanently unservable rather
 * than half-open: fail-closed by construction, with no runtime migration and no self-healing.
 *
 * That is a correct design that nothing was pinning. These assertions exist so that moving the
 * activation earlier — which would look like a harmless tidy-up — cannot pass review.
 */
describe("7. tenant provisioning cannot expose a hospital before its schema exists", () => {
  it("does not serve a tenant that is still provisioning", () => {
    expect(SERVABLE_TENANT_STATUSES).not.toContain("provisioning");
    // The other end of the same rule: these two ARE served, so the list cannot simply be empty.
    expect([...SERVABLE_TENANT_STATUSES].sort()).toEqual(["active", "trial"]);
  });

  /**
   * A structural assertion, deliberately. The behavioural version would need a migration that
   * fails on demand, and `provisionTenant` reads the module-level registry — so the property that
   * actually protects the window is the ORDER of these two statements, and that is what is pinned.
   */
  it("activates the tenant only AFTER migrations have run", async () => {
    const source = await readFile(
      new URL("./modules/tenants/tenant.service.ts", import.meta.url),
      "utf8",
    );
    const body = source.slice(source.indexOf("export async function provisionTenant"));
    const migrated = body.indexOf("migrateTenantDb(");
    const activated = body.indexOf("transitionStatus(tenant.id");

    expect(migrated).toBeGreaterThan(-1);
    expect(activated).toBeGreaterThan(-1);
    expect(
      activated,
      "provisionTenant must migrate before it activates — otherwise a half-migrated hospital " +
        "is servable and every runtime schema guard is answering for a database that is still " +
        "being built.",
    ).toBeGreaterThan(migrated);
  });

  /** The tenant this suite provisioned went all the way through, so it is servable AND converged. */
  it("a fully provisioned tenant is both servable and schema-converged", async () => {
    const verdict = await verifyTenantSchema(db, tenantMigrations);
    expect(verdict.ok).toBe(true);
    expect(SERVABLE_TENANT_STATUSES).toContain("active");
  });
});
