/**
 * THE SESSION LIFECYCLE — scenarios 1–5 and 11 of the M1 test plan.
 *
 * Every test here drives the real `@medicore/api-client` and the real controllers; only the wire
 * and the Keychain are substituted. The three that earn their place are the last three: a logout
 * that survives no network, a refresh that cannot stampede, and a refresh failure that leaves
 * nothing behind.
 */
import { describe, expect, it } from "vitest";
import { ApiClientError, isMfaChallenge } from "@medicore/api-client";
import { createHarness, PASSWORD, SLUG, USER, tokenPair } from "./support/harness";
import { fail, ok } from "./support/fakeApi";
import { storageKeys } from "../src/lib/storage";

const refreshKey = storageKeys.refreshToken(SLUG);

describe("1. login succeeds and produces a usable session", () => {
  it("stores the refresh token securely, keeps the access token in memory, and bootstraps", async () => {
    const h = createHarness();
    h.happyPath();

    const result = await h.runtime.auth.signIn(USER.email, PASSWORD, "Pixel 8 / Android 15");
    expect(isMfaChallenge(result)).toBe(false);

    const session = h.runtime.session.getState();
    expect(session.status).toBe("signedIn");
    expect(session.user?.email).toBe(USER.email);

    /**
     * The permission set comes from `/auth/me`, NOT from the login response — the login payload
     * has no permissions field. A shell built before this call would render the wrong tabs.
     */
    expect([...session.permissions].sort()).toEqual([
      "encounter:read",
      "order:read",
      "patient:read",
    ]);
    expect(h.api.callsTo("GET", "/api/v1/auth/me")).toHaveLength(1);

    // The refresh token is on "disk"; the access token is not.
    expect(await h.secureStore.get(refreshKey)).toBe("refresh-1");
    expect([...h.preferences.snapshot().values()]).not.toContain("access-1");
    expect([...h.secureStore.snapshot().values()]).not.toContain("access-1");
  });

  it("attaches the access token to the next request, read live from the store", async () => {
    const h = createHarness();
    h.happyPath();
    await h.runtime.auth.signIn(USER.email, PASSWORD, "device");

    const [meCall] = h.api.callsTo("GET", "/api/v1/auth/me");
    expect(meCall?.headers.authorization).toBe("Bearer access-1");
  });
});

describe("2. login fails", () => {
  it("surfaces HMS-AUTH-001 as a typed error and leaves NOTHING behind", async () => {
    const h = createHarness();
    h.happyPath();
    h.api.on("POST", "/api/v1/auth/login", () => fail(401, "HMS-AUTH-001", "Invalid credentials"));

    await expect(h.runtime.auth.signIn(USER.email, "wrong", "device")).rejects.toBeInstanceOf(
      ApiClientError,
    );

    expect(h.runtime.session.getState().status).toBe("unknown");
    expect(await h.secureStore.get(refreshKey)).toBeUndefined();
    // A failed sign-in must not have gone looking for a user or a branch list.
    expect(h.api.callsTo("GET", "/api/v1/auth/me")).toHaveLength(0);
  });

  it("does not treat a bad password as an expired session — no refresh is attempted", async () => {
    const h = createHarness();
    h.happyPath();
    h.api.on("POST", "/api/v1/auth/login", () => fail(401, "HMS-AUTH-001"));

    await expect(h.runtime.auth.signIn(USER.email, "wrong", "device")).rejects.toThrow();

    /**
     * The client excludes auth endpoints from `onUnauthorized` precisely so this cannot recurse.
     * Worth asserting: a refresh loop on the login screen would lock an account out through the
     * server's brute-force counter without the user pressing anything twice.
     */
    expect(h.api.callsTo("POST", "/api/v1/auth/refresh")).toHaveLength(0);
  });
});

describe("3. the access token refreshes without the user seeing it", () => {
  it("recovers from a mid-session 401 by refreshing and replaying the SAME request", async () => {
    const h = createHarness();
    h.happyPath();
    await h.runtime.auth.signIn(USER.email, PASSWORD, "device");

    // The next read 401s once, then succeeds — the shape of an access token expiring mid-use.
    h.api.once("GET", "/api/v1/patients", () => fail(401, "HMS-AUTH-002", "Session expired"));
    h.api.on("GET", "/api/v1/patients", () => ok([]));

    const patients = await h.runtime.api.listPatients({ limit: 5 });
    expect(patients.items).toEqual([]);

    expect(h.api.callsTo("POST", "/api/v1/auth/refresh")).toHaveLength(1);
    // Two attempts at the same path: the one that 401'd and the replay.
    expect(h.api.callsTo("GET", "/api/v1/patients")).toHaveLength(2);
    expect(h.runtime.session.getState().status).toBe("signedIn");
  });

  it("rotates the stored refresh token, so the spent one is not kept", async () => {
    const h = createHarness();
    h.happyPath();
    await h.runtime.auth.signIn(USER.email, PASSWORD, "device");
    expect(await h.secureStore.get(refreshKey)).toBe("refresh-1");

    await h.runtime.auth.refreshOnce();

    /**
     * Refresh tokens rotate and the server revokes the family on reuse (ADR-0009). Keeping the old
     * one would eventually present it again and sign the user out as a suspected thief.
     */
    expect(await h.secureStore.get(refreshKey)).toBe("refresh-2");
  });
});

describe("4. refresh failure ends the session cleanly", () => {
  it("wipes the credential, clears state and reports WHY", async () => {
    const h = createHarness();
    h.happyPath();
    await h.runtime.auth.signIn(USER.email, PASSWORD, "device");
    h.runtime.branch.getState().setBranches([], false);

    h.api.on("POST", "/api/v1/auth/refresh", () => fail(401, "HMS-AUTH-002", "Session expired"));
    const recovered = await h.runtime.auth.refreshOnce();

    expect(recovered).toBe(false);
    expect(h.runtime.session.getState().status).toBe("signedOut");
    expect(h.runtime.session.getState().accessToken).toBeUndefined();
    expect(await h.secureStore.get(refreshKey)).toBeUndefined();
    expect(h.runtime.branch.getState().validated).toBe(false);
    expect(h.sessionEndings).toEqual(["expired"]);
  });

  it("distinguishes a REVOKED family from an ordinary expiry", async () => {
    const h = createHarness();
    h.happyPath();
    await h.runtime.auth.signIn(USER.email, PASSWORD, "device");

    h.api.on("POST", "/api/v1/auth/refresh", () =>
      fail(401, "HMS-AUTH-003", "Refresh token reuse detected"),
    );
    await h.runtime.auth.refreshOnce();

    /**
     * Not cosmetic. `revoked` means every one of the user's devices was signed out by the server,
     * and they need to be told that rather than shown a routine "please sign in again".
     */
    expect(h.sessionEndings).toEqual(["revoked"]);
  });

  it("a cold start with no stored token signs out rather than hanging on a splash", async () => {
    const h = createHarness();
    h.happyPath();

    expect(await h.runtime.auth.resume()).toBe(false);
    expect(h.runtime.session.getState().status).toBe("signedOut");
    expect(h.api.callsTo("POST", "/api/v1/auth/refresh")).toHaveLength(0);
  });

  it("a cold start WITH a stored token restores the whole session", async () => {
    const h = createHarness();
    h.happyPath();
    await h.secureStore.set(refreshKey, "refresh-from-last-launch");

    expect(await h.runtime.auth.resume()).toBe(true);
    expect(h.runtime.session.getState().status).toBe("signedIn");
    expect(h.runtime.session.getState().permissions.size).toBe(3);
    // The branch list is part of bootstrap — the shell must not render before it (M0 §7).
    expect(h.runtime.branch.getState().validated).toBe(true);
  });
});

describe("5. logout always completes locally", () => {
  it("wipes everything even when the network is gone", async () => {
    const h = createHarness();
    h.happyPath();
    await h.runtime.auth.signIn(USER.email, PASSWORD, "device");
    expect(await h.secureStore.get(refreshKey)).toBeTruthy();

    h.api.goOffline();
    await h.runtime.auth.signOut();

    /**
     * The assertion that earns this file. If the wipe were conditional on the server call, this
     * button would silently do nothing on a phone with no signal — while the user walked away
     * believing they were signed out, with a live refresh token and a cache full of PHI.
     */
    expect(h.runtime.session.getState().status).toBe("signedOut");
    expect(await h.secureStore.get(refreshKey)).toBeUndefined();
    expect(h.sessionEndings).toEqual(["userSignedOut"]);
  });

  it("wipes when the server refuses the logout too", async () => {
    const h = createHarness();
    h.happyPath();
    await h.runtime.auth.signIn(USER.email, PASSWORD, "device");

    h.api.on("POST", "/api/v1/auth/logout", () => fail(401, "HMS-AUTH-002"));
    await h.runtime.auth.signOut();

    expect(h.runtime.session.getState().status).toBe("signedOut");
    expect(await h.secureStore.get(refreshKey)).toBeUndefined();
  });

  it("does not hang when the server never answers", async () => {
    const h = createHarness();
    h.happyPath();
    await h.runtime.auth.signIn(USER.email, PASSWORD, "device");

    // A request that resolves long after any reasonable patience. The timeout in `signOut` is what
    // keeps the UI moving; without it the user force-quits, which skips the wipe entirely.
    h.api.on(
      "POST",
      "/api/v1/auth/logout",
      () => new Promise<Response>((resolve) => setTimeout(() => resolve(ok({})), 30_000)),
    );

    const started = Date.now();
    await h.runtime.auth.signOut();

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(h.runtime.session.getState().status).toBe("signedOut");
  });

  it("clears cached server state, not just the credential", async () => {
    const h = createHarness();
    h.happyPath();
    await h.runtime.auth.signIn(USER.email, PASSWORD, "device");
    h.runtime.queryClient.setQueryData(["apollo", "all", "patients", ""], [{ id: "p1" }]);

    await h.runtime.auth.signOut();

    // PHI in a query cache outlives a sign-out unless something clears it. That something is the
    // runtime, once, rather than each screen remembering.
    expect(h.runtime.queryClient.getQueryData(["apollo", "all", "patients", ""])).toBeUndefined();
  });
});

describe("11. concurrent 401s cause exactly ONE refresh", () => {
  it("single-flights the refresh rather than racing the rotation", async () => {
    const h = createHarness();
    h.happyPath();
    await h.runtime.auth.signIn(USER.email, PASSWORD, "device");

    // Three screens all discover the expired token in the same tick — the ordinary case on a
    // resumed app with three queries in flight.
    h.api.once("GET", "/api/v1/patients", () => fail(401, "HMS-AUTH-002"));
    h.api.once("GET", "/api/v1/encounters", () => fail(401, "HMS-AUTH-002"));
    h.api.once("GET", "/api/v1/orders", () => fail(401, "HMS-AUTH-002"));
    h.api.on("GET", "/api/v1/patients", () => ok([]));
    h.api.on("GET", "/api/v1/encounters", () => ok([]));
    h.api.on("GET", "/api/v1/orders", () => ok([]));

    await Promise.all([
      h.runtime.api.listPatients({ limit: 1 }),
      h.runtime.api.listEncounters({ limit: 1 }),
      h.runtime.api.listOrders({ limit: 1 }),
    ]);

    /**
     * THE point of the single-flight gate, and it is correctness rather than efficiency: three
     * refreshes with the same rotating token look exactly like token theft to the server, which
     * revokes the family and signs the user out mid-round (HMS-AUTH-003).
     */
    expect(h.api.callsTo("POST", "/api/v1/auth/refresh")).toHaveLength(1);
    expect(h.runtime.session.getState().status).toBe("signedIn");
  });

  it("a second refresh AFTER the first settles is a new flight, not a cached answer", async () => {
    const h = createHarness();
    h.happyPath();
    await h.runtime.auth.signIn(USER.email, PASSWORD, "device");

    await h.runtime.auth.refreshOnce();
    await h.runtime.auth.refreshOnce();

    // The gate must release. A permanently-cached promise would mean the token never rotates again.
    expect(h.api.callsTo("POST", "/api/v1/auth/refresh")).toHaveLength(2);
  });
});

describe("the proactive refresh timer", () => {
  it("fires a minute before expiry, not after", () => {
    const now = 1_000_000;
    const h = createHarness({ now: () => now });
    h.runtime.session.getState().setTokens("access", 900, now);
    h.runtime.session.getState().setUser({ ...USER, ...tokenPair().user });

    // 900s life, 60s lead → 840s.
    expect(h.runtime.auth.msUntilRefresh(now)).toBe(840_000);
  });

  it("has no opinion when nobody is signed in", () => {
    const h = createHarness();
    expect(h.runtime.auth.msUntilRefresh()).toBeUndefined();
  });
});
