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
const { closeMaster } = await import("./core/db/masterDb.js");
const { closeRedis } = await import("./core/redis/redis.js");
const { runWithContext } = await import("./core/context/requestContext.js");
const { createUser, transitionStatus } = await import("./modules/users/index.js");
const { assignRoleByCode, seedRbac } = await import("./modules/rbac/index.js");
const { setPassword } = await import("./modules/auth/index.js");
const { seedTariff } = await import("./seed/tariff.js");

const SLUG = "test-mar";
const PASSWORD = "V4lid!Password#2026";
/** 9.5 hours from the pinned process zone, and DST-observing, which Kolkata is not. */
const WARD_ZONE = "America/New_York";
/** Dropped alongside the master: a tenant DB that survives a run carries the OLD plan and the
 *  old rows, which is how a suite starts failing for reasons that have nothing to do with it. */
const TENANT_DB = `hms_${SLUG}`;

const app = createApp(createLogger({ service: "mar-int-test" }));

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
  const res = await request(app)
    .post("/api/v1/auth/login")
    .set("Host", host)
    .send({ email, password: PASSWORD });
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
  await dropDatabases([process.env.MONGO_MASTER_DB as string, TENANT_DB]);
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
}, 120_000);

afterAll(async () => {
  await closeAllTenantConnections();
  await closeMaster();
  await closeRedis();
  await dropDatabases([process.env.MONGO_MASTER_DB as string, TENANT_DB]);
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
