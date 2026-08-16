/**
 * NURSING DOCUMENTATION + ALLERGY REACH — release-gating (M3-S2).
 *
 * ── THE TWO CLAIMS ──────────────────────────────────────────────────────────
 *
 *   1. A NURSE CAN WRITE A NOTE, AND ONLY THE RIGHT KIND. Before S2 a nurse could not write any
 *      note at all: `POST /encounters/:id/notes` needs `emr:write`, which NURSE does not hold.
 *      The obvious "fix" — granting it — would also have handed them `discharge_summary` and
 *      `outcome_note`, the second of which is the statutory account of a death. So the nursing
 *      note has its own route under `nursing:manage`, a permission NURSE already held and which
 *      until now gated nothing at all.
 *
 *   2. AN ALLERGY REACHES THE WHOLE HOSPITAL; A WARD NOTE DOES NOT. These pull in opposite
 *      directions and both are correct. "Branch isolation" does not mean "branch-scope
 *      everything" — an allergy hidden by a branch filter is a fatal drug waved through at the
 *      other site, which is why `allergy.repository.ts` deliberately omits `scopeFilter()`.
 *      This suite pins BOTH directions so neither can be "tidied" into the other.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createLogger } from "@medicore/logger";
import { assertMongoReachable, dropDatabases, TEST_MONGO_URI } from "./test/mongoTestEnv.js";
import { assertRedisReachable, flushTestCache, testRedisUrl } from "./test/redisTestEnv.js";

process.env.MONGO_URI = TEST_MONGO_URI;
process.env.REDIS_URL = testRedisUrl("nursing");
process.env.MONGO_MASTER_DB = "test_nursing_master";
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

const SLUG = "test-nursing";
const OTHER_SLUG = "test-nursing-rival";
const PASSWORD = "V4lid!Password#2026";
const DB = `hms_${SLUG}`;
const OTHER_DB = `hms_${OTHER_SLUG}`;

const app = createApp(createLogger({ service: "nursing-int-test" }));

interface Site {
  id: string;
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
let receptionToken = "";
/** A nurse rostered to the second ward only. */
let wardBNurseToken = "";
let wardA = "";
let wardB = "";

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
  if (res.status !== 200) throw new Error(`login ${email}: ${res.status}`);
  return res.body.data.accessToken as string;
}

async function makeUser(
  email: string,
  name: string,
  role: string,
  branchIds: string[],
): Promise<string> {
  const u = await createUser({ email, name, status: "invited" });
  await setPassword(u.id, PASSWORD, { mustChangePassword: false });
  await assignRoleByCode(u.id, role, branchIds);
  await transitionStatus(u.id, "active");
  return u.id;
}

beforeAll(async () => {
  await assertMongoReachable();
  await assertRedisReachable();
  await dropDatabases([process.env.MONGO_MASTER_DB as string, DB, OTHER_DB]);
  await flushTestCache("nursing");

  for (const [site, slug, branches] of [
    [main, SLUG, 2],
    [rival, OTHER_SLUG, 1],
  ] as [Site, string, number][]) {
    const t = await provisionTenant({
      hospitalName: slug,
      slug,
      planCode: "PLAN_HOSPITAL",
      organizationType: "private_hospital",
      maxBranches: branches,
    });
    site.id = t.tenant.id;
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

  const branches = await req("get", "/api/v1/branches", main.admin, main.host).expect(200);
  wardA = (branches.body.data as { id: string }[])[0]?.id as string;
  const b = await req("post", "/api/v1/branches", main.admin, main.host)
    .send({ name: "Riverside", code: "RIV" })
    .expect(201);
  wardB = b.body.data.id as string;

  await runWithContext(
    { traceId: "setup-staff", tenantId: main.id, tenantSlug: SLUG, connection: main.connection },
    async () => {
      doctorId = await makeUser(`doc@${SLUG}.test`, "Dr Rao", "DOCTOR", [wardA]);
      nurseId = await makeUser(`nurse@${SLUG}.test`, "Sister Fatima", "NURSE", [wardA]);
      await makeUser(`front@${SLUG}.test`, "Front Desk", "RECEPTIONIST", [wardA]);
      await makeUser(`nurseb@${SLUG}.test`, "Sister Grace", "NURSE", [wardB]);
    },
  );

  doctorToken = await login(main.host, `doc@${SLUG}.test`);
  nurseToken = await login(main.host, `nurse@${SLUG}.test`);
  receptionToken = await login(main.host, `front@${SLUG}.test`);
  wardBNurseToken = await login(main.host, `nurseb@${SLUG}.test`);
}, 180_000);

afterAll(async () => {
  await closeAllTenantConnections();
  await closeMaster();
  await closeRedis();
  await dropDatabases([process.env.MONGO_MASTER_DB as string, DB, OTHER_DB]);
}, 30_000);

/* ── fixtures ──────────────────────────────────────────────────────────────── */

/** A registered patient at `site`. Returns the patient id. */
async function registerPatient(site: Site, name: string, token: string, branch?: string) {
  const res = await req("post", "/api/v1/patients", token, site.host, branch)
    .send({ name, gender: "female", contact: { phone: `9${Math.floor(Math.random() * 1e9)}` } })
    .expect(201);
  return res.body.data.patient.id as string;
}

/**
 * An ADMITTED patient on ward A. Returns the INPATIENT encounter id — a nursing note requires an
 * open inpatient stay, and admission opens a new encounter rather than converting the OP one.
 *
 * The queue/start steps are not ceremony: `arrived → admitted` is not a legal edge, so a patient
 * must actually have been seen before they can be given a bed.
 */
async function admit(name: string): Promise<string> {
  const patientId = await registerPatient(main, name, receptionToken);
  const enc = await req("post", "/api/v1/encounters", receptionToken, main.host)
    .send({ patientId, departmentId: doctorId })
    .expect(201);
  const opId = enc.body.data.encounter.id as string;

  await req("post", `/api/v1/encounters/${opId}/queue`, receptionToken, main.host, wardA);
  await req("post", `/api/v1/encounters/${opId}/start`, doctorToken, main.host, wardA).expect(200);

  const admitted = await req(
    "post",
    `/api/v1/encounters/${opId}/admit`,
    doctorToken,
    main.host,
    wardA,
  )
    .send({
      ward: "General",
      bedCode: `B-${Math.floor(Math.random() * 1e6)}`,
      tariffCode: "BED_GEN",
    })
    .expect(201);

  return admitted.body.data.inpatient.id as string;
}

function nursingNote(encounterId: string, text: string, token = nurseToken, key?: string) {
  const r = req("post", `/api/v1/encounters/${encounterId}/nursing-notes`, token, main.host, wardA);
  if (key) r.set("Idempotency-Key", key);
  return r.send({ text });
}

/* ── 1. the nurse can finally write ────────────────────────────────────────── */

describe("nursing notes", () => {
  it("lets a NURSE write one, stamped with author, patient and type", async () => {
    const enc = await admit("Note Subject");
    const res = await nursingNote(enc, "Patient settled, obs stable, family updated.").expect(201);

    expect(res.body.data).toMatchObject({
      type: "nursing",
      authorId: nurseId,
      encounterId: enc,
    });
    expect(res.body.data.at).toBeTruthy();
  });

  it("refuses a receptionist", async () => {
    const enc = await admit("Authz Subject");
    await nursingNote(enc, "should not land", receptionToken, "authz-front-1").expect(403);
  });

  /**
   * The complementary half of the permission split, and the reason a separate route was needed
   * rather than a second permission on the existing one. Neither role can write the other's
   * record, and both facts are load-bearing.
   */
  it("keeps the two note routes complementary: nurse cannot write a medical note", async () => {
    const enc = await admit("Split Subject");
    await req("post", `/api/v1/encounters/${enc}/notes`, nurseToken, main.host, wardA)
      .send({ text: "a doctor's progress note" })
      .expect(403);
  });

  it("and a doctor cannot write a nursing note", async () => {
    const enc = await admit("Split Subject Two");
    await nursingNote(enc, "not the doctor's record", doctorToken, "authz-doc-1").expect(403);
  });

  /**
   * The route cannot be talked into writing another kind of note. The DTO carries only `text` and
   * is `.strict()`, so naming a type is a 400 rather than something the service has to defend
   * against — structure, not a check that can be edited away.
   */
  it("rejects an attempt to smuggle a discharge_summary through the nursing route", async () => {
    const enc = await admit("Type Smuggler");
    const res = await req(
      "post",
      `/api/v1/encounters/${enc}/nursing-notes`,
      nurseToken,
      main.host,
      wardA,
    )
      .send({ text: "trying it on", type: "discharge_summary" })
      .expect(400);
    expect(res.body.error.code).toBe("HMS-VAL-001");

    const notes = await req(
      "get",
      `/api/v1/encounters/${enc}/notes`,
      nurseToken,
      main.host,
      wardA,
    ).expect(200);
    expect(notes.body.data).toHaveLength(0);
  });

  it("lands in the same chart as the medical notes, and is filterable", async () => {
    const enc = await admit("One Chart");
    await nursingNote(enc, "nursing entry").expect(201);
    await req("post", `/api/v1/encounters/${enc}/notes`, doctorToken, main.host, wardA)
      .send({ text: "medical entry" })
      .expect(201);

    const all = await req(
      "get",
      `/api/v1/encounters/${enc}/notes`,
      nurseToken,
      main.host,
      wardA,
    ).expect(200);
    expect(all.body.data).toHaveLength(2);
    expect((all.body.data as { type: string }[]).map((n) => n.type).sort()).toEqual([
      "nursing",
      "progress",
    ]);

    const onlyNursing = await req(
      "get",
      `/api/v1/encounters/${enc}/notes?type=nursing`,
      nurseToken,
      main.host,
      wardA,
    ).expect(200);
    expect(onlyNursing.body.data).toHaveLength(1);
    expect(onlyNursing.body.data[0].text).toBe("nursing entry");
  });

  it("refuses a note on a patient who is not admitted", async () => {
    const patientId = await registerPatient(main, "Outpatient", receptionToken);
    const enc = await req("post", "/api/v1/encounters", receptionToken, main.host)
      .send({ patientId, departmentId: doctorId })
      .expect(201);
    const res = await nursingNote(enc.body.data.encounter.id as string, "op note").expect(422);
    expect(res.body.error.code).toBe("HMS-STATE-001");
  });

  /**
   * ── THE AUTHOR AND THE CLOCK ARE THE SERVER'S ───────────────────────────────
   * A note is signed and timed evidence. Both come from the request context and the database, and
   * the DTO is `.strict()` with neither field on it — so a client that tried to sign a colleague's
   * name or backdate the entry is refused at the edge rather than trusted. Structure again, not a
   * check somebody could later relax.
   */
  it("signs the note with the AUTHENTICATED nurse, whatever the body claims", async () => {
    const enc = await admit("Attribution Subject");

    await req("post", `/api/v1/encounters/${enc}/nursing-notes`, nurseToken, main.host, wardA)
      .send({ text: "signed by somebody else", authorId: doctorId })
      .expect(400);
    await req("post", `/api/v1/encounters/${enc}/nursing-notes`, nurseToken, main.host, wardA)
      .send({ text: "written last Tuesday", at: "2020-01-01T00:00:00.000Z" })
      .expect(400);

    const before = Date.now();
    const res = await nursingNote(enc, "Obs stable, analgesia given.").expect(201);

    expect(res.body.data.authorId).toBe(nurseId);
    expect(res.body.data.authorId).not.toBe(doctorId);
    // The server's clock, not a client's: within a minute either side of this request.
    const at = Date.parse(res.body.data.at as string);
    expect(at).toBeGreaterThanOrEqual(before - 60_000);
    expect(at).toBeLessThanOrEqual(Date.now() + 60_000);
  });
});

/* ── 1b. the note is confined to its site and its hospital ─────────────────── */

/**
 * The nurse's route is new reach into the chart, so it gets the same two walls every other
 * clinical write has. These are WRITE tests deliberately: §3 below already proves a note does not
 * READ across a branch, and "cannot see it" is a different claim from "cannot write onto it".
 */
describe("a nursing note cannot be written outside the nurse's reach", () => {
  it("refuses an encounter that belongs to another branch", async () => {
    const enc = await admit("Ward A Stay");

    // Sister Grace is rostered to Ward B. The stay is Ward A's, and the id is no help: the
    // encounter is simply not there for her (HMS-GEN-404 — "may belong to another branch").
    const res = await req(
      "post",
      `/api/v1/encounters/${enc}/nursing-notes`,
      wardBNurseToken,
      main.host,
      wardB,
    ).send({ text: "written from the wrong ward" });
    expect([403, 404]).toContain(res.status);

    // And nothing landed. The status is the mechanism; the chart is the property.
    const notes = await req(
      "get",
      `/api/v1/encounters/${enc}/notes`,
      nurseToken,
      main.host,
      wardA,
    ).expect(200);
    expect(notes.body.data).toHaveLength(0);
  });

  /**
   * The other hospital, holding the same permission through its own admin. `getTenantDb()` hands
   * back a physically separate database, so the encounter id resolves to nothing — the write is
   * not filtered out, it has nowhere to go.
   */
  it("refuses an encounter that belongs to another hospital", async () => {
    const enc = await admit("Tenant A Stay");

    const res = await request(app)
      .post(`/api/v1/encounters/${enc}/nursing-notes`)
      .set("Host", rival.host)
      .set("Authorization", `Bearer ${rival.admin}`)
      .send({ text: "written from another hospital" });
    expect([403, 404]).toContain(res.status);

    const notes = await req(
      "get",
      `/api/v1/encounters/${enc}/notes`,
      nurseToken,
      main.host,
      wardA,
    ).expect(200);
    expect(notes.body.data).toHaveLength(0);
  });

  /**
   * A token from one hospital presented at the other's host. Refused before the route is reached —
   * the note is incidental here, but the door it knocks on is new, so it is worth one assertion
   * that the new door is behind the same lock as every other.
   */
  it("refuses a token issued by the other hospital", async () => {
    const enc = await admit("Cross Token Stay");

    const res = await request(app)
      .post(`/api/v1/encounters/${enc}/nursing-notes`)
      .set("Host", rival.host)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ text: "wrong hospital entirely" });
    expect([401, 403, 404]).toContain(res.status);
  });

  it("refuses an encounter that does not exist at all", async () => {
    const res = await nursingNote("64b7f0000000000000000009", "nobody's chart");
    expect([404, 422]).toContain(res.status);
  });

  /** Empty and whitespace-only prose is a 400, not an empty entry on a medico-legal record. */
  it("refuses a note with no words in it", async () => {
    const enc = await admit("Empty Note Subject");

    await req("post", `/api/v1/encounters/${enc}/nursing-notes`, nurseToken, main.host, wardA)
      .send({ text: "" })
      .expect(400);
    await req("post", `/api/v1/encounters/${enc}/nursing-notes`, nurseToken, main.host, wardA)
      .send({})
      .expect(400);

    const notes = await req(
      "get",
      `/api/v1/encounters/${enc}/notes`,
      nurseToken,
      main.host,
      wardA,
    ).expect(200);
    expect(notes.body.data).toHaveLength(0);
  });
});

/* ── 2. a retry must not duplicate a medico-legal record ───────────────────── */

describe("nursing note retry safety", () => {
  it("replays the original note when the same key is retried", async () => {
    const enc = await admit("Lost Response");
    const first = await nursingNote(enc, "obs stable", nurseToken, "nursing-note-key-1").expect(
      201,
    );
    const replay = await nursingNote(enc, "obs stable", nurseToken, "nursing-note-key-1").expect(
      201,
    );

    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(replay.headers["idempotency-replayed"]).toBe("true");

    const notes = await req(
      "get",
      `/api/v1/encounters/${enc}/notes`,
      nurseToken,
      main.host,
      wardA,
    ).expect(200);
    expect(notes.body.data).toHaveLength(1);
  });

  it("refuses the same key spent on a different note", async () => {
    const enc = await admit("Key Reuse");
    await nursingNote(enc, "first observation", nurseToken, "nursing-note-key-2").expect(201);
    const conflict = await nursingNote(
      enc,
      "a completely different observation",
      nurseToken,
      "nursing-note-key-2",
    ).expect(409);
    expect(conflict.body.error.code).toBe("HMS-REQ-002");
  });

  /**
   * A double tap fires two requests before either answers. One must win and one must be told to
   * wait — never two notes. `HMS-REQ-004` is the in-flight answer; a replayed 201 is also correct
   * if the first finished first. What is NOT acceptable is two rows.
   */
  it("survives a genuine double tap without writing two notes", async () => {
    const enc = await admit("Double Tap");
    const [a, b] = await Promise.all([
      nursingNote(enc, "pressed twice", nurseToken, "nursing-double-tap"),
      nursingNote(enc, "pressed twice", nurseToken, "nursing-double-tap"),
    ]);

    expect([a.status, b.status].filter((s) => s === 201).length).toBeGreaterThanOrEqual(1);
    for (const res of [a, b]) {
      expect([201, 409]).toContain(res.status);
      if (res.status === 409) expect(res.body.error.code).toBe("HMS-REQ-004");
    }

    const notes = await req(
      "get",
      `/api/v1/encounters/${enc}/notes`,
      nurseToken,
      main.host,
      wardA,
    ).expect(200);
    expect(notes.body.data).toHaveLength(1);
  });
});

/* ── 3. reach: an allergy crosses branches, a note does not ────────────────── */

describe("allergies reach the whole hospital", () => {
  it("stays visible after a branch switch, while a ward note does not", async () => {
    const enc = await admit("Reach Subject");
    const chart = await req(
      "get",
      `/api/v1/encounters/${enc}`,
      nurseToken,
      main.host,
      wardA,
    ).expect(200);
    const patientId = chart.body.data.patientId as string;

    await req("post", `/api/v1/patients/${patientId}/allergies`, nurseToken, main.host, wardA)
      .send({ allergen: "penicillins", severity: "severe", reaction: "anaphylaxis" })
      .expect(201);
    await nursingNote(enc, "allergy band applied").expect(201);

    // Ward A: both visible.
    expect(
      (
        await req(
          "get",
          `/api/v1/patients/${patientId}/allergies`,
          nurseToken,
          main.host,
          wardA,
        ).expect(200)
      ).body.data,
    ).toHaveLength(1);

    /**
     * Ward B, a nurse who has never met this patient. The ALLERGY must follow the patient — an
     * allergy hidden by a branch filter is a fatal drug waved through at the other site. The
     * ward NOTE must not: it is a record of what happened on a specific stay at a specific site.
     */
    const allergiesAtB = await req(
      "get",
      `/api/v1/patients/${patientId}/allergies`,
      wardBNurseToken,
      main.host,
      wardB,
    ).expect(200);
    expect(allergiesAtB.body.data).toHaveLength(1);
    expect(allergiesAtB.body.data[0]).toMatchObject({
      allergen: "penicillins",
      label: "Penicillins",
    });

    const notesAtB = await req(
      "get",
      `/api/v1/encounters/${enc}/notes`,
      wardBNurseToken,
      main.host,
      wardB,
    );
    // Either the encounter is invisible from the other site, or its notes are. Never the note.
    expect([200, 403, 404]).toContain(notesAtB.status);
    if (notesAtB.status === 200) expect(notesAtB.body.data).toHaveLength(0);
  });

  /**
   * Hospital-wide stops at the hospital. `tenantScopePlugin` forces `tenantId` onto every query,
   * so the rival tenant asking for this exact patient id gets an EMPTY list rather than the
   * allergy — the read is answered, and answers nothing.
   *
   * The assertion is on the DATA, not the status code: an unknown patient id currently yields
   * `200 []` rather than a 404, which leaks nothing (it is the same answer a real patient with no
   * allergies gives). Asserting 404 would pin an incidental behaviour instead of the property
   * that matters.
   */
  it("does NOT reach another hospital", async () => {
    const mine = await registerPatient(main, "Tenant A Patient", receptionToken, wardA);
    await req("post", `/api/v1/patients/${mine}/allergies`, nurseToken, main.host, wardA)
      .send({ allergen: "sulfonamides", severity: "moderate" })
      .expect(201);

    expect(
      (
        await req("get", `/api/v1/patients/${mine}/allergies`, nurseToken, main.host, wardA).expect(
          200,
        )
      ).body.data,
    ).toHaveLength(1);

    const res = await req("get", `/api/v1/patients/${mine}/allergies`, rival.admin, rival.host);
    if (res.status === 200) expect(res.body.data).toEqual([]);
    else expect([403, 404]).toContain(res.status);
  });
});

/* ── 4. allergy write safety (G4 — already closed, now pinned) ─────────────── */

describe("recording an allergy twice", () => {
  /**
   * The M3 audit listed "allergy writes are not idempotent" as a gap. Re-reading the code for S2
   * showed that is WRONG, and the audit has been corrected: migration 0032 carries a unique index
   * on the active allergen per patient, and the service turns E11000 into `HMS-ALLERGY-001`.
   *
   * That is stronger than an `Idempotency-Key` would be. A key protects one client replaying one
   * request; this protects the fact itself, including a second nurse on another device — the same
   * distinction that decided the MAR design in S1. These tests exist so the invariant cannot be
   * removed silently.
   */
  it("refuses the duplicate and keeps exactly one row", async () => {
    const patientId = await registerPatient(main, "Duplicate Allergy", receptionToken, wardA);
    const body = { allergen: "penicillins", severity: "severe" as const };

    await req("post", `/api/v1/patients/${patientId}/allergies`, nurseToken, main.host, wardA)
      .send(body)
      .expect(201);
    const second = await req(
      "post",
      `/api/v1/patients/${patientId}/allergies`,
      nurseToken,
      main.host,
      wardA,
    )
      .send(body)
      .expect(409);

    expect(second.body.error.code).toBe("HMS-ALLERGY-001");
    const list = await req(
      "get",
      `/api/v1/patients/${patientId}/allergies`,
      nurseToken,
      main.host,
      wardA,
    ).expect(200);
    expect(list.body.data).toHaveLength(1);
  });

  it("holds under a genuine double tap", async () => {
    const patientId = await registerPatient(main, "Concurrent Allergy", receptionToken, wardA);
    const send = () =>
      req("post", `/api/v1/patients/${patientId}/allergies`, nurseToken, main.host, wardA).send({
        allergen: "nsaids",
        severity: "mild",
      });

    const [a, b] = await Promise.all([send(), send()]);
    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([201, 409]);

    const list = await req(
      "get",
      `/api/v1/patients/${patientId}/allergies`,
      nurseToken,
      main.host,
      wardA,
    ).expect(200);
    expect(list.body.data).toHaveLength(1);
  });

  it("refuting is terminal, and a second attempt says so rather than silently succeeding", async () => {
    const patientId = await registerPatient(main, "Refute Twice", receptionToken, wardA);
    const created = await req(
      "post",
      `/api/v1/patients/${patientId}/allergies`,
      nurseToken,
      main.host,
      wardA,
    )
      .send({ allergen: "latex", severity: "mild" })
      .expect(201);
    const id = created.body.data.id as string;

    await req("post", `/api/v1/allergies/${id}/refute`, nurseToken, main.host, wardA)
      .send({ reason: "challenged and tolerated" })
      .expect(200);
    const again = await req("post", `/api/v1/allergies/${id}/refute`, nurseToken, main.host, wardA)
      .send({ reason: "again" })
      .expect(422);
    expect(again.body.error.code).toBe("HMS-STATE-001");

    // Refuted, not deleted — the history survives.
    const list = await req(
      "get",
      `/api/v1/patients/${patientId}/allergies`,
      nurseToken,
      main.host,
      wardA,
    ).expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].status).toBe("refuted");
  });
});

/* ── 5. G6 — the ward filter the worklist needs ────────────────────────────── */

describe("the inpatient list can be narrowed to one ward", () => {
  it("returns only that ward, and everything without the filter", async () => {
    await admit("Ward Filter A");

    const all = await req("get", "/api/v1/inpatients", nurseToken, main.host, wardA).expect(200);
    expect(all.body.data.length).toBeGreaterThan(0);

    const general = await req(
      "get",
      "/api/v1/inpatients?ward=General",
      nurseToken,
      main.host,
      wardA,
    ).expect(200);
    expect(general.body.data.length).toBe(all.body.data.length);
    expect(general.body.meta.total).toBe(all.body.meta.total);

    const nowhere = await req(
      "get",
      "/api/v1/inpatients?ward=NoSuchWard",
      nurseToken,
      main.host,
      wardA,
    ).expect(200);
    expect(nowhere.body.data).toEqual([]);
    expect(nowhere.body.meta.total).toBe(0);
  });
});
