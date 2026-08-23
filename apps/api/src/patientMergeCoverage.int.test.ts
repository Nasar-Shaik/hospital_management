/**
 * PATIENT MERGE — DOES EVERY REFERENCE ACTUALLY FOLLOW THE SURVIVOR?
 *
 * ── THE INVARIANT, AND WHY IT WAS NOT HOLDING ────────────────────────────────
 * `core/db/repointPatient.ts` states it plainly: "EVERY module that stores a `patientId` must then
 * re-point its own references." It was a comment, and comments do not fail. An audit of the real
 * schemas found **thirteen collections across eleven modules** that stored a patient and consumed
 * nothing — the medication administration record, the consultation note, the coded diagnosis, ED
 * triage, theatre bookings and their operative notes, insurance cover and claims, consent, death
 * records, the mortuary register, ambulance trips, feedback tickets and the portal identity — plus
 * `packageEnrollments`, which sat INSIDE a module that already had a consumer and was missed by it.
 *
 * Nothing failed when a merge left them behind. That is the whole problem: the survivor's chart was
 * quietly short of a note, a dose history and a package the hospital had already been paid for, and
 * the only symptom was an absence.
 *
 * ── THE THREE THINGS THIS FILE PROVES ────────────────────────────────────────
 *   1. COVERAGE IS COMPLETE, structurally. Every registered model carrying a patient reference is
 *      either re-pointed or exempt for a written reason — read off the REAL schemas, not a list.
 *   2. THE REFERENCES ACTUALLY MOVE, duplicate → survivor, for every declared collection, through
 *      the real event and the real consumers.
 *   3. NOTHING IS DELETED ON THE WAY. A merge is a pointer, not a cull; the row count before and
 *      after is the same, with exactly one documented exception that is itself asserted.
 *
 * ── WHY THE ROWS ARE INSERTED THROUGH THE DRIVER ─────────────────────────────
 * The fixtures below write minimal documents with `collection.insertOne`, bypassing Mongoose. This
 * is deliberate. Building twenty-nine valid domain objects through their services would be a
 * thousand lines of fixture whose failure modes are all about the SERVICES, and the thing under
 * test is a `$set` on one field. Driving it generically off the register is also what makes the
 * suite pick up a new collection automatically instead of the day someone remembers.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { Types } from "mongoose";
import { createLogger } from "@medicore/logger";
import { assertMongoReachable, dropDatabases, TEST_MONGO_URI } from "./test/mongoTestEnv.js";
import { assertRedisReachable, flushTestCache, testRedisUrl } from "./test/redisTestEnv.js";

process.env.MONGO_URI = TEST_MONGO_URI;
process.env.REDIS_URL = testRedisUrl("mergeCoverage");
process.env.MONGO_MASTER_DB = "test_mergecov_master";
process.env.TENANT_BASE_DOMAIN = "medicore.test";

const { provisionTenant } = await import("./modules/tenants/index.js");
const { getTenantConnection, closeAllTenantConnections } =
  await import("./core/db/connectionManager.js");
const { closeMaster } = await import("./core/db/masterDb.js");
const { closeRedis } = await import("./core/redis/redis.js");
const { runWithContext } = await import("./core/context/requestContext.js");
const { seedRbac } = await import("./modules/rbac/index.js");
const { dispatchEventInline } = await import("./core/events/eventConsumer.js");
const { EVENTS } = await import("./core/events/eventCatalog.js");
const { REPOINTED_PATIENT_REFERENCES, EXEMPT_PATIENT_REFERENCES } =
  await import("./core/db/repointPatient.js");

createLogger({ service: "merge-coverage-int-test" });

const SLUG = "test-mergecov";
const DB = `hms_${SLUG}`;

let tenant: { id: string; slug: string; databaseName: string };
let connection: Awaited<ReturnType<typeof getTenantConnection>>;

const survivorId = new Types.ObjectId();
const duplicateId = new Types.ObjectId();

async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runWithContext(
    { traceId: "mergecov", tenantId: tenant.id, tenantSlug: SLUG, connection },
    fn,
  );
}

/**
 * Registers every model on the connection.
 *
 * Mongoose only knows a model once its getter has been called, so a guard that read
 * `connection.models` on a fresh connection would find almost nothing and pass vacuously — the
 * worst possible outcome for a coverage check. Every `*.model.ts` is imported and every
 * `get…Model(conn)` export invoked, so a model file added tomorrow is registered here with no edit
 * to this suite. That is the property that makes the guard structural rather than another list.
 */
async function registerEveryModel(): Promise<void> {
  const root = join(import.meta.dirname, "modules");
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const file of readdirSync(join(root, dir.name))) {
      if (!file.endsWith(".model.ts")) continue;
      const mod = (await import(`./modules/${dir.name}/${file.replace(/\.ts$/, ".js")}`)) as Record<
        string,
        unknown
      >;
      for (const [name, value] of Object.entries(mod)) {
        if (/^get[A-Za-z]*Model$/.test(name) && typeof value === "function") {
          (value as (c: typeof connection) => unknown)(connection);
        }
      }
    }
  }
}

/** Collections whose schema declares a `patientId`, read off the registered models. */
function patientBearingCollections(): { collection: string; as: "ObjectId" | "string" }[] {
  const out: { collection: string; as: "ObjectId" | "string" }[] = [];
  for (const name of connection.modelNames()) {
    const model = connection.model(name);
    const path = model.schema.path("patientId");
    if (!path) continue;
    out.push({
      collection: model.collection.collectionName,
      as: path.instance === "ObjectId" ? "ObjectId" : "string",
    });
  }
  return out;
}

beforeAll(async () => {
  await assertMongoReachable();
  await assertRedisReachable();
  await dropDatabases(["test_mergecov_master", DB]);
  await flushTestCache("mergeCoverage");

  const provisioned = await provisionTenant({
    hospitalName: "Merge Coverage",
    slug: SLUG,
    planCode: "PLAN_ENTERPRISE",
  });
  tenant = {
    id: provisioned.tenant.id,
    slug: SLUG,
    databaseName: provisioned.tenant.databaseName,
  };
  connection = await getTenantConnection({ id: tenant.id, databaseName: tenant.databaseName });
  await inTenant(seedRbac);
  await registerEveryModel();
}, 120_000);

afterAll(async () => {
  await closeAllTenantConnections();
  await closeMaster();
  await closeRedis();
  await dropDatabases(["test_mergecov_master", DB]);
}, 30_000);

/* ────────────────────────────────────────────────────────────────────────────
 * 1. THE STRUCTURAL GUARD
 * ──────────────────────────────────────────────────────────────────────────── */

describe("1. every patient-bearing collection is accounted for", () => {
  it("registers enough models to be worth checking", () => {
    // A vacuous pass is the failure mode this guard is most exposed to: if nothing were
    // registered, every assertion below would hold over an empty set.
    expect(connection.modelNames().length).toBeGreaterThan(30);
    expect(patientBearingCollections().length).toBeGreaterThan(20);
  });

  it("is either re-pointed or exempt — never neither", () => {
    const known = new Set([
      ...REPOINTED_PATIENT_REFERENCES.map((r) => r.collection),
      ...EXEMPT_PATIENT_REFERENCES.map((r) => r.collection),
    ]);
    const orphans = patientBearingCollections()
      .map((c) => c.collection)
      .filter((c) => !known.has(c));

    expect(
      orphans,
      `these collections store a patientId and no merge consumer moves it — add a consumer, or ` +
        `list them in EXEMPT_PATIENT_REFERENCES with a reason: ${orphans.join(", ")}`,
    ).toEqual([]);
  });

  it("declares the reference type the schema actually uses", () => {
    /**
     * THIS is what catches a wrong `objectId` flag — not the behaviour.
     *
     * Flipping theatres from `false` to `true` was tried, and every lifecycle assertion below
     * still passed: `repointPatientId` is handed a Mongoose MODEL, and Mongoose casts a query
     * value to the schema's declared type, so it silently repairs the mistake. (The helper's
     * comment claimed the opposite until this was measured.) The flag would matter against a raw
     * collection handle, so it stays stated rather than guessed — and this assertion is what makes
     * the statement true, by reading the type off the schema instead of trusting the register.
     */
    const actual = new Map(patientBearingCollections().map((c) => [c.collection, c.as]));
    const wrong = REPOINTED_PATIENT_REFERENCES.filter(
      (r) => actual.has(r.collection) && actual.get(r.collection) !== r.as,
    ).map(
      (r) => `${r.collection}: declared ${r.as}, schema says ${String(actual.get(r.collection))}`,
    );

    expect(wrong).toEqual([]);
  });

  it("has no stale entry pointing at a collection that no longer carries a patient", () => {
    const actual = new Set(patientBearingCollections().map((c) => c.collection));
    // `auditLogs` and `outboxEvents` reference a patient inside a generic field rather than a
    // declared `patientId` path, so they are expected NOT to appear — see their exemption reasons.
    const generic = new Set(["auditLogs", "outboxEvents"]);
    const stale = [
      ...REPOINTED_PATIENT_REFERENCES.map((r) => r.collection),
      ...EXEMPT_PATIENT_REFERENCES.map((r) => r.collection),
    ].filter((c) => !actual.has(c) && !generic.has(c));

    expect(stale).toEqual([]);
  });

  it("gives every exemption a reason somebody wrote", () => {
    for (const exempt of EXEMPT_PATIENT_REFERENCES) {
      expect(exempt.why.length, `${exempt.collection} is exempt with no reason`).toBeGreaterThan(
        40,
      );
    }
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2. THE LIFECYCLE — duplicate → survivor, through the real event
 * ──────────────────────────────────────────────────────────────────────────── */

/** A minimal row carrying nothing but the reference under test. */
function seedRow(ref: (typeof REPOINTED_PATIENT_REFERENCES)[number], patient: Types.ObjectId) {
  return {
    tenantId: tenant.id,
    /**
     * `isDeleted: false` is not decoration. `tenantScopePlugin` adds it to every scoped query, and
     * Mongo does not match a missing field against `false` — so a row inserted through the driver
     * without it is invisible to the very `updateMany` under test, and every assertion here would
     * fail for a reason that has nothing to do with merging. The schema default writes it on a
     * real document; the fixture has to write it itself.
     */
    isDeleted: false,
    patientId: ref.as === "ObjectId" ? patient : patient.toString(),
    // `walletAccounts` folds a balance rather than moving the row; give it something to fold.
    ...(ref.collection === "walletAccounts" ? { balance: 250_00 } : {}),
  };
}

async function seedAll(): Promise<void> {
  for (const ref of REPOINTED_PATIENT_REFERENCES) {
    await connection.collection(ref.collection).deleteMany({ tenantId: tenant.id });
    await connection.collection(ref.collection).insertOne(seedRow(ref, duplicateId));
  }
}

async function mergeEvent(): Promise<void> {
  await inTenant(() =>
    dispatchEventInline({
      eventId: `evt-merge-${String(Date.now())}`,
      name: EVENTS.PATIENTS_MERGED,
      version: 1,
      tenantId: tenant.id,
      occurredAt: new Date().toISOString(),
      payload: { survivorId: survivorId.toString(), mergedId: duplicateId.toString() },
    }),
  );
}

/** How many rows in `collection` point at `patient`, whichever way the reference is stored. */
async function pointingAt(
  ref: (typeof REPOINTED_PATIENT_REFERENCES)[number],
  patient: Types.ObjectId,
): Promise<number> {
  return connection.collection(ref.collection).countDocuments({
    patientId: ref.as === "ObjectId" ? patient : patient.toString(),
  });
}

describe("2. every declared reference moves to the survivor", () => {
  beforeEach(async () => {
    await seedAll();
    await mergeEvent();
  });

  // `walletAccounts` is the one collection that does not simply move — one purse per patient, so
  // the duplicate's account is folded into the survivor's and removed. Asserted on its own below.
  const moving = REPOINTED_PATIENT_REFERENCES.filter((r) => r.collection !== "walletAccounts");

  it.each(moving.map((r) => [r.collection, r] as const))(
    "%s follows the surviving patient",
    async (_name, ref) => {
      expect(await pointingAt(ref, duplicateId)).toBe(0);
      expect(await pointingAt(ref, survivorId)).toBe(1);
    },
  );

  it("moves an ObjectId-backed reference — the coded diagnosis", async () => {
    const coding = REPOINTED_PATIENT_REFERENCES.find((r) => r.collection === "encounterCodings");
    expect(coding?.as).toBe("ObjectId");
    const row = await connection.collection("encounterCodings").findOne({ tenantId: tenant.id });
    // Stored as a real ObjectId, not the string that would have been written by a wrong flag.
    expect(row?.patientId).toBeInstanceOf(Types.ObjectId);
    expect(String(row?.patientId)).toBe(survivorId.toString());
  });

  it("moves a string-backed reference — the medication administration record", async () => {
    const mar = REPOINTED_PATIENT_REFERENCES.find(
      (r) => r.collection === "medicationAdministrations",
    );
    expect(mar?.as).toBe("string");
    const row = await connection
      .collection("medicationAdministrations")
      .findOne({ tenantId: tenant.id });
    expect(typeof row?.patientId).toBe("string");
    expect(row?.patientId).toBe(survivorId.toString());
  });

  it("moves the money that was missed — package enrolments", async () => {
    /**
     * This one lived inside a module that ALREADY had a consumer, and the consumer moved charges
     * and invoices and not enrolments. An enrolment is what zeroes the covered codes on a bill, so
     * the survivor was billed full price for care already paid for under a package.
     */
    const enrolment = REPOINTED_PATIENT_REFERENCES.find(
      (r) => r.collection === "packageEnrollments",
    );
    expect(enrolment).toBeDefined();
    const row = await connection.collection("packageEnrollments").findOne({ tenantId: tenant.id });
    expect(String(row?.patientId)).toBe(survivorId.toString());
  });

  it("is idempotent — a redelivered event moves nothing a second time", async () => {
    // At-least-once delivery (ADR-0007): the consumer WILL see this event again.
    await mergeEvent();
    await mergeEvent();
    for (const ref of moving) {
      expect(await pointingAt(ref, survivorId)).toBe(1);
      expect(await pointingAt(ref, duplicateId)).toBe(0);
    }
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3. NOTHING IS DELETED
 * ──────────────────────────────────────────────────────────────────────────── */

describe("3. a merge is a pointer, never a cull", () => {
  it("keeps every row it touched", async () => {
    await seedAll();
    const before = new Map<string, number>();
    for (const ref of REPOINTED_PATIENT_REFERENCES) {
      before.set(ref.collection, await connection.collection(ref.collection).countDocuments({}));
    }

    await mergeEvent();

    for (const ref of REPOINTED_PATIENT_REFERENCES) {
      const after = await connection.collection(ref.collection).countDocuments({});
      if (ref.collection === "walletAccounts") continue; // the one exception, asserted next
      expect(after, `${ref.collection} lost a row to a merge`).toBe(before.get(ref.collection));
    }
  });

  it("folds the duplicate's purse into the survivor's rather than losing the money", async () => {
    /**
     * The documented exception, and it is a deliberate one: a patient has ONE wallet account, so
     * two cannot both survive. What must never happen is the balance evaporating with the row —
     * so this asserts the money arrived, not merely that the row went.
     */
    await seedAll();
    await mergeEvent();

    const accounts = connection.collection("walletAccounts");
    expect(await accounts.countDocuments({ patientId: duplicateId })).toBe(0);
    const survivorAccount = await accounts.findOne({ patientId: survivorId });
    expect(survivorAccount).not.toBeNull();
    expect(survivorAccount?.balance).toBe(250_00);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 4. THE COLLISION THIS AUDIT FOUND — A KNOWN DEFECT, PINNED
 * ──────────────────────────────────────────────────────────────────────────── */

describe("4. two open encounters collide, and the merge half-applies", () => {
  /**
   * ⚠️ THIS TEST ASSERTS A DEFECT, NOT A FEATURE. It is here so the behaviour cannot change
   * without somebody noticing, and so the fix — when it is made — has a test that turns red.
   *
   * `encounters` carries a unique partial index on `{tenantId, patientId}` where `open: true`:
   * "a patient has at most one open encounter" (clinicalInvariants.ts, migration 0012). The
   * re-point is a bare `updateMany`, so when the duplicate AND the survivor each have a visit
   * open, the update asks that index for exactly what it exists to refuse:
   *
   *     E11000 duplicate key error … index: one_open_encounter_per_patient
   *
   * This is not an exotic shape. It is the COMMONEST real merge — a clerk registers the same
   * walk-in twice on one morning and starts a visit on each, which is precisely the pair the MPI
   * asks a human to reconcile.
   *
   * What makes it serious is where the throw lands. `dispatchEvent` runs the handlers under
   * `Promise.allSettled` and throws afterwards, so every OTHER module has already re-pointed by
   * the time anything fails: the patient is marked merged, the bills, the notes and the doses have
   * moved, and the encounters have not. The job then retries and fails the same way, forever. The
   * survivor's chart is missing the duplicate's entire visit history and nothing on any screen
   * says so.
   *
   * NOT FIXED HERE, deliberately. Deciding which of two open visits closes is clinical
   * reconciliation, and the sane fix is upstream — refuse the merge in `mergePatients` and tell
   * the clerk to close one visit first, which keeps the decision with the human the MPI already
   * insists on. That is a change to merge semantics and belongs in its own slice with its own
   * error code.
   */
  it("throws on the unique index and leaves the duplicate's encounter behind", async () => {
    const encounters = connection.collection("encounters");
    await encounters.deleteMany({ tenantId: tenant.id });
    for (const patient of [duplicateId, survivorId]) {
      await encounters.insertOne({
        tenantId: tenant.id,
        isDeleted: false,
        patientId: patient,
        open: true,
      });
    }

    await expect(mergeEvent()).rejects.toThrow(/E11000|duplicate key/);

    // The duplicate's visit is still on the duplicate — the half that did not apply.
    expect(await encounters.countDocuments({ patientId: duplicateId })).toBe(1);
    expect(await encounters.countDocuments({ patientId: survivorId })).toBe(1);
  });

  it("moves cleanly when only one of the two has a visit open", async () => {
    /**
     * The control. Without it the test above could be read as "merging encounters never works",
     * and the actual condition — BOTH open — would be lost.
     */
    const encounters = connection.collection("encounters");
    await encounters.deleteMany({ tenantId: tenant.id });
    await encounters.insertOne({
      tenantId: tenant.id,
      isDeleted: false,
      patientId: duplicateId,
      open: true,
    });

    await mergeEvent();

    expect(await encounters.countDocuments({ patientId: duplicateId })).toBe(0);
    expect(await encounters.countDocuments({ patientId: survivorId })).toBe(1);
  });
});
