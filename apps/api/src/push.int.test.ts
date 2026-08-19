/**
 * STAFF PUSH — M4. The half of Alerts that reaches a phone.
 *
 * ── WHAT IS REAL IN THIS SUITE ──────────────────────────────────────────────
 * Everything except Expo. The app, the tenant databases, the notification ledger, the task queue's
 * handler, the device collection and its unique index are all the shipped code. `EXPO_PUSH_URL` is
 * pointed at a loopback server that speaks Expo's actual protocol — an array of messages in, an
 * array of positional tickets out — so the request shape, the ticket parsing and the
 * `DeviceNotRegistered` path are exercised rather than believed.
 *
 * That is the same choice `test/mailTestEnv.ts` argues for and for the same reason: a mocked
 * transport proves we CALLED a sender. What is worth defending is that a critical result reaches
 * the right handset, that it stops reaching a handset its owner signed out of, and that it never
 * reaches a hospital that did not raise it.
 *
 * ── WHAT THIS SUITE CANNOT PROVE ────────────────────────────────────────────
 * That a phone rings. Nothing that runs without hardware can: APNs and FCM are the last hop and
 * neither has a loopback. That gap is recorded honestly in `MOBILE_M4_DEVICE_CHECKLIST.md` and is
 * BLOCKED, not passed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import http from "node:http";
import Redis from "ioredis";
import { listening } from "./test/appServer.js";
import { createLogger } from "@medicore/logger";
import { assertMongoReachable, dropDatabases, TEST_MONGO_URI } from "./test/mongoTestEnv.js";
import { assertRedisReachable, flushTestCache, testRedisUrl } from "./test/redisTestEnv.js";

/* ── a loopback Expo, started before the app reads its environment ─────────── */

interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  priority: string;
  data: Record<string, string>;
}

/** What the fake Expo will answer for a given token, keyed by token. Default: ok. */
const ticketFor = new Map<string, { status: "ok" } | { status: "error"; error?: string }>();
/** Every batch the server received, in order — the assertion surface. */
const batches: ExpoMessage[][] = [];
/** Set to fail the whole HTTP call, the way a provider outage looks. */
let expoIsDown = false;

const expo = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
  req.on("end", () => {
    if (expoIsDown) {
      res.writeHead(503).end("service unavailable");
      return;
    }
    const messages = JSON.parse(raw) as ExpoMessage[];
    batches.push(messages);
    const data = messages.map((message) => {
      const outcome = ticketFor.get(message.to) ?? { status: "ok" as const };
      if (outcome.status === "ok") return { status: "ok", id: "ticket-1" };
      return {
        status: "error",
        message: "the device is gone",
        ...(outcome.error ? { details: { error: outcome.error } } : {}),
      };
    });
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data }));
  });
});

// Loopback, never the wildcard — `test/noWildcardBinds.setup.ts` refuses the other spelling, and
// `test/appServer.ts` explains what a wildcard bind costs when another process holds the port.
await new Promise<void>((resolve) => expo.listen(0, "127.0.0.1", resolve));
const expoPort = (expo.address() as { port: number }).port;

process.env.MONGO_URI = TEST_MONGO_URI;
process.env.REDIS_URL = testRedisUrl("push");
process.env.MONGO_MASTER_DB = "test_push_master";
process.env.TENANT_BASE_DOMAIN = "medicore.test";
process.env.EXPO_PUSH_URL = `http://127.0.0.1:${String(expoPort)}/`;

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
const { notify } = await import("./modules/notifications/index.js");
const { seedNotificationTemplates } = await import("./seed/notificationTemplates.js");
const { dispatchTaskInline } = await import("./core/events/eventConsumer.js");
const { copyFor, PUSH_TASK } = await import("./modules/notifications/index.js");

const SLUG = "test-push";
const RIVAL_SLUG = "test-push-rival";
const DB = `hms_${SLUG}`;
const RIVAL_DB = `hms_${RIVAL_SLUG}`;
const PASSWORD = "V4lid!Password#2026";

const app = await listening(createApp(createLogger({ service: "push-int-test" })));

interface Site {
  id: string;
  slug: string;
  host: string;
  connection: Awaited<ReturnType<typeof getTenantConnection>>;
}

const main = {} as Site;
const rival = {} as Site;

/** Dr Rao's phone. */
let raoToken = "";
let raoId = "";
/** Dr Iyer, at the same hospital — the "not your colleague's alerts" probe. */
let iyerToken = "";
let iyerId = "";
/** An administrator at the OTHER hospital, on the same physical handset string. */
let rivalToken = "";
let rivalUserId = "";

const PHONE = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]";
const TABLET = "ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]";

function auth(req: request.Test, site: Site, token: string): request.Test {
  return req.set("Host", site.host).set("Authorization", `Bearer ${token}`);
}

async function makeUser(site: Site, email: string, role: string): Promise<[string, string]> {
  let id = "";
  await runWithContext(
    {
      traceId: `setup-${email}`,
      tenantId: site.id,
      tenantSlug: site.slug,
      connection: site.connection,
    },
    async () => {
      const user = await createUser({ email, name: email, status: "invited" });
      await setPassword(user.id, PASSWORD, { mustChangePassword: false });
      await assignRoleByCode(user.id, role, []);
      await transitionStatus(user.id, "active");
      id = user.id;
    },
  );

  const login = await request(app)
    .post("/api/v1/auth/login")
    .set("Host", site.host)
    .send({ email, password: PASSWORD });

  return [login.body.data.accessToken as string, id];
}

async function setup(slug: string, into: Site): Promise<void> {
  const t = await provisionTenant({
    hospitalName: slug,
    slug,
    planCode: "PLAN_HOSPITAL",
    organizationType: "private_hospital",
  });
  into.id = t.tenant.id;
  into.slug = slug;
  into.host = `${slug}.medicore.test`;
  into.connection = await getTenantConnection({
    id: t.tenant.id,
    databaseName: t.tenant.databaseName,
  });
  // The messages this suite pushes are rendered from the shipped templates — `notify()` records
  // "failed" and writes nothing at all for a template it cannot find, which would make every
  // assertion below fail for a reason that has nothing to do with push.
  await seedNotificationTemplates(into.id, slug, into.connection);
  await runWithContext(
    { traceId: `seed-${slug}`, tenantId: into.id, tenantSlug: slug, connection: into.connection },
    async () => {
      await seedRbac();
    },
  );
}

/** Raises one in-app message to `userId` and returns its ledger id. */
async function alert(
  site: Site,
  userId: string,
  templateKey: string,
  dedupeKey: string,
  resource?: { type: string; id: string },
): Promise<string> {
  return runWithContext(
    {
      traceId: `alert-${dedupeKey}`,
      tenantId: site.id,
      tenantSlug: site.slug,
      connection: site.connection,
    },
    async () => {
      await notify({
        templateKey,
        recipient: { type: "user", id: userId, name: "Dr Rao" },
        data: {
          doctorName: "Dr Rao",
          patientName: "Kamala Devi",
          uhid: "UH-000042",
          testName: "Serum Potassium",
          result: "7.2 mmol/L",
          hospital: site.slug,
        },
        dedupeKey,
        ...(resource ? { resource } : {}),
      });

      const rows = await site.connection.collection("notifications").find({ dedupeKey }).toArray();
      return String(rows[0]?._id);
    },
  );
}

/** Runs the push task the way the queue would, inside the tenant it belongs to. */
async function runPush(site: Site, notificationId: string): Promise<void> {
  await runWithContext(
    {
      traceId: `push-${notificationId}`,
      tenantId: site.id,
      tenantSlug: site.slug,
      connection: site.connection,
    },
    () => dispatchTaskInline(PUSH_TASK, { notificationId }),
  );
}

beforeAll(async () => {
  await assertMongoReachable();
  await assertRedisReachable();
  await dropDatabases([DB, RIVAL_DB, "test_push_master"]);
  await flushTestCache("push");

  await setup(SLUG, main);
  await setup(RIVAL_SLUG, rival);

  [raoToken, raoId] = await makeUser(main, "rao@push.test", "DOCTOR");
  [iyerToken, iyerId] = await makeUser(main, "iyer@push.test", "DOCTOR");
  [rivalToken, rivalUserId] = await makeUser(rival, "admin@rival.test", "TENANT_ADMIN");
}, 120_000);

afterAll(async () => {
  await closeAllTenantConnections();
  await closeMaster();
  await closeRedis();
  await new Promise<void>((resolve) => expo.close(() => resolve()));
});

/**
 * Every case starts from an empty register and a silent Expo.
 *
 * Devices are the one piece of state these tests both write and read, and a suite whose cases
 * inherit each other's handsets asserts on whatever the previous test happened to leave — which
 * is how "every push failed" passed while a second, healthy phone was quietly succeeding.
 */
beforeEach(async () => {
  batches.length = 0;
  ticketFor.clear();
  expoIsDown = false;
  await main.connection.collection("devices").deleteMany({});
  await rival.connection.collection("devices").deleteMany({});
});

/* ────────────────────────────────────────────────────────────────────────────
 * 1. REGISTERING A HANDSET
 * ──────────────────────────────────────────────────────────────────────────── */

describe("a phone registers itself, and only for the person holding it", () => {
  it("registers on sign-in and hands back an id, never the token", async () => {
    const res = await auth(request(app).post("/api/v1/me/devices"), main, raoToken)
      .send({ token: PHONE, platform: "ios" })
      .expect(200);

    expect(res.body.data.id).toMatch(/^[a-f\d]{24}$/i);
    expect(res.body.data.userId).toBe(raoId);
    expect(res.body.data.active).toBe(true);
    // The address is the server's business. A route that read it back would list the push
    // addresses of every phone in the building to anyone signed in.
    expect(res.body.data.token, "the token must never leave the server").toBeUndefined();
  });

  /**
   * The client calls this on EVERY sign-in, not just the first. If it created a row each time, a
   * doctor who signs in and out twice a day would leave sixty dead addresses behind them in a
   * month and every alert would fan out to all of them.
   */
  it("is safe to call again — the same phone is one row, however many sign-ins", async () => {
    const first = await auth(request(app).post("/api/v1/me/devices"), main, raoToken)
      .send({ token: PHONE, platform: "ios" })
      .expect(200);
    const second = await auth(request(app).post("/api/v1/me/devices"), main, raoToken)
      .send({ token: PHONE, platform: "ios" })
      .expect(200);

    expect(second.body.data.id).toBe(first.body.data.id);

    const list = await auth(request(app).get("/api/v1/me/devices"), main, raoToken).expect(200);
    expect(list.body.data.filter((d: { id: string }) => d.id === first.body.data.id)).toHaveLength(
      1,
    );
  });

  it("refuses a body that names an owner — the recipient is the session", async () => {
    const res = await auth(request(app).post("/api/v1/me/devices"), main, raoToken)
      .send({ token: PHONE, platform: "ios", userId: iyerId })
      .expect(400);

    expect(res.body.error.code).toBe("HMS-VAL-001");
  });

  it("refuses an unauthenticated caller", async () => {
    await request(app)
      .post("/api/v1/me/devices")
      .set("Host", main.host)
      .send({ token: PHONE, platform: "ios" })
      .expect(401);
  });

  it("refuses a platform it cannot deliver to", async () => {
    await auth(request(app).post("/api/v1/me/devices"), main, raoToken)
      .send({ token: PHONE, platform: "blackberry" })
      .expect(400);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2. THE HANDSET HAS ONE OWNER — the safety rule the unique index encodes
 * ──────────────────────────────────────────────────────────────────────────── */

describe("a shared phone belongs to whoever signed in last", () => {
  /**
   * ── THE ONE THAT MATTERS ──────────────────────────────────────────────────
   * A ward phone handed over at shift change. Registering it to the incoming doctor must MOVE it:
   * if both rows stayed active, the doctor who went home would keep receiving their patients'
   * critical results on a handset in somebody else's pocket.
   */
  it("moves the phone to the new signatory, and stops pushing to the old one", async () => {
    await auth(request(app).post("/api/v1/me/devices"), main, raoToken)
      .send({ token: PHONE, platform: "android" })
      .expect(200);
    await auth(request(app).post("/api/v1/me/devices"), main, iyerToken)
      .send({ token: PHONE, platform: "android" })
      .expect(200);

    const raosPhones = await auth(request(app).get("/api/v1/me/devices"), main, raoToken).expect(
      200,
    );
    expect(
      raosPhones.body.data.some((d: { id: string }) => d.id),
      "Dr Rao must no longer own the handset",
    ).toBe(false);

    const id = await alert(main, raoId, "order.critical", `handover:${Date.now()}`);
    await runPush(main, id);
    expect(batches, "an alert for Dr Rao reached a phone that is now Dr Iyer's").toEqual([]);
  });

  it("delivers to the person who now holds it", async () => {
    await auth(request(app).post("/api/v1/me/devices"), main, raoToken)
      .send({ token: PHONE, platform: "android" })
      .expect(200);
    await auth(request(app).post("/api/v1/me/devices"), main, iyerToken)
      .send({ token: PHONE, platform: "android" })
      .expect(200);

    const id = await alert(main, iyerId, "order.critical", `handover-new:${Date.now()}`);
    await runPush(main, id);

    expect(batches).toHaveLength(1);
    expect(batches[0]?.[0]?.to).toBe(PHONE);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3. RELEASING — the sign-out half
 * ──────────────────────────────────────────────────────────────────────────── */

describe("signing out stops the phone ringing", () => {
  it("releases the caller's own handset", async () => {
    const registered = await auth(request(app).post("/api/v1/me/devices"), main, raoToken)
      .send({ token: TABLET, platform: "ios" })
      .expect(200);

    await auth(
      request(app).delete(`/api/v1/me/devices/${registered.body.data.id as string}`),
      main,
      raoToken,
    ).expect(200);

    const id = await alert(main, raoId, "order.critical", `signed-out:${Date.now()}`);
    await runPush(main, id);
    expect(batches, "a released handset was pushed to").toEqual([]);
  });

  /**
   * A sign-out that retries must not report a failure. The write matches on `{_id, userId}` and
   * says nothing about `active`, so a replay is a no-op that answers exactly the same way —
   * idempotent by the query, for every caller, like `POST /notifications/:id/read`. A 404 here
   * would make a dropped connection during sign-out look like a broken app.
   */
  it("is safe to release twice — a retried sign-out is not an error", async () => {
    const registered = await auth(request(app).post("/api/v1/me/devices"), main, raoToken)
      .send({ token: TABLET, platform: "ios" })
      .expect(200);
    const url = `/api/v1/me/devices/${registered.body.data.id as string}`;

    await auth(request(app).delete(url), main, raoToken).expect(200);
    await auth(request(app).delete(url), main, raoToken).expect(200);

    const id = await alert(main, raoId, "order.critical", `twice:${Date.now()}`);
    await runPush(main, id);
    expect(batches, "a twice-released handset was pushed to").toEqual([]);
  });

  /** …and a device that never existed is still a 404, so the 200 above is not blanket. */
  it("answers 404 for a handset nobody ever registered", async () => {
    await auth(
      request(app).delete("/api/v1/me/devices/64b7f0000000000000000009"),
      main,
      raoToken,
    ).expect(404);
  });

  /**
   * ── THE ATTACK THIS CLOSES ────────────────────────────────────────────────
   * Silencing a colleague. `userId` is part of the repository's FILTER rather than a check after
   * the read, so the request cannot match — and the answer is 404, not 403, because "that device
   * exists but is somebody else's" answers a question the caller had no business asking.
   */
  it("will not let one doctor release another's phone", async () => {
    const registered = await auth(request(app).post("/api/v1/me/devices"), main, iyerToken)
      .send({ token: TABLET, platform: "ios" })
      .expect(200);

    await auth(
      request(app).delete(`/api/v1/me/devices/${registered.body.data.id as string}`),
      main,
      raoToken,
    ).expect(404);

    // …and it is still reachable, which is the half a 404 alone would not prove.
    const id = await alert(main, iyerId, "order.critical", `not-silenced:${Date.now()}`);
    await runPush(main, id);
    expect(batches.flat().map((m) => m.to)).toContain(TABLET);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 4. WHAT A LOCKED SCREEN IS ALLOWED TO SAY
 * ──────────────────────────────────────────────────────────────────────────── */

describe("the push says what happened, never who it happened to", () => {
  it("carries no patient name, no test name and no result", async () => {
    await auth(request(app).post("/api/v1/me/devices"), main, raoToken)
      .send({ token: PHONE, platform: "ios" })
      .expect(200);

    const id = await alert(main, raoId, "order.critical", `privacy:${Date.now()}`, {
      type: "order",
      id: "64b7f0000000000000000001",
    });
    await runPush(main, id);

    const message = batches[0]?.[0];
    const shown = `${message?.title ?? ""} ${message?.body ?? ""}`;
    for (const secret of ["Kamala", "UH-000042", "Potassium", "7.2"]) {
      expect(shown, `"${secret}" reached a lock screen`).not.toContain(secret);
    }
    expect(message?.title).toBe(copyFor("order.critical").title);
  });

  /** The identifiers ride where the OS does not display them, so the app can still open it. */
  it("carries the destination in the undisplayed data payload", async () => {
    await auth(request(app).post("/api/v1/me/devices"), main, raoToken)
      .send({ token: PHONE, platform: "ios" })
      .expect(200);

    const id = await alert(main, raoId, "order.critical", `deeplink:${Date.now()}`, {
      type: "order",
      id: "64b7f0000000000000000002",
    });
    await runPush(main, id);

    expect(batches[0]?.[0]?.data).toMatchObject({
      notificationId: id,
      templateKey: "order.critical",
      resourceType: "order",
      resourceId: "64b7f0000000000000000002",
    });
  });

  /** The same destination is on the ledger row, so the inbox and the push agree. */
  it("puts the same destination on the message the inbox reads", async () => {
    const id = await alert(main, raoId, "order.result.released", `inbox-link:${Date.now()}`, {
      type: "order",
      id: "64b7f0000000000000000003",
    });

    const inbox = await auth(request(app).get("/api/v1/notifications/me"), main, raoToken).expect(
      200,
    );
    const message = (
      inbox.body.data as { id: string; resourceType?: string; resourceId?: string }[]
    ).find((m) => m.id === id);

    expect(message?.resourceType).toBe("order");
    expect(message?.resourceId).toBe("64b7f0000000000000000003");
  });

  /** A critical value travels `high` so the OS does not batch it behind a routine one. */
  it("marks the one alert that cannot wait as urgent, and the rest as ordinary", async () => {
    await auth(request(app).post("/api/v1/me/devices"), main, raoToken)
      .send({ token: PHONE, platform: "ios" })
      .expect(200);

    const critical = await alert(main, raoId, "order.critical", `prio-c:${Date.now()}`);
    await runPush(main, critical);
    expect(batches[0]?.[0]?.priority).toBe("high");

    batches.length = 0;
    const routine = await alert(main, raoId, "order.result.released", `prio-r:${Date.now()}`);
    await runPush(main, routine);
    expect(batches[0]?.[0]?.priority).toBe("default");
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 5. THE MESSAGE IS THE LEDGER; PUSH IS A KNOCK ON THE DOOR
 * ──────────────────────────────────────────────────────────────────────────── */

describe("a failed push never costs the alert", () => {
  it("still delivers the in-app message when Expo is down", async () => {
    await auth(request(app).post("/api/v1/me/devices"), main, raoToken)
      .send({ token: PHONE, platform: "ios" })
      .expect(200);
    expoIsDown = true;

    const key = `outage:${Date.now()}`;
    const id = await alert(main, raoId, "order.critical", key);

    // The row is `sent` before the push is even queued — that is the ordering the design turns on.
    const inbox = await auth(request(app).get("/api/v1/notifications/me"), main, raoToken).expect(
      200,
    );
    expect((inbox.body.data as { id: string }[]).some((m) => m.id === id)).toBe(true);

    // And the task throws, so BullMQ retries it — the alert is not silently abandoned.
    await expect(runPush(main, id)).rejects.toThrow(/503|expo/i);
  });

  /**
   * The app was uninstalled, or the OS rotated the token. Expo will refuse this address forever,
   * so leaving it active means every future alert pays for a guaranteed failure — and a batch
   * that is entirely dead becomes indistinguishable from a real outage.
   */
  it("retires a handset Expo says is gone, and does not throw for it", async () => {
    const registered = await auth(request(app).post("/api/v1/me/devices"), main, raoToken)
      .send({ token: PHONE, platform: "ios" })
      .expect(200);
    ticketFor.set(PHONE, { status: "error", error: "DeviceNotRegistered" });

    const id = await alert(main, raoId, "order.critical", `gone:${Date.now()}`);
    await runPush(main, id);

    const list = await auth(request(app).get("/api/v1/me/devices"), main, raoToken).expect(200);
    expect(
      list.body.data.some((d: { id: string }) => d.id === registered.body.data.id),
      "a dead token stayed active",
    ).toBe(false);
  });

  /** One dead handset among several must not re-push to the ones that already buzzed. */
  it("does not retry the whole batch when only one device failed", async () => {
    await auth(request(app).post("/api/v1/me/devices"), main, raoToken)
      .send({ token: PHONE, platform: "ios" })
      .expect(200);
    await auth(request(app).post("/api/v1/me/devices"), main, raoToken)
      .send({ token: TABLET, platform: "android" })
      .expect(200);
    ticketFor.set(PHONE, { status: "error", error: "MessageRateExceeded" });

    const id = await alert(main, raoId, "order.critical", `partial:${Date.now()}`);
    await expect(runPush(main, id)).resolves.toBeUndefined();
  });

  it("retries when every handset failed for a reason that is not 'it is gone'", async () => {
    await auth(request(app).post("/api/v1/me/devices"), main, raoToken)
      .send({ token: PHONE, platform: "ios" })
      .expect(200);
    ticketFor.set(PHONE, { status: "error", error: "MessageRateExceeded" });

    const id = await alert(main, raoId, "order.critical", `all-failed:${Date.now()}`);
    await expect(runPush(main, id)).rejects.toThrow(/every push failed/);
  });

  it("does nothing at all when the recipient has never installed the app", async () => {
    const id = await alert(main, iyerId, "order.result.released", `no-device:${Date.now()}`);
    await runPush(main, id);
    expect(batches).toEqual([]);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 6. THE BOUNDARIES
 * ──────────────────────────────────────────────────────────────────────────── */

describe("one hospital cannot reach another's phones", () => {
  /**
   * ── THE SAME PHYSICAL HANDSET, TWO HOSPITALS ─────────────────────────────
   * An Expo token identifies an installation, so the same string can legitimately exist in two
   * tenants' databases. `tenantScopePlugin` puts them in different collections in different
   * databases; this proves the sender reads its own.
   */
  it("keeps a token registered at two hospitals in two separate registers", async () => {
    await auth(request(app).post("/api/v1/me/devices"), main, raoToken)
      .send({ token: PHONE, platform: "ios" })
      .expect(200);
    await auth(request(app).post("/api/v1/me/devices"), rival, rivalToken)
      .send({ token: PHONE, platform: "ios" })
      .expect(200);

    const id = await alert(rival, rivalUserId, "order.critical", `rival:${Date.now()}`);
    await runPush(rival, id);

    expect(batches).toHaveLength(1);
    // It went out under the RIVAL's push, from the rival's register — not through the main
    // hospital's row for the same string.
    expect(batches[0]?.[0]?.to).toBe(PHONE);

    const mainList = await auth(request(app).get("/api/v1/me/devices"), main, raoToken).expect(200);
    expect(mainList.body.data, "the main hospital's own row survived").toHaveLength(1);
    expect(mainList.body.data[0].userId).toBe(raoId);
  });

  it("does not list another hospital's devices to a caller of this one", async () => {
    const list = await auth(request(app).get("/api/v1/me/devices"), rival, rivalToken).expect(200);
    expect(list.body.data.every((d: { userId: string }) => d.userId === rivalUserId)).toBe(true);
  });

  /** A token belonging to another hospital cannot be released from this one. */
  it("refuses a cross-tenant release", async () => {
    const registered = await auth(request(app).post("/api/v1/me/devices"), rival, rivalToken)
      .send({ token: TABLET, platform: "ios" })
      .expect(200);

    await auth(
      request(app).delete(`/api/v1/me/devices/${registered.body.data.id as string}`),
      main,
      raoToken,
    ).expect(404);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 7. WHAT THE PHONE IS TOLD ABOUT THE HOSPITAL'S EDITION
 * ──────────────────────────────────────────────────────────────────────────── */

describe("the session tells the client what the hospital bought", () => {
  /**
   * The server half of M4's entitlement fix. `/auth/me` has carried `features` since D20 and the
   * mobile runtime dropped them, so its tab bar gated on permission alone and offered modules the
   * plan does not include. Pinned here because a client cannot honour a field the server stops
   * sending.
   */
  it("carries the edition's feature flags on /auth/me", async () => {
    const me = await auth(request(app).get("/api/v1/auth/me"), main, raoToken).expect(200);

    expect(Array.isArray(me.body.data.features)).toBe(true);
    expect(me.body.data.features).toContain("module.ops.ipd");
    expect(me.body.data.features).not.toContain("module.finance.packages");
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 8. WHO GETS PUSHED, ASSERTED ON THE QUEUE ITSELF
 *
 * The two sections above drive `deliver()` directly, which proves what happens once a push is
 * scheduled. This proves the other half — that it is scheduled for the right messages and exactly
 * once — by looking at the job BullMQ was actually given, because that is the artefact the design
 * turns on and nothing else can see it.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("only a staff message knocks on a phone, and only once", () => {
  const redis = new Redis(testRedisUrl("push"));

  afterAll(async () => {
    redis.disconnect();
  });

  /** BullMQ stores a job at `bull:<queue>:<jobId>`; ours is `push-<notificationId>`. */
  const queued = async (notificationId: string): Promise<boolean> =>
    (await redis.exists(`bull:notifications:push-${notificationId}`)) === 1;

  it("queues a push for an in-app message addressed to a person", async () => {
    const id = await alert(main, raoId, "order.critical", `queued:${Date.now()}`);
    expect(await queued(id)).toBe(true);
  });

  /**
   * ── AND NOTHING FOR A PATIENT ─────────────────────────────────────────────
   * `patient.welcome` is an EMAIL template addressed to a patient. Two independent things stop it
   * reaching a phone here, and this test deliberately claims only the outcome: the channel guard
   * (`shouldPush`, pinned on its own in `pushCopy.test.ts` because this suite CANNOT falsify it —
   * with no SMTP host the message is `suppressed` before the guard is even reached), and the fact
   * that a patient has no login and therefore no device row at all.
   *
   * The narrower claim is still worth making: whatever the reason, a patient's welcome mail must
   * not put a job on the push queue.
   */
  it("queues nothing for a message that goes out by email", async () => {
    const key = `email:${Date.now()}`;
    await runWithContext(
      { traceId: key, tenantId: main.id, tenantSlug: main.slug, connection: main.connection },
      () =>
        notify({
          templateKey: "patient.welcome",
          recipient: {
            address: "someone@example.test",
            name: "Kamala",
            type: "patient",
            id: "p-1",
          },
          data: { patientName: "Kamala", uhid: "UH-1", hospital: main.slug },
          dedupeKey: key,
        }),
    );

    const rows = await main.connection
      .collection("notifications")
      .find({ dedupeKey: key })
      .toArray();
    const id = String(rows[0]?._id);
    expect(rows[0]?.channel, "this template stopped being an email — pick another").toBe("email");
    expect(await queued(id), "a patient's email queued a push").toBe(false);
  });

  /**
   * Delivery is at-least-once by design (ADR-0007), so the consumer WILL see the same event twice.
   * The ledger's `dedupeKey` stops the second MESSAGE; `jobId` stops the second BUZZ. Without the
   * second guard a redelivered critical result would wake a doctor twice for one potassium.
   */
  it("queues one push however many times the cause is redelivered", async () => {
    const key = `twice-queued:${Date.now()}`;
    const first = await alert(main, raoId, "order.critical", key);
    const second = await alert(main, raoId, "order.critical", key);

    expect(second, "the ledger should have deduped the message itself").toBe(first);
    const jobs = await redis.keys("bull:notifications:push-*");
    expect(jobs.filter((k) => k.endsWith(first))).toHaveLength(1);
  });
});
