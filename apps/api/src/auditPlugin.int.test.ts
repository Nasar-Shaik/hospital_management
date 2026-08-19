/**
 * THE AUDIT TRAIL ITSELF — what it records, and when it must record nothing (D17).
 *
 * ── WHY THIS FILE EXISTS AT ALL ─────────────────────────────────────────────
 * Doc 09 §9 requires an audit entry for every mutation of PHI or financial data, and
 * `auditPlugin` is the mechanism that makes that true without asking developers to remember. When
 * D17 was found on 2026-08-19 the plugin had been carrying that requirement for the whole project
 * and **not one test asserted that it wrote anything.** Route permissions were covered, the CSV
 * content type was covered, the page loaded in Playwright — the trail's contents were not. So a
 * whole branch of it could be wrong for months, and was: the query-path post hook returned early
 * whenever there was no pre-image, which silently discarded the FIRST write of every document
 * created by an upsert. The first ED triage of a patient produced no audit row; a later re-triage
 * produced one.
 *
 * ── THE INVARIANT ───────────────────────────────────────────────────────────
 * A successful first write is a CREATE, however it was implemented. A later mutation is an UPDATE.
 * A write that changed nothing, or failed, is neither — the trail must not contain a record of a
 * change that did not happen.
 *
 * ── WHY IT DRIVES REAL ROUTES ───────────────────────────────────────────────
 * The actor, tenant, branch and trace id all come from the request context. A model-level test
 * would have to build that context by hand and would therefore prove that the context it invented
 * arrives — not that the one a nurse's request carries does. Where no route can produce the shape
 * (an `updateOne` upsert, a write that fails on a unique index), the model is driven directly and
 * the comment says so.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { Types } from "mongoose";
import { listening } from "./test/appServer.js";
import { createLogger } from "@medicore/logger";
import { assertMongoReachable, dropDatabases, TEST_MONGO_URI } from "./test/mongoTestEnv.js";
import { assertRedisReachable, flushTestCache, testRedisUrl } from "./test/redisTestEnv.js";

process.env.MONGO_URI = TEST_MONGO_URI;
process.env.REDIS_URL = testRedisUrl("auditPlugin");
process.env.MONGO_MASTER_DB = "test_auditplugin_master";
process.env.TENANT_BASE_DOMAIN = "medicore.test";

const { createApp } = await import("./app.js");
const { provisionTenant } = await import("./modules/tenants/index.js");
const { getTenantConnection, closeAllTenantConnections } =
  await import("./core/db/connectionManager.js");
const { closeMaster } = await import("./core/db/masterDb.js");
const { closeRedis } = await import("./core/redis/redis.js");
const { runWithContext } = await import("./core/context/requestContext.js");
const { createUser, transitionStatus } = await import("./modules/users/index.js");
const { assignRoleByCode, seedRbac } = await import("./modules/rbac/index.js");
const { setPassword } = await import("./modules/auth/index.js");
const { seedTariff } = await import("./seed/tariff.js");
const { hashAuditEntry } = await import("./core/audit/auditWriter.js");
const { getIcdCodeModel } = await import("./modules/mrd/mrd.model.js");
const { getEdTriageModel } = await import("./modules/emergency/emergency.model.js");

const SLUG = "test-auditplugin";
const RIVAL_SLUG = "test-auditplugin-rival";
const DB = `hms_${SLUG}`;
const RIVAL_DB = `hms_${RIVAL_SLUG}`;
const PASSWORD = "V4lid!Password#2026";

const app = await listening(createApp(createLogger({ service: "audit-plugin-int-test" })));

interface Site {
  id: string;
  slug: string;
  host: string;
  admin: string;
  connection: Awaited<ReturnType<typeof getTenantConnection>>;
}

const main = {} as Site;
const rival = {} as Site;

let doctorToken = "";
let doctorId = "";
let nurseToken = "";
let nurseId = "";
let nurseBToken = "";
let deskToken = "";
let siteA = "";
let siteB = "";
let phone = 9_910_000_000;

function req(
  method: "get" | "post",
  path: string,
  token: string,
  host: string,
  activeBranch?: string,
): request.Test {
  const r = request(app)[method](path).set("Host", host).set("Authorization", `Bearer ${token}`);
  return activeBranch ? r.set("X-Active-Branch", activeBranch) : r;
}

async function login(host: string, email: string): Promise<string> {
  const res = await request(app)
    .post("/api/v1/auth/login")
    .set("Host", host)
    .send({ email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login ${email}: ${res.status} ${res.text}`);
  return res.body.data.accessToken as string;
}

async function makeUser(email: string, name: string, role: string, branchIds: string[]) {
  const u = await createUser({ email, name, status: "invited" });
  await setPassword(u.id, PASSWORD, { mustChangePassword: false });
  await assignRoleByCode(u.id, role, branchIds);
  await transitionStatus(u.id, "active");
  return u.id;
}

interface AuditRow {
  _id: unknown;
  seq: number;
  action: string;
  category: string;
  resource: string;
  resourceId?: string;
  outcome: string;
  actorId?: string;
  actorEmail?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  branchId?: string;
  traceId?: string;
  tenantId: string;
}

/** Every trail entry about one document, oldest first. The trail is append-only, so this grows. */
async function trailFor(resourceId: string, site: Site = main): Promise<AuditRow[]> {
  return (await site.connection
    .collection("auditLogs")
    .find({ resourceId })
    .sort({ seq: 1 })
    .toArray()) as unknown as AuditRow[];
}

/**
 * The triage DOCUMENT's id. The triage contract deliberately returns the clinical facts and no
 * `id` — the board is keyed on the encounter — so the trail, which is keyed on the document, has
 * to be looked up through the collection.
 */
async function triageIdFor(encounterId: string, site: Site = main): Promise<string> {
  const doc = await site.connection
    .collection("edTriage")
    .findOne({ encounterId: new Types.ObjectId(encounterId) });
  expect(doc, `no triage row for encounter ${encounterId}`).toBeTruthy();
  return String((doc as { _id: unknown })._id);
}

/** An ED arrival, registered the ordinary way, ready to be triaged. */
async function arrive(name: string, branch = siteA): Promise<{ encounterId: string }> {
  phone += 1;
  const patient = await req("post", "/api/v1/patients", deskToken, main.host, branch)
    .send({ name, gender: "female", contact: { phone: String(phone) } })
    .expect(201);
  const enc = await req("post", "/api/v1/encounters", deskToken, main.host, branch)
    .send({
      patientId: patient.body.data.patient.id,
      origin: "emergency",
      class: "ER",
      doctorId,
      departmentId: doctorId,
    })
    .expect(201);
  return { encounterId: enc.body.data.encounter.id as string };
}

beforeAll(async () => {
  await assertMongoReachable();
  await assertRedisReachable();
  await dropDatabases([process.env.MONGO_MASTER_DB as string, DB, RIVAL_DB]);
  await flushTestCache("auditPlugin");

  for (const [site, slug, branches] of [
    [main, SLUG, 2],
    [rival, RIVAL_SLUG, 1],
  ] as [Site, string, number][]) {
    const t = await provisionTenant({
      hospitalName: slug,
      slug,
      planCode: "PLAN_HOSPITAL",
      organizationType: "private_hospital",
      maxBranches: branches,
    });
    site.id = t.tenant.id;
    site.slug = slug;
    site.host = `${slug}.medicore.test`;
    site.connection = await getTenantConnection({
      id: t.tenant.id,
      databaseName: t.tenant.databaseName,
    });
    await seedTariff(t.tenant.id, slug, site.connection);
    await runWithContext(
      {
        traceId: `setup-${slug}`,
        tenantId: site.id,
        tenantSlug: slug,
        connection: site.connection,
      },
      async () => {
        await seedRbac();
        await makeUser(`admin@${slug}.test`, "Admin", "TENANT_ADMIN", []);
      },
    );
    site.admin = await login(site.host, `admin@${slug}.test`);
  }

  siteA = (await req("get", "/api/v1/branches", main.admin, main.host).expect(200)).body.data[0]
    .id as string;
  siteB = (
    await req("post", "/api/v1/branches", main.admin, main.host)
      .send({ name: "Riverside", code: "RIV" })
      .expect(201)
  ).body.data.id as string;

  await runWithContext(
    { traceId: "setup-staff", tenantId: main.id, tenantSlug: SLUG, connection: main.connection },
    async () => {
      doctorId = await makeUser(`doc@${SLUG}.test`, "Dr Rao", "DOCTOR", [siteA, siteB]);
      nurseId = await makeUser(`nurse@${SLUG}.test`, "Sister Fatima", "NURSE", [siteA]);
      await makeUser(`nurseb@${SLUG}.test`, "Sister Grace", "NURSE", [siteB]);
      await makeUser(`front@${SLUG}.test`, "Front Desk", "RECEPTIONIST", [siteA, siteB]);
    },
  );
  doctorToken = await login(main.host, `doc@${SLUG}.test`);
  nurseToken = await login(main.host, `nurse@${SLUG}.test`);
  nurseBToken = await login(main.host, `nurseb@${SLUG}.test`);
  deskToken = await login(main.host, `front@${SLUG}.test`);
}, 240_000);

afterAll(async () => {
  await closeAllTenantConnections();
  await closeMaster();
  await closeRedis();
});

/* ══ 1. a first write is a CREATE, however it was implemented ════════════════ */

describe("a document created by an upsert is in the trail", () => {
  /**
   * ── THE D17 REGRESSION ────────────────────────────────────────────────────
   * `recordTriage` is an upsert, so before the fix this produced NOTHING. The assertion is not
   * "some audit row exists" — it is that exactly one exists, that it says `created`, and that it
   * carries the nurse who made the judgement rather than a system default.
   */
  it("records the FIRST triage as a create, with the nurse who made it", async () => {
    const { encounterId } = await arrive("First Ever Triage");

    await req("post", "/api/v1/emergency/triage", nurseToken, main.host, siteA)
      .send({ encounterId, priority: "critical", chiefComplaint: "Crushing central chest pain" })
      .expect(201);
    const triageId = await triageIdFor(encounterId);

    const trail = await trailFor(triageId);
    expect(
      trail.map((r) => r.action),
      "the first write of a document created by an upsert produced no audit entry (D17)",
    ).toEqual(["edTriage.created"]);

    const [entry] = trail;
    expect(entry?.resource).toBe("edTriage");
    expect(entry?.category).toBe("phi");
    expect(entry?.outcome).toBe("success");

    // CREATE: no before-image, and the after carries what was actually written.
    expect(entry?.before, "a create must not claim a previous version").toBeUndefined();
    expect(entry?.after?.priority).toBe("critical");
    expect(entry?.after?.chiefComplaint).toBe("Crushing central chest pain");
    expect(entry?.meta?.fields).toEqual(expect.arrayContaining(["priority", "chiefComplaint"]));

    // Actor, tenant, branch, trace — all from the request, none of them defaulted.
    expect(entry?.actorId, "the trail must name the real authenticated actor").toBe(nurseId);
    expect(entry?.actorEmail).toBe(`nurse@${SLUG}.test`);
    expect(entry?.tenantId).toBe(main.id);
    expect(entry?.branchId).toBe(siteA);
    expect(entry?.traceId).toBeTruthy();
  });

  /**
   * The other half of the invariant, and the half that used to be the ONLY half: a second write
   * to the same document is an update, and it carries both sides of what moved.
   */
  it("records the re-triage as an update, naming the doctor who revised it", async () => {
    const { encounterId } = await arrive("Revised On Review");

    await req("post", "/api/v1/emergency/triage", nurseToken, main.host, siteA)
      .send({ encounterId, priority: "critical", chiefComplaint: "Chest pain" })
      .expect(201);
    const triageId = await triageIdFor(encounterId);

    await req("post", "/api/v1/emergency/triage", doctorToken, main.host, siteA)
      .send({ encounterId, priority: "urgent", chiefComplaint: "Settled after GTN" })
      .expect(201);

    const trail = await trailFor(triageId);
    expect(trail.map((r) => r.action)).toEqual(["edTriage.created", "edTriage.updated"]);

    const update = trail[1];
    expect(update?.before?.priority, "the update must show what it moved FROM").toBe("critical");
    expect(update?.after?.priority, "…and what it moved TO").toBe("urgent");
    expect(update?.before?.chiefComplaint).toBe("Chest pain");
    expect(update?.after?.chiefComplaint).toBe("Settled after GTN");

    /**
     * Each entry names its OWN actor. A trail that stamped every row with the last writer would
     * satisfy a weaker test and would be useless in exactly the investigation it exists for.
     */
    expect(trail[0]?.actorEmail).toBe(`nurse@${SLUG}.test`);
    expect(update?.actorEmail).toBe(`doc@${SLUG}.test`);

    // The create is not rewritten by the update — the trail is append-only.
    expect(trail[0]?.after?.priority).toBe("critical");
  });

  /**
   * `updateOne` reports an insert as `upsertedId` rather than by returning the document, so it
   * reaches the plugin's create path by a different route than `findOneAndUpdate`. No HTTP route
   * uses it today; the plugin supports it, and support nothing proves is support that rots.
   */
  it("records a create made through updateOne + upsert", async () => {
    const code = `Z${String(Date.now()).slice(-5)}`;
    const created = await runWithContext(
      {
        traceId: "updateone-upsert",
        tenantId: main.id,
        tenantSlug: SLUG,
        connection: main.connection,
        userId: nurseId,
        userEmail: `nurse@${SLUG}.test`,
      },
      async () => {
        await getIcdCodeModel(main.connection).updateOne(
          { code },
          { $set: { title: "Made by an upsert", active: true } },
          { upsert: true },
        );
        return main.connection.collection("icdCodes").findOne({ code });
      },
    );
    expect(created, "the upsert did not create the document").toBeTruthy();

    const trail = await trailFor(String((created as { _id: unknown })._id));
    expect(trail.map((r) => r.action)).toEqual(["icdCode.created"]);
    expect(trail[0]?.before).toBeUndefined();
    expect(trail[0]?.after?.code).toBe(code);
    expect(trail[0]?.actorEmail).toBe(`nurse@${SLUG}.test`);
  });
});

/* ══ 2. and a write that did not happen is NOT in the trail ══════════════════ */

describe("nothing that did not happen is recorded", () => {
  /**
   * The case the old early return was protecting, and the reason the fix could not simply delete
   * it: a query that matches nothing and does not upsert changed nothing. An audit row here would
   * be a fabricated event — worse than a missing one, because it is trusted.
   */
  it("writes nothing when the filter matched nothing and no upsert was asked for", async () => {
    const before = await main.connection.collection("auditLogs").countDocuments();

    await runWithContext(
      {
        traceId: "no-match",
        tenantId: main.id,
        tenantSlug: SLUG,
        connection: main.connection,
        userId: nurseId,
        userEmail: `nurse@${SLUG}.test`,
      },
      async () => {
        const res = await getIcdCodeModel(main.connection).findOneAndUpdate(
          { code: "NOSUCHCODE" },
          { $set: { title: "should not exist" } },
          { new: true },
        );
        expect(res, "the fixture is wrong — this was supposed to match nothing").toBeNull();
      },
    );

    expect(
      await main.connection.collection("auditLogs").countDocuments(),
      "a write that matched nothing put an entry in the trail",
    ).toBe(before);
  });

  /**
   * ── THE ONE THAT DECIDES WHETHER THIS FIX SCALES ──────────────────────────
   * Seeds are documented as safe to re-run, and they are upserts on audited catalogues — this fix
   * is why provisioning now records the ~150 rows it creates, which is a good thing and the reason
   * "who added this ICD code?" has an answer at all. It would stop being a good thing immediately
   * if every re-run appended another 150. It does not: an upsert that matches an identical
   * document produces an empty delta, and `write` returns before recording anything.
   */
  it("records a re-run of an identical upsert once, not twice", async () => {
    const code = `Y${String(Date.now()).slice(-5)}`;
    const ctx = {
      traceId: "reseed",
      tenantId: main.id,
      tenantSlug: SLUG,
      connection: main.connection,
      userId: nurseId,
      userEmail: `nurse@${SLUG}.test`,
    };
    // Awaited INSIDE the context: a Mongoose query executes when it is awaited, and awaiting the
    // return of `runWithContext` would run it after the async-local scope had already closed.
    const seed = async () => {
      await getIcdCodeModel(main.connection).updateOne(
        { code },
        { $set: { title: "Seeded twice", active: true } },
        { upsert: true },
      );
    };

    await runWithContext(ctx, seed);
    await runWithContext(ctx, seed);

    const doc = await main.connection.collection("icdCodes").findOne({ code });
    const trail = await trailFor(String((doc as { _id: unknown })._id));
    expect(
      trail.map((r) => r.action),
      "re-running an idempotent seed appended a second entry for an unchanged document",
    ).toEqual(["icdCode.created"]);
  });

  /**
   * A FAILED mutation. `one_triage_per_encounter` refuses a second triage row for one visit, so
   * this insert dies on the unique index. Mongoose does not run post hooks for a query that threw
   * — this asserts that, rather than assuming it, because "the audit says it happened" about a
   * write that was rejected is the worst entry the trail can contain.
   */
  it("writes nothing when the mutation itself fails", async () => {
    const { encounterId } = await arrive("Duplicate Refused");
    await req("post", "/api/v1/emergency/triage", nurseToken, main.host, siteA)
      .send({ encounterId, priority: "urgent" })
      .expect(201);

    const before = await main.connection.collection("auditLogs").countDocuments();

    await runWithContext(
      {
        traceId: "failed-write",
        tenantId: main.id,
        tenantSlug: SLUG,
        connection: main.connection,
        userId: nurseId,
        userEmail: `nurse@${SLUG}.test`,
      },
      async () => {
        // A filter that cannot match the existing row, so the upsert INSERTS — straight into the
        // unique index on { tenantId, encounterId }.
        await expect(
          getEdTriageModel(main.connection).findOneAndUpdate(
            { encounterId: new Types.ObjectId(encounterId), priority: "non_urgent" },
            { $set: { patientId: new Types.ObjectId(), chiefComplaint: "second row" } },
            { new: true, upsert: true },
          ),
        ).rejects.toThrow();
      },
    );

    expect(
      await main.connection.collection("auditLogs").countDocuments(),
      "a mutation that was refused by the database still produced an audit entry",
    ).toBe(before);
  });

  /** A refusal above the database — the D14 guard — must not leave a trace either. */
  it("writes nothing when the service refuses the request", async () => {
    const { encounterId } = await arrive("Already Gone");
    await req("post", "/api/v1/emergency/triage", nurseToken, main.host, siteA)
      .send({ encounterId, priority: "critical" })
      .expect(201);
    await req("post", "/api/v1/emergency/transfer-out", doctorToken, main.host, siteA)
      .send({ encounterId, destination: "St Jude" })
      .expect(201);

    const before = await main.connection.collection("auditLogs").countDocuments();
    await req("post", "/api/v1/emergency/triage", nurseToken, main.host, siteA)
      .send({ encounterId, priority: "non_urgent" })
      .expect(409);

    expect(
      await main.connection.collection("auditLogs").countDocuments(),
      "a refused triage was recorded as though it had happened",
    ).toBe(before);
  });
});

/* ══ 3. the boundaries the trail must respect ═══════════════════════════════ */

describe("the trail belongs to one hospital and one branch", () => {
  it("keeps another hospital's creates out of this one's trail", async () => {
    const mainBefore = await main.connection.collection("auditLogs").countDocuments();

    // The rival hospital does its own admin work — an audited create in its own database.
    const rivalCode = `R${String(Date.now()).slice(-5)}`;
    const rivalDoc = await runWithContext(
      {
        traceId: "rival-write",
        tenantId: rival.id,
        tenantSlug: RIVAL_SLUG,
        connection: rival.connection,
        userId: "rival-user",
        userEmail: `admin@${RIVAL_SLUG}.test`,
      },
      async () => {
        await getIcdCodeModel(rival.connection).findOneAndUpdate(
          { code: rivalCode },
          { $set: { title: "Rival only", active: true } },
          { new: true, upsert: true },
        );
        return rival.connection.collection("icdCodes").findOne({ code: rivalCode });
      },
    );

    const rivalId = String((rivalDoc as { _id: unknown })._id);
    expect((await trailFor(rivalId, rival)).map((r) => r.action)).toEqual(["icdCode.created"]);

    expect(await trailFor(rivalId, main), "another hospital's entry reached this trail").toEqual(
      [],
    );
    expect(await main.connection.collection("auditLogs").countDocuments()).toBe(mainBefore);
  });

  it("stamps the branch the work was actually done in", async () => {
    const a = await arrive("Branch A Patient", siteA);
    const b = await arrive("Branch B Patient", siteB);

    await req("post", "/api/v1/emergency/triage", nurseToken, main.host, siteA)
      .send({ encounterId: a.encounterId, priority: "urgent" })
      .expect(201);
    await req("post", "/api/v1/emergency/triage", nurseBToken, main.host, siteB)
      .send({ encounterId: b.encounterId, priority: "urgent" })
      .expect(201);

    expect((await trailFor(await triageIdFor(a.encounterId)))[0]?.branchId).toBe(siteA);
    expect((await trailFor(await triageIdFor(b.encounterId)))[0]?.branchId).toBe(siteB);
  });
});

/* ══ 4. the chain still verifies with the new entries in it ═════════════════ */

describe("the tamper-evident chain", () => {
  /**
   * Every entry is hashed over a fixed projection and the chain is verified end to end. The create
   * entries this fix adds are new SHAPES in that chain — a first entry with no `before` key at all
   * — so this is the assertion that the fix did not quietly break the property the whole trail is
   * built on.
   */
  /**
   * Every entry is hashed over a fixed projection shared by the writer and the verifier, and a
   * CREATE is a SHAPE that projection had barely seen from the query path before this fix: an
   * entry with no `before` key at all. If `before: undefined` were to serialise differently from
   * an absent `before`, every create would verify as tampered and the tamper alarm would become
   * noise. So the stored hash is recomputed here from the stored row.
   *
   * Anchors are deliberately not used: `sealAuditRange` ignores anything younger than a two-minute
   * lag, so a suite can only reach the anchor walk by sleeping through it — and a test that sleeps
   * two minutes to assert a hash is a test nobody runs.
   */
  it("hashes a create so the chain still recomputes it", async () => {
    const rows = (await main.connection
      .collection("auditLogs")
      .find({ action: { $in: ["edTriage.created", "edTriage.updated", "icdCode.created"] } })
      .sort({ seq: 1 })
      .toArray()) as unknown as (AuditRow & { hash: string; at: Date })[];

    expect(rows.length, "no entries to verify — the suite wrote nothing").toBeGreaterThan(0);
    expect(
      rows.some((r) => r.action.endsWith(".created")),
      "no CREATE entry present, which is the shape this is here to check",
    ).toBe(true);

    const tampered = rows
      .filter((r) => hashAuditEntry(r as never) !== r.hash)
      .map((r) => `${r.action} seq=${String(r.seq)}`);

    expect(
      tampered,
      "these entries do not recompute to their stored hash — the trail would report itself " +
        "tampered with, on entries nobody touched",
    ).toEqual([]);
  });

  /**
   * ── THE ENTRY THAT FOUND `minimize` ───────────────────────────────────────
   * A transfer-out only ADDS fields to an existing triage row, so `diff` produces an empty
   * `before` — it records a previous value only where one existed. Mongoose's default strips an
   * empty object on the way to the database, so the stored entry no longer matched the hash that
   * had been computed over it, and `verifyAuditChain` would have called it content-tampered.
   *
   * Called out separately from the sweep above because the sweep only covers this by accident of
   * ordering, and an accident is not a regression test.
   */
  it("hashes an update that only ADDS fields, whose before-delta is empty", async () => {
    const { encounterId } = await arrive("Add-Only Update");
    await req("post", "/api/v1/emergency/triage", nurseToken, main.host, siteA)
      .send({ encounterId, priority: "critical" })
      .expect(201);
    await req("post", "/api/v1/emergency/transfer-out", doctorToken, main.host, siteA)
      .send({ encounterId, destination: "St Jude — cath lab" })
      .expect(201);

    const trail = await trailFor(await triageIdFor(encounterId));
    const transfer = trail.find((r) => r.after?.transferredTo === "St Jude — cath lab");
    expect(transfer, "the transfer was not audited at all").toBeTruthy();
    expect(transfer?.before, "an add-only update has no previous value to show").toBeUndefined();
    expect(
      hashAuditEntry(transfer as never),
      "the stored entry does not recompute to its own hash — the chain would report a tamper " +
        "on an entry nobody touched",
    ).toBe((transfer as unknown as { hash: string }).hash);
  });

  /** And the endpoint the operator actually calls still answers cleanly. */
  it("reports no problems through /audit/integrity", async () => {
    const res = await req("get", "/api/v1/audit/integrity", main.admin, main.host).expect(200);
    expect(res.body.data.problems).toEqual([]);
    expect(res.body.data.ok, JSON.stringify(res.body.data)).toBe(true);
  });
});
