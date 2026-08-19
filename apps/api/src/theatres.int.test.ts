/**
 * OPERATION THEATRE — release-gating (Module B5, Theatre v1).
 *
 * ── WHY THIS SUITE EXISTS NOW ───────────────────────────────────────────────
 * The theatre module shipped a registry, bookings, an overlap rule, a four-state machine and a
 * screen — and had NO behavioural test of any of it. Every assertion about theatres in this
 * repository came from `rbac.int.test.ts`, which probes routes for a status code and knows nothing
 * about what they do. That is the same shape of hole the pharmacy milestone found in stock, and it
 * hid the same kind of defect: `ot:schedule` was granted to no clinical role, so the only person in
 * the building who could book a theatre was the hospital administrator. Six months of code, and
 * nobody could use it.
 *
 * ── THE FOUR CLAIMS ─────────────────────────────────────────────────────────
 *
 *   1. TWO PROCEDURES CANNOT SHARE A THEATRE AND A MOMENT. The overlap rule is the module's whole
 *      reason to exist, and it is tested at its BOUNDARIES (a back-to-back list is legal; one
 *      minute of overlap is not) and under CONCURRENCY, because the check is a read and the write
 *      that follows it is what actually arbitrates.
 *
 *   2. A BOOKING MOVES ONLY ALONG LEGAL EDGES. A procedure cannot be completed without starting,
 *      restarted after it finished, or resurrected after cancellation.
 *
 *   3. AN OPERATION RECORD DESCRIBES AN OPERATION THAT HAPPENED. Not one that is merely scheduled,
 *      not one that was cancelled, and never twice — a clinical record that can be silently
 *      rewritten is not a record.
 *
 *   4. THE BOUNDARIES HOLD. Another hospital's booking, another branch's list, a role without the
 *      permission, a hospital that never bought the module — all refused by the SERVER.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { listening } from "./test/appServer.js";
import { createLogger } from "@medicore/logger";
import { assertMongoReachable, dropDatabases, TEST_MONGO_URI } from "./test/mongoTestEnv.js";
import { assertRedisReachable, flushTestCache, testRedisUrl } from "./test/redisTestEnv.js";

process.env.MONGO_URI = TEST_MONGO_URI;
process.env.REDIS_URL = testRedisUrl("theatres");
process.env.MONGO_MASTER_DB = "test_theatres_master";
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

const SLUG = "test-theatres";
const RIVAL_SLUG = "test-theatres-rival";
const CLINIC_SLUG = "test-theatres-clinic";
const DB = `hms_${SLUG}`;
const RIVAL_DB = `hms_${RIVAL_SLUG}`;
const CLINIC_DB = `hms_${CLINIC_SLUG}`;
const PASSWORD = "V4lid!Password#2026";

const app = await listening(createApp(createLogger({ service: "theatres-int-test" })));

interface Site {
  id: string;
  slug: string;
  host: string;
  admin: string;
  connection: Awaited<ReturnType<typeof getTenantConnection>>;
}

const main = {} as Site;
const rival = {} as Site;
const clinic = {} as Site;

let doctorToken = "";
let doctorId = "";
let nurseToken = "";
/** Holds `emr:read` and neither OT permission — the "reads the board, touches nothing" probe. */
let pharmacistToken = "";
let deskToken = "";
/** A doctor bound to the SECOND site only. */
let siteBDoctorToken = "";
let siteA = "";
let siteB = "";

/** Theatres at main: one per site, plus a retired one. */
let otA = "";
let otA2 = "";
let otB = "";
let retiredOt = "";
let rivalOt = "";

let patientA = "";
let patientA2 = "";
let rivalBooking = "";

/** A far-future id that is well-formed and belongs to nobody. */
const FORGED = "64b7f0000000000000000009";

function req(
  method: "get" | "post" | "patch",
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

/**
 * A window `n` hours from a FIXED anchor, so no test depends on the wall clock and two tests can
 * never accidentally collide by both meaning "now".
 *
 * The anchor is deliberately in the future: `performedAt` on an operation record and the board's
 * "today" default both read real time, and a fixture anchored in the past would make the board
 * assertions depend on when the suite runs.
 */
const ANCHOR = new Date("2031-04-08T02:00:00.000Z");
function slot(startHour: number, hours = 1): { scheduledStart: string; scheduledEnd: string } {
  const start = new Date(ANCHOR.getTime() + startHour * 3_600_000);
  const end = new Date(start.getTime() + hours * 3_600_000);
  return { scheduledStart: start.toISOString(), scheduledEnd: end.toISOString() };
}
const WINDOW = {
  from: new Date(ANCHOR.getTime() - 24 * 3_600_000).toISOString(),
  to: new Date(ANCHOR.getTime() + 24 * 3_600_000).toISOString(),
};

function book(token: string, body: Record<string, unknown>, branch?: string): request.Test {
  return req("post", "/api/v1/ot-bookings", token, main.host, branch).send(body);
}

/** A booking in a slot nobody else uses, already moved to `to`. Returns its id. */
async function bookingAt(
  startHour: number,
  to?: "in_progress" | "completed" | "cancelled",
): Promise<string> {
  const res = await book(doctorToken, {
    theatreId: otA,
    patientId: patientA,
    surgeonId: doctorId,
    procedureName: "Appendectomy",
    ...slot(startHour),
  });
  expect(res.status, res.text).toBe(201);
  const id = res.body.data.id as string;
  if (to === "in_progress" || to === "completed" || to === "cancelled") {
    if (to === "completed") {
      await req("post", `/api/v1/ot-bookings/${id}/transition`, nurseToken, main.host)
        .send({ to: "in_progress" })
        .expect(200);
    }
    await req("post", `/api/v1/ot-bookings/${id}/transition`, nurseToken, main.host)
      .send({ to })
      .expect(200);
  }
  return id;
}

const NOTE = {
  procedurePerformed: "Laparoscopic appendectomy",
  performedAt: ANCHOR.toISOString(),
  findings: "Inflamed appendix, no perforation.",
};

beforeAll(async () => {
  await assertMongoReachable();
  await assertRedisReachable();
  await dropDatabases([process.env.MONGO_MASTER_DB as string, DB, RIVAL_DB, CLINIC_DB]);
  await flushTestCache("theatres");

  for (const [site, slug, plan, branches] of [
    [main, SLUG, "PLAN_HOSPITAL", 2],
    [rival, RIVAL_SLUG, "PLAN_HOSPITAL", 1],
    // No OT flag in this edition — the entitlement probe.
    [clinic, CLINIC_SLUG, "PLAN_CLINIC", 1],
  ] as [Site, string, string, number][]) {
    const t = await provisionTenant({
      hospitalName: slug,
      slug,
      planCode: plan,
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

  // Branches first, before any branch-bound staff exist (a hospital-wide admin cannot write once
  // there are two sites and no active branch chosen).
  const branches = await req("get", "/api/v1/branches", main.admin, main.host).expect(200);
  siteA = (branches.body.data as { id: string }[])[0]!.id;
  siteB = (
    await req("post", "/api/v1/branches", main.admin, main.host)
      .send({ name: "Riverside", code: "RIV" })
      .expect(201)
  ).body.data.id as string;

  await runWithContext(
    { traceId: "setup-staff", tenantId: main.id, tenantSlug: SLUG, connection: main.connection },
    async () => {
      doctorId = await makeUser(`doc@${SLUG}.test`, "Dr Rao", "DOCTOR", [siteA]);
      await makeUser(`nurse@${SLUG}.test`, "Sister Fatima", "NURSE", [siteA]);
      await makeUser(`pharm@${SLUG}.test`, "Mr Iyer", "PHARMACIST", [siteA]);
      await makeUser(`front@${SLUG}.test`, "Front Desk", "RECEPTIONIST", [siteA]);
      await makeUser(`docb@${SLUG}.test`, "Dr Grace", "DOCTOR", [siteB]);
    },
  );
  doctorToken = await login(main.host, `doc@${SLUG}.test`);
  nurseToken = await login(main.host, `nurse@${SLUG}.test`);
  pharmacistToken = await login(main.host, `pharm@${SLUG}.test`);
  deskToken = await login(main.host, `front@${SLUG}.test`);
  siteBDoctorToken = await login(main.host, `docb@${SLUG}.test`);

  // Theatres. The admin is hospital-wide, so each write names its site explicitly.
  otA = (
    await req("post", "/api/v1/theatres", main.admin, main.host, siteA)
      .send({ name: "OT One", code: "OT1", kind: "major_ot" })
      .expect(201)
  ).body.data.id as string;
  otA2 = (
    await req("post", "/api/v1/theatres", main.admin, main.host, siteA)
      .send({ name: "OT Two", code: "OT2", kind: "minor_ot" })
      .expect(201)
  ).body.data.id as string;
  otB = (
    await req("post", "/api/v1/theatres", main.admin, main.host, siteB)
      .send({ name: "Riverside OT", code: "ROT1", kind: "major_ot" })
      .expect(201)
  ).body.data.id as string;
  retiredOt = (
    await req("post", "/api/v1/theatres", main.admin, main.host, siteA)
      .send({ name: "Old OT", code: "OT9", kind: "major_ot" })
      .expect(201)
  ).body.data.id as string;
  await req("patch", `/api/v1/theatres/${retiredOt}`, main.admin, main.host, siteA)
    .send({ status: "inactive" })
    .expect(200);

  patientA = (
    await req("post", "/api/v1/patients", deskToken, main.host, siteA)
      .send({ name: "Ramesh Kumar", gender: "male", contact: { phone: "9812345670" } })
      .expect(201)
  ).body.data.patient.id as string;
  patientA2 = (
    await req("post", "/api/v1/patients", deskToken, main.host, siteA)
      .send({ name: "Sunita Devi", gender: "female", contact: { phone: "9812345671" } })
      .expect(201)
  ).body.data.patient.id as string;

  // The rival hospital's own theatre, patient and booking — so "another tenant's id" is a REAL id.
  await runWithContext(
    {
      traceId: "setup-rival",
      tenantId: rival.id,
      tenantSlug: RIVAL_SLUG,
      connection: rival.connection,
    },
    async () => {
      await makeUser(`doc@${RIVAL_SLUG}.test`, "Dr Rival", "DOCTOR", []);
      await makeUser(`front@${RIVAL_SLUG}.test`, "Desk Rival", "RECEPTIONIST", []);
    },
  );
  const rivalDoc = await login(rival.host, `doc@${RIVAL_SLUG}.test`);
  const rivalDesk = await login(rival.host, `front@${RIVAL_SLUG}.test`);
  rivalOt = (
    await req("post", "/api/v1/theatres", rival.admin, rival.host)
      .send({ name: "Rival OT", code: "OT1", kind: "major_ot" })
      .expect(201)
  ).body.data.id as string;
  const rivalPatient = (
    await req("post", "/api/v1/patients", rivalDesk, rival.host)
      .send({ name: "Rival Patient", gender: "female", contact: { phone: "9812345699" } })
      .expect(201)
  ).body.data.patient.id as string;
  const rivalDocId = (
    await request(app)
      .get("/api/v1/auth/me")
      .set("Host", rival.host)
      .set("Authorization", `Bearer ${rivalDoc}`)
      .expect(200)
  ).body.data.id as string;
  rivalBooking = (
    await req("post", "/api/v1/ot-bookings", rivalDoc, rival.host)
      .send({
        theatreId: rivalOt,
        patientId: rivalPatient,
        surgeonId: rivalDocId,
        procedureName: "Cholecystectomy",
        ...slot(200),
      })
      .expect(201)
  ).body.data.id as string;
}, 240_000);

afterAll(async () => {
  await closeAllTenantConnections();
  await closeMaster();
  await closeRedis();
  await dropDatabases([process.env.MONGO_MASTER_DB as string, DB, RIVAL_DB, CLINIC_DB]);
}, 30_000);

/* ══ 1. the collision rule ═══════════════════════════════════════════════════ */

describe("two procedures cannot share a theatre and a moment", () => {
  it("books a procedure into a free window", async () => {
    const res = await book(doctorToken, {
      theatreId: otA,
      patientId: patientA,
      surgeonId: doctorId,
      procedureName: "Hernia repair",
      ...slot(10),
    });
    expect(res.status, res.text).toBe(201);
    expect(res.body.data.status).toBe("scheduled");
    // The board is for humans: the patient is NAMED, not an id to go and look up.
    expect(res.body.data.patientName).toBe("Ramesh Kumar");
    expect(res.body.data.theatreCode).toBe("OT1");
  });

  it("refuses a window that overlaps an existing booking, and names the clash", async () => {
    await book(doctorToken, {
      theatreId: otA,
      patientId: patientA,
      surgeonId: doctorId,
      procedureName: "Cataract",
      ...slot(20, 2),
    }).expect(201);

    // Starts one hour in, while the first is still running.
    const res = await book(doctorToken, {
      theatreId: otA,
      patientId: patientA2,
      surgeonId: doctorId,
      procedureName: "Biopsy",
      ...slot(21, 2),
    });
    expect(res.status).toBe(409);
    expect(res.body.error.details.conflictsWith).toBe("Cataract");
  });

  it("allows a BACK-TO-BACK list — the rule is overlap, not adjacency", async () => {
    /**
     * The boundary that matters clinically. An OT list is booked nose to tail all day; a rule
     * written with `<=` instead of `<` would refuse every second case in the hospital and would
     * look exactly like a working overlap check on any test that only tried a real overlap.
     */
    await book(doctorToken, {
      theatreId: otA,
      patientId: patientA,
      surgeonId: doctorId,
      procedureName: "First case",
      ...slot(30),
    }).expect(201);

    const res = await book(doctorToken, {
      theatreId: otA,
      patientId: patientA2,
      surgeonId: doctorId,
      procedureName: "Second case",
      ...slot(31),
    });
    expect(res.status, res.text).toBe(201);
  });

  it("lets a DIFFERENT theatre take the same window", async () => {
    await book(doctorToken, {
      theatreId: otA,
      patientId: patientA,
      surgeonId: doctorId,
      procedureName: "Same time, OT1",
      ...slot(40),
    }).expect(201);

    const res = await book(doctorToken, {
      theatreId: otA2,
      patientId: patientA2,
      surgeonId: doctorId,
      procedureName: "Same time, OT2",
      ...slot(40),
    });
    expect(res.status, res.text).toBe(201);
  });

  it("frees the window when a booking is CANCELLED", async () => {
    const id = await bookingAt(50);
    await req("post", `/api/v1/ot-bookings/${id}/transition`, nurseToken, main.host)
      .send({ to: "cancelled", reason: "patient unfit" })
      .expect(200);

    const res = await book(doctorToken, {
      theatreId: otA,
      patientId: patientA2,
      surgeonId: doctorId,
      procedureName: "Took the slot",
      ...slot(50),
    });
    expect(res.status, res.text).toBe(201);
  });

  it("frees the window when a procedure is COMPLETED", async () => {
    const id = await bookingAt(60, "completed");
    expect(id).toBeTruthy();

    const res = await book(doctorToken, {
      theatreId: otA,
      patientId: patientA2,
      surgeonId: doctorId,
      procedureName: "Next case, same slot",
      ...slot(60),
    });
    expect(res.status, res.text).toBe(201);
  });

  /**
   * ── THE RACE THE OVERLAP CHECK CANNOT WIN ON ITS OWN ──────────────────────
   * `findOverlap` is a READ. Two coordinators pressing Book at the same instant both see a free
   * theatre, and it is the WRITE that has to arbitrate — which is what the partial-unique index on
   * `{tenantId, theatreId, scheduledStart}` is for. Firing both requests concurrently is the only
   * way to exercise that path: sequentially, the read alone is enough and the index proves nothing.
   */
  it("survives two coordinators booking the same slot at the same instant", async () => {
    const body = {
      theatreId: otA2,
      patientId: patientA,
      surgeonId: doctorId,
      procedureName: "Simultaneous",
      ...slot(70),
    };
    const [a, b] = await Promise.all([book(doctorToken, body), book(nurseToken, body)]);

    const statuses = [a.status, b.status].sort();
    expect(statuses, `${a.status}/${a.text} — ${b.status}/${b.text}`).toEqual([201, 409]);

    // Read back by PATIENT, which carries no date window — the slot deliberately sits outside the
    // board's, and a window that quietly excluded both rows would let a double-booking pass here.
    const chart = await req(
      "get",
      `/api/v1/ot-bookings?patientId=${patientA}&theatreId=${otA2}`,
      doctorToken,
      main.host,
    ).expect(200);
    const held = (chart.body.data as { procedureName: string }[]).filter(
      (x) => x.procedureName === "Simultaneous",
    );
    expect(held).toHaveLength(1);
  });

  it("refuses a window that ends before it starts", async () => {
    const s = slot(80);
    const res = await book(doctorToken, {
      theatreId: otA,
      patientId: patientA,
      surgeonId: doctorId,
      procedureName: "Backwards",
      scheduledStart: s.scheduledEnd,
      scheduledEnd: s.scheduledStart,
    });
    expect(res.status).toBe(400);
  });

  it("refuses a retired theatre", async () => {
    const res = await book(doctorToken, {
      theatreId: retiredOt,
      patientId: patientA,
      surgeonId: doctorId,
      procedureName: "In the old room",
      ...slot(85),
    });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/out of service/i);
  });

  it("refuses a theatre that does not exist", async () => {
    const res = await book(doctorToken, {
      theatreId: FORGED,
      patientId: patientA,
      surgeonId: doctorId,
      procedureName: "Nowhere",
      ...slot(86),
    });
    expect(res.status).toBe(404);
  });

  it("refuses a duplicate theatre CODE, and says so in words", async () => {
    const res = await req("post", "/api/v1/theatres", main.admin, main.host, siteA).send({
      name: "Another OT One",
      code: "OT1",
      kind: "major_ot",
    });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/already in use/i);
  });
});

/* ══ 2. the state machine ════════════════════════════════════════════════════ */

describe("a booking moves only along legal edges", () => {
  it("runs scheduled → in_progress → completed", async () => {
    const id = await bookingAt(100);

    const started = await req("post", `/api/v1/ot-bookings/${id}/transition`, nurseToken, main.host)
      .send({ to: "in_progress" })
      .expect(200);
    expect(started.body.data.status).toBe("in_progress");

    const done = await req("post", `/api/v1/ot-bookings/${id}/transition`, nurseToken, main.host)
      .send({ to: "completed" })
      .expect(200);
    expect(done.body.data.status).toBe("completed");
  });

  it("refuses to complete a procedure that never started", async () => {
    const id = await bookingAt(110);
    const res = await req(
      "post",
      `/api/v1/ot-bookings/${id}/transition`,
      nurseToken,
      main.host,
    ).send({ to: "completed" });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/scheduled.*completed/i);
  });

  it("refuses to restart a completed procedure", async () => {
    const id = await bookingAt(120, "completed");
    const res = await req(
      "post",
      `/api/v1/ot-bookings/${id}/transition`,
      nurseToken,
      main.host,
    ).send({ to: "in_progress" });
    expect(res.status).toBe(409);
  });

  it("refuses to revive a cancelled booking", async () => {
    const id = await bookingAt(130, "cancelled");
    for (const to of ["in_progress", "completed", "scheduled"]) {
      const res = await req(
        "post",
        `/api/v1/ot-bookings/${id}/transition`,
        nurseToken,
        main.host,
      ).send({ to });
      expect(res.status, `cancelled → ${to}`).toBe(409);
    }
  });

  it("refuses a transition on a booking that does not exist", async () => {
    const res = await req(
      "post",
      `/api/v1/ot-bookings/${FORGED}/transition`,
      nurseToken,
      main.host,
    ).send({ to: "in_progress" });
    expect(res.status).toBe(404);
  });
});

/* ══ 3. the operation record ═════════════════════════════════════════════════ */

describe("an operation record describes an operation that happened", () => {
  it("is written once the procedure has started, and reads back on the booking", async () => {
    const id = await bookingAt(140, "in_progress");
    const res = await req(
      "post",
      `/api/v1/ot-bookings/${id}/operative-note`,
      doctorToken,
      main.host,
    ).send({ ...NOTE, surgeonId: doctorId });

    expect(res.status, res.text).toBe(201);
    expect(res.body.data.operativeNote.procedurePerformed).toBe("Laparoscopic appendectomy");
    expect(res.body.data.operativeNote.findings).toMatch(/no perforation/);
    // Provenance: who WROTE it, kept separate from the surgeon it names.
    expect(res.body.data.operativeNote.recordedBy).toBe(doctorId);
    expect(res.body.data.operativeNote.recordedAt).toBeTruthy();
  });

  it("survives the procedure being completed afterwards", async () => {
    const id = await bookingAt(150, "in_progress");
    await req("post", `/api/v1/ot-bookings/${id}/operative-note`, doctorToken, main.host)
      .send({ ...NOTE, surgeonId: doctorId })
      .expect(201);
    const done = await req("post", `/api/v1/ot-bookings/${id}/transition`, nurseToken, main.host)
      .send({ to: "completed" })
      .expect(200);
    expect(done.body.data.operativeNote.procedurePerformed).toBe("Laparoscopic appendectomy");
  });

  it("can be written after completion too — the surgeon writes up after the list", async () => {
    const id = await bookingAt(160, "completed");
    const res = await req(
      "post",
      `/api/v1/ot-bookings/${id}/operative-note`,
      doctorToken,
      main.host,
    ).send({ ...NOTE, surgeonId: doctorId });
    expect(res.status, res.text).toBe(201);
  });

  /**
   * The claim that gives the record its meaning: it says what HAPPENED. A note on a booking that
   * has not started would be a signed clinical statement about an operation nobody has performed.
   */
  it("REFUSES a note on a procedure that has not started", async () => {
    const id = await bookingAt(170);
    const res = await req(
      "post",
      `/api/v1/ot-bookings/${id}/operative-note`,
      doctorToken,
      main.host,
    ).send({ ...NOTE, surgeonId: doctorId });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/scheduled/i);
  });

  it("REFUSES a note on a cancelled procedure", async () => {
    const id = await bookingAt(180, "cancelled");
    const res = await req(
      "post",
      `/api/v1/ot-bookings/${id}/operative-note`,
      doctorToken,
      main.host,
    ).send({ ...NOTE, surgeonId: doctorId });
    expect(res.status).toBe(409);
  });

  it("REFUSES a second note — a clinical record is not editable", async () => {
    const id = await bookingAt(190, "in_progress");
    await req("post", `/api/v1/ot-bookings/${id}/operative-note`, doctorToken, main.host)
      .send({ ...NOTE, surgeonId: doctorId })
      .expect(201);

    const second = await req(
      "post",
      `/api/v1/ot-bookings/${id}/operative-note`,
      doctorToken,
      main.host,
    ).send({
      ...NOTE,
      surgeonId: doctorId,
      procedurePerformed: "Something else entirely",
      findings: "Rewritten",
    });
    expect(second.status).toBe(409);

    // …and the FIRST record is what the chart still holds. A refusal that left the row rewritten
    // would be worse than an accepted edit, because it would look like it had been refused.
    const board = await req(
      "get",
      `/api/v1/ot-bookings?patientId=${patientA}`,
      doctorToken,
      main.host,
    ).expect(200);
    const row = (
      board.body.data as { id: string; operativeNote?: { procedurePerformed: string } }[]
    ).find((x) => x.id === id);
    expect(row?.operativeNote?.procedurePerformed).toBe("Laparoscopic appendectomy");
  });

  /**
   * Two devices, one booking, no read-then-write window. The service's `if (already recorded)` runs
   * against a READ; only the conditional update arbitrates, and this is the test that can tell the
   * difference.
   */
  it("survives two surgeons writing the record at the same instant", async () => {
    const id = await bookingAt(200, "in_progress");
    const one = req("post", `/api/v1/ot-bookings/${id}/operative-note`, doctorToken, main.host)
      .send({ ...NOTE, surgeonId: doctorId, procedurePerformed: "Version A" })
      .then((r) => r);
    const two = req("post", `/api/v1/ot-bookings/${id}/operative-note`, main.admin, main.host)
      .send({ ...NOTE, surgeonId: doctorId, procedurePerformed: "Version B" })
      .then((r) => r);
    const [a, b] = await Promise.all([one, two]);

    expect([a.status, b.status].sort(), `${a.status}/${a.text} — ${b.status}/${b.text}`).toEqual([
      201, 409,
    ]);
  });

  it("refuses a note on a booking that does not exist", async () => {
    const res = await req(
      "post",
      `/api/v1/ot-bookings/${FORGED}/operative-note`,
      doctorToken,
      main.host,
    ).send({ ...NOTE, surgeonId: doctorId });
    expect(res.status).toBe(404);
  });

  it("refuses a note with no procedure named", async () => {
    const id = await bookingAt(210, "in_progress");
    const res = await req(
      "post",
      `/api/v1/ot-bookings/${id}/operative-note`,
      doctorToken,
      main.host,
    ).send({ surgeonId: doctorId, performedAt: ANCHOR.toISOString() });
    expect(res.status).toBe(400);
  });
});

/* ══ 4. the chart ════════════════════════════════════════════════════════════ */

describe("the operation reaches the patient's chart", () => {
  it("returns a patient's WHOLE surgical history, not one day of it", async () => {
    /**
     * The booking is deliberately far outside any board window. A chart query that silently
     * inherited the board's "today" default would answer "this patient has never been operated on"
     * — which is indistinguishable from the truth, and is the reason this test exists.
     */
    const res = await book(doctorToken, {
      theatreId: otA2,
      patientId: patientA2,
      surgeonId: doctorId,
      procedureName: "Old hernia repair",
      ...slot(5000),
    });
    expect(res.status, res.text).toBe(201);

    const chart = await req(
      "get",
      `/api/v1/ot-bookings?patientId=${patientA2}`,
      doctorToken,
      main.host,
    ).expect(200);
    const names = (chart.body.data as { procedureName: string }[]).map((x) => x.procedureName);
    expect(names).toContain("Old hernia repair");
  });

  it("still clips the BOARD to its window — the chart's rule did not leak", async () => {
    const board = await req(
      "get",
      `/api/v1/ot-bookings?from=${WINDOW.from}&to=${WINDOW.to}`,
      doctorToken,
      main.host,
    ).expect(200);
    const names = (board.body.data as { procedureName: string }[]).map((x) => x.procedureName);
    expect(names).not.toContain("Old hernia repair");
  });

  it("shows only the named patient's procedures", async () => {
    const chart = await req(
      "get",
      `/api/v1/ot-bookings?patientId=${patientA2}`,
      doctorToken,
      main.host,
    ).expect(200);
    const ids = new Set((chart.body.data as { patientId: string }[]).map((x) => x.patientId));
    expect([...ids]).toEqual([patientA2]);
  });

  it("carries the pre-op note the list was booked with", async () => {
    const res = await book(doctorToken, {
      theatreId: otA,
      patientId: patientA,
      surgeonId: doctorId,
      procedureName: "With a pre-op line",
      notes: "Cross-match 2 units.",
      ...slot(300),
    });
    expect(res.status, res.text).toBe(201);
    expect(res.body.data.notes).toBe("Cross-match 2 units.");
  });
});

/* ══ 5. the boundaries ═══════════════════════════════════════════════════════ */

describe("authorization: who may run the list, and who may write the record", () => {
  it("lets a DOCTOR book a theatre — the defect this milestone fixed", async () => {
    const res = await book(doctorToken, {
      theatreId: otA,
      patientId: patientA,
      surgeonId: doctorId,
      procedureName: "Booked by the surgeon",
      ...slot(400),
    });
    expect(res.status, res.text).toBe(201);
  });

  it("lets the OT NURSE move the list along", async () => {
    const id = await bookingAt(410);
    await req("post", `/api/v1/ot-bookings/${id}/transition`, nurseToken, main.host)
      .send({ to: "in_progress" })
      .expect(200);
  });

  it("refuses a role that holds neither OT permission", async () => {
    const res = await book(pharmacistToken, {
      theatreId: otA,
      patientId: patientA,
      surgeonId: doctorId,
      procedureName: "Not their job",
      ...slot(420),
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("HMS-AUTH-005");
  });

  it("refuses the OPERATION RECORD to the nurse who ran the list", async () => {
    /**
     * `ot:schedule` and `ot:record` are different capabilities on purpose. The circulating nurse
     * starts and completes the case; what was found inside the patient is the surgeon's statement,
     * and one permission covering both would let the person running the board author it.
     */
    const id = await bookingAt(430, "in_progress");
    const res = await req(
      "post",
      `/api/v1/ot-bookings/${id}/operative-note`,
      nurseToken,
      main.host,
    ).send({ ...NOTE, surgeonId: doctorId });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("HMS-AUTH-005");
  });

  it("refuses the theatre REGISTRY to a doctor — a surgeon books rooms, they do not build them", async () => {
    const res = await req("post", "/api/v1/theatres", doctorToken, main.host, siteA).send({
      name: "Doctor's own OT",
      code: "OTX",
      kind: "major_ot",
    });
    expect(res.status).toBe(403);
  });

  it("refuses everything to an unauthenticated caller", async () => {
    for (const [method, path] of [
      ["get", "/api/v1/ot-bookings"],
      ["post", "/api/v1/ot-bookings"],
      ["get", "/api/v1/theatres"],
    ] as ["get" | "post", string][]) {
      const res = await request(app)[method](path).set("Host", main.host).send({});
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

describe("permissions do not cross the tenancy boundary", () => {
  it("cannot read another hospital's booking", async () => {
    const res = await req(
      "post",
      `/api/v1/ot-bookings/${rivalBooking}/transition`,
      doctorToken,
      main.host,
    ).send({ to: "in_progress" });
    expect(res.status).toBe(404);
  });

  it("cannot write an operation record onto another hospital's booking", async () => {
    const res = await req(
      "post",
      `/api/v1/ot-bookings/${rivalBooking}/operative-note`,
      doctorToken,
      main.host,
    ).send({ ...NOTE, surgeonId: doctorId });
    expect(res.status).toBe(404);
  });

  it("cannot book into another hospital's theatre", async () => {
    const res = await book(doctorToken, {
      theatreId: rivalOt,
      patientId: patientA,
      surgeonId: doctorId,
      procedureName: "Across the road",
      ...slot(500),
    });
    expect(res.status).toBe(404);
  });

  it("never shows another hospital's list on this hospital's board", async () => {
    const board = await req(
      "get",
      `/api/v1/ot-bookings?from=${WINDOW.from}&to=${new Date(ANCHOR.getTime() + 10_000 * 3_600_000).toISOString()}`,
      main.admin,
      main.host,
    ).expect(200);
    const names = (board.body.data as { procedureName: string }[]).map((x) => x.procedureName);
    expect(names).not.toContain("Cholecystectomy");
  });
});

describe("row scope: one site's list is not another's", () => {
  it("stamps a booking with its THEATRE's branch — the room is the place", async () => {
    const res = await req("post", "/api/v1/ot-bookings", main.admin, main.host, siteB)
      .send({
        theatreId: otB,
        patientId: patientA,
        surgeonId: doctorId,
        procedureName: "Riverside case",
        ...slot(600),
      })
      .expect(201);
    expect(res.body.data.branchId).toBe(siteB);
  });

  it("hides another branch's booking from a doctor confined to one site", async () => {
    /**
     * Both rows are created HERE rather than relied on from an earlier describe. A test whose
     * subject is created by a different test passes trivially when run alone — and that is not a
     * hypothetical: this assertion survived `scopeFilter()` being deleted from the board query,
     * because under a filtered run the main-site booking it looked for had never been made.
     */
    await book(doctorToken, {
      theatreId: otA,
      patientId: patientA,
      surgeonId: doctorId,
      procedureName: "Main site only",
      ...slot(640),
    }).expect(201);

    const wide = await req(
      "get",
      `/api/v1/ot-bookings?from=${WINDOW.from}&to=${new Date(ANCHOR.getTime() + 10_000 * 3_600_000).toISOString()}`,
      siteBDoctorToken,
      main.host,
    ).expect(200);
    const names = (wide.body.data as { procedureName: string }[]).map((x) => x.procedureName);
    expect(names).toContain("Riverside case");
    expect(names).not.toContain("Main site only");
  });

  it("keeps the CHART read scoped too — a patient's history is not cross-branch reading", async () => {
    const chart = await req(
      "get",
      `/api/v1/ot-bookings?patientId=${patientA}`,
      siteBDoctorToken,
      main.host,
    ).expect(200);
    const names = (chart.body.data as { procedureName: string }[]).map((x) => x.procedureName);
    expect(names).not.toContain("Main site only");
  });

  it("refuses a transition on another branch's booking", async () => {
    const mine = await bookingAt(610);
    const res = await req(
      "post",
      `/api/v1/ot-bookings/${mine}/transition`,
      siteBDoctorToken,
      main.host,
    ).send({ to: "in_progress" });
    expect(res.status).toBe(404);
  });

  it("refuses an operation record on another branch's booking", async () => {
    const mine = await bookingAt(620, "in_progress");
    const res = await req(
      "post",
      `/api/v1/ot-bookings/${mine}/operative-note`,
      siteBDoctorToken,
      main.host,
    ).send({ ...NOTE, surgeonId: doctorId });
    expect(res.status).toBe(404);
  });

  it("does not let one branch's theatre take another branch's booking window", async () => {
    // Different rooms in different buildings: the same window is legal, and must stay legal.
    await book(doctorToken, {
      theatreId: otA,
      patientId: patientA,
      surgeonId: doctorId,
      procedureName: "Main site",
      ...slot(630),
    }).expect(201);

    const res = await req("post", "/api/v1/ot-bookings", main.admin, main.host, siteB).send({
      theatreId: otB,
      patientId: patientA,
      surgeonId: doctorId,
      procedureName: "Riverside, same hour",
      ...slot(630),
    });
    expect(res.status, res.text).toBe(201);
  });
});

describe("entitlement: a hospital that never bought theatres has none", () => {
  it("answers HMS-PLAN-002 on every OT route, read and write alike", async () => {
    const probes: ["get" | "post" | "patch", string, Record<string, unknown>?][] = [
      ["get", "/api/v1/theatres"],
      ["post", "/api/v1/theatres", { name: "OT", code: "OT1", kind: "major_ot" }],
      ["patch", `/api/v1/theatres/${FORGED}`, { name: "OT" }],
      ["get", "/api/v1/ot-bookings"],
      [
        "post",
        "/api/v1/ot-bookings",
        {
          theatreId: FORGED,
          patientId: FORGED,
          surgeonId: FORGED,
          procedureName: "x",
          ...slot(1),
        },
      ],
      ["post", `/api/v1/ot-bookings/${FORGED}/transition`, { to: "in_progress" }],
      ["post", `/api/v1/ot-bookings/${FORGED}/operative-note`, { ...NOTE, surgeonId: FORGED }],
    ];

    for (const [method, path, body] of probes) {
      const res = await req(method, path, clinic.admin, clinic.host).send(body ?? {});
      expect(res.body.error?.code, `${method} ${path} was not entitlement-gated`).toBe(
        "HMS-PLAN-002",
      );
    }
  });

  it("and an entitled hospital reaches the same routes", async () => {
    await req("get", "/api/v1/theatres", main.admin, main.host).expect(200);
  });
});
