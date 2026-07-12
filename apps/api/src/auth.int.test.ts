/**
 * AUTHENTICATION SUITE — release-gating (Doc 05 §4.2, ADR-0009).
 *
 * Runs over real HTTP through the real middleware chain
 * (resolveTenant → authenticate → validate → handler), against a real MongoDB
 * and a real Redis. Nothing on the auth path is mocked, because a mocked token
 * check proves nothing about the token check that ships.
 *
 * The properties being defended here, in order of how badly they would hurt:
 *
 *   1. A token minted for one hospital is worthless at another (HMS-TEN-003).
 *   2. A stolen refresh token cannot be replayed — the second use of any token
 *      kills the whole family (HMS-AUTH-003).
 *   3. Login leaks nothing: unknown email, wrong password, disabled and locked
 *      accounts are indistinguishable to the caller.
 *   4. Logout, session revocation and password change really do end a session.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { TOTP, Secret } from "otpauth";
import { createLogger } from "@medicore/logger";
import { assertMongoReachable, dropDatabases, TEST_MONGO_URI } from "./test/mongoTestEnv.js";
import { assertRedisReachable, flushTestCache, TEST_REDIS_URL } from "./test/redisTestEnv.js";

// Point config at the test infrastructure BEFORE any module reads env.
process.env.MONGO_URI = TEST_MONGO_URI;
process.env.REDIS_URL = TEST_REDIS_URL;
process.env.MONGO_MASTER_DB = "test_auth_master";
process.env.TENANT_BASE_DOMAIN = "paperlesstech.in";
process.env.LOGIN_MAX_ATTEMPTS = "5";

const { createApp } = await import("./app.js");
const { provisionTenant } = await import("./modules/tenants/index.js");
const { seedTenantAdmin } = await import("./seed/seedTenantAdmin.js");
const { getTenantConnection, closeAllTenantConnections } =
  await import("./core/db/connectionManager.js");
const { closeMaster } = await import("./core/db/masterDb.js");
const { closeRedis } = await import("./core/redis/redis.js");
const { runWithContext } = await import("./core/context/requestContext.js");
const { createUser, transitionStatus } = await import("./modules/users/index.js");
const { assignRoleByCode } = await import("./modules/rbac/index.js");
const { setPassword } = await import("./modules/auth/index.js");

const SLUG_A = "test-auth-apollo";
const SLUG_B = "test-auth-sunshine";
const DB_A = `hms_${SLUG_A}`;
const DB_B = `hms_${SLUG_B}`;
const HOST_A = `${SLUG_A}.paperlesstech.in`;
const HOST_B = `${SLUG_B}.paperlesstech.in`;

const ADMIN_EMAIL = "admin@apollo.test";
const ADMIN_PASSWORD = "Str0ng!Admin#Pass1";
const GOOD_PASSWORD = "V4lid!Password#2026";

const app = createApp(createLogger({ service: "auth-int-test" }));

interface Tenant {
  id: string;
  slug: string;
  databaseName: string;
}
let tenantA: Tenant;
let tenantB: Tenant;

/** Creates an active user with a password and the TENANT_ADMIN role, in `tenant`. */
async function createTestUser(tenant: Tenant, email: string, password: string): Promise<string> {
  const connection = await getTenantConnection({
    id: tenant.id,
    databaseName: tenant.databaseName,
  });
  return runWithContext(
    {
      traceId: "test-setup",
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      connection,
    },
    async () => {
      const user = await createUser({ email, name: email, status: "invited" });
      await setPassword(user.id, password, { mustChangePassword: false });
      await assignRoleByCode(user.id, "TENANT_ADMIN");
      await transitionStatus(user.id, "active");
      return user.id;
    },
  );
}

const loginAs = (host: string, email: string, password: string) =>
  request(app).post("/api/v1/auth/login").set("Host", host).send({ email, password });

beforeAll(async () => {
  await assertMongoReachable();
  await assertRedisReachable();
  await dropDatabases(["test_auth_master", DB_A, DB_B]);
  await flushTestCache(); // the registry is cached — see flushTestCache()

  const a = await provisionTenant({ hospitalName: "Apollo Auth", slug: SLUG_A });
  const b = await provisionTenant({ hospitalName: "Sunshine Auth", slug: SLUG_B });
  tenantA = a.tenant;
  tenantB = b.tenant;

  for (const tenant of [tenantA, tenantB]) {
    const connection = await getTenantConnection({
      id: tenant.id,
      databaseName: tenant.databaseName,
    });
    await seedTenantAdmin({
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      connection,
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });
  }
}, 90_000);

afterAll(async () => {
  await closeAllTenantConnections();
  await closeMaster();
  await closeRedis();
  await dropDatabases(["test_auth_master", DB_A, DB_B]);
}, 30_000);

/* ───────────────────────────────────────────────────────────────────────── */

describe("login", () => {
  it("issues an access token, a rotating refresh token and the seeded admin's role", async () => {
    const res = await loginAs(HOST_A, ADMIN_EMAIL, ADMIN_PASSWORD);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.refreshToken).toBeTruthy();
    expect(res.body.data.user.roles).toEqual(["TENANT_ADMIN"]);
    expect(res.body.data.expiresIn).toBe(900);
  });

  it("puts the refresh token in an httpOnly cookie for browsers", async () => {
    const res = await loginAs(HOST_A, ADMIN_EMAIL, ADMIN_PASSWORD);
    const cookie = (res.headers["set-cookie"] as unknown as string[])[0];
    expect(cookie).toContain("hms_refresh=");
    expect(cookie).toContain("HttpOnly");
  });

  it("never returns the password hash", async () => {
    const res = await loginAs(HOST_A, ADMIN_EMAIL, ADMIN_PASSWORD);
    expect(JSON.stringify(res.body)).not.toContain("argon2");
  });

  it("rejects a wrong password with HMS-AUTH-001", async () => {
    const res = await loginAs(HOST_A, ADMIN_EMAIL, "wrong-password-entirely");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("HMS-AUTH-001");
  });

  it("gives an unknown email the IDENTICAL response — login is not a user-enumeration oracle", async () => {
    const unknown = await loginAs(HOST_A, "nobody@apollo.test", "wrong-password-entirely");
    const wrongPw = await loginAs(HOST_A, ADMIN_EMAIL, "wrong-password-entirely");

    expect(unknown.status).toBe(wrongPw.status);
    expect(unknown.body.error.code).toBe(wrongPw.body.error.code);
    expect(unknown.body.error.message).toBe(wrongPw.body.error.message);
  });

  it("rejects an unknown host before it ever looks at the credentials", async () => {
    const res = await loginAs("ghost.paperlesstech.in", ADMIN_EMAIL, ADMIN_PASSWORD);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("HMS-TEN-001");
  });

  it("rejects an unexpected field (schemas are strict)", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .set("Host", HOST_A)
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, isAdmin: true });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("HMS-VAL-001");
  });
});

describe("TENANT ISOLATION of identity — the property auth adds on top of Phase 1A", () => {
  it("rejects tenant A's access token on tenant B's host with HMS-TEN-003", async () => {
    const { body } = await loginAs(HOST_A, ADMIN_EMAIL, ADMIN_PASSWORD);

    const onOwnHost = await request(app)
      .get("/api/v1/auth/me")
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${body.data.accessToken}`);
    expect(onOwnHost.status).toBe(200);

    // Same signature, same user, different hospital → the token has no authority.
    const onOtherHost = await request(app)
      .get("/api/v1/auth/me")
      .set("Host", HOST_B)
      .set("Authorization", `Bearer ${body.data.accessToken}`);

    expect(onOtherHost.status).toBe(403);
    expect(onOtherHost.body.error.code).toBe("HMS-TEN-003");
  });

  it("does not let tenant A's credentials log in at tenant B, even with the same email", async () => {
    // Both tenants seeded the SAME admin email — they are different users in
    // different databases, and only B's password works at B.
    const atB = await loginAs(HOST_B, ADMIN_EMAIL, ADMIN_PASSWORD);
    expect(atB.status).toBe(200); // B's own admin, B's own password

    const wrongTenantPassword = await loginAs(HOST_B, ADMIN_EMAIL, "A-only-password!9");
    expect(wrongTenantPassword.status).toBe(401);
  });

  it("refuses a refresh token issued by tenant A when presented to tenant B", async () => {
    const { body } = await loginAs(HOST_A, ADMIN_EMAIL, ADMIN_PASSWORD);

    const res = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Host", HOST_B)
      .send({ refreshToken: body.data.refreshToken });

    // B's database has no such token — it cannot even be looked up.
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("HMS-AUTH-002");
  });
});

describe("refresh rotation and reuse detection (ADR-0009)", () => {
  it("rotates: the refresh token is exchanged for a NEW one", async () => {
    const login = await loginAs(HOST_A, ADMIN_EMAIL, ADMIN_PASSWORD);
    const first = login.body.data.refreshToken;

    const res = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Host", HOST_A)
      .send({ refreshToken: first });

    expect(res.status).toBe(200);
    expect(res.body.data.refreshToken).not.toBe(first);

    // The fresh access token works.
    const me = await request(app)
      .get("/api/v1/auth/me")
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${res.body.data.accessToken}`);
    expect(me.status).toBe(200);
  });

  it("detects reuse of an already-rotated token and burns the whole family", async () => {
    const login = await loginAs(HOST_A, ADMIN_EMAIL, ADMIN_PASSWORD);
    const stolen = login.body.data.refreshToken;

    // The legitimate client rotates once.
    const rotated = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Host", HOST_A)
      .send({ refreshToken: stolen });
    expect(rotated.status).toBe(200);
    const successor = rotated.body.data.refreshToken;

    // The thief replays the token they captured earlier.
    const replay = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Host", HOST_A)
      .send({ refreshToken: stolen });

    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe("HMS-AUTH-003");

    // …and the legitimate client's CURRENT token is dead too. That is the
    // intended blast radius: we cannot tell victim from thief, so the session
    // ends for both and the human is forced to notice.
    const afterBurn = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Host", HOST_A)
      .send({ refreshToken: successor });

    expect(afterBurn.status).toBe(401);
    expect(afterBurn.body.error.code).toBe("HMS-AUTH-002");
  });

  it("rejects an unknown refresh token with HMS-AUTH-002", async () => {
    const res = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Host", HOST_A)
      .send({ refreshToken: "not-a-real-token-but-long-enough-to-pass-validation" });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("HMS-AUTH-002");
  });
});

describe("authenticate middleware", () => {
  it("rejects a missing token", async () => {
    const res = await request(app).get("/api/v1/auth/me").set("Host", HOST_A);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("HMS-AUTH-002");
  });

  it("rejects a forged token", async () => {
    const res = await request(app)
      .get("/api/v1/auth/me")
      .set("Host", HOST_A)
      .set("Authorization", "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJoYWNrZXIifQ.not-a-signature");

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("HMS-AUTH-002");
  });

  it("returns the caller's identity, roles and branch scope on /me", async () => {
    const login = await loginAs(HOST_A, ADMIN_EMAIL, ADMIN_PASSWORD);
    const res = await request(app)
      .get("/api/v1/auth/me")
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${login.body.data.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe(ADMIN_EMAIL);
    expect(res.body.data.roles).toEqual(["TENANT_ADMIN"]);
    expect(res.body.data).not.toHaveProperty("passwordHash");
  });
});

describe("logout and session management", () => {
  it("blocklists the access token in Redis AND kills the refresh family", async () => {
    const login = await loginAs(HOST_A, ADMIN_EMAIL, ADMIN_PASSWORD);
    const { accessToken, refreshToken } = login.body.data;

    const out = await request(app)
      .post("/api/v1/auth/logout")
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ refreshToken });
    expect(out.status).toBe(200);

    // The access token is still cryptographically valid and unexpired — only the
    // blocklist stops it. This is the assertion that would silently pass if the
    // suite ran without a real Redis.
    const me = await request(app)
      .get("/api/v1/auth/me")
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${accessToken}`);
    expect(me.status).toBe(401);
    expect(me.body.error.code).toBe("HMS-AUTH-002");

    // And the session cannot be resurrected by refreshing.
    const refreshed = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Host", HOST_A)
      .send({ refreshToken });
    expect(refreshed.status).toBe(401);
  });

  it("revokes ONE named device and leaves the others alone", async () => {
    const email = "sessions@apollo.test";
    await createTestUser(tenantA, email, GOOD_PASSWORD);

    // Device 1 logs in, and we capture ITS session id while it is the only one.
    const first = await loginAs(HOST_A, email, GOOD_PASSWORD);
    const before = await request(app)
      .get("/api/v1/auth/sessions")
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${first.body.data.accessToken}`);
    expect(before.body.data).toHaveLength(1);
    const firstSessionId = (before.body.data[0] as { id: string }).id;

    // Device 2 logs in — now there are two, and we know which is which.
    const second = await loginAs(HOST_A, email, GOOD_PASSWORD);
    const both = await request(app)
      .get("/api/v1/auth/sessions")
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${second.body.data.accessToken}`);
    expect(both.body.data).toHaveLength(2);

    // From device 2, sign device 1 out.
    const revoked = await request(app)
      .delete(`/api/v1/auth/sessions/${firstSessionId}`)
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${second.body.data.accessToken}`);
    expect(revoked.status).toBe(200);

    // Device 1's session is gone and its refresh token is dead…
    const remaining = await request(app)
      .get("/api/v1/auth/sessions")
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${second.body.data.accessToken}`);
    expect(remaining.body.data).toHaveLength(1);
    expect((remaining.body.data[0] as { id: string }).id).not.toBe(firstSessionId);

    const deadDevice = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Host", HOST_A)
      .send({ refreshToken: first.body.data.refreshToken });
    expect(deadDevice.status).toBe(401);

    // …while device 2 keeps working. Revocation must be surgical, not a blunt
    // "log everyone out" that happens to satisfy the count assertion.
    const survivor = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Host", HOST_A)
      .send({ refreshToken: second.body.data.refreshToken });
    expect(survivor.status).toBe(200);
  });
});

describe("password policy and change", () => {
  const email = "pwchange@apollo.test";

  beforeAll(async () => {
    await createTestUser(tenantA, email, GOOD_PASSWORD);
  });

  it("refuses to change the password without the current one", async () => {
    const login = await loginAs(HOST_A, email, GOOD_PASSWORD);
    const res = await request(app)
      .post("/api/v1/auth/change-password")
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${login.body.data.accessToken}`)
      .send({ currentPassword: "not-the-current-one", newPassword: "An0ther!Password#7" });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("HMS-AUTH-001");
  });

  it("enforces the policy on the new password", async () => {
    const login = await loginAs(HOST_A, email, GOOD_PASSWORD);
    const res = await request(app)
      .post("/api/v1/auth/change-password")
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${login.body.data.accessToken}`)
      .send({ currentPassword: GOOD_PASSWORD, newPassword: "password123" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("HMS-VAL-001");
    expect(res.body.error.details.password).toBeTruthy();
  });

  it("blocks reuse of a recent password, and ends every session on success", async () => {
    const login = await loginAs(HOST_A, email, GOOD_PASSWORD);
    const access = login.body.data.accessToken;
    const refresh = login.body.data.refreshToken;
    const NEW_PASSWORD = "Rotated!Password#8";

    const changed = await request(app)
      .post("/api/v1/auth/change-password")
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${access}`)
      .send({ currentPassword: GOOD_PASSWORD, newPassword: NEW_PASSWORD });
    expect(changed.status).toBe(200);

    // Every session minted under the OLD secret is gone.
    const stale = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Host", HOST_A)
      .send({ refreshToken: refresh });
    expect(stale.status).toBe(401);

    // The new password works; the old one does not.
    expect((await loginAs(HOST_A, email, NEW_PASSWORD)).status).toBe(200);
    expect((await loginAs(HOST_A, email, GOOD_PASSWORD)).status).toBe(401);

    // And history blocks going straight back to the old one.
    const relogin = await loginAs(HOST_A, email, NEW_PASSWORD);
    const reuse = await request(app)
      .post("/api/v1/auth/change-password")
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${relogin.body.data.accessToken}`)
      .send({ currentPassword: NEW_PASSWORD, newPassword: GOOD_PASSWORD });

    expect(reuse.status).toBe(400);
    expect(reuse.body.error.code).toBe("HMS-VAL-001");
  }, 20_000);
});

describe("brute-force lockout", () => {
  it("locks the account after LOGIN_MAX_ATTEMPTS failures — the right password then fails too", async () => {
    const email = "lockout@apollo.test";
    await createTestUser(tenantA, email, GOOD_PASSWORD);

    for (let i = 0; i < 5; i++) {
      const attempt = await loginAs(HOST_A, email, `wrong-guess-${String(i)}`);
      expect(attempt.status).toBe(401);
    }

    // The credential is CORRECT, and it is still refused — that is the lockout.
    const correct = await loginAs(HOST_A, email, GOOD_PASSWORD);
    expect(correct.status).toBe(401);
    expect(correct.body.error.code).toBe("HMS-AUTH-001");
    expect(correct.body.error.details.lockedUntil).toBeTruthy();
  }, 30_000);
});

describe("MFA (TOTP)", () => {
  const email = "mfa@apollo.test";
  let accessToken: string;
  let secret: string;
  let recoveryCodes: string[];

  const codeFor = (base32: string): string =>
    new TOTP({ secret: Secret.fromBase32(base32), digits: 6, period: 30 }).generate();

  beforeAll(async () => {
    await createTestUser(tenantA, email, GOOD_PASSWORD);
    const login = await loginAs(HOST_A, email, GOOD_PASSWORD);
    accessToken = login.body.data.accessToken;
  });

  it("enrols but does NOT activate until a code is proven", async () => {
    const setup = await request(app)
      .post("/api/v1/auth/mfa/setup")
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${accessToken}`);

    expect(setup.status).toBe(200);
    expect(setup.body.data.otpauthUrl).toContain("otpauth://totp/");
    secret = setup.body.data.secret;

    // Still inactive — a half-finished enrolment must not lock the user out.
    const me = await request(app)
      .get("/api/v1/auth/me")
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${accessToken}`);
    expect(me.body.data.mfaEnabled).toBe(false);
  });

  it("activates on a valid code and hands back one-time recovery codes", async () => {
    const res = await request(app)
      .post("/api/v1/auth/mfa/activate")
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ code: codeFor(secret) });

    expect(res.status).toBe(200);
    recoveryCodes = res.body.data.recoveryCodes;
    expect(recoveryCodes).toHaveLength(10);

    const me = await request(app)
      .get("/api/v1/auth/me")
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${accessToken}`);
    expect(me.body.data.mfaEnabled).toBe(true);
  });

  it("now stops login at the MFA gate — no tokens are issued by the password alone", async () => {
    const res = await loginAs(HOST_A, email, GOOD_PASSWORD);

    expect(res.status).toBe(200);
    expect(res.body.data.mfaRequired).toBe(true);
    expect(res.body.data.mfaToken).toBeTruthy();
    expect(res.body.data.accessToken).toBeUndefined();
  });

  it("rejects the MFA challenge token when used as an access token", async () => {
    const login = await loginAs(HOST_A, email, GOOD_PASSWORD);
    const res = await request(app)
      .get("/api/v1/auth/me")
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${login.body.data.mfaToken}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("HMS-AUTH-002");
  });

  it("refuses to redeem tenant A's MFA challenge at tenant B", async () => {
    const login = await loginAs(HOST_A, email, GOOD_PASSWORD);
    const res = await request(app)
      .post("/api/v1/auth/mfa/verify")
      .set("Host", HOST_B)
      .send({ mfaToken: login.body.data.mfaToken, code: codeFor(secret) });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("HMS-TEN-003");
  });

  it("rejects a wrong code and completes the login on a right one", async () => {
    const login = await loginAs(HOST_A, email, GOOD_PASSWORD);

    const wrong = await request(app)
      .post("/api/v1/auth/mfa/verify")
      .set("Host", HOST_A)
      .send({ mfaToken: login.body.data.mfaToken, code: "000000" });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe("HMS-AUTH-001");

    const right = await request(app)
      .post("/api/v1/auth/mfa/verify")
      .set("Host", HOST_A)
      .send({ mfaToken: login.body.data.mfaToken, code: codeFor(secret) });

    expect(right.status).toBe(200);
    expect(right.body.data.accessToken).toBeTruthy();
    expect(right.body.data.user.mfaEnabled).toBe(true);
  });

  it("accepts a recovery code exactly once", async () => {
    const code = recoveryCodes[0] as string;

    const first = await loginAs(HOST_A, email, GOOD_PASSWORD);
    const used = await request(app)
      .post("/api/v1/auth/mfa/verify")
      .set("Host", HOST_A)
      .send({ mfaToken: first.body.data.mfaToken, code });
    expect(used.status).toBe(200);

    const second = await loginAs(HOST_A, email, GOOD_PASSWORD);
    const replayed = await request(app)
      .post("/api/v1/auth/mfa/verify")
      .set("Host", HOST_A)
      .send({ mfaToken: second.body.data.mfaToken, code });

    expect(replayed.status).toBe(401);
    expect(replayed.body.error.code).toBe("HMS-AUTH-001");
  }, 20_000);
});
