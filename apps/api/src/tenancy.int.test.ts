/**
 * TENANT ISOLATION SUITE — release-gating (Doc 05 §4.2, RISK_REGISTER T1).
 *
 * This suite exists to prove the single most important property of the platform:
 * one hospital can never see another hospital's data. It runs against a real
 * MongoDB and exercises the real Connection Manager, real registry, real
 * middleware and real tenantScope plugin — no mocks of the isolation path,
 * because a mock would prove nothing.
 *
 * Every new tenant-scoped collection must stay green under these tests.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Schema } from "mongoose";
import { assertMongoReachable, dropDatabases, TEST_MONGO_URI } from "./test/mongoTestEnv.js";

// Point the app's config at the test cluster BEFORE any module reads env.
process.env.MONGO_URI = TEST_MONGO_URI;
process.env.MONGO_MASTER_DB = "test_paperlesstech_master";
// `.test` is RESERVED by RFC 6761 and can never resolve on the public internet.
// The suite previously used the real production domain — which has wildcard DNS
// pointing at the live server, so any code path that ever performed a lookup
// would have reached out to production from a test run. A test must not be able
// to touch a system it is not testing, even by accident.
process.env.TENANT_BASE_DOMAIN = "medicore.test";
delete process.env.REDIS_URL; // exercise the DB path, not the cache, in isolation tests

const { getTenantConnection, closeAllTenantConnections, openConnectionCount } =
  await import("./core/db/connectionManager.js");
const { runWithContext } = await import("./core/context/requestContext.js");
const { tenantScopePlugin } = await import("./core/db/plugins/tenantScope.js");
const { provisionTenant, transitionStatus } = await import("./modules/tenants/index.js");
const { resolveTenantFromHost, slugFromHost, normalizeHost } =
  await import("./middleware/resolveTenant.js");
const { getMasterConnection, closeMaster } = await import("./core/db/masterDb.js");
const { pendingCount } = await import("./core/db/migrations/runner.js");
const { tenantMigrations } = await import("./core/db/migrations/tenantMigrations.js");

/** A stand-in clinical collection: the plugin must protect any tenant-scoped model. */
const patientSchema = new Schema({ name: String, uhid: String });
patientSchema.plugin(tenantScopePlugin);

const SLUG_A = "test-apollo";
const SLUG_B = "test-sunshine";
const DB_A = `hms_${SLUG_A}`;
const DB_B = `hms_${SLUG_B}`;

let tenantA: { id: string; databaseName: string };
let tenantB: { id: string; databaseName: string };

beforeAll(async () => {
  await assertMongoReachable();
  await dropDatabases(["test_paperlesstech_master", DB_A, DB_B]);

  const a = await provisionTenant({ hospitalName: "Apollo Test", slug: SLUG_A });
  const b = await provisionTenant({
    hospitalName: "Sunshine Test",
    slug: SLUG_B,
    customDomain: "hms.sunshine-test.com",
  });
  tenantA = { id: a.tenant.id, databaseName: a.tenant.databaseName };
  tenantB = { id: b.tenant.id, databaseName: b.tenant.databaseName };
}, 60_000);

afterAll(async () => {
  await closeAllTenantConnections();
  await closeMaster();
  await dropDatabases(["test_paperlesstech_master", DB_A, DB_B]);
}, 30_000);

describe("provisioning (BUSINESS_WORKFLOWS §13)", () => {
  it("creates a dedicated database named hms_<slug> and activates the tenant", async () => {
    expect(tenantA.databaseName).toBe(DB_A);
    expect(tenantB.databaseName).toBe(DB_B);

    const master = await getMasterConnection();
    const registry = await master.collection("tenants").findOne({ slug: SLUG_A });
    expect(registry?.status).toBe("active");
    expect(registry?.databaseName).toBe(DB_A);
  });

  it("converges each tenant database to the full migration set", async () => {
    for (const tenant of [tenantA, tenantB]) {
      const db = await getTenantConnection(tenant);
      const names = (await db.db!.listCollections().toArray()).map((c) => c.name);
      expect(names).toEqual(
        expect.arrayContaining(["counters", "outboxEvents", "auditLogs", "idempotencyKeys"]),
      );
      // Idempotent: a second run applies nothing.
      expect(await pendingCount(db, tenantMigrations)).toBe(0);
    }
  });

  it("rejects a duplicate slug instead of half-creating a tenant", async () => {
    await expect(provisionTenant({ hospitalName: "Dup", slug: SLUG_A })).rejects.toMatchObject({
      httpStatus: 409,
    });
  });

  it("rejects an unsafe slug (it becomes a database name and a subdomain)", async () => {
    await expect(provisionTenant({ hospitalName: "Bad", slug: "Bad Slug!" })).rejects.toMatchObject(
      { code: "HMS-VAL-001" },
    );
  });
});

describe("TENANT ISOLATION — the property the whole platform rests on", () => {
  it("writes land in the tenant's own database, invisible to the other tenant", async () => {
    const connA = await getTenantConnection(tenantA);
    const connB = await getTenantConnection(tenantB);
    const PatientA = connA.model("Patient", patientSchema);
    const PatientB = connB.model("Patient", patientSchema);

    await runWithContext(
      { traceId: "t1", tenantId: tenantA.id, tenantSlug: SLUG_A, connection: connA },
      async () => {
        await PatientA.create({ name: "Alice of Apollo", uhid: "A-001" });
      },
    );

    // Tenant B, querying its own connection, must see nothing.
    const seenByB = await runWithContext(
      { traceId: "t2", tenantId: tenantB.id, tenantSlug: SLUG_B, connection: connB },
      async () => PatientB.find({}).lean().exec(),
    );
    expect(seenByB).toHaveLength(0);

    // Tenant A sees exactly its own document.
    const seenByA = await runWithContext(
      { traceId: "t3", tenantId: tenantA.id, tenantSlug: SLUG_A, connection: connA },
      async () => PatientA.find({}).lean().exec(),
    );
    expect(seenByA).toHaveLength(1);
    expect(seenByA[0]).toMatchObject({ name: "Alice of Apollo", tenantId: tenantA.id });
  });

  it("physically separates the databases (proof at the driver level, below the ORM)", async () => {
    const connA = await getTenantConnection(tenantA);
    const connB = await getTenantConnection(tenantB);
    expect(connA.name).toBe(DB_A);
    expect(connB.name).toBe(DB_B);

    const rawA = await connA.db!.collection("patients").countDocuments();
    const rawB = await connB.db!.collection("patients").countDocuments();
    expect(rawA).toBe(1);
    expect(rawB).toBe(0); // no ORM filtering involved — the data simply is not there
  });

  it("stamps tenantId automatically (defense in depth, Doc 03 §1.3)", async () => {
    const connA = await getTenantConnection(tenantA);
    const PatientA = connA.model("Patient", patientSchema);
    const doc = await runWithContext(
      { traceId: "t4", tenantId: tenantA.id, tenantSlug: SLUG_A, connection: connA },
      async () => PatientA.create({ name: "Bob", uhid: "A-002" }),
    );
    expect(doc.get("tenantId")).toBe(tenantA.id);
    expect(doc.get("isDeleted")).toBe(false);
    expect(doc.get("schemaVersion")).toBe(1);
  });

  it("refuses a query that explicitly names a foreign tenantId", async () => {
    const connA = await getTenantConnection(tenantA);
    const PatientA = connA.model("Patient", patientSchema);
    await expect(
      runWithContext(
        { traceId: "t5", tenantId: tenantA.id, tenantSlug: SLUG_A, connection: connA },
        async () => PatientA.find({ tenantId: tenantB.id }).exec(),
      ),
    ).rejects.toThrow(/tenant scope violation/);
  });

  it("refuses to save a document carrying a foreign tenantId", async () => {
    const connA = await getTenantConnection(tenantA);
    const PatientA = connA.model("Patient", patientSchema);
    await expect(
      runWithContext(
        { traceId: "t6", tenantId: tenantA.id, tenantSlug: SLUG_A, connection: connA },
        async () => PatientA.create({ name: "Mallory", tenantId: tenantB.id }),
      ),
    ).rejects.toThrow(/tenant scope violation/);
  });

  it("throws rather than guessing when there is no tenant context at all", async () => {
    const connA = await getTenantConnection(tenantA);
    const PatientA = connA.model("Patient", patientSchema);
    // No runWithContext wrapper: a repository ran outside a resolved request.
    await expect(PatientA.find({}).exec()).rejects.toThrow(/No request context/);
  });

  it("hides soft-deleted documents by default", async () => {
    const connA = await getTenantConnection(tenantA);
    const PatientA = connA.model("Patient", patientSchema);
    await runWithContext(
      { traceId: "t7", tenantId: tenantA.id, tenantSlug: SLUG_A, connection: connA },
      async () => {
        await PatientA.updateOne({ uhid: "A-002" }, { isDeleted: true, deletedAt: new Date() });
        const visible = await PatientA.find({}).lean().exec();
        expect(visible.every((d) => (d as { uhid?: string }).uhid !== "A-002")).toBe(true);
      },
    );
  });
});

describe("host → tenant resolution (Doc 04 §2.2.1)", () => {
  it("parses hosts and extracts slugs", () => {
    expect(normalizeHost("Apollo.MediCore.test:3000")).toBe("apollo.medicore.test");
    expect(slugFromHost("apollo.medicore.test")).toBe("apollo");
    expect(slugFromHost("www.medicore.test")).toBeUndefined();
    expect(slugFromHost("medicore.test")).toBeUndefined();
    expect(slugFromHost("hms.apollohospital.com")).toBeUndefined(); // custom domain path
  });

  it("resolves a tenant by subdomain", async () => {
    const tenant = await resolveTenantFromHost(`${SLUG_A}.medicore.test`);
    expect(tenant?.id).toBe(tenantA.id);
  });

  it("resolves a tenant by verified custom domain", async () => {
    const tenant = await resolveTenantFromHost("hms.sunshine-test.com");
    expect(tenant?.id).toBe(tenantB.id);
  });

  it("does not resolve an unknown host", async () => {
    expect(await resolveTenantFromHost("nobody.medicore.test")).toBeUndefined();
    expect(await resolveTenantFromHost("evil.example.com")).toBeUndefined();
  });
});

describe("lifecycle guards (STATE_MACHINE_CATALOG §11)", () => {
  it("rejects an illegal transition instead of corrupting state", async () => {
    // active → purged is not a legal edge.
    await expect(transitionStatus(tenantB.id, "purged")).rejects.toMatchObject({
      code: "HMS-STATE-001",
    });
  });

  it("suspends a tenant and drops its cached connection", async () => {
    await getTenantConnection(tenantB); // ensure it is pooled
    const before = openConnectionCount();
    const suspended = await transitionStatus(tenantB.id, "suspended");
    expect(suspended.status).toBe("suspended");
    expect(openConnectionCount()).toBeLessThan(before);

    // Restore for other tests / reruns.
    await transitionStatus(tenantB.id, "active");
  });
});
