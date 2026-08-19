/**
 * EMERGENCY DEPARTMENT — release-gating (Module D10, Emergency v1).
 *
 * ── THE FOUR CLAIMS ─────────────────────────────────────────────────────────
 *
 *   1. THE ED IS AN ENCOUNTER, NOT A SECOND HOSPITAL. An emergency arrival is registered, queued,
 *      seen, ordered for, admitted and discharged by the SAME routes as every other patient. The
 *      tests below drive those routes rather than emergency copies of them, because if an
 *      emergency copy ever appears, these are what will fail to notice — so they assert the reuse
 *      explicitly: a lab order placed on an ED visit lands on the ordinary bench.
 *
 *   2. AN UNASSESSED PATIENT IS AT THE TOP OF THE BOARD. Not the bottom, and not missing. Unknown
 *      severity treated as low severity is the failure mode that kills people in waiting rooms,
 *      and it is the one ordering property of this module that is a safety claim rather than a
 *      convenience.
 *
 *   3. A PATIENT LEAVES THE BOARD EXACTLY WHEN THEY LEAVE THE DEPARTMENT. Discharged, admitted,
 *      transferred out or gone without being seen — and not one moment before. A board that keeps
 *      a discharged patient is noise; a board that drops a waiting one is a patient nobody is
 *      looking for.
 *
 *   4. THE BOUNDARIES HOLD. Another hospital's visit, another branch's board, the desk that may
 *      not assess a patient, and a hospital that never bought an emergency department.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { listening } from "./test/appServer.js";
import { createLogger } from "@medicore/logger";
import { assertMongoReachable, dropDatabases, TEST_MONGO_URI } from "./test/mongoTestEnv.js";
import { assertRedisReachable, flushTestCache, testRedisUrl } from "./test/redisTestEnv.js";

process.env.MONGO_URI = TEST_MONGO_URI;
process.env.REDIS_URL = testRedisUrl("emergency");
process.env.MONGO_MASTER_DB = "test_emergency_master";
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

const SLUG = "test-emergency";
const RIVAL_SLUG = "test-emergency-rival";
const CLINIC_SLUG = "test-emergency-clinic";
const DB = `hms_${SLUG}`;
const RIVAL_DB = `hms_${RIVAL_SLUG}`;
const CLINIC_DB = `hms_${CLINIC_SLUG}`;
const PASSWORD = "V4lid!Password#2026";

const app = await listening(createApp(createLogger({ service: "emergency-int-test" })));

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
let deskToken = "";
/** Holds `encounter:read` and NOT `triage:perform` — the "may look, may not judge" probe. */
let cashierToken = "";
let siteBNurseToken = "";
let siteA = "";
let siteB = "";
let rivalEncounter = "";

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

let phone = 9_810_000_000;

/** A patient who has just been brought in: registered, ER class, nobody has looked at them yet. */
async function arrive(
  name: string,
  opts: { site?: string; token?: string; host?: string; doctor?: string } = {},
): Promise<{ encounterId: string; patientId: string }> {
  const host = opts.host ?? main.host;
  const desk = opts.token ?? deskToken;
  const branch = opts.site ?? siteA;
  phone += 1;
  const patient = await req("post", "/api/v1/patients", desk, host, branch)
    .send({ name, gender: "female", contact: { phone: String(phone) } })
    .expect(201);
  const patientId = patient.body.data.patient.id as string;

  const enc = await req("post", "/api/v1/encounters", desk, host, branch)
    .send({
      patientId,
      origin: "emergency",
      class: "ER",
      departmentId: opts.doctor ?? doctorId,
      doctorId: opts.doctor ?? doctorId,
    })
    .expect(201);
  return { encounterId: enc.body.data.encounter.id as string, patientId };
}

async function boardAt(token = nurseToken, branch = siteA, host = main.host) {
  const res = await req("get", "/api/v1/emergency/board", token, host, branch).expect(200);
  return res.body.data as {
    encounterId: string;
    patientName: string;
    priority?: string;
    status: string;
    waitingMinutes: number;
    chiefComplaint?: string;
  }[];
}

beforeAll(async () => {
  await assertMongoReachable();
  await assertRedisReachable();
  await dropDatabases([process.env.MONGO_MASTER_DB as string, DB, RIVAL_DB, CLINIC_DB]);
  await flushTestCache("emergency");

  for (const [site, slug, plan, branches] of [
    [main, SLUG, "PLAN_HOSPITAL", 2],
    [rival, RIVAL_SLUG, "PLAN_HOSPITAL", 1],
    // No emergency flag in this edition — the entitlement probe.
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
      await makeUser(`front@${SLUG}.test`, "Front Desk", "RECEPTIONIST", [siteA]);
      await makeUser(`cash@${SLUG}.test`, "Cash Desk", "FRONT_OFFICE", [siteA]);
      await makeUser(`nurseb@${SLUG}.test`, "Sister Grace", "NURSE", [siteB]);
    },
  );
  doctorToken = await login(main.host, `doc@${SLUG}.test`);
  nurseToken = await login(main.host, `nurse@${SLUG}.test`);
  deskToken = await login(main.host, `front@${SLUG}.test`);
  cashierToken = await login(main.host, `cash@${SLUG}.test`);
  siteBNurseToken = await login(main.host, `nurseb@${SLUG}.test`);

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
  // The clinic needs a doctor of its own: this hospital routes patients TO a doctor, so no
  // encounter can be opened without one — including the one the entitlement test opens.
  await runWithContext(
    {
      traceId: "setup-clinic",
      tenantId: clinic.id,
      tenantSlug: CLINIC_SLUG,
      connection: clinic.connection,
    },
    async () => {
      await makeUser(`doc@${CLINIC_SLUG}.test`, "Dr Clinic", "DOCTOR", []);
    },
  );
  const rivalDocId = await runWithContext(
    {
      traceId: "rival-doc",
      tenantId: rival.id,
      tenantSlug: RIVAL_SLUG,
      connection: rival.connection,
    },
    async () => {
      const res = await request(app)
        .get("/api/v1/doctors")
        .set("Host", rival.host)
        .set("Authorization", `Bearer ${rival.admin}`)
        .expect(200);
      return (res.body.data as { id: string }[])[0]!.id;
    },
  );
  rivalEncounter = (
    await arrive("Rival Emergency", {
      host: rival.host,
      token: await login(rival.host, `front@${RIVAL_SLUG}.test`),
      site: "",
      doctor: rivalDocId,
    })
  ).encounterId;
}, 240_000);

afterAll(async () => {
  await closeAllTenantConnections();
  await closeMaster();
  await closeRedis();
  await dropDatabases([process.env.MONGO_MASTER_DB as string, DB, RIVAL_DB, CLINIC_DB]);
}, 30_000);

/* ══ 1. the ED is an encounter ═══════════════════════════════════════════════ */

describe("an emergency arrival is a visit, registered the ordinary way", () => {
  it("puts an ER-class visit on the board the moment it is created", async () => {
    const { encounterId } = await arrive("Meera Nair");
    const rows = await boardAt();
    const mine = rows.find((r) => r.encounterId === encounterId);
    expect(mine, "a registered emergency arrival is not on the board").toBeTruthy();
    expect(mine?.patientName).toBe("Meera Nair");
    expect(mine?.status).toBe("arrived");
    // Nobody has assessed them, and the board says so rather than guessing.
    expect(mine?.priority).toBeUndefined();
  });

  it("keeps an ORDINARY outpatient visit off it", async () => {
    phone += 1;
    const patient = await req("post", "/api/v1/patients", deskToken, main.host, siteA)
      .send({ name: "Outpatient Only", gender: "male", contact: { phone: String(phone) } })
      .expect(201);
    const enc = await req("post", "/api/v1/encounters", deskToken, main.host, siteA)
      .send({ patientId: patient.body.data.patient.id, doctorId, departmentId: doctorId })
      .expect(201);

    const rows = await boardAt();
    expect(rows.map((r) => r.encounterId)).not.toContain(enc.body.data.encounter.id);
  });

  it("refuses to triage a visit that is not an emergency presentation", async () => {
    phone += 1;
    const patient = await req("post", "/api/v1/patients", deskToken, main.host, siteA)
      .send({ name: "Not An Emergency", gender: "male", contact: { phone: String(phone) } })
      .expect(201);
    const enc = await req("post", "/api/v1/encounters", deskToken, main.host, siteA)
      .send({ patientId: patient.body.data.patient.id, doctorId, departmentId: doctorId })
      .expect(201);

    const res = await req("post", "/api/v1/emergency/triage", nurseToken, main.host, siteA).send({
      encounterId: enc.body.data.encounter.id,
      priority: "critical",
    });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/not an emergency presentation/i);
  });

  /**
   * ── THE CLAIM THIS MODULE LIVES OR DIES ON ────────────────────────────────
   * An ED doctor's investigation is the SAME order object, on the same bench, reached through the
   * same route. If somebody ever adds `POST /emergency/orders`, this test is what should have
   * stopped them — so it drives the ordinary route against an ED visit and asserts it lands.
   */
  it("takes an ordinary lab order, on the ordinary worklist", async () => {
    const { encounterId } = await arrive("Ordered For");
    await req("post", `/api/v1/encounters/${encounterId}/queue`, deskToken, main.host, siteA);
    await req(
      "post",
      `/api/v1/encounters/${encounterId}/start`,
      doctorToken,
      main.host,
      siteA,
    ).expect(200);

    const order = await req("post", "/api/v1/orders", doctorToken, main.host, siteA).send({
      encounterId,
      category: "lab",
      code: "CBC",
      name: "Complete Blood Count",
      priority: "emergency",
    });
    expect(order.status, order.text).toBe(201);

    const bench = await req(
      "get",
      "/api/v1/orders?category=lab&status=placed",
      main.admin,
      main.host,
      siteA,
    ).expect(200);
    expect(
      (bench.body.data as { id: string }[]).map((o) => o.id),
      "an emergency lab order did not reach the ordinary bench",
    ).toContain(order.body.data.order.id);
  });
});

/* ══ 2. triage and the ordering it produces ══════════════════════════════════ */

describe("the board ranks the department", () => {
  it("records a priority and a complaint against the visit", async () => {
    const { encounterId } = await arrive("Triaged Patient");
    const res = await req("post", "/api/v1/emergency/triage", nurseToken, main.host, siteA).send({
      encounterId,
      priority: "urgent",
      chiefComplaint: "Chest pain since morning",
    });
    expect(res.status, res.text).toBe(201);
    expect(res.body.data.priority).toBe("urgent");
    expect(res.body.data.triagedAt).toBeTruthy();

    const row = (await boardAt()).find((r) => r.encounterId === encounterId);
    expect(row?.priority).toBe("urgent");
    expect(row?.chiefComplaint).toBe("Chest pain since morning");
  });

  it("REVISES rather than repeats — a deteriorating patient moves up", async () => {
    const { encounterId } = await arrive("Deteriorating");
    await req("post", "/api/v1/emergency/triage", nurseToken, main.host, siteA)
      .send({ encounterId, priority: "non_urgent" })
      .expect(201);
    await req("post", "/api/v1/emergency/triage", nurseToken, main.host, siteA)
      .send({ encounterId, priority: "critical" })
      .expect(201);

    const rows = (await boardAt()).filter((r) => r.encounterId === encounterId);
    expect(rows, "re-triage created a second row for one patient").toHaveLength(1);
    expect(rows[0]?.priority).toBe("critical");
  });

  it("survives two nurses triaging the same patient at the same instant", async () => {
    const { encounterId } = await arrive("Raced Triage");
    const [a, b] = await Promise.all([
      req("post", "/api/v1/emergency/triage", nurseToken, main.host, siteA).send({
        encounterId,
        priority: "urgent",
      }),
      req("post", "/api/v1/emergency/triage", doctorToken, main.host, siteA).send({
        encounterId,
        priority: "urgent",
      }),
    ]);
    expect([a.status, b.status].every((s) => s === 201 || s === 409)).toBe(true);

    const rows = (await boardAt()).filter((r) => r.encounterId === encounterId);
    expect(rows, "a concurrent double-triage left two rows for one patient").toHaveLength(1);
  });

  /**
   * ── THE SAFETY CLAIM ──────────────────────────────────────────────────────
   * Unknown severity sorts ABOVE known severity. A board that put the unassessed at the bottom
   * would look tidy and would be the exact arrangement that leaves somebody in a waiting room.
   */
  it("puts a patient NOBODY has assessed above every patient who has been", async () => {
    const critical = await arrive("Known Critical");
    await req("post", "/api/v1/emergency/triage", nurseToken, main.host, siteA)
      .send({ encounterId: critical.encounterId, priority: "critical" })
      .expect(201);

    const unassessed = await arrive("Just Walked In");

    const rows = await boardAt();
    const iUnassessed = rows.findIndex((r) => r.encounterId === unassessed.encounterId);
    const iCritical = rows.findIndex((r) => r.encounterId === critical.encounterId);
    expect(iUnassessed).toBeGreaterThanOrEqual(0);
    expect(iCritical).toBeGreaterThanOrEqual(0);
    expect(
      iUnassessed,
      "an unassessed patient sorted BELOW an assessed one — unknown is not low",
    ).toBeLessThan(iCritical);
  });

  it("orders critical above urgent above non-urgent", async () => {
    const low = await arrive("Sorts Last");
    const mid = await arrive("Sorts Middle");
    const high = await arrive("Sorts First");
    for (const [id, priority] of [
      [low.encounterId, "non_urgent"],
      [mid.encounterId, "urgent"],
      [high.encounterId, "critical"],
    ] as [string, string][]) {
      await req("post", "/api/v1/emergency/triage", nurseToken, main.host, siteA)
        .send({ encounterId: id, priority })
        .expect(201);
    }

    const rows = await boardAt();
    const at = (id: string) => rows.findIndex((r) => r.encounterId === id);
    expect(at(high.encounterId)).toBeLessThan(at(mid.encounterId));
    expect(at(mid.encounterId)).toBeLessThan(at(low.encounterId));
  });

  it("reports the wait from the SERVER's clock, never the caller's", async () => {
    const { encounterId } = await arrive("Waiting Patient");
    const row = (await boardAt()).find((r) => r.encounterId === encounterId);
    expect(row?.waitingMinutes).toBeGreaterThanOrEqual(0);
    expect(row?.waitingMinutes).toBeLessThan(5);
  });

  it("refuses a triage with no priority — the product does not decide how sick somebody is", async () => {
    const { encounterId } = await arrive("No Priority Given");
    const res = await req("post", "/api/v1/emergency/triage", nurseToken, main.host, siteA).send({
      encounterId,
    });
    expect(res.status).toBe(400);
  });

  it("refuses a triage on a visit that does not exist", async () => {
    const res = await req("post", "/api/v1/emergency/triage", nurseToken, main.host, siteA).send({
      encounterId: FORGED,
      priority: "urgent",
    });
    expect(res.status).toBe(404);
  });
});

/* ══ 3. disposition ══════════════════════════════════════════════════════════ */

describe("a patient leaves the board exactly when they leave the department", () => {
  it("stays on it while they are being seen", async () => {
    const { encounterId } = await arrive("Still Here");
    await req("post", `/api/v1/encounters/${encounterId}/queue`, deskToken, main.host, siteA);
    await req(
      "post",
      `/api/v1/encounters/${encounterId}/start`,
      doctorToken,
      main.host,
      siteA,
    ).expect(200);

    const row = (await boardAt()).find((r) => r.encounterId === encounterId);
    expect(row?.status).toBe("in_progress");
  });

  it("leaves it on DISCHARGE, through the ordinary close", async () => {
    const { encounterId } = await arrive("Sent Home");
    await req("post", `/api/v1/encounters/${encounterId}/queue`, deskToken, main.host, siteA);
    await req(
      "post",
      `/api/v1/encounters/${encounterId}/start`,
      doctorToken,
      main.host,
      siteA,
    ).expect(200);
    await req("post", `/api/v1/encounters/${encounterId}/close`, doctorToken, main.host, siteA)
      .send({ reason: "Discharged from ED" })
      .expect(200);

    expect((await boardAt()).map((r) => r.encounterId)).not.toContain(encounterId);
  });

  it("leaves it on ADMISSION, through the ordinary admit", async () => {
    const { encounterId } = await arrive("Needs A Bed");
    await req("post", `/api/v1/encounters/${encounterId}/queue`, deskToken, main.host, siteA);
    await req(
      "post",
      `/api/v1/encounters/${encounterId}/start`,
      doctorToken,
      main.host,
      siteA,
    ).expect(200);

    const admitted = await req(
      "post",
      `/api/v1/encounters/${encounterId}/admit`,
      doctorToken,
      main.host,
      siteA,
    ).send({ ward: "General", bedCode: `ED-${String(phone).slice(-4)}`, tariffCode: "BED_GEN" });
    expect(admitted.status, admitted.text).toBe(201);

    // The ED visit is gone from the board, and the patient is an inpatient — one care story, two
    // encounters (ADR-0013 §4), which is exactly what "admitted from the ED" means.
    expect((await boardAt()).map((r) => r.encounterId)).not.toContain(encounterId);
  });

  it("leaves it on TRANSFER OUT, and records where they went", async () => {
    const { encounterId } = await arrive("Sent Elsewhere");
    await req("post", "/api/v1/emergency/triage", nurseToken, main.host, siteA)
      .send({ encounterId, priority: "critical" })
      .expect(201);

    const res = await req(
      "post",
      "/api/v1/emergency/transfer-out",
      doctorToken,
      main.host,
      siteA,
    ).send({ encounterId, destination: "City General — cardiology", note: "Needs a cath lab." });
    expect(res.status, res.text).toBe(201);
    expect(res.body.data.transferredTo).toBe("City General — cardiology");
    expect(res.body.data.transferredAt).toBeTruthy();
    // The triage judgement survives the transfer — it is why they were sent.
    expect(res.body.data.priority).toBe("critical");

    expect((await boardAt()).map((r) => r.encounterId)).not.toContain(encounterId);

    // …and the visit was actually CLOSED, not merely annotated.
    const visit = await req(
      "get",
      `/api/v1/encounters/${encounterId}`,
      doctorToken,
      main.host,
      siteA,
    ).expect(200);
    expect(visit.body.data.status).toBe("closed");
  });

  it("records a transfer for a patient nobody had time to triage", async () => {
    const { encounterId } = await arrive("Diverted On Sight");
    const res = await req(
      "post",
      "/api/v1/emergency/transfer-out",
      doctorToken,
      main.host,
      siteA,
    ).send({ encounterId, destination: "Trauma centre" });
    expect(res.status, res.text).toBe(201);
    // No priority was invented for a patient nobody assessed.
    expect(res.body.data.priority).toBeUndefined();
    expect(res.body.data.transferredTo).toBe("Trauma centre");
  });

  it("refuses a transfer with no destination", async () => {
    const { encounterId } = await arrive("Nowhere Named");
    const res = await req(
      "post",
      "/api/v1/emergency/transfer-out",
      doctorToken,
      main.host,
      siteA,
    ).send({ encounterId, destination: "" });
    expect(res.status).toBe(400);
  });

  it("leaves it when the patient gives up and goes home", async () => {
    const { encounterId } = await arrive("Left Without Being Seen");
    await req("post", `/api/v1/encounters/${encounterId}/queue`, deskToken, main.host, siteA);
    await req("post", `/api/v1/encounters/${encounterId}/left`, deskToken, main.host, siteA).expect(
      200,
    );

    expect((await boardAt()).map((r) => r.encounterId)).not.toContain(encounterId);
  });
});

/* ══ 4. the boundaries ═══════════════════════════════════════════════════════ */

describe("who may look, and who may judge", () => {
  it("lets the NURSE triage", async () => {
    const { encounterId } = await arrive("Nurse Triaged");
    await req("post", "/api/v1/emergency/triage", nurseToken, main.host, siteA)
      .send({ encounterId, priority: "urgent" })
      .expect(201);
  });

  it("lets the DOCTOR triage — a night shift may have no triage nurse", async () => {
    const { encounterId } = await arrive("Doctor Triaged");
    await req("post", "/api/v1/emergency/triage", doctorToken, main.host, siteA)
      .send({ encounterId, priority: "urgent" })
      .expect(201);
  });

  /**
   * The desk registers the patient and can SEE the board — they are asked "where is my father"
   * twenty times a shift. What they cannot do is say how sick he is.
   */
  it("lets the front desk read the board and REFUSES them the judgement", async () => {
    const { encounterId } = await arrive("Desk Cannot Judge");

    const board = await req(
      "get",
      "/api/v1/emergency/board",
      cashierToken,
      main.host,
      siteA,
    ).expect(200);
    expect((board.body.data as { encounterId: string }[]).map((r) => r.encounterId)).toContain(
      encounterId,
    );

    const res = await req("post", "/api/v1/emergency/triage", cashierToken, main.host, siteA).send({
      encounterId,
      priority: "non_urgent",
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("HMS-AUTH-005");
  });

  it("refuses everything to an unauthenticated caller", async () => {
    for (const [method, path] of [
      ["get", "/api/v1/emergency/board"],
      ["post", "/api/v1/emergency/triage"],
      ["post", "/api/v1/emergency/transfer-out"],
    ] as ["get" | "post", string][]) {
      const res = await request(app)[method](path).set("Host", main.host).send({});
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

describe("permissions do not cross the tenancy boundary", () => {
  it("cannot triage another hospital's emergency patient", async () => {
    const res = await req("post", "/api/v1/emergency/triage", nurseToken, main.host, siteA).send({
      encounterId: rivalEncounter,
      priority: "critical",
    });
    expect(res.status).toBe(404);
  });

  it("cannot transfer another hospital's patient out", async () => {
    const res = await req(
      "post",
      "/api/v1/emergency/transfer-out",
      doctorToken,
      main.host,
      siteA,
    ).send({ encounterId: rivalEncounter, destination: "Anywhere" });
    expect(res.status).toBe(404);
  });

  it("never shows another hospital's department on this one's board", async () => {
    const rows = await boardAt(main.admin);
    expect(rows.map((r) => r.patientName)).not.toContain("Rival Emergency");
  });
});

describe("row scope: one site's department is not another's", () => {
  it("hides another branch's emergency patients", async () => {
    const mine = await arrive("Main Site ED");
    const theirs = await arrive("Riverside ED", { site: siteB, token: main.admin });

    const atB = await boardAt(siteBNurseToken, siteB);
    const names = atB.map((r) => r.patientName);
    expect(names).toContain("Riverside ED");
    expect(names, "a nurse at one site saw another site's emergency patient").not.toContain(
      "Main Site ED",
    );
    expect(atB.map((r) => r.encounterId)).not.toContain(mine.encounterId);
    expect(atB.map((r) => r.encounterId)).toContain(theirs.encounterId);
  });

  it("refuses a triage on another branch's patient", async () => {
    const mine = await arrive("Not Yours To Triage");
    const res = await req(
      "post",
      "/api/v1/emergency/triage",
      siteBNurseToken,
      main.host,
      siteB,
    ).send({ encounterId: mine.encounterId, priority: "critical" });
    expect(res.status).toBe(404);
  });
});

describe("entitlement: a hospital that never bought an emergency department has none", () => {
  it("answers HMS-PLAN-002 on the board, on triage and on transfer alike", async () => {
    const probes: ["get" | "post", string, Record<string, unknown>?][] = [
      ["get", "/api/v1/emergency/board"],
      ["post", "/api/v1/emergency/triage", { encounterId: FORGED, priority: "urgent" }],
      ["post", "/api/v1/emergency/transfer-out", { encounterId: FORGED, destination: "Anywhere" }],
    ];
    for (const [method, path, body] of probes) {
      const res = await req(method, path, clinic.admin, clinic.host).send(body ?? {});
      expect(res.body.error?.code, `${method} ${path} was not entitlement-gated`).toBe(
        "HMS-PLAN-002",
      );
    }
  });

  /**
   * ── AND WHAT STAYS CORE, DELIBERATELY ─────────────────────────────────────
   * `origin: "emergency"` and `class: "ER"` are DESCRIPTIONS of how a patient arrived. They
   * predate this module and a clinic recording "came in as an emergency" on a walk-in is telling
   * the truth about its afternoon. The licensed thing is the DEPARTMENT — triage, the board, the
   * transfer record — not the vocabulary.
   */
  it("still lets an unentitled clinic record that somebody arrived as an emergency", async () => {
    phone += 1;
    const patient = await req("post", "/api/v1/patients", clinic.admin, clinic.host)
      .send({ name: "Clinic Emergency", gender: "male", contact: { phone: String(phone) } })
      .expect(201);
    const doctors = await req("get", "/api/v1/doctors", clinic.admin, clinic.host).expect(200);
    const res = await req("post", "/api/v1/encounters", clinic.admin, clinic.host).send({
      patientId: patient.body.data.patient.id,
      origin: "emergency",
      class: "ER",
      departmentId: (doctors.body.data as { id: string }[])[0]?.id,
      doctorId: (doctors.body.data as { id: string }[])[0]?.id,
    });
    expect(res.status, res.text).toBe(201);
    expect(res.body.data.encounter.class).toBe("ER");
  });

  it("and an entitled hospital reaches the board", async () => {
    await req("get", "/api/v1/emergency/board", main.admin, main.host, siteA).expect(200);
  });
});
