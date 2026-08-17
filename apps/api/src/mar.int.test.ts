/**
 * MAR SAFETY SPINE — release-gating (M3-S1).
 *
 * ── THE DEFECT THIS SUITE EXISTS FOR ────────────────────────────────────────
 * `medicationAdministrations` shipped with two NON-unique indexes and no uniqueness at any other
 * layer. The service checked the prescription was real, signed and for this visit, then wrote a row
 * unconditionally, however many times it was asked. Two nurses charting the same 14:00 antibiotic
 * produced two `given` rows; the chart read as a double dose; nothing flagged it; and because the
 * MAR is append-only, neither row could be withdrawn.
 *
 * Before this suite the MAR had NO integration coverage at all — only an RBAC probe. So the claims
 * below are proved for the first time here:
 *
 *   1. ONE SCHEDULED SLOT HOLDS AT MOST ONE ADMINISTRATION. Enforced by the database, proved under
 *      genuine concurrency rather than by a service-level check-then-insert.
 *   2. THE SECOND ATTEMPT LEARNS WHO GOT THERE FIRST. A 409 carrying the existing row, so a lost
 *      response cannot become a second dose in a patient.
 *   3. PRN IS STILL REPEATABLE. The fix must not make an as-needed analgesic single-use.
 *   4. THE ROUND IS ON THE WARD'S CLOCK, not the server's and not the phone's.
 *   5. THE SAME DRUG TWICE ON ONE PRESCRIPTION IS TWO MEDICATIONS, and charting one is not
 *      charting the other.
 *
 * ── THE ZONE IS DELIBERATELY NOT THE PROCESS ZONE ───────────────────────────
 * `vitest.config.ts` pins `TZ: "Asia/Kolkata"`. The ward here is `America/New_York` — 9.5 hours
 * away — so a schedule computed on the process clock cannot accidentally look right.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { listening } from "./test/appServer.js";
/** Only for the fan-out probe below — `mongoose.set("debug")` counts collection operations. */
import mongoose from "mongoose";
import { createLogger } from "@medicore/logger";
import { assertMongoReachable, dropDatabases, TEST_MONGO_URI } from "./test/mongoTestEnv.js";
import { assertRedisReachable, flushTestCache, testRedisUrl } from "./test/redisTestEnv.js";

process.env.MONGO_URI = TEST_MONGO_URI;
process.env.REDIS_URL = testRedisUrl("mar");
process.env.MONGO_MASTER_DB = "test_mar_master";
process.env.TENANT_BASE_DOMAIN = "medicore.test";

const { createApp } = await import("./app.js");
const { provisionTenant } = await import("./modules/tenants/index.js");
const { getTenantConnection, closeAllTenantConnections } =
  await import("./core/db/connectionManager.js");
const { forgetSchemaReadiness } = await import("./core/db/schemaReadiness.js");
const { closeMaster } = await import("./core/db/masterDb.js");
const { closeRedis } = await import("./core/redis/redis.js");
const { runWithContext } = await import("./core/context/requestContext.js");
const { createUser, transitionStatus } = await import("./modules/users/index.js");
const { assignRoleByCode, seedRbac } = await import("./modules/rbac/index.js");
const { setPassword } = await import("./modules/auth/index.js");
const { seedTariff } = await import("./seed/tariff.js");
/** M3-S5B: the round is gated on the NURSING module, and that has to be provable. */
const { setFeatureOverride, clearFeatureOverride } =
  await import("./modules/entitlements/index.js");
const { FEATURE_FLAGS } = await import("@medicore/permissions");

const SLUG = "test-mar";
/** A second hospital, for the cross-tenant probe (M3-S5A). Its own physical database. */
const RIVAL_SLUG = "test-mar-rival";
const PASSWORD = "V4lid!Password#2026";
/** 9.5 hours from the pinned process zone, and DST-observing, which Kolkata is not. */
const WARD_ZONE = "America/New_York";
/** Dropped alongside the master: a tenant DB that survives a run carries the OLD plan and the
 *  old rows, which is how a suite starts failing for reasons that have nothing to do with it. */
const TENANT_DB = `hms_${SLUG}`;
const RIVAL_DB = `hms_${RIVAL_SLUG}`;

const app = await listening(createApp(createLogger({ service: "mar-int-test" })));

let tenantId = "";
let host = "";
let adminToken = "";
let doctorToken = "";
let doctorId = "";
let nurseToken = "";
let nurseId = "";
let nurse2Token = "";
let receptionToken = "";
/** A nurse who works only at the OTHER site — the branch-isolation probe. */
let otherSiteNurseToken = "";
let wardBranchId = "";
let otherBranchId = "";
let connection: Awaited<ReturnType<typeof getTenantConnection>>;

function auth(req: request.Test, token: string): request.Test {
  return req.set("Host", host).set("Authorization", `Bearer ${token}`);
}

async function login(email: string): Promise<string> {
  return loginAt(host, email);
}

/** Sign in at a named host — the rival hospital is a different host, not a different path. */
async function loginAt(atHost: string, email: string): Promise<string> {
  const res = await request(app)
    .post("/api/v1/auth/login")
    .set("Host", atHost)
    .send({ email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login ${email}: ${String(res.status)}`);
  return res.body.data.accessToken as string;
}

/**
 * @param branchIds the sites this user may work at. EMPTY means hospital-wide — and with two
 * branches a hospital-wide user cannot write at all, because `writeBranchId()` refuses to guess
 * which site a row belongs to. Ward staff are therefore confined to the ward, which is also what
 * a real hospital does.
 */
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
  await dropDatabases([process.env.MONGO_MASTER_DB as string, TENANT_DB, RIVAL_DB]);
  await flushTestCache("mar");

  const t = await provisionTenant({
    hospitalName: SLUG,
    slug: SLUG,
    planCode: "PLAN_HOSPITAL", // nursing + IPD + prescriptions
    organizationType: "private_hospital",
    // Two sites, so branch isolation has a boundary to cross. `maxBranches` is a provisioning
    // limit, not a plan feature — the default is 1 and a second POST is a 402, not a 403.
    maxBranches: 2,
  });
  tenantId = t.tenant.id;
  host = `${SLUG}.medicore.test`;
  connection = await getTenantConnection({
    id: t.tenant.id,
    databaseName: t.tenant.databaseName,
  });
  await seedTariff(t.tenant.id, SLUG, connection);

  // The admin first and alone: the branch list is an authenticated read, and every other user's
  // scope depends on knowing the branch ids.
  await runWithContext(
    { traceId: "mar-setup", tenantId, tenantSlug: SLUG, connection },
    async () => {
      await seedRbac();
      await makeUser(`admin@${SLUG}.test`, "Admin", "TENANT_ADMIN", []);
    },
  );
  adminToken = await login(`admin@${SLUG}.test`);

  // The ward's clock. Provisioning already seeds a main branch, so this moves the existing one.
  const branches = await auth(request(app).get("/api/v1/branches"), adminToken).expect(200);
  wardBranchId = (branches.body.data as { id: string }[])[0]?.id as string;
  await auth(request(app).patch(`/api/v1/branches/${wardBranchId}`), adminToken)
    .send({ timezone: WARD_ZONE })
    .expect(200);

  // A second site, in a different zone, staffed by somebody who may not work at the first.
  const other = await auth(request(app).post("/api/v1/branches"), adminToken)
    .send({ name: "Second Site", code: "SS2", timezone: "Asia/Kolkata" })
    .expect(201);
  otherBranchId = other.body.data.id as string;

  await runWithContext(
    { traceId: "mar-setup-staff", tenantId, tenantSlug: SLUG, connection },
    async () => {
      doctorId = await makeUser(`doc@${SLUG}.test`, "Dr Rao", "DOCTOR", [wardBranchId]);
      nurseId = await makeUser(`nurse@${SLUG}.test`, "Sister Fatima", "NURSE", [wardBranchId]);
      await makeUser(`nurse2@${SLUG}.test`, "Sister Priya", "NURSE", [wardBranchId]);
      await makeUser(`front@${SLUG}.test`, "Front Desk", "RECEPTIONIST", [wardBranchId]);
      await makeUser(`nurse3@${SLUG}.test`, "Sister Anjali", "NURSE", [otherBranchId]);
    },
  );

  doctorToken = await login(`doc@${SLUG}.test`);
  nurseToken = await login(`nurse@${SLUG}.test`);
  nurse2Token = await login(`nurse2@${SLUG}.test`);
  receptionToken = await login(`front@${SLUG}.test`);
  otherSiteNurseToken = await login(`nurse3@${SLUG}.test`);

  /**
   * A whole second hospital with a real admitted patient (M3-S5A).
   *
   * Tenant isolation here is PHYSICAL — one database per hospital — so this exists to prove that
   * a REAL encounter id from another tenant, not a fabricated one, is unreachable. A made-up id
   * would pass the same assertions for the wrong reason.
   */
  const rival = await provisionTenant({
    hospitalName: RIVAL_SLUG,
    slug: RIVAL_SLUG,
    planCode: "PLAN_HOSPITAL",
    organizationType: "private_hospital",
    maxBranches: 1,
  });
  rivalHost = `${RIVAL_SLUG}.medicore.test`;
  const rivalConnection = await getTenantConnection({
    id: rival.tenant.id,
    databaseName: rival.tenant.databaseName,
  });
  await seedTariff(rival.tenant.id, RIVAL_SLUG, rivalConnection);
  let rivalDoctorId = "";
  await runWithContext(
    {
      traceId: "mar-setup-rival",
      tenantId: rival.tenant.id,
      tenantSlug: RIVAL_SLUG,
      connection: rivalConnection,
    },
    async () => {
      await seedRbac();
      rivalDoctorId = await makeUser(`doc@${RIVAL_SLUG}.test`, "Dr Rival", "DOCTOR", []);
      await makeUser(`front@${RIVAL_SLUG}.test`, "Desk Rival", "RECEPTIONIST", []);
      await makeUser(`nurse@${RIVAL_SLUG}.test`, "Sister Rival", "NURSE", []);
    },
  );
  rivalEncounterId = await admitAtRival(rivalDoctorId);
  rivalAdministrationId = await chartAtRival(rivalEncounterId);
}, 180_000);

let rivalHost = "";
let rivalEncounterId = "";
/** A dose genuinely charted at the OTHER hospital — see `chartAtRival`. */
let rivalAdministrationId = "";

/** An admitted patient at the OTHER hospital. Mirrors `admitPatient`, on the rival's host. */
async function admitAtRival(departmentId: string): Promise<string> {
  const desk = await loginAt(rivalHost, `front@${RIVAL_SLUG}.test`);
  const doc = await loginAt(rivalHost, `doc@${RIVAL_SLUG}.test`);
  const at = (r: request.Test, token: string) =>
    r.set("Host", rivalHost).set("Authorization", `Bearer ${token}`);

  const patient = await at(request(app).post("/api/v1/patients"), desk)
    .send({
      name: "Rival Patient",
      gender: "female",
      contact: { phone: `9${Math.floor(Math.random() * 1e9)}` },
    })
    .expect(201);

  const enc = await at(request(app).post("/api/v1/encounters"), desk)
    .send({ patientId: patient.body.data.patient.id, departmentId })
    .expect(201);
  const opId = enc.body.data.encounter.id as string;

  await at(request(app).post(`/api/v1/encounters/${opId}/queue`), desk);
  await at(request(app).post(`/api/v1/encounters/${opId}/start`), doc).expect(200);
  const admitted = await at(request(app).post(`/api/v1/encounters/${opId}/admit`), doc)
    .send({
      ward: "General",
      bedCode: `R-${Math.floor(Math.random() * 1e6)}`,
      tariffCode: "BED_GEN",
    })
    .expect(201);

  return admitted.body.data.inpatient.id as string;
}

/**
 * A real, signed prescription and a real administration AT THE RIVAL HOSPITAL.
 *
 * ── WHY THIS FIXTURE HAD TO EXIST (found by falsification in M3-S6) ─────────
 * The cross-tenant tests below used to ask this hospital about the rival's ENCOUNTER ID and
 * assert an empty answer — which is true whether or not isolation works, because the id simply is
 * not in this database and the rival had no MAR rows at all. Pinning the MAR repository to one
 * shared database (the strongest possible breach) left every assertion green.
 *
 * So the rival now holds a dose that genuinely exists. "This hospital cannot see it" is then a
 * claim about isolation rather than about an empty collection.
 */
async function chartAtRival(encounterId: string): Promise<string> {
  const doc = await loginAt(rivalHost, `doc@${RIVAL_SLUG}.test`);
  const nurse = await loginAt(rivalHost, `nurse@${RIVAL_SLUG}.test`);
  const at = (r: request.Test, token: string) =>
    r.set("Host", rivalHost).set("Authorization", `Bearer ${token}`);

  const draft = await at(request(app).post("/api/v1/prescriptions"), doc)
    .send({ encounterId, lines: [PARACETAMOL_TDS] })
    .expect(201);
  const rx = draft.body.data.id as string;
  await at(request(app).post(`/api/v1/prescriptions/${rx}/sign`), doc).expect(200);

  const given = await at(
    request(app).post(`/api/v1/encounters/${encounterId}/medication-administrations`),
    nurse,
  )
    .send({ prescriptionId: rx, drugCode: PARACETAMOL_TDS.drugCode, status: "given" })
    .expect(201);

  return given.body.data.id as string;
}

afterAll(async () => {
  await closeAllTenantConnections();
  await closeMaster();
  await closeRedis();
  await dropDatabases([process.env.MONGO_MASTER_DB as string, TENANT_DB, RIVAL_DB]);
}, 30_000);

/* ── fixtures ──────────────────────────────────────────────────────────────── */

const PARACETAMOL_TDS = {
  drugCode: "DRUG_PARA_500",
  drugName: "Paracetamol 500mg Tablet",
  dose: "500 mg",
  route: "oral" as const,
  frequency: "TDS" as const,
  durationDays: 5,
  quantity: 15,
};

/** The same drug again, as needed — the pair that makes `drugCode` an unsafe identity. */
const PARACETAMOL_PRN = { ...PARACETAMOL_TDS, frequency: "SOS" as const, quantity: 6 };

const ADRENALINE_STAT = {
  drugCode: "DRUG_ADR_1",
  drugName: "Adrenaline 1mg",
  dose: "1 mg",
  route: "im" as const,
  frequency: "STAT" as const,
  quantity: 1,
};

async function admitPatient(name: string): Promise<string> {
  const p = await auth(request(app).post("/api/v1/patients"), receptionToken)
    .send({ name, gender: "female", contact: { phone: `9${Math.floor(Math.random() * 1e9)}` } })
    .expect(201);

  const enc = await auth(request(app).post("/api/v1/encounters"), receptionToken)
    .send({ patientId: p.body.data.patient.id, departmentId: doctorId })
    .expect(201);

  return enc.body.data.encounter.id as string;
}

/**
 * A genuinely ADMITTED patient, returning the INPATIENT encounter.
 *
 * `admitPatient` above opens an OP visit, which is all the MAR itself needs — a dose can be
 * charted on any encounter. The ward worklist reads `/inpatients`, which is `class: IP` and
 * `open: true`, so its tests need the real admission chain: queue, start, admit. `arrived →
 * admitted` is not a legal edge, and the patient must actually have been seen.
 */
async function admitToWard(name: string): Promise<string> {
  const opId = await admitPatient(name);
  await auth(request(app).post(`/api/v1/encounters/${opId}/queue`), receptionToken);
  await auth(request(app).post(`/api/v1/encounters/${opId}/start`), doctorToken).expect(200);

  const admitted = await auth(request(app).post(`/api/v1/encounters/${opId}/admit`), doctorToken)
    .send({
      ward: "General",
      bedCode: `B-${Math.floor(Math.random() * 1e6)}`,
      tariffCode: "BED_GEN",
    })
    .expect(201);

  return admitted.body.data.inpatient.id as string;
}

/** A signed, administrable prescription for the encounter. */
async function signedRx(encounterId: string, lines: unknown[]): Promise<string> {
  const draft = await auth(request(app).post("/api/v1/prescriptions"), doctorToken)
    .send({ encounterId, lines })
    .expect(201);
  const id = draft.body.data.id as string;
  await auth(request(app).post(`/api/v1/prescriptions/${id}/sign`), doctorToken).expect(200);
  return id;
}

interface ChartInput {
  prescriptionId: string;
  drugCode: string;
  lineIndex?: number;
  status?: string;
  scheduledFor?: string;
  administeredAt?: string;
  reason?: string;
}

function chart(encounterId: string, body: ChartInput, token = nurseToken, key?: string) {
  const req = auth(
    request(app).post(`/api/v1/encounters/${encounterId}/medication-administrations`),
    token,
  );
  if (key) req.set("Idempotency-Key", key);
  return req.send({ status: "given", ...body });
}

/**
 * 08:00 tomorrow at the ward, as a UTC instant.
 *
 * Used to chart a PRN dose at a time that IS a round for the scheduled frequencies. If PRN were
 * ever given slots, this is the instant that would bind one — so the repeatability test below
 * genuinely fails when the PRN exemption is removed, instead of passing because "now" happened
 * to fall between rounds.
 */
function wardRoundTomorrow(hour: number): string {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const dayKey = new Intl.DateTimeFormat("en-CA", {
    timeZone: WARD_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(tomorrow);
  // New York is UTC-4 in summer and UTC-5 in winter; resolve rather than assume.
  const naive = new Date(`${dayKey}T${String(hour).padStart(2, "0")}:00:00Z`);
  const shown = new Intl.DateTimeFormat("en-US", {
    timeZone: WARD_ZONE,
    hour12: false,
    hour: "2-digit",
  }).format(naive);
  const offsetHours = (Number(shown) % 24) - hour;
  return new Date(naive.getTime() - offsetHours * 60 * 60 * 1000).toISOString();
}

function schedule(encounterId: string, date?: string, token = nurseToken) {
  const qs = date ? `?date=${date}` : "";
  return auth(
    request(app).get(`/api/v1/encounters/${encounterId}/medication-schedule${qs}`),
    token,
  );
}

/* ── 1. the schedule is on the ward's clock ────────────────────────────────── */

describe("the dose schedule resolves in the ward's timezone", () => {
  it("offers a TDS round at 08:00, 14:00 and 20:00 New York — not on the server clock", async () => {
    const enc = await admitPatient("Schedule Subject");
    await signedRx(enc, [PARACETAMOL_TDS]);

    const res = await schedule(enc).expect(200);
    const slots = res.body.data as { scheduledFor: string; state: string }[];
    expect(slots.length).toBeGreaterThan(0);

    const hours = slots.map((s) =>
      Number(
        new Intl.DateTimeFormat("en-GB", {
          timeZone: WARD_ZONE,
          hour: "2-digit",
          hour12: false,
        }).format(new Date(s.scheduledFor)),
      ),
    );
    for (const h of hours) expect([8, 14, 20]).toContain(h);

    // The falsifiable half: on the process clock (IST) these same instants are not round hours,
    // and a schedule built in UTC would put them at 08:00Z. Neither is what a New York ward sees.
    const istHours = slots.map((s) =>
      Number(
        new Intl.DateTimeFormat("en-GB", {
          timeZone: "Asia/Kolkata",
          hour: "2-digit",
          hour12: false,
        }).format(new Date(s.scheduledFor)),
      ),
    );
    expect(istHours.some((h) => [8, 14, 20].includes(h))).toBe(false);
  });

  it("a PRN line contributes no slots — it is never 'due'", async () => {
    const enc = await admitPatient("PRN Only");
    await signedRx(enc, [PARACETAMOL_PRN]);
    const res = await schedule(enc).expect(200);
    expect(res.body.data).toEqual([]);
  });

  it("reports a slot as answered once it is charted", async () => {
    const enc = await admitPatient("Answered Slot");
    const rx = await signedRx(enc, [PARACETAMOL_TDS]);

    const before = await schedule(enc).expect(200);
    const slot = (before.body.data as { scheduledFor: string }[])[0] as { scheduledFor: string };

    await chart(enc, {
      prescriptionId: rx,
      drugCode: PARACETAMOL_TDS.drugCode,
      scheduledFor: slot.scheduledFor,
    }).expect(201);

    const after = await schedule(enc).expect(200);
    const answered = (
      after.body.data as { scheduledFor: string; state: string; administeredBy?: string }[]
    ).find((s) => s.scheduledFor === slot.scheduledFor);
    expect(answered?.state).toBe("given");
    expect(answered?.administeredBy).toBe(nurseId);
  });
});

/* ── 2. one slot, one administration ───────────────────────────────────────── */

describe("a scheduled dose slot holds at most one administration", () => {
  it("refuses a second nurse charting the same slot, and names who got there first", async () => {
    const enc = await admitPatient("Double Dose Risk");
    const rx = await signedRx(enc, [PARACETAMOL_TDS]);
    const slot = ((await schedule(enc).expect(200)).body.data as { scheduledFor: string }[])[0]
      ?.scheduledFor as string;

    await chart(
      enc,
      { prescriptionId: rx, drugCode: PARACETAMOL_TDS.drugCode, scheduledFor: slot },
      nurseToken,
      "nurse-one-key",
    ).expect(201);

    // A DIFFERENT nurse, a DIFFERENT idempotency key — everything the key mechanism cannot catch.
    const second = await chart(
      enc,
      { prescriptionId: rx, drugCode: PARACETAMOL_TDS.drugCode, scheduledFor: slot },
      nurse2Token,
      "nurse-two-key",
    ).expect(409);

    expect(second.body.error.code).toBe("HMS-MAR-001");
    // The oracle: enough to tell the second nurse this dose is already in the patient.
    expect(second.body.error.details.existing).toMatchObject({
      status: "given",
      drugName: PARACETAMOL_TDS.drugName,
      administeredBy: nurseId,
      scheduledFor: slot,
    });

    const log = await auth(
      request(app).get(`/api/v1/encounters/${enc}/medication-administrations`),
      nurseToken,
    ).expect(200);
    expect(log.body.data).toHaveLength(1);
  });

  it("holds under GENUINE concurrency — the database, not a check-then-insert", async () => {
    const enc = await admitPatient("Race Subject");
    const rx = await signedRx(enc, [PARACETAMOL_TDS]);
    const slot = ((await schedule(enc).expect(200)).body.data as { scheduledFor: string }[])[0]
      ?.scheduledFor as string;

    /**
     * Fired together, deliberately not serialised. A service-level "does a row already exist?"
     * check passes both of these — the second request's read happens before the first's write —
     * which is exactly why the guard has to be the unique index.
     */
    const [a, b] = await Promise.all([
      chart(
        enc,
        { prescriptionId: rx, drugCode: PARACETAMOL_TDS.drugCode, scheduledFor: slot },
        nurseToken,
        "race-nurse-a",
      ),
      chart(
        enc,
        { prescriptionId: rx, drugCode: PARACETAMOL_TDS.drugCode, scheduledFor: slot },
        nurse2Token,
        "race-nurse-b",
      ),
    ]);

    const codes = [a.status, b.status].sort((x, y) => x - y);
    expect(codes).toEqual([201, 409]);

    const log = await auth(
      request(app).get(`/api/v1/encounters/${enc}/medication-administrations`),
      nurseToken,
    ).expect(200);
    expect(log.body.data).toHaveLength(1);
  });

  it("protects a client that names no slot at all — the server binds the round", async () => {
    const enc = await admitPatient("Legacy Client");
    const rx = await signedRx(enc, [PARACETAMOL_TDS]);
    const slot = ((await schedule(enc).expect(200)).body.data as { scheduledFor: string }[])[0]
      ?.scheduledFor as string;

    // No `scheduledFor` — the shape an older build sends. `administeredAt` puts it on the round.
    const first = await chart(enc, {
      prescriptionId: rx,
      drugCode: PARACETAMOL_TDS.drugCode,
      administeredAt: slot,
    }).expect(201);
    expect(first.body.data.scheduledFor).toBe(slot);

    await chart(
      enc,
      { prescriptionId: rx, drugCode: PARACETAMOL_TDS.drugCode, administeredAt: slot },
      nurse2Token,
      "legacy-two",
    ).expect(409);
  });

  it("prevents a STAT dose being given twice", async () => {
    const enc = await admitPatient("Stat Subject");
    const rx = await signedRx(enc, [ADRENALINE_STAT]);

    await chart(enc, { prescriptionId: rx, drugCode: ADRENALINE_STAT.drugCode }).expect(201);
    const second = await chart(
      enc,
      { prescriptionId: rx, drugCode: ADRENALINE_STAT.drugCode },
      nurse2Token,
      "stat-two",
    ).expect(409);
    expect(second.body.error.code).toBe("HMS-MAR-001");
  });
});

/* ── 3. PRN must stay repeatable ───────────────────────────────────────────── */

describe("PRN is not caught by the slot rule", () => {
  it("allows the same as-needed drug to be given repeatedly", async () => {
    const enc = await admitPatient("PRN Repeat");
    const rx = await signedRx(enc, [PARACETAMOL_PRN]);

    // Deliberately charted ON a round time. A scheduled line would bind a slot here and the
    // second attempt would be a 409; a PRN line must simply record three separate doses.
    const onTheRound = wardRoundTomorrow(8);
    for (const key of ["prn-dose-1", "prn-dose-2", "prn-dose-3"]) {
      const res = await chart(
        enc,
        {
          prescriptionId: rx,
          drugCode: PARACETAMOL_PRN.drugCode,
          administeredAt: onTheRound,
        },
        nurseToken,
        key,
      ).expect(201);
      // No slot, so nothing constrains it — which is the point.
      expect(res.body.data.scheduledFor).toBeUndefined();
    }

    const log = await auth(
      request(app).get(`/api/v1/encounters/${enc}/medication-administrations`),
      nurseToken,
    ).expect(200);
    expect(log.body.data).toHaveLength(3);
  });

  it("rejects a slot claimed for a PRN line rather than silently ignoring it", async () => {
    const enc = await admitPatient("PRN Slot Claim");
    const rx = await signedRx(enc, [PARACETAMOL_PRN]);
    const res = await chart(enc, {
      prescriptionId: rx,
      drugCode: PARACETAMOL_PRN.drugCode,
      scheduledFor: new Date().toISOString(),
    }).expect(400);
    expect(res.body.error.details.scheduledFor[0]).toMatch(/as needed/);
  });
});

/* ── 4. the same drug twice is two medications ─────────────────────────────── */

describe("prescription line identity", () => {
  it("refuses an ambiguous drugCode instead of charting an arbitrary line", async () => {
    const enc = await admitPatient("Ambiguous Drug");
    const rx = await signedRx(enc, [PARACETAMOL_TDS, PARACETAMOL_PRN]);

    const res = await chart(enc, {
      prescriptionId: rx,
      drugCode: PARACETAMOL_TDS.drugCode,
    }).expect(400);
    expect(res.body.error.details.lineIndex[0]).toMatch(/2 times/);
  });

  it("charts the PRN line without touching the scheduled one", async () => {
    const enc = await admitPatient("Two Lines One Drug");
    const rx = await signedRx(enc, [PARACETAMOL_TDS, PARACETAMOL_PRN]);

    const prn = await chart(enc, {
      prescriptionId: rx,
      drugCode: PARACETAMOL_TDS.drugCode,
      lineIndex: 1,
    }).expect(201);
    expect(prn.body.data.lineIndex).toBe(1);
    expect(prn.body.data.scheduledFor).toBeUndefined();

    // The scheduled line's rounds are all still open.
    const slots = (await schedule(enc).expect(200)).body.data as { state: string }[];
    expect(slots.every((s) => s.state === "due" || s.state === "overdue")).toBe(true);
  });

  it("rejects a lineIndex that disagrees with the drugCode sent alongside it", async () => {
    const enc = await admitPatient("Mismatched Line");
    const rx = await signedRx(enc, [PARACETAMOL_TDS, ADRENALINE_STAT]);
    const res = await chart(enc, {
      prescriptionId: rx,
      drugCode: ADRENALINE_STAT.drugCode,
      lineIndex: 0,
    }).expect(400);
    expect(res.body.error.details.drugCode[0]).toMatch(/line 0 is/);
  });
});

/* ── 5. the slot cannot be invented by the client ──────────────────────────── */

describe("a client may not declare its own slot", () => {
  it("rejects a scheduledFor the prescription's schedule does not contain", async () => {
    const enc = await admitPatient("Invented Slot");
    const rx = await signedRx(enc, [PARACETAMOL_TDS]);

    const res = await chart(enc, {
      prescriptionId: rx,
      drugCode: PARACETAMOL_TDS.drugCode,
      // 09:17 is not a round on any schedule this prescription generates.
      scheduledFor: "2026-06-11T13:17:00.000Z",
    }).expect(400);
    expect(res.body.error.details.scheduledFor[0]).toMatch(/not a scheduled dose/);
  });
});

/* ── 6. idempotency and state, which are separate concerns ─────────────────── */

describe("Idempotency-Key and slot uniqueness are different mechanisms", () => {
  it("replays the original response for the same key without writing a second row", async () => {
    const enc = await admitPatient("Lost Response");
    const rx = await signedRx(enc, [PARACETAMOL_TDS]);

    const first = await chart(
      enc,
      { prescriptionId: rx, drugCode: PARACETAMOL_TDS.drugCode },
      nurseToken,
      "lost-response-key",
    ).expect(201);

    // The client never saw the 201 and retried with the SAME key.
    const replay = await chart(
      enc,
      { prescriptionId: rx, drugCode: PARACETAMOL_TDS.drugCode },
      nurseToken,
      "lost-response-key",
    ).expect(201);

    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(replay.headers["idempotency-replayed"]).toBe("true");

    const log = await auth(
      request(app).get(`/api/v1/encounters/${enc}/medication-administrations`),
      nurseToken,
    ).expect(200);
    expect(log.body.data).toHaveLength(1);
  });

  it("refuses a dose against a cancelled prescription", async () => {
    const enc = await admitPatient("Cancelled Order");
    const rx = await signedRx(enc, [PARACETAMOL_TDS]);
    await auth(request(app).post(`/api/v1/prescriptions/${rx}/cancel`), doctorToken)
      .send({ reason: "culture came back negative" })
      .expect(200);

    const res = await chart(enc, {
      prescriptionId: rx,
      drugCode: PARACETAMOL_TDS.drugCode,
    }).expect(422);
    expect(res.body.error.code).toBe("HMS-STATE-001");
  });

  it("refuses a dose against an unsigned draft", async () => {
    const enc = await admitPatient("Draft Order");
    const draft = await auth(request(app).post("/api/v1/prescriptions"), doctorToken)
      .send({ encounterId: enc, lines: [PARACETAMOL_TDS] })
      .expect(201);

    await chart(enc, {
      prescriptionId: draft.body.data.id,
      drugCode: PARACETAMOL_TDS.drugCode,
    }).expect(422);
  });

  it("refuses a prescription belonging to another visit", async () => {
    const encA = await admitPatient("Visit A");
    const encB = await admitPatient("Visit B");
    const rxA = await signedRx(encA, [PARACETAMOL_TDS]);

    await chart(encB, { prescriptionId: rxA, drugCode: PARACETAMOL_TDS.drugCode }).expect(400);
  });
});

/* ── 7. authorization ──────────────────────────────────────────────────────── */

describe("authorization", () => {
  it("lets a nurse chart and a receptionist not", async () => {
    const enc = await admitPatient("Authz Subject");
    const rx = await signedRx(enc, [PARACETAMOL_TDS]);

    await chart(
      enc,
      { prescriptionId: rx, drugCode: PARACETAMOL_TDS.drugCode },
      receptionToken,
      "authz-front",
    ).expect(403);

    await chart(
      enc,
      { prescriptionId: rx, drugCode: PARACETAMOL_TDS.drugCode },
      nurseToken,
      "authz-nurse",
    ).expect(201);
  });

  /**
   * ── THE PERMISSION SPLIT, IN THE DIRECTION THAT ACTUALLY TESTS IT ─────────
   * A receptionist is refused by `emr:read` alone, so that case proves nothing about
   * `mar:administer`. The DOCTOR is the discriminating role: they hold `emr:read` (they read the
   * round below) and do NOT hold `mar:administer`, because giving a drug is the nurse's own act
   * and its own responsibility.
   *
   * Added in M3-S5A after falsification: swapping the route's permission to `emr:read` broke
   * nothing, which meant nothing was testing the permission at all. The RBAC matrix cannot catch
   * a swap either — it reads the tags back off the shipped app, so it stays self-consistent.
   */
  it("refuses a DOCTOR — reading the round is emr:read, charting a dose is not", async () => {
    const enc = await admitPatient("Doctor Charts");
    const rx = await signedRx(enc, [PARACETAMOL_TDS]);

    await chart(
      enc,
      { prescriptionId: rx, drugCode: PARACETAMOL_TDS.drugCode },
      doctorToken,
      "authz-doctor-charts",
    ).expect(403);

    // …and no row was written by the attempt.
    const rows = await auth(
      request(app).get(`/api/v1/encounters/${enc}/medication-administrations`),
      nurseToken,
    ).expect(200);
    expect(rows.body.data).toEqual([]);
  });

  it("lets the doctor read the schedule — it is emr:read, not a nursing-only view", async () => {
    const enc = await admitPatient("Doctor Reads");
    await signedRx(enc, [PARACETAMOL_TDS]);
    await schedule(enc, undefined, doctorToken).expect(200);
  });

  it("refuses the schedule to a role with no clinical read", async () => {
    const enc = await admitPatient("Front Desk Reads");
    await signedRx(enc, [PARACETAMOL_TDS]);
    await schedule(enc, undefined, receptionToken).expect(403);
  });
});

/* ── 8. the migration is safe on data that already exists ──────────────────── */

describe("migration 0049 over existing clinical history", () => {
  /**
   * The question the work order asks: what happens to a hospital that ALREADY holds duplicate
   * administrations when the unique index is created?
   *
   * Answer, proved rather than asserted: nothing. Historical rows have no `scheduledFor`, the
   * index is partial on that field's existence, so they are not in it and cannot conflict with
   * it. No clinical record is rewritten to make the build succeed — which is the rule that
   * matters, because the alternative is a migration that deletes evidence.
   */
  it("keeps pre-existing duplicate rows and still builds the index", async () => {
    const enc = await admitPatient("Historical Duplicate");
    const rx = await signedRx(enc, [PARACETAMOL_TDS]);

    const collection = connection.collection("medicationAdministrations");
    // Scoped to THIS run: the tenant database is not dropped between runs, so a fixed marker
    // would count the previous run's rows too and the assertion would drift upwards.
    const marker = `legacy-${Date.now().toString(36)}`;
    const legacy = {
      tenantId,
      encounterId: connection.base.Types.ObjectId.createFromHexString(enc),
      patientId: marker,
      prescriptionId: connection.base.Types.ObjectId.createFromHexString(rx),
      drugCode: PARACETAMOL_TDS.drugCode,
      drugName: PARACETAMOL_TDS.drugName,
      dose: "500 mg",
      route: "oral",
      status: "given",
      administeredAt: new Date("2026-01-01T08:00:00Z"),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await collection.insertMany([legacy, { ...legacy }]);

    // The index already exists (migrations ran at provisioning); rebuilding is the operation a
    // hospital upgrading with dirty data performs.
    await collection.createIndex(
      { tenantId: 1, prescriptionId: 1, lineIndex: 1, scheduledFor: 1 },
      {
        unique: true,
        partialFilterExpression: { scheduledFor: { $exists: true } },
        name: "one_administration_per_dose_slot",
      },
    );

    const survivors = await collection.countDocuments({ patientId: marker });
    expect(survivors).toBe(2);

    // And the new rule still applies to anything charted from now on.
    const slot = ((await schedule(enc).expect(200)).body.data as { scheduledFor: string }[])[0]
      ?.scheduledFor as string;
    await chart(enc, {
      prescriptionId: rx,
      drugCode: PARACETAMOL_TDS.drugCode,
      scheduledFor: slot,
    }).expect(201);
    await chart(
      enc,
      { prescriptionId: rx, drugCode: PARACETAMOL_TDS.drugCode, scheduledFor: slot },
      nurse2Token,
      "after-legacy",
    ).expect(409);
  });
});

/* ── 9. the branch boundary ────────────────────────────────────────────────── */

describe("branch isolation", () => {
  /**
   * A nurse confined to the second site must not be able to see — or answer — a dose slot on a
   * ward they do not work at. Patient identity is not what keeps them apart: both sites belong to
   * one hospital and share one patient register, so the boundary has to be the branch scope on
   * every read and every write.
   */
  it("hides another site's MAR and refuses a dose charted across the boundary", async () => {
    const enc = await admitPatient("Cross Branch Subject");
    const rx = await signedRx(enc, [PARACETAMOL_TDS]);
    await chart(enc, { prescriptionId: rx, drugCode: PARACETAMOL_TDS.drugCode }).expect(201);

    // The ward's own nurse sees the dose.
    const mine = await auth(
      request(app).get(`/api/v1/encounters/${enc}/medication-administrations`),
      nurseToken,
    ).expect(200);
    expect(mine.body.data).toHaveLength(1);

    // The other site's nurse sees nothing of it.
    const theirs = await auth(
      request(app).get(`/api/v1/encounters/${enc}/medication-administrations`),
      otherSiteNurseToken,
    ).expect(200);
    expect(theirs.body.data).toEqual([]);

    // And cannot chart against it: the prescription is not reachable from where they work.
    await chart(
      enc,
      { prescriptionId: rx, drugCode: PARACETAMOL_TDS.drugCode },
      otherSiteNurseToken,
      "cross-branch-attempt",
    ).expect(404);
  });

  it("shows no dose schedule for a ward the caller does not work at", async () => {
    const enc = await admitPatient("Cross Branch Schedule");
    await signedRx(enc, [PARACETAMOL_TDS]);

    expect((await schedule(enc).expect(200)).body.data.length).toBeGreaterThan(0);
    expect((await schedule(enc, undefined, otherSiteNurseToken).expect(200)).body.data).toEqual([]);
  });
});

/* ── 10. the ward worklist (M3-S3) ─────────────────────────────────────────── */

describe("the ward worklist", () => {
  /**
   * The endpoint exists to answer, in ONE request, what the phone would otherwise assemble from
   * a per-patient allergy call and a per-encounter schedule call. These tests pin the two numbers
   * a nurse triages from and the isolation properties around them.
   */
  function worklist(query = "", token = nurseToken) {
    return auth(request(app).get(`/api/v1/ward-worklist${query}`), token);
  }

  it("reports doses due and the allergy flag without a per-patient request", async () => {
    const enc = await admitToWard("Worklist Subject");
    const rx = await signedRx(enc, [PARACETAMOL_TDS]);
    const chart = await auth(request(app).get(`/api/v1/encounters/${enc}`), nurseToken).expect(200);
    const patientId = chart.body.data.patientId as string;

    await auth(request(app).post(`/api/v1/patients/${patientId}/allergies`), nurseToken)
      .send({ allergen: "penicillins", severity: "severe" })
      .expect(201);

    const res = await worklist().expect(200);
    const mine = (res.body.data as { encounterId: string }[]).find((r) => r.encounterId === enc);

    expect(mine).toMatchObject({
      patientId,
      allergens: ["penicillins"],
      severeAllergy: true,
    });
    // The schedule endpoint is the oracle; the worklist must agree with it exactly.
    const slots = (await schedule(enc).expect(200)).body.data as { state: string }[];
    const outstanding = slots.filter((s) => s.state === "due" || s.state === "overdue").length;
    expect((mine as { dosesDue: number }).dosesDue).toBe(outstanding);
    expect(rx).toBeTruthy();
  });

  it("stops counting a dose once it has been charted", async () => {
    const enc = await admitToWard("Worklist Charted");
    const rx = await signedRx(enc, [PARACETAMOL_TDS]);
    const before = (await worklist().expect(200)).body.data as {
      encounterId: string;
      dosesDue: number;
    }[];
    const start = before.find((r) => r.encounterId === enc)?.dosesDue ?? 0;
    expect(start).toBeGreaterThan(0);

    const slotAt = ((await schedule(enc).expect(200)).body.data as { scheduledFor: string }[])[0]
      ?.scheduledFor as string;
    await chart(enc, {
      prescriptionId: rx,
      drugCode: PARACETAMOL_TDS.drugCode,
      scheduledFor: slotAt,
    }).expect(201);

    const after = (await worklist().expect(200)).body.data as {
      encounterId: string;
      dosesDue: number;
    }[];
    expect(after.find((r) => r.encounterId === enc)?.dosesDue).toBe(start - 1);
  });

  it("never counts a PRN drug as due — it has no scheduled time", async () => {
    const enc = await admitToWard("Worklist PRN");
    await signedRx(enc, [PARACETAMOL_PRN]);
    const res = await worklist().expect(200);
    const mine = (res.body.data as { encounterId: string; dosesDue: number }[]).find(
      (r) => r.encounterId === enc,
    );
    expect(mine?.dosesDue).toBe(0);
  });

  it("narrows to one ward, and pages with a real total", async () => {
    await admitToWard("Worklist Ward A");
    const all = await worklist().expect(200);
    expect(all.body.meta.total).toBeGreaterThan(0);

    const none = await worklist("?ward=NoSuchWard").expect(200);
    expect(none.body.data).toEqual([]);
    expect(none.body.meta.total).toBe(0);

    // A page smaller than the population must say there is more rather than truncate silently.
    const firstPage = await worklist("?limit=1&page=1").expect(200);
    expect(firstPage.body.data).toHaveLength(1);
    expect(firstPage.body.meta.total).toBeGreaterThanOrEqual(1);
  });

  it("pages without losing or repeating a patient", async () => {
    for (const name of ["Page One", "Page Two", "Page Three"]) await admitToWard(name);

    const total = (await worklist("?limit=1").expect(200)).body.meta.total as number;
    const seen: string[] = [];
    for (let page = 1; page <= total; page += 1) {
      const res = await worklist(`?limit=1&page=${String(page)}`).expect(200);
      for (const r of res.body.data as { encounterId: string }[]) seen.push(r.encounterId);
    }
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
  });

  it("shows nothing of another site's ward", async () => {
    await admitToWard("Worklist Isolation");
    expect((await worklist().expect(200)).body.data.length).toBeGreaterThan(0);
    expect((await worklist("", otherSiteNurseToken).expect(200)).body.data).toEqual([]);
  });

  it("refuses a role with no clinical read", async () => {
    await worklist("", receptionToken).expect(403);
  });
});

/* ── M3-S5A: the three outcomes, and one answer per slot ───────────────────── */

/**
 * S1 proved a slot holds at most one administration. S5A is the UI that answers one, so what needs
 * proving here is the part the screen depends on: that HOLD and REFUSED are first-class answers,
 * that they close the slot exactly as GIVEN does, and that the 409 carries enough for a nurse to
 * be told who got there first.
 *
 * The unique index deliberately does NOT include `status` — which is what makes "held, then given"
 * impossible. That is the single most important assertion in this block: without it a nurse could
 * hold a dose for low blood pressure and a colleague could give it ten minutes later, with both
 * events on the chart and neither contradicting the other.
 */
describe("held and refused are answers, not gaps", () => {
  /** Charts an outcome against the first scheduled slot of a fresh TDS order. */
  async function freshSlot(name: string): Promise<{ enc: string; rx: string; slot: string }> {
    const enc = await admitPatient(name);
    const rx = await signedRx(enc, [PARACETAMOL_TDS]);
    const slot = ((await schedule(enc).expect(200)).body.data as { scheduledFor: string }[])[0]
      ?.scheduledFor as string;
    return { enc, rx, slot };
  }

  const stateOf = async (enc: string, slot: string) => {
    const res = await schedule(enc).expect(200);
    return (res.body.data as { scheduledFor: string; state: string; reason?: string }[]).find(
      (s) => s.scheduledFor === slot,
    );
  };

  it("records a HELD dose with its reason, and the slot reads held", async () => {
    const { enc, rx, slot } = await freshSlot("Held Dose");

    const res = await chart(enc, {
      prescriptionId: rx,
      drugCode: PARACETAMOL_TDS.drugCode,
      lineIndex: 0,
      scheduledFor: slot,
      status: "held",
      reason: "systolic 84",
    }).expect(201);

    expect(res.body.data).toMatchObject({ status: "held", reason: "systolic 84" });
    expect(await stateOf(enc, slot)).toMatchObject({ state: "held", reason: "systolic 84" });
  });

  /** A held dose with no reason is the blank the MAR exists to prevent. The server says so. */
  it("refuses a held dose with no reason", async () => {
    const { enc, rx, slot } = await freshSlot("Held No Reason");
    const res = await chart(enc, {
      prescriptionId: rx,
      drugCode: PARACETAMOL_TDS.drugCode,
      scheduledFor: slot,
      status: "held",
    }).expect(400);
    expect(Object.keys(res.body.error.details)).toContain("reason");
    expect(await stateOf(enc, slot)).toMatchObject({ state: "due" });
  });

  it("records a REFUSED dose, and does not demand a reason for it", async () => {
    const { enc, rx, slot } = await freshSlot("Refused Dose");
    const res = await chart(enc, {
      prescriptionId: rx,
      drugCode: PARACETAMOL_TDS.drugCode,
      scheduledFor: slot,
      status: "refused",
    }).expect(201);

    expect(res.body.data.status).toBe("refused");
    expect(await stateOf(enc, slot)).toMatchObject({ state: "refused" });
  });

  it("writes exactly one row for each of the four outcomes", async () => {
    for (const [name, body] of [
      ["One Row Given", { status: "given" }],
      ["One Row Held", { status: "held", reason: "nil by mouth" }],
      ["One Row Refused", { status: "refused" }],
      ["One Row Unavailable", { status: "not_available" }],
    ] as [string, Record<string, string>][]) {
      const { enc, rx, slot } = await freshSlot(name);
      await chart(enc, {
        prescriptionId: rx,
        drugCode: PARACETAMOL_TDS.drugCode,
        scheduledFor: slot,
        ...body,
      }).expect(201);

      const rows = await auth(
        request(app).get(`/api/v1/encounters/${enc}/medication-administrations`),
        nurseToken,
      ).expect(200);
      expect(rows.body.data).toHaveLength(1);
    }
  });

  /* ── `not_available`: a SUPPLY event, not a clinical decision (F-3) ───────── */

  /**
   * ── THE STATUS THE BACKEND ACCEPTED AND NOTHING EVER SENT ───────────────────
   * `not_available` ("the drug was not on the ward to give", `mar.model.ts`) has been in
   * `MAR_STATUSES` since D5, validated by the DTO and persisted by the model — and until now it had
   * NO test and no client that offered it. Both surfaces recorded the omission in their own
   * comments along with its cost: a nurse who cannot chart a stock-out charts HELD with a reason,
   * which files a supply failure in the clinical-decision column, where the next nurse reads it as
   * "somebody decided to withhold this" — a different fact about the patient.
   *
   * These pin the server half, so the clients have something true to rely on.
   */
  it("records a stock-out as not_available, and the slot reads it back", async () => {
    const { enc, rx, slot } = await freshSlot("Not On The Ward");

    const res = await chart(enc, {
      prescriptionId: rx,
      drugCode: PARACETAMOL_TDS.drugCode,
      lineIndex: 0,
      scheduledFor: slot,
      status: "not_available",
    }).expect(201);

    // The stored status is the one that was sent — not coerced to `held`, not defaulted to `given`.
    expect(res.body.data).toMatchObject({
      status: "not_available",
      drugName: PARACETAMOL_TDS.drugName,
      administeredBy: nurseId,
    });
    expect(res.body.data.status).not.toBe("held");
    expect(res.body.data.status).not.toBe("given");

    // And it survives the round trip — the schedule is the oracle every client re-reads.
    expect(await stateOf(enc, slot)).toMatchObject({ state: "not_available" });

    // Persisted on the record itself, not only derived onto the slot.
    const rows = await auth(
      request(app).get(`/api/v1/encounters/${enc}/medication-administrations`),
      nurseToken,
    ).expect(200);
    expect(rows.body.data).toHaveLength(1);
    expect(rows.body.data[0].status).toBe("not_available");
  });

  /**
   * The reason rule is `held`'s alone (`mar.service.ts`). Pinned from BOTH sides so neither client
   * invents a requirement the server does not have — which would block a nurse charting a true
   * fact — nor drops the one it does.
   */
  it("does not demand a reason for a stock-out, and keeps one when given", async () => {
    const bare = await freshSlot("Unavailable No Reason");
    await chart(bare.enc, {
      prescriptionId: bare.rx,
      drugCode: PARACETAMOL_TDS.drugCode,
      scheduledFor: bare.slot,
      status: "not_available",
    }).expect(201);
    expect(await stateOf(bare.enc, bare.slot)).toMatchObject({ state: "not_available" });

    const noted = await freshSlot("Unavailable With Reason");
    const res = await chart(noted.enc, {
      prescriptionId: noted.rx,
      drugCode: PARACETAMOL_TDS.drugCode,
      scheduledFor: noted.slot,
      status: "not_available",
      reason: "none in ward stock, pharmacy notified",
    }).expect(201);
    expect(res.body.data.reason).toBe("none in ward stock, pharmacy notified");
    expect(await stateOf(noted.enc, noted.slot)).toMatchObject({
      state: "not_available",
      reason: "none in ward stock, pharmacy notified",
    });
  });

  /**
   * The slot rule does not care WHICH answer arrived first — `status` is deliberately not in the
   * unique index, so "unavailable then given" is as impossible as "held then given". If a nurse
   * finds the drug after all, that is a new clinical event and not an edit of this one.
   */
  it("refuses a GIVE after the slot was charted not_available, and names the record", async () => {
    const { enc, rx, slot } = await freshSlot("Unavailable Then Given");
    await chart(
      enc,
      {
        prescriptionId: rx,
        drugCode: PARACETAMOL_TDS.drugCode,
        scheduledFor: slot,
        status: "not_available",
      },
      nurseToken,
      "s3-unavailable-first",
    ).expect(201);

    const clash = await chart(
      enc,
      {
        prescriptionId: rx,
        drugCode: PARACETAMOL_TDS.drugCode,
        scheduledFor: slot,
        status: "given",
      },
      nurse2Token,
      "s3-unavailable-then-give",
    ).expect(409);

    expect(clash.body.error.code).toBe("HMS-MAR-001");
    expect(clash.body.error.details.existing).toMatchObject({
      status: "not_available",
      administeredBy: nurseId,
    });
    expect(await stateOf(enc, slot)).toMatchObject({ state: "not_available" });
  });

  /** The same key replays the same row. The mechanism is status-blind, and this says so. */
  it("replays a retried stock-out rather than writing a second row", async () => {
    const { enc, rx, slot } = await freshSlot("Unavailable Retry");
    const body = {
      prescriptionId: rx,
      drugCode: PARACETAMOL_TDS.drugCode,
      scheduledFor: slot,
      status: "not_available",
    };

    const first = await chart(enc, body, nurseToken, "s3-unavailable-key").expect(201);
    const again = await chart(enc, body, nurseToken, "s3-unavailable-key").expect(201);

    expect(again.body.data.id).toBe(first.body.data.id);
    const rows = await auth(
      request(app).get(`/api/v1/encounters/${enc}/medication-administrations`),
      nurseToken,
    ).expect(200);
    expect(rows.body.data).toHaveLength(1);
  });

  /**
   * A stock-out ANSWERS the slot — it is a recorded fact, not an absence. A round that kept
   * counting it would send somebody back to a dose already dealt with.
   *
   * Asserted against the SCHEDULE rather than `/ward-worklist`: the worklist pages over every
   * admitted patient in the tenant, so a row lookup there silently returns 0 for a patient who
   * fell onto page two and the test passes for the wrong reason (mine did, before this note). The
   * two cannot disagree — one derivation, `slotsForStay` — and the worklist section above already
   * pins that `dosesDue` equals the schedule's outstanding count exactly.
   */
  it("counts a stock-out as answered, not as a dose still outstanding", async () => {
    const outstandingFor = async (encounterId: string): Promise<number> => {
      const res = await schedule(encounterId).expect(200);
      return (res.body.data as { state: string }[]).filter(
        (s) => s.state === "due" || s.state === "overdue",
      ).length;
    };

    const { enc, rx, slot } = await freshSlot("Unavailable Not Outstanding");
    const before = await outstandingFor(enc);
    expect(before).toBeGreaterThan(0);

    await chart(enc, {
      prescriptionId: rx,
      drugCode: PARACETAMOL_TDS.drugCode,
      scheduledFor: slot,
      status: "not_available",
    }).expect(201);

    expect(await outstandingFor(enc)).toBe(before - 1);
    expect(await stateOf(enc, slot)).toMatchObject({ state: "not_available" });
  });

  /**
   * The new outcome is not a new door. Same permission, same walls — asserted against the status
   * itself rather than inferred from the `given` tests elsewhere in this file. All four refusals
   * share one slot, because a refused write leaves it untouched.
   */
  it("is refused without mar:administer, across a branch, and across a hospital", async () => {
    const { enc, rx, slot } = await freshSlot("Unavailable Refusals");
    const body = {
      prescriptionId: rx,
      drugCode: PARACETAMOL_TDS.drugCode,
      scheduledFor: slot,
      status: "not_available",
    };

    // Reading the round is `emr:read`; charting a dose is not.
    for (const token of [receptionToken, doctorToken]) {
      await chart(enc, body, token).expect(403);
    }

    // The other site: the prescription is simply not reachable from where that nurse works.
    await chart(enc, body, otherSiteNurseToken, "s3-unavailable-cross-branch").expect(404);

    // The other hospital, through its own host and its own nurse — who really does hold
    // `mar:administer` there, so the refusal is about REACH and not about permission. Tenancy is
    // physical (one database per hospital), so this encounter id resolves to nothing at all.
    const rivalNurse = await loginAt(rivalHost, `nurse@${RIVAL_SLUG}.test`);
    const cross = await request(app)
      .post(`/api/v1/encounters/${enc}/medication-administrations`)
      .set("Host", rivalHost)
      .set("Authorization", `Bearer ${rivalNurse}`)
      .send(body);
    expect([403, 404]).toContain(cross.status);

    // Nothing landed, from any of the four directions.
    expect(await stateOf(enc, slot)).toMatchObject({ state: "due" });
  });

  /**
   * ── THE ONE-SLOT-ONE-ANSWER RULE, IN THE DIRECTION THAT MATTERS ───────────
   * A nurse holds a dose because the blood pressure is 84. Ten minutes later a colleague opens the
   * same slot and presses Give. If the index keyed on status this would succeed and the chart
   * would hold both events, each looking authoritative. It does not, and this is what says so.
   */
  it("refuses a GIVE after the slot was HELD, and names the held record", async () => {
    const { enc, rx, slot } = await freshSlot("Held Then Given");
    await chart(
      enc,
      {
        prescriptionId: rx,
        drugCode: PARACETAMOL_TDS.drugCode,
        scheduledFor: slot,
        status: "held",
        reason: "systolic 84",
      },
      nurseToken,
      "s5a-held-then-given",
    ).expect(201);

    const clash = await chart(
      enc,
      {
        prescriptionId: rx,
        drugCode: PARACETAMOL_TDS.drugCode,
        scheduledFor: slot,
        status: "given",
      },
      nurse2Token,
      "s5a-second-nurse-give",
    ).expect(409);

    expect(clash.body.error.code).toBe("HMS-MAR-001");
    expect(clash.body.error.details.existing).toMatchObject({
      status: "held",
      reason: "systolic 84",
      administeredBy: nurseId,
    });
    expect(await stateOf(enc, slot)).toMatchObject({ state: "held" });
  });

  it("refuses a GIVE after the slot was REFUSED", async () => {
    const { enc, rx, slot } = await freshSlot("Refused Then Given");
    await chart(
      enc,
      {
        prescriptionId: rx,
        drugCode: PARACETAMOL_TDS.drugCode,
        scheduledFor: slot,
        status: "refused",
      },
      nurseToken,
      "s5a-refused-first",
    ).expect(201);

    const clash = await chart(
      enc,
      {
        prescriptionId: rx,
        drugCode: PARACETAMOL_TDS.drugCode,
        scheduledFor: slot,
        status: "given",
      },
      nurse2Token,
      "s5a-refused-then-give",
    ).expect(409);

    expect(clash.body.error.code).toBe("HMS-MAR-001");
    expect(clash.body.error.details.existing).toMatchObject({ status: "refused" });
    expect(await stateOf(enc, slot)).toMatchObject({ state: "refused" });
  });

  it("refuses a second HOLD on a slot already given", async () => {
    const { enc, rx, slot } = await freshSlot("Given Then Held");
    await chart(
      enc,
      {
        prescriptionId: rx,
        drugCode: PARACETAMOL_TDS.drugCode,
        scheduledFor: slot,
        status: "given",
      },
      nurseToken,
      "s5a-given-first",
    ).expect(201);

    await chart(
      enc,
      {
        prescriptionId: rx,
        drugCode: PARACETAMOL_TDS.drugCode,
        scheduledFor: slot,
        status: "held",
        reason: "changed my mind",
      },
      nurse2Token,
      "s5a-given-then-hold",
    ).expect(409);
  });
});

/* ── M3-S5A: the reconciliation contract the phone depends on ──────────────── */

describe("the 409 carries what a client needs to reconcile", () => {
  /**
   * The mobile confirmation screen renders `details.existing` directly — "already given at 14:03".
   * These fields are therefore a CONTRACT, not incidental debugging detail: without `status`,
   * `administeredBy` and `administeredAt` the screen can only say "something went wrong", which is
   * the wording `ERROR_CODES.md` exists to forbid.
   */
  it("names the slot, the drug, the outcome, the actor and the time", async () => {
    const enc = await admitPatient("Oracle Payload");
    const rx = await signedRx(enc, [PARACETAMOL_TDS]);
    const slot = ((await schedule(enc).expect(200)).body.data as { scheduledFor: string }[])[0]
      ?.scheduledFor as string;

    await chart(
      enc,
      { prescriptionId: rx, drugCode: PARACETAMOL_TDS.drugCode, scheduledFor: slot },
      nurseToken,
      "s5a-oracle-first",
    ).expect(201);

    const clash = await chart(
      enc,
      { prescriptionId: rx, drugCode: PARACETAMOL_TDS.drugCode, scheduledFor: slot },
      nurse2Token,
      "s5a-oracle-second",
    ).expect(409);

    expect(clash.body.error.details).toMatchObject({
      scheduledFor: slot,
      drugName: PARACETAMOL_TDS.drugName,
    });
    expect(clash.body.error.details.existing).toMatchObject({
      status: "given",
      administeredBy: nurseId,
      prescriptionId: rx,
      lineIndex: 0,
      scheduledFor: slot,
    });
    expect(clash.body.error.details.existing.administeredAt).toBeTruthy();
  });

  /**
   * The schedule is the other half of the oracle: after a LOST response the phone re-reads it and
   * asks "is this slot answered?". That question must be answerable without the 409 — a timeout
   * never produces one.
   */
  it("answers the same question through the schedule, for a client that saw no response at all", async () => {
    const enc = await admitPatient("Lost Response Oracle");
    const rx = await signedRx(enc, [PARACETAMOL_TDS]);
    const slot = ((await schedule(enc).expect(200)).body.data as { scheduledFor: string }[])[0]
      ?.scheduledFor as string;

    await chart(
      enc,
      {
        prescriptionId: rx,
        drugCode: PARACETAMOL_TDS.drugCode,
        scheduledFor: slot,
        status: "held",
        reason: "asleep",
      },
      nurseToken,
      "s5a-lost-response",
    ).expect(201);

    const after = (await schedule(enc).expect(200)).body.data as {
      prescriptionId: string;
      lineIndex: number;
      scheduledFor: string;
      state: string;
      administrationId?: string;
      administeredBy?: string;
    }[];
    // Found by the S1 triple — prescription, line and instant — never by drug name.
    const answered = after.find(
      (s) => s.prescriptionId === rx && s.lineIndex === 0 && s.scheduledFor === slot,
    );
    expect(answered).toMatchObject({ state: "held", administeredBy: nurseId });
    expect(answered?.administrationId).toBeTruthy();
  });

  /** A key names ONE clinical decision. Reusing it for a different one is refused, not merged. */
  it("refuses the same key used for a different outcome", async () => {
    const enc = await admitPatient("Key Reuse");
    const rx = await signedRx(enc, [PARACETAMOL_TDS]);
    const slots = (await schedule(enc).expect(200)).body.data as { scheduledFor: string }[];
    const first = slots[0]?.scheduledFor as string;
    const second = slots[1]?.scheduledFor as string;

    await chart(
      enc,
      { prescriptionId: rx, drugCode: PARACETAMOL_TDS.drugCode, scheduledFor: first },
      nurseToken,
      "s5a-one-decision",
    ).expect(201);

    // A DIFFERENT slot under the SAME key: the request bodies differ, so this is a client bug and
    // the server refuses it rather than replaying the first — which would silently chart nothing
    // while the nurse believed the second dose was recorded.
    const clash = await chart(
      enc,
      { prescriptionId: rx, drugCode: PARACETAMOL_TDS.drugCode, scheduledFor: second },
      nurseToken,
      "s5a-one-decision",
    ).expect(409);
    expect(clash.body.error.code).toBe("HMS-REQ-002");
    // Not a replay. Before the fingerprint fix this returned the FIRST dose's 201 with
    // `Idempotency-Replayed: true`, and the 18:00 dose was silently never charted.
    expect(clash.headers["idempotency-replayed"]).toBeUndefined();

    const after = (await schedule(enc).expect(200)).body.data as {
      scheduledFor: string;
      state: string;
    }[];
    expect(after.find((s) => s.scheduledFor === second)?.state).not.toBe("given");
  });

  /** Replaying the SAME decision is safe and writes nothing — the other half of the same rule. */
  it("replays the identical request without a second row", async () => {
    const enc = await admitPatient("Replay Same");
    const rx = await signedRx(enc, [PARACETAMOL_TDS]);
    const slot = ((await schedule(enc).expect(200)).body.data as { scheduledFor: string }[])[0]
      ?.scheduledFor as string;
    const body = {
      prescriptionId: rx,
      drugCode: PARACETAMOL_TDS.drugCode,
      scheduledFor: slot,
      status: "refused",
    };

    const first = await chart(enc, body, nurseToken, "s5a-replay-refused").expect(201);
    const again = await chart(enc, body, nurseToken, "s5a-replay-refused").expect(201);
    expect(again.body.data.id).toBe(first.body.data.id);

    const rows = await auth(
      request(app).get(`/api/v1/encounters/${enc}/medication-administrations`),
      nurseToken,
    ).expect(200);
    expect(rows.body.data).toHaveLength(1);
  });
});

/* ── 11. the medication round (M3-S5B) ────────────────────────────────────── */

describe("the medication round", () => {
  /**
   * ── WHAT THIS ENDPOINT HAS TO PROVE THAT ITS TWO NEIGHBOURS DO NOT ────────
   * `/ward-worklist` says a patient has three doses due. `/encounters/:id/medication-schedule`
   * says which three. This says which three, for every patient on the ward, in one request — and
   * the load-bearing claim is that it says EXACTLY what the schedule endpoint says. They are one
   * derivation (`slotsForStay`), and the test below compares them field for field rather than
   * trusting that.
   *
   * A round that disagreed with the schedule would be the worst possible defect in this slice: the
   * nurse decides from the round and the confirmation screen re-reads the schedule, so the two
   * disagreeing means a dose charted against a slot the nurse never meant.
   */
  function round(query = "", token = nurseToken) {
    return auth(request(app).get(`/api/v1/medication-round${query}`), token);
  }

  interface RoundRow {
    encounterId: string;
    patientId: string;
    patientName: string;
    uhid: string;
    ward?: string;
    bedCode?: string;
    allergens: string[];
    severeAllergy: boolean;
    slots: {
      prescriptionId: string;
      lineIndex: number;
      drugCode: string;
      scheduledFor: string;
      state: string;
    }[];
    dosesDue: number;
    dosesOverdue: number;
  }

  /**
   * One encounter's row, found by PAGING rather than by reading page one.
   *
   * ── A TEST HELPER THAT WENT STALE WITH THE WARD (found in M3-S6) ──────────
   * This first read a single default page (limit 20) and searched it. Every test in this suite
   * admits another patient to the same ward, so once the suite had grown past twenty the row it
   * was looking for was on page one only by luck — `listInpatients` orders by ward then bedCode,
   * and `admitToWard` gives each patient a RANDOM bed code. The result was a suite that passed
   * standalone, passed most full runs, and failed one test at random in the others: exactly the
   * shape that gets blamed on infrastructure and then ignored.
   *
   * Paging is the honest fix — the same thing a client does — and it cannot rot as the ward grows.
   */
  const rowsOf = async (query = "", token = nurseToken): Promise<RoundRow[]> => {
    const all: RoundRow[] = [];
    for (let page = 1; ; page += 1) {
      const sep = query.startsWith("?") ? "&" : "?";
      const res = await round(`${query}${sep}page=${String(page)}&limit=50`, token).expect(200);
      const rows = res.body.data as RoundRow[];
      all.push(...rows);
      const meta = res.body.meta as { total: number };
      if (all.length >= meta.total || rows.length === 0) return all;
    }
  };

  const rowFor = async (enc: string, query = "", token = nurseToken): Promise<RoundRow> =>
    (await rowsOf(query, token)).find((r) => r.encounterId === enc) as RoundRow;

  it("returns the ward's doses with the patient named on every row", async () => {
    const enc = await admitToWard("Round Subject");
    await signedRx(enc, [PARACETAMOL_TDS]);

    const mine = await rowFor(enc);
    expect(mine.patientName).toBe("Round Subject");
    // Identity is on the ROW, not left to a bed-board join: a medication row identified only by
    // its bed is the ambiguity the five rights exist to close.
    expect(mine.uhid).toMatch(/\S/);
    expect(mine.ward).toBe("General");
    expect(mine.slots.length).toBeGreaterThan(0);
  });

  /**
   * ── ONE SCHEDULING ENGINE ─────────────────────────────────────────────────
   * The round's slots must be indistinguishable from the per-encounter schedule's. Not "the same
   * count", not "the same times" — the same objects.
   */
  it("agrees with the per-encounter schedule exactly, field for field", async () => {
    const enc = await admitToWard("Round Agreement");
    await signedRx(enc, [PARACETAMOL_TDS, ADRENALINE_STAT]);

    const fromRound = (await rowFor(enc)).slots;
    const fromSchedule = (await schedule(enc).expect(200)).body.data as unknown[];
    expect(fromRound).toEqual(fromSchedule);
  });

  it("counts due and overdue as the server sees them, and overdue is a subset", async () => {
    const enc = await admitToWard("Round Counts");
    await signedRx(enc, [PARACETAMOL_TDS]);

    const mine = await rowFor(enc);
    const outstanding = mine.slots.filter((s) => s.state === "due" || s.state === "overdue");
    expect(mine.dosesDue).toBe(outstanding.length);
    expect(mine.dosesOverdue).toBe(mine.slots.filter((s) => s.state === "overdue").length);
    expect(mine.dosesOverdue).toBeLessThanOrEqual(mine.dosesDue);
  });

  /**
   * The identity that makes the round navigable. `drugCode` alone is NOT it: the same drug can be
   * on a scheduled line and a PRN line, and the pair below is exactly that.
   */
  it("keeps two lines of the same drug distinct, and gives PRN no slot at all", async () => {
    const enc = await admitToWard("Round Duplicate Drug");
    const rx = await signedRx(enc, [PARACETAMOL_TDS, PARACETAMOL_PRN]);

    const mine = await rowFor(enc);
    expect(mine.slots.every((s) => s.prescriptionId === rx)).toBe(true);
    // Every slot belongs to line 0 — the scheduled one. The PRN line contributes none, because
    // as-needed medication has no rounds and binding it to one would refuse the second dose.
    expect([...new Set(mine.slots.map((s) => s.lineIndex))]).toEqual([0]);
    expect(mine.slots.every((s) => s.drugCode === PARACETAMOL_TDS.drugCode)).toBe(true);
  });

  it("carries a distinct scheduled instant on every slot of a line", async () => {
    const enc = await admitToWard("Round Slot Times");
    await signedRx(enc, [PARACETAMOL_TDS]);

    const times = (await rowFor(enc)).slots.map((s) => s.scheduledFor);
    expect(new Set(times).size).toBe(times.length);
  });

  /**
   * ── THE ROUND REFLECTS THE RECORD, IT DOES NOT REMEMBER ───────────────────
   * Charting a dose changes what the next read says. This is the server half of "the round must
   * not patch its own copy": there is nothing for the client to patch, because the truth is one
   * request away and it moves.
   */
  it("shows a charted dose as given on the very next read", async () => {
    const enc = await admitToWard("Round Charted");
    const rx = await signedRx(enc, [PARACETAMOL_TDS]);

    const before = await rowFor(enc);
    const target = before.slots.find((s) => s.state === "due" || s.state === "overdue");
    expect(target).toBeTruthy();

    await chart(enc, {
      prescriptionId: rx,
      drugCode: PARACETAMOL_TDS.drugCode,
      scheduledFor: (target as { scheduledFor: string }).scheduledFor,
    }).expect(201);

    const after = await rowFor(enc);
    const same = after.slots.find(
      (s) => s.scheduledFor === (target as { scheduledFor: string }).scheduledFor,
    );
    expect(same?.state).toBe("given");
    expect(after.dosesDue).toBe(before.dosesDue - 1);
  });

  /**
   * ── CONCURRENCY: THE ROUND IS NOT AN AUTHORITY ────────────────────────────
   * Nurse A loads the round. Nurse B answers a dose. Nurse A's copy still says "due" — it is a
   * snapshot, and snapshots go stale. What must NOT happen is nurse A charting a second dose off
   * it: the database refuses, with the 409 that names who got there first.
   */
  it("lets a stale round reach the write, and the database refuses it", async () => {
    const enc = await admitToWard("Round Concurrency");
    const rx = await signedRx(enc, [PARACETAMOL_TDS]);

    // Nurse A's copy of the round.
    const staleSlot = (await rowFor(enc)).slots.find(
      (s) => s.state === "due" || s.state === "overdue",
    ) as { scheduledFor: string };

    // Nurse B answers it in the meantime.
    await chart(
      enc,
      {
        prescriptionId: rx,
        drugCode: PARACETAMOL_TDS.drugCode,
        scheduledFor: staleSlot.scheduledFor,
      },
      nurse2Token,
    ).expect(201);

    // Nurse A acts on the stale row. Not a generic error — the answer, with the existing row.
    const conflict = await chart(enc, {
      prescriptionId: rx,
      drugCode: PARACETAMOL_TDS.drugCode,
      scheduledFor: staleSlot.scheduledFor,
    }).expect(409);
    expect(conflict.body.error.code).toBe("HMS-MAR-001");
    expect(conflict.body.error.details.existing).toBeTruthy();

    // …and a fresh read of the round already says so.
    const fresh = await rowFor(enc);
    expect(fresh.slots.find((s) => s.scheduledFor === staleSlot.scheduledFor)?.state).toBe("given");
  });

  it("shows a patient with no prescription as a row with no doses, not as an absence", async () => {
    const enc = await admitToWard("Round No Drugs");
    const mine = await rowFor(enc);
    expect(mine).toBeTruthy();
    expect(mine.slots).toEqual([]);
    expect(mine.dosesDue).toBe(0);
  });

  it("carries the allergy context a nurse identifies the patient by", async () => {
    const enc = await admitToWard("Round Allergy");
    const chartRes = await auth(request(app).get(`/api/v1/encounters/${enc}`), nurseToken).expect(
      200,
    );
    const patientId = chartRes.body.data.patientId as string;
    await auth(request(app).post(`/api/v1/patients/${patientId}/allergies`), nurseToken)
      .send({ allergen: "penicillins", severity: "severe" })
      .expect(201);

    const mine = await rowFor(enc);
    expect(mine.allergens).toEqual(["penicillins"]);
    expect(mine.severeAllergy).toBe(true);
  });

  /**
   * ── THE ROUND APPLIES NO FILTER OF ITS OWN TO THE ALLERGY LIST ────────────
   * The round's allergens must be exactly what the hospital-wide allergy endpoint returns — same
   * set, same order, nothing dropped and nothing re-derived.
   *
   * ── AND A LIMITATION, STATED RATHER THAN PAPERED OVER (M3-S5B) ────────────
   * This does NOT prove the branch part. I tried to write the scenario that would — an allergy
   * recorded at the city site, read on a round at the suburban one — and the domain cannot
   * currently produce it: `recordAllergy` stamps the allergy with the PATIENT's branch, and a
   * patient is only reachable from the branch they were registered at, so every allergy row a test
   * can create carries the same branch as the ward reading it. A branch filter here would
   * therefore pass this test. The hospital-wide rule is defended structurally instead —
   * `allergy.repository.ts` omits `scopeFilter`, the mobile key carries no branch segment, and
   * both are pinned — and it stays unproven behaviourally until patients can move between sites.
   */
  it("passes the allergy list through exactly as the hospital-wide read returns it", async () => {
    const enc = await admitToWard("Round Allergy Passthrough");
    const chartRes = await auth(request(app).get(`/api/v1/encounters/${enc}`), nurseToken).expect(
      200,
    );
    const patientId = chartRes.body.data.patientId as string;
    for (const allergen of ["sulfonamides", "nsaids"]) {
      await auth(request(app).post(`/api/v1/patients/${patientId}/allergies`), nurseToken)
        .send({ allergen, severity: "mild" })
        .expect(201);
    }

    const direct = (
      await auth(request(app).get(`/api/v1/patients/${patientId}/allergies`), nurseToken).expect(
        200,
      )
    ).body.data as { allergen: string; status: string }[];

    expect((await rowFor(enc)).allergens).toEqual(
      direct.filter((a) => a.status === "active").map((a) => a.allergen),
    );
  });

  /* ── the ward, the day, and the page ─────────────────────────────────────── */

  it("narrows to one ward by name, and says nothing is there when nothing is", async () => {
    await admitToWard("Round Ward Filter");
    expect((await round("?ward=General").expect(200)).body.data.length).toBeGreaterThan(0);

    const none = await round("?ward=NoSuchWard").expect(200);
    expect(none.body.data).toEqual([]);
    expect(none.body.meta.total).toBe(0);
  });

  it("pages without losing or repeating a patient, and never truncates silently", async () => {
    for (const name of ["Round Page A", "Round Page B"]) await admitToWard(name);

    const total = (await round("?limit=1").expect(200)).body.meta.total as number;
    expect(total).toBeGreaterThan(1);

    const seen: string[] = [];
    for (let page = 1; page <= total; page += 1) {
      const res = await round(`?limit=1&page=${String(page)}`).expect(200);
      // The page is short, and `meta.total` is what says so — a client that only counted rows
      // would believe a one-row page was the whole ward.
      expect(res.body.meta.total).toBe(total);
      for (const r of res.body.data as RoundRow[]) seen.push(r.encounterId);
    }
    expect(new Set(seen).size).toBe(total);
  });

  /**
   * ── THE CLINICAL DAY IS THE WARD'S ────────────────────────────────────────
   * The process runs in Asia/Kolkata and the ward is America/New_York, 9.5 hours away. Asking for
   * a specific ward day must produce that day's rounds in NEW YORK — 08:00, 14:00 and 20:00 there,
   * whatever o'clock it is on the server.
   */
  it("resolves the requested day in the ward's timezone, not the server's", async () => {
    const enc = await admitToWard("Round Ward Day");
    await signedRx(enc, [PARACETAMOL_TDS]);

    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: WARD_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());

    const mine = await rowFor(enc, `?date=${today}`);
    const hours = mine.slots.map((s) =>
      Number(
        new Intl.DateTimeFormat("en-GB", {
          timeZone: WARD_ZONE,
          hour: "2-digit",
          hour12: false,
        }).format(new Date(s.scheduledFor)),
      ),
    );
    expect(hours.length).toBeGreaterThan(0);
    for (const hour of hours) expect([8, 14, 20]).toContain(hour);
  });

  it("defaults to the ward's today when the caller names no day", async () => {
    const enc = await admitToWard("Round Default Day");
    await signedRx(enc, [PARACETAMOL_TDS]);

    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: WARD_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());

    expect((await rowFor(enc)).slots).toEqual((await rowFor(enc, `?date=${today}`)).slots);
  });

  it("refuses a date that is not a day", async () => {
    const res = await round("?date=2026-06-11T08:00:00Z");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("HMS-VAL-001");
  });

  /* ── who may see it, and where ───────────────────────────────────────────── */

  it("shows nothing of another site's ward", async () => {
    const enc = await admitToWard("Round Other Branch");
    await signedRx(enc, [PARACETAMOL_TDS]);

    expect((await rowFor(enc))?.encounterId).toBe(enc);
    // Paged, like `rowFor`: "absent from page one" is not the same claim as "absent".
    const theirs = await rowsOf("", otherSiteNurseToken);
    expect(theirs.find((r) => r.encounterId === enc)).toBeUndefined();
  });

  it("refuses a role without emr:read", async () => {
    const res = await round("", receptionToken);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("HMS-AUTH-005");
  });

  /**
   * ── THE DOCTOR MAY READ THE ROUND AND STILL MAY NOT CHART FROM IT ─────────
   * The read is `emr:read`, the same gate as `/ward-worklist` and the schedule endpoint it
   * composes: it grants no reach a doctor does not already have one request at a time. The WRITE
   * is `mar:administer`, which the doctor does not hold — the boundary S5A established, restated
   * here because S5B is the screen that puts the two next to each other.
   */
  it("lets a doctor read the round, and still refuses them the dose", async () => {
    const enc = await admitToWard("Round Doctor");
    const rx = await signedRx(enc, [PARACETAMOL_TDS]);

    await round("", doctorToken).expect(200);

    const attempt = await chart(
      enc,
      { prescriptionId: rx, drugCode: PARACETAMOL_TDS.drugCode },
      doctorToken,
    );
    expect(attempt.status).toBe(403);
    expect(attempt.body.error.code).toBe("HMS-AUTH-005");
  });

  /**
   * ── A MODULE THE HOSPITAL DID NOT BUY IS NOT AN EMPTY WARD ────────────────
   * The round is gated on `module.clinical.nursing` — the MAR flag — and NOT on `module.ops.ipd`
   * like the rest of this router. Gating it on beds would let a hospital without the medication
   * record read the medication record through this door, one ward at a time.
   */
  it("answers HMS-PLAN-002 when the nursing module is not in the edition", async () => {
    await setFeatureOverride({
      tenantId,
      flag: FEATURE_FLAGS.CLINICAL_NURSING,
      enabled: false,
      reason: "M3-S5B entitlement probe",
    });
    try {
      const res = await round();
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("HMS-PLAN-002");
      // …and the sibling worklist, which is gated on BEDS, is unaffected. The two flags are
      // genuinely different questions and this is what proves the round asks the right one.
      await auth(request(app).get("/api/v1/ward-worklist"), nurseToken).expect(200);
    } finally {
      await clearFeatureOverride(tenantId, FEATURE_FLAGS.CLINICAL_NURSING);
    }
    await round().expect(200);
  });

  it("shows another hospital's ward not at all", async () => {
    const theirs = await rowsOf();
    expect(theirs.find((r) => r.encounterId === rivalEncounterId)).toBeUndefined();
  });

  /**
   * ── THE N+1 CONTROL, COUNTED RATHER THAN ASSERTED ─────────────────────────
   * The whole justification for this endpoint is that a twenty-bed round costs a fixed number of
   * queries instead of one per patient. That is a claim about the DATABASE, and every other way of
   * checking it — reading the code, counting HTTP requests — would pass a version that looped
   * internally. So this counts mongoose operations across the request and compares a one-patient
   * page against a four-patient page.
   *
   * Asserted as "does not GROW with the page", not as an exact number: pinning the exact count
   * would fail on any unrelated repository change and teach the next person to raise the constant.
   * Growth is the defect; the constant is an implementation detail.
   */
  it("costs no more database queries for four patients than for one", async () => {
    const encounters: string[] = [];
    for (const name of ["Fanout A", "Fanout B", "Fanout C", "Fanout D"]) {
      const enc = await admitToWard(name);
      await signedRx(enc, [PARACETAMOL_TDS, ADRENALINE_STAT]);
      encounters.push(enc);
    }

    // Warm the entitlement and permission caches: the first request of a run does extra reads that
    // have nothing to do with the page size, and counting them would compare two different things.
    await round("?limit=4").expect(200);

    const count = async (query: string): Promise<number> => {
      let ops = 0;
      mongoose.set("debug", () => {
        ops += 1;
      });
      try {
        await round(query).expect(200);
      } finally {
        mongoose.set("debug", false);
      }
      return ops;
    };

    const one = await count("?limit=1");
    const four = await count("?limit=4");

    // Guards the guard: a hook that silently stopped firing would make every assertion below pass.
    expect(one).toBeGreaterThan(0);
    expect(encounters).toHaveLength(4);
    expect(
      four,
      `a page of four cost ${String(four)} queries against ${String(one)} for a page of one — ` +
        `that is a fan-out, which is the exact defect this endpoint exists to remove`,
    ).toBeLessThanOrEqual(one);
  });
});

/* ── M3-S5A: tenant isolation ──────────────────────────────────────────────── */

describe("another hospital's dose is unreachable", () => {
  /**
   * Isolation here is PHYSICAL — one database per hospital — so a real encounter id from the rival
   * tenant is not filtered out of a query, it is simply not in the database being queried. The id
   * is a genuine one (see `admitAtRival`), because a fabricated id would pass for the wrong reason.
   */
  it("refuses to chart against another tenant's encounter", async () => {
    const res = await chart(rivalEncounterId, {
      prescriptionId: "64b7f0000000000000000001",
      drugCode: PARACETAMOL_TDS.drugCode,
    });
    expect(res.status).toBe(404);
  });

  it("shows no schedule and no MAR for another tenant's encounter", async () => {
    // The rival genuinely HAS a dose on this encounter — `chartAtRival` charted one — so an empty
    // answer here is isolation working, not an empty collection.
    expect(rivalAdministrationId).toMatch(/\S/);

    expect((await schedule(rivalEncounterId).expect(200)).body.data).toEqual([]);
    const rows = await auth(
      request(app).get(`/api/v1/encounters/${rivalEncounterId}/medication-administrations`),
      nurseToken,
    ).expect(200);
    expect(rows.body.data).toEqual([]);
  });

  /**
   * And the same claim from the other side: the rival's own nurse still sees their dose. Without
   * this, "nobody can see it" would also be satisfied by the row never having been written.
   */
  it("still shows that dose to the hospital it belongs to", async () => {
    const theirNurse = await loginAt(rivalHost, `nurse@${RIVAL_SLUG}.test`);
    const rows = await request(app)
      .get(`/api/v1/encounters/${rivalEncounterId}/medication-administrations`)
      .set("Host", rivalHost)
      .set("Authorization", `Bearer ${theirNurse}`)
      .expect(200);

    expect((rows.body.data as { id: string }[]).map((r) => r.id)).toContain(rivalAdministrationId);
  });
});

/**
 * THE RUNTIME SCHEMA GUARD — the API refuses to chart when the rule cannot be enforced.
 *
 * ── WHY THIS IS A REAL REQUEST AND NOT A UNIT TEST ──────────────────────────
 * `schemaReadiness.test.ts` proves every judgement the guard makes, in memory. What it cannot prove
 * is the thing a nurse actually meets: that a tenant whose index has genuinely been dropped answers
 * 503 rather than 201, that nothing reaches the collection on the way, and that the rest of the
 * ward — vitals, nursing notes, reads — keeps working while it does.
 *
 * These tests drop a real index on this suite's own throwaway tenant and put it straight back. The
 * readiness verdict is cached for a minute, so every transition clears the cache explicitly; that is
 * not test scaffolding working around the design, it is the documented way an operator's repair
 * becomes visible before the TTL expires.
 */
describe("charting refuses when the database cannot enforce the dose-duplication rule", () => {
  const SLOT_INDEX = "one_administration_per_dose_slot";
  const CLAIM_INDEX = "one_claim_per_idempotency_key";

  async function dropSlotIndex(): Promise<void> {
    await connection.collection("medicationAdministrations").dropIndex(SLOT_INDEX);
    forgetSchemaReadiness();
  }

  async function restoreSlotIndex(): Promise<void> {
    await connection.collection("medicationAdministrations").createIndex(
      { tenantId: 1, prescriptionId: 1, lineIndex: 1, scheduledFor: 1 },
      {
        unique: true,
        partialFilterExpression: { scheduledFor: { $exists: true } },
        background: true,
        name: SLOT_INDEX,
      },
    );
    forgetSchemaReadiness();
  }

  it("charts normally while every invariant it rests on is armed", async () => {
    const enc = await admitPatient("Guard Baseline");
    const rx = await signedRx(enc, [PARACETAMOL_TDS]);
    const slots = (await schedule(enc).expect(200)).body.data as { scheduledFor: string }[];

    await chart(enc, {
      prescriptionId: rx,
      drugCode: PARACETAMOL_TDS.drugCode,
      scheduledFor: slots[0]?.scheduledFor,
    }).expect(201);
  });

  /**
   * ── THE REFUSAL ───────────────────────────────────────────────────────────
   * Without the index `repo.record` inserts unconditionally, so a second nurse would ALSO be told
   * "recorded" and the round would show one dose. The guard is what turns that into a stop.
   */
  it("answers 503 HMS-MAR-002 with Retry-After when the dose-slot index is gone", async () => {
    const enc = await admitPatient("Guard Refusal");
    const rx = await signedRx(enc, [PARACETAMOL_TDS]);
    const slots = (await schedule(enc).expect(200)).body.data as { scheduledFor: string }[];
    const slot = slots[0]?.scheduledFor;

    await dropSlotIndex();
    try {
      const res = await chart(enc, {
        prescriptionId: rx,
        drugCode: PARACETAMOL_TDS.drugCode,
        scheduledFor: slot,
      }).expect(503);

      expect(res.body.error.code).toBe("HMS-MAR-002");
      // A client that cannot see WHEN to come back will either hammer or give up.
      expect(res.headers["retry-after"]).toBe("60");
      // The finding names the rule and the migration, so whoever is paged has the remedy.
      const missing = res.body.error.details.missing as { rule: string; migration: string }[];
      expect(missing.map((m) => m.migration)).toContain("0049-one-administration-per-dose-slot");
      // It must tell the nurse what to DO — a bare failure sends her back to the same button.
      expect(String(res.body.error.message)).toMatch(/paper/i);

      /**
       * NOTHING WAS WRITTEN. The whole point of refusing before the read-and-write path is that
       * there is no partial state to reconcile afterwards.
       */
      const rows = await connection
        .collection("medicationAdministrations")
        .countDocuments({ prescriptionId: new mongoose.Types.ObjectId(rx) });
      expect(rows).toBe(0);
    } finally {
      await restoreSlotIndex();
    }
  });

  it("charts again the moment the index is restored — the refusal is not sticky", async () => {
    const enc = await admitPatient("Guard Recovery");
    const rx = await signedRx(enc, [PARACETAMOL_TDS]);
    const slots = (await schedule(enc).expect(200)).body.data as { scheduledFor: string }[];

    await dropSlotIndex();
    await chart(enc, {
      prescriptionId: rx,
      drugCode: PARACETAMOL_TDS.drugCode,
      scheduledFor: slots[0]?.scheduledFor,
    }).expect(503);

    await restoreSlotIndex();
    await chart(enc, {
      prescriptionId: rx,
      drugCode: PARACETAMOL_TDS.drugCode,
      scheduledFor: slots[0]?.scheduledFor,
    }).expect(201);
  });

  /**
   * A PRN dose carries no `scheduledFor`, so the dose-slot index deliberately does not cover it —
   * the Idempotency-Key claim is the only thing standing between a retried request and a second
   * recorded dose. That is why charting asks for both invariants and not just its own.
   */
  it("also refuses when the idempotency claim index is gone", async () => {
    const enc = await admitPatient("Guard Claim");
    const rx = await signedRx(enc, [PARACETAMOL_TDS]);
    const slots = (await schedule(enc).expect(200)).body.data as { scheduledFor: string }[];

    await connection.collection("idempotencyKeys").dropIndex(CLAIM_INDEX);
    forgetSchemaReadiness();
    try {
      const res = await chart(enc, {
        prescriptionId: rx,
        drugCode: PARACETAMOL_TDS.drugCode,
        scheduledFor: slots[0]?.scheduledFor,
      }).expect(503);

      expect(res.body.error.code).toBe("HMS-MAR-002");
      const missing = res.body.error.details.missing as { migration: string }[];
      expect(missing.map((m) => m.migration)).toContain("0048-idempotency-key-claims");
    } finally {
      await connection
        .collection("idempotencyKeys")
        .createIndex(
          { tenantId: 1, userId: 1, key: 1 },
          { unique: true, background: true, name: CLAIM_INDEX },
        );
      forgetSchemaReadiness();
    }
  });

  /**
   * ── PROPORTIONALITY ───────────────────────────────────────────────────────
   * The MAR cannot be trusted; the ward has not stopped existing. Vitals (migration 0025 creates NO
   * unique index) and nursing notes (whose only uniqueness is partial on discharge summaries) have
   * no dependency on the missing constraint, and blocking them would invent a rule the product does
   * not have — while pushing a nurse off the system for observations that are still perfectly safe
   * to record.
   */
  it("does not block vitals, nursing notes, or reads while charting is refused", async () => {
    const enc = await admitToWard("Guard Bystander");
    const rx = await signedRx(enc, [PARACETAMOL_TDS]);

    await dropSlotIndex();
    try {
      await chart(enc, { prescriptionId: rx, drugCode: PARACETAMOL_TDS.drugCode }).expect(503);

      await auth(request(app).post(`/api/v1/encounters/${enc}/vitals`), nurseToken)
        .send({ systolic: 118, diastolic: 76, pulse: 72 })
        .expect(201);

      await auth(request(app).post(`/api/v1/encounters/${enc}/nursing-notes`), nurseToken)
        .send({ text: "Patient settled; dose charted on paper, escalated to the ward manager." })
        .expect(201);

      // Reads are untouched — the chart must stay legible precisely when writing is refused.
      await schedule(enc).expect(200);
      await auth(
        request(app).get(`/api/v1/encounters/${enc}/medication-administrations`),
        nurseToken,
      ).expect(200);
    } finally {
      await restoreSlotIndex();
    }
  });

  /**
   * The guard sits in front of the existing protection; it must not replace or weaken it. With the
   * index present, a second nurse on the same slot still meets HMS-MAR-001 and its oracle.
   */
  it("leaves the existing duplicate protection exactly as it was", async () => {
    const enc = await admitPatient("Guard Duplicate");
    const rx = await signedRx(enc, [PARACETAMOL_TDS]);
    const slots = (await schedule(enc).expect(200)).body.data as { scheduledFor: string }[];
    const slot = slots[0]?.scheduledFor;

    await chart(enc, {
      prescriptionId: rx,
      drugCode: PARACETAMOL_TDS.drugCode,
      scheduledFor: slot,
    }).expect(201);
    const second = await chart(enc, {
      prescriptionId: rx,
      drugCode: PARACETAMOL_TDS.drugCode,
      scheduledFor: slot,
    }).expect(409);

    expect(second.body.error.code).toBe("HMS-MAR-001");
    expect(second.body.error.details.existing).toBeDefined();
  });

  /**
   * One hospital's schema says nothing about another's. The rival tenant is a physically separate
   * database (ADR-0005), and its charting must be unaffected while this one is refusing.
   */
  it("refuses only the tenant whose index is missing", async () => {
    await dropSlotIndex();
    try {
      const enc = await admitPatient("Guard Isolation");
      const rx = await signedRx(enc, [PARACETAMOL_TDS]);
      await chart(enc, { prescriptionId: rx, drugCode: PARACETAMOL_TDS.drugCode }).expect(503);

      // The rival hospital charts normally throughout. `chartAtRival` writes its own prescription
      // and charts a PRN dose against it, so it is repeatable and independent of this tenant.
      await chartAtRival(rivalEncounterId);
    } finally {
      await restoreSlotIndex();
    }
  });

  /**
   * ── THE ORDER GUARD MUST NOT REACH THE BEDSIDE ────────────────────────────
   * `one_order_per_request_id` (migration 0013) protects raising an investigation. Charting a dose
   * has no dependency on it whatsoever, and a nurse losing the drug round because the lab's
   * idempotency index was dropped would be a far worse outcome than the drift itself. Asserted at
   * the HTTP level rather than only in the readiness unit suite, because the claim is about what
   * the running application does.
   */
  it("is untouched when the ORDER index is gone — that is the lab's rule, not the bedside's", async () => {
    const enc = await admitToWard("Guard Order Bystander");
    const rx = await signedRx(enc, [PARACETAMOL_TDS]);

    await connection.collection("orders").dropIndex("one_order_per_request_id");
    forgetSchemaReadiness();
    try {
      await chart(enc, { prescriptionId: rx, drugCode: PARACETAMOL_TDS.drugCode }).expect(201);

      await auth(request(app).post(`/api/v1/encounters/${enc}/vitals`), nurseToken)
        .send({ systolic: 120, diastolic: 78, pulse: 70 })
        .expect(201);

      await auth(request(app).post(`/api/v1/encounters/${enc}/nursing-notes`), nurseToken)
        .send({ text: "Round complete; nothing outstanding." })
        .expect(201);
    } finally {
      await connection.collection("orders").createIndex(
        { tenantId: 1, requestId: 1 },
        {
          unique: true,
          partialFilterExpression: { requestId: { $exists: true } },
          background: true,
          name: "one_order_per_request_id",
        },
      );
      forgetSchemaReadiness();
    }
  });
});
