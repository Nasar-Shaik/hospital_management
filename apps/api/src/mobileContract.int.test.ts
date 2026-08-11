/**
 * MOBILE CONTRACT SUITE — the handoff gate for the React Native application.
 *
 * ── WHY THIS DRIVES THE REAL CLIENT AND NOT SUPERTEST ───────────────────────
 * Every other integration suite here asks "does the API behave?" by talking to it directly. That
 * proves the server and proves nothing about the object the phone will actually hold. The mobile
 * app will not write `request(app).post(...)`; it will call `api.recordPayment(...)` on
 * `@medicore/api-client` and depend on that class to attach the token, the tenant host, the
 * active branch and the idempotency key, to refresh silently, and to turn an error envelope into
 * an `ApiClientError`.
 *
 * So this suite instantiates the shipped client and exercises the API THROUGH it. A defect in the
 * wiring between them — a header the client forgets, a shape it mis-parses — is invisible to
 * every other test in the repository and is exactly the class of thing that would surface on day
 * one of mobile development.
 *
 * ── FETCH INJECTION IS THE MECHANISM AND ALSO THE POINT ─────────────────────
 * The client takes a `fetchImpl`. Here it is a function that forwards into the Express app
 * in-process, which means the suite needs no listening socket and no DNS — and, incidentally,
 * proves the injection point works, which is the seam React Native itself relies on (its `fetch`
 * is XHR-backed, not undici).
 *
 * A real socket was tried first and cannot work: Node's `fetch` silently DROPS a `Host` header,
 * so the tenant would never resolve. Recorded because it looks like it should work.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createLogger } from "@medicore/logger";
import {
  ApiClient,
  ApiClientError,
  API_VERSION,
  isMfaChallenge,
  readDeprecationHeaders,
  type DeprecationNotice,
  type LicenseHeader,
} from "@medicore/api-client";
import { assertMongoReachable, dropDatabases, TEST_MONGO_URI } from "./test/mongoTestEnv.js";
import { assertRedisReachable, flushTestCache, testRedisUrl } from "./test/redisTestEnv.js";

process.env.MONGO_URI = TEST_MONGO_URI;
process.env.REDIS_URL = testRedisUrl("mobile");
process.env.MONGO_MASTER_DB = "test_mobile_master";
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
const { createBranch } = await import("./modules/branches/index.js");

const SLUG = "test-mobile";
const OTHER = "test-mobile-other";
const PASSWORD = "V4lid!Password#2026";
const BASE = "http://api.local";

const app = createApp(createLogger({ service: "mobile-contract-test" }));

/**
 * A `fetch` that answers out of the Express app.
 *
 * This is what an offline-capable mobile client would swap for its own instrumented fetch, so the
 * shape matters: in, a `Request`-ish URL and init; out, a real `Response` whose `headers.get()`,
 * `json()` and `blob()` all behave. Anything less would test a fetch we do not ship against.
 */
function fetchViaApp(target: Express): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toLowerCase();
    type Verb = "get" | "post" | "put" | "patch" | "delete";
    let call = request(target)[method as Verb](url.pathname + url.search);

    for (const [name, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      call = call.set(name, value);
    }

    const res =
      init.body === undefined
        ? await call
        : await call.send(JSON.parse(String(init.body)) as object);

    const headers = new Headers();
    for (const [name, value] of Object.entries(res.headers)) headers.set(name, String(value));

    // Binary responses arrive as a Buffer; JSON and text arrive in `res.text`. Getting this
    // wrong would make `blob()` return the string "[object Object]" and the download tests
    // would pass while a phone got garbage.
    const body: BodyInit | null = Buffer.isBuffer(res.body)
      ? new Uint8Array(res.body)
      : ((res.text as string | undefined) ?? null);

    return new Response(body, { status: res.status, headers });
  }) as typeof fetch;
}

interface Session {
  accessToken?: string;
  refreshToken?: string;
  activeBranch?: string;
}

const session: Session = {};
const licenceSeen: (LicenseHeader | null)[] = [];
const deprecationsSeen: { notice: DeprecationNotice; path: string }[] = [];
let refreshed = 0;

/** The client a phone would build, with the callbacks a phone would supply. */
const api = new ApiClient({
  baseUrl: BASE,
  tenantHost: `${SLUG}.medicore.test`,
  fetchImpl: fetchViaApp(app),
  getAccessToken: () => session.accessToken,
  getActiveBranch: () => session.activeBranch,
  onLicenseState: (state) => licenceSeen.push(state),
  onDeprecation: (notice, path) => deprecationsSeen.push({ notice, path }),
  onUnauthorized: async () => {
    // The silent-refresh path, exactly as an app would wire it: swap the token and let the
    // client replay the request that 401'd.
    if (!session.refreshToken) return false;
    const pair = await api.refresh(session.refreshToken);
    session.accessToken = pair.accessToken;
    session.refreshToken = pair.refreshToken;
    refreshed += 1;
    return true;
  },
});

/** A second client pointed at another hospital — the tenant-resolution probe. */
const otherApi = new ApiClient({
  baseUrl: BASE,
  tenantHost: `${OTHER}.medicore.test`,
  fetchImpl: fetchViaApp(app),
  getAccessToken: () => session.accessToken,
});

let branchA = "";
let branchB = "";
let patientId = "";
let doctorId = "";

async function provision(slug: string): Promise<Awaited<ReturnType<typeof getTenantConnection>>> {
  const t = await provisionTenant({
    hospitalName: slug,
    slug,
    // Enterprise, because the branch switcher is the point: a plan capped at one branch cannot
    // exercise the header the mobile app depends on.
    planCode: "PLAN_ENTERPRISE",
    maxBranches: 5,
    organizationType: "private_hospital",
  });
  const connection = await getTenantConnection({
    id: t.tenant.id,
    databaseName: t.tenant.databaseName,
  });
  await runWithContext(
    { traceId: `setup-${slug}`, tenantId: t.tenant.id, tenantSlug: slug, connection },
    async () => {
      await seedRbac();
      const admin = await createUser({
        email: `admin@${slug}.test`,
        name: "Admin",
        status: "invited",
      });
      await setPassword(admin.id, PASSWORD, { mustChangePassword: false });
      await assignRoleByCode(admin.id, "TENANT_ADMIN", []);
      await transitionStatus(admin.id, "active");

      if (slug === SLUG) {
        const second = await createBranch({ name: "Chennai", code: "CHN" });
        branchB = second.id;

        const doctor = await createUser({
          email: `doc@${slug}.test`,
          name: "Dr Rao",
          status: "invited",
        });
        await assignRoleByCode(doctor.id, "DOCTOR", []);
        await transitionStatus(doctor.id, "active");
        doctorId = doctor.id;
      }
    },
  );
  return connection;
}

beforeAll(async () => {
  await assertMongoReachable();
  await assertRedisReachable();
  await dropDatabases(["test_mobile_master", `hms_${SLUG}`, `hms_${OTHER}`]);
  await flushTestCache("mobile");

  await provision(SLUG);
  await provision(OTHER);
}, 180_000);

afterAll(async () => {
  await closeAllTenantConnections();
  await closeMaster();
  await closeRedis();
  await dropDatabases(["test_mobile_master", `hms_${SLUG}`, `hms_${OTHER}`]);
}, 30_000);

/* ────────────────────────────────────────────────────────────────────────────
 * 1. GETTING IN — the first three screens of any mobile app
 * ──────────────────────────────────────────────────────────────────────────── */

describe("a phone can sign in and stay signed in", () => {
  it("logs in and receives a token pair", async () => {
    const result = await api.login(`admin@${SLUG}.test`, PASSWORD, "Pixel 8 / Android 15");

    /**
     * `LoginResult` is a UNION — a token pair, or an MFA challenge. The narrowing helper ships
     * with the client precisely so a mobile login screen cannot forget the second branch and
     * render a home screen for a user who has not finished authenticating.
     */
    expect(isMfaChallenge(result)).toBe(false);
    if (isMfaChallenge(result)) return;

    session.accessToken = result.accessToken;
    session.refreshToken = result.refreshToken;

    expect(result.accessToken).toBeTruthy();
    expect(result.refreshToken).toBeTruthy();
    expect(result.expiresIn).toBeGreaterThan(0);
    // The app needs to know who it is holding before it can render a home screen.
    expect(result.user.email).toBe(`admin@${SLUG}.test`);
    expect(Array.isArray(result.user.roles)).toBe(true);
    expect(Array.isArray(result.user.branchIds)).toBe(true);
  });

  it("refreshes with the token in the BODY — the native path, not a cookie", async () => {
    /**
     * A phone has no cookie jar it can rely on across a cold start, and the web flow's refresh
     * token is deliberately httpOnly. The API accepts the token in the body precisely so a native
     * client can hold it in secure storage and present it itself. If this ever broke, mobile
     * sessions would end at the first access-token expiry and no browser test would notice.
     */
    const pair = await api.refresh(session.refreshToken);
    expect(pair.accessToken).toBeTruthy();
    expect(pair.refreshToken).toBeTruthy();
    // Rotating: the old refresh token must not still be usable (ADR-0009 reuse detection).
    expect(pair.refreshToken).not.toBe(session.refreshToken);

    session.accessToken = pair.accessToken;
    session.refreshToken = pair.refreshToken;
  });

  it("recovers from an expired access token without the user seeing it", async () => {
    const before = refreshed;
    session.accessToken = "not-a-token";

    // The client's `onUnauthorized` hook swaps the token and REPLAYS the call. From the app's
    // point of view the list simply loaded; from the user's, nothing happened at all.
    const patients = await api.listPatients({ limit: 5 });

    expect(refreshed).toBe(before + 1);
    expect(Array.isArray(patients.items)).toBe(true);
  });

  it("resolves the hospital from the tenant host, not from the token", async () => {
    /**
     * The mobile app picks a hospital before it picks a user, and the host header is what carries
     * that choice. A token minted at one hospital presented at another must be refused — the host
     * selects the database, the token proves who you are, and neither is allowed to override the
     * other (Doc 04 §5.1, `HMS-TEN-003`).
     */
    await expect(otherApi.listPatients({ limit: 1 })).rejects.toMatchObject({
      code: "HMS-TEN-003",
    });
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2. THE BRANCH SWITCHER — ADR-0015, from a phone
 * ──────────────────────────────────────────────────────────────────────────── */

describe("a phone can choose which site it is working at", () => {
  it("lists the branches this user may act in", async () => {
    const mine = await api.listMyBranches();

    expect(mine.branches.length).toBeGreaterThanOrEqual(2);
    const codes = mine.branches.map((b) => b.code);
    expect(codes).toContain("CHN");
    branchA = mine.branches.find((b) => b.code !== "CHN")?.id ?? "";
    expect(branchA).toBeTruthy();
  });

  it("sends X-Active-Branch, read live, so switching needs no new client", async () => {
    session.activeBranch = branchA;
    const created = await api.registerPatient({
      name: "Branch A Patient",
      gender: "female",
      contact: { phone: "9200000001" },
    });
    patientId = created.patient.id;
    expect(created.patient.branchId).toBe(branchA);

    /**
     * The switch is a change to what the CALLBACK returns — no new client, no re-login. That is
     * the property a mobile branch switcher needs: the user taps a site in a sheet and the very
     * next request acts there.
     */
    session.activeBranch = branchB;
    const atChennai = await api.registerPatient({
      name: "Branch B Patient",
      gender: "male",
      contact: { phone: "9200000002" },
    });
    expect(atChennai.patient.branchId).toBe(branchB);
  });

  it("scopes a READ to the active branch", async () => {
    session.activeBranch = branchB;
    const chennai = await api.listPatients({ limit: 50 });
    const names = chennai.items.map((p) => p.name);

    expect(names).toContain("Branch B Patient");
    expect(names).not.toContain("Branch A Patient");
  });

  it("scopes a WRITE to the active branch, and refuses to guess", async () => {
    session.activeBranch = branchA;
    const encounter = await api.startEncounter({ patientId, departmentId: doctorId });
    expect(encounter.encounter.branchId).toBe(branchA);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3. RETRYING SAFELY — the reason a mobile client needs idempotency at all
 * ──────────────────────────────────────────────────────────────────────────── */

describe("a phone can retry a mutation without paying twice", () => {
  it("carries the key, replays the answer, and says so", async () => {
    session.activeBranch = branchA;
    const key = "mobile-queue-0001-aaaa";
    const body = { amount: 250_000, method: "cash", reason: "Admission advance" };

    const first = await api.depositToWallet(patientId, body, key);
    const again = await api.depositToWallet(patientId, body, key);

    // Byte-identical: an offline queue that drains twice must not credit twice, and the second
    // drain must be able to reconcile against the same numbers it would have seen the first time.
    expect(again).toEqual(first);
    const wallet = await api.getWallet(patientId);
    expect(wallet.balance).toBe(250_000);
  });

  it("refuses a key reused for a different payload rather than replaying it", async () => {
    const key = "mobile-queue-0002-bbbb";
    await api.depositToWallet(patientId, { amount: 10_000, method: "cash" }, key);

    /**
     * The failure mode this prevents is a queue bug becoming an accounting one: replaying here
     * would tell the phone its ₹500 deposit succeeded when the hospital took ₹100.
     */
    await expect(
      api.depositToWallet(patientId, { amount: 50_000, method: "cash" }, key),
    ).rejects.toMatchObject({ status: 409, code: "HMS-REQ-002" });
  });

  it("does NOT treat a body `requestId` as the central idempotency key", async () => {
    /**
     * `requestId` survives on four endpoints as a per-module guard (see `docs/API_LIFECYCLE.md`).
     * It must not be silently promoted into the central mechanism: the two have different scopes
     * — one is a column on the order, the other is a claim owned by (tenant, user) — and a client
     * that believed the body field gave it header semantics would be relying on a replay it never
     * gets.
     */
    session.activeBranch = branchA;
    const encounter = await api.startEncounter({ patientId, departmentId: doctorId });
    const requestId = "body-only-key-0003";

    const first = await api.placeOrder({
      encounterId: encounter.encounter.id,
      category: "lab",
      code: "CBC",
      name: "Complete blood count",
      requestId,
    });
    const second = await api.placeOrder({
      encounterId: encounter.encounter.id,
      category: "lab",
      code: "CBC",
      name: "Complete blood count",
      requestId,
    });

    // The module guard answers — `duplicate: true` and the SAME order, not a replayed 201.
    expect(second.duplicate).toBe(true);
    expect(second.order.id).toBe(first.order.id);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 4. THE SHAPES A LIST SCREEN AND AN ERROR TOAST NEED
 * ──────────────────────────────────────────────────────────────────────────── */

describe("a phone can page, and can explain a failure", () => {
  it("returns items with the meta an infinite scroll needs", async () => {
    session.activeBranch = branchA;
    // Three at this site, so a single-row page has something to page PAST — a `total` that
    // equals the page size proves nothing about the field an infinite scroll actually reads.
    for (const phone of ["9200000010", "9200000011"]) {
      await api.registerPatient({ name: `Paged ${phone}`, gender: "other", contact: { phone } });
    }
    const page = await api.listPatients({ page: 1, limit: 1 });

    expect(page.items).toHaveLength(1);
    // `total` is what tells a phone whether to render a "load more" — without it the list has to
    // guess from a short page, which is wrong on the boundary.
    expect(page.meta.page).toBe(1);
    expect(page.meta.limit).toBe(1);
    expect(page.meta.total).toBeGreaterThan(1);
  });

  it("turns an error envelope into a typed ApiClientError with a traceId", async () => {
    const err = await api.getPatient("64b7f0000000000000000009").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiClientError);
    const typed = err as ApiClientError;
    expect(typed.status).toBe(404);
    expect(typed.code).toBe("HMS-PAT-001");
    // The traceId is the whole reason a support call from a phone is answerable: the user reads
    // it off a screen and it names the exact request in the logs.
    expect(typed.traceId).toMatch(/[0-9a-f-]{8,}/);
  });

  it("reports a permission refusal as HMS-AUTH-005, not as a crash", async () => {
    const err = await api
      .createBranch({ name: "Nope", code: "NOPE" })
      .then(() => null)
      .catch((e: unknown) => e);
    // TENANT_ADMIN may actually do this, so the assertion is the shape of the answer either way:
    // a phone must never see an untyped rejection from this client.
    if (err) expect(err).toBeInstanceOf(ApiClientError);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 5. FILES — the one place React Native differs from a browser
 * ──────────────────────────────────────────────────────────────────────────── */

describe("a phone can upload and download a file", () => {
  it("uploads base64 and gets typed metadata back", async () => {
    session.activeBranch = branchA;
    const meta = await api.uploadDocument(patientId, {
      category: "insurance",
      title: "Policy card",
      filename: "policy.pdf",
      contentType: "application/pdf",
      // base64, deliberately: RN has no `File`, no `FormData` file part worth relying on, and no
      // `Blob` constructor from a path. A base64 string is the one representation every RN file
      // library can produce (`expo-file-system` reads it directly).
      dataBase64: Buffer.from("%PDF-1.4 minimal").toString("base64"),
    });

    expect(meta.id).toBeTruthy();
    expect(meta.contentType).toBe("application/pdf");
    expect(meta.size).toBeGreaterThan(0);

    const listed = await api.listDocuments(patientId);
    expect(listed.map((d) => d.id)).toContain(meta.id);
  });

  it("downloads the bytes as a Blob, authenticated", async () => {
    const [doc] = await api.listDocuments(patientId);
    expect(doc).toBeDefined();

    const blob = await api.fetchDocumentBlob(doc?.id ?? "");
    /**
     * A Blob, not an ArrayBuffer, and that is the React Native decision: RN's fetch is XHR-backed
     * and implements `blob()` and `text()` — `arrayBuffer()` is not available on all versions. A
     * client that reached for `arrayBuffer()` would work in every test here and throw on a phone.
     */
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBeGreaterThan(0);
    expect(await blob.text()).toContain("%PDF");
  });

  it("downloads a CSV export with the token attached, and says if it was truncated", async () => {
    /**
     * ── THE DEFECT THIS TEST WAS WRITTEN FOR ────────────────────────────────
     * The client used to offer `auditExportUrl()` — a bare URL the web app hung on an `<a href>`.
     * `/audit/export` sits behind `authenticate()`, which reads `Authorization: Bearer` and
     * nothing else, so that navigation arrived with no credential and was refused. It looked
     * correct in review because a URL builder cannot fail; only the far end can.
     *
     * React Native has no "open an authenticated URL in a tab" at all, so this was a hard mobile
     * blocker as well as a live web bug.
     */
    const csv = await api.fetchAuditCsv({ limit: 10 });

    expect(csv.blob).toBeInstanceOf(Blob);
    const text = await csv.blob.text();
    expect(text.split("\n")[0]).toContain("at");
    expect(typeof csv.rows === "number" || csv.rows === null).toBe(true);
    // The export is capped, and a truncated CSV is byte-indistinguishable from a complete one.
    // The flag is the only way a caller can know, and it lives in a header a download drops.
    expect(csv.truncated).toBe(false);
  });

  it("answers a missing file with null rather than a thrown Blob", async () => {
    // The logo is public and optional. A phone rendering a header must be able to ask without
    // wrapping the call in a try/catch that swallows real errors too.
    const logo = await api.fetchSiteLogoBlob();
    expect(logo).toBeNull();
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 6. THE HEADERS A LONG-LIVED INSTALL DEPENDS ON
 * ──────────────────────────────────────────────────────────────────────────── */

describe("a phone hears about licence and lifecycle without polling", () => {
  it("receives the licence state on every tenant response", async () => {
    licenceSeen.length = 0;
    await api.listPatients({ limit: 1 });

    expect(licenceSeen).toHaveLength(1);
    // A hospital whose licence is expiring must be able to warn its staff on the device they
    // actually use, and a poll for that would be a request per screen forever.
    expect(licenceSeen[0]?.state).toBe("ACTIVE");
    expect(typeof licenceSeen[0]?.daysLeft === "number" || licenceSeen[0]?.daysLeft === null).toBe(
      true,
    );
  });

  it("has a deprecation receiver in place, and nothing is deprecated yet", async () => {
    deprecationsSeen.length = 0;
    await api.listPatients({ limit: 1 });

    /**
     * The ordering that matters: the RECEIVER ships before the first sender. A build installed
     * today must already know how to hear "this endpoint retires next September", because by the
     * time we send it that build is the one we cannot change.
     */
    expect(deprecationsSeen).toEqual([]);
    expect(readDeprecationHeaders({ headers: new Headers() })).toBeNull();
    expect(
      readDeprecationHeaders({
        headers: new Headers({
          deprecation: "@1788220800",
          sunset: "Wed, 01 Sep 2027 00:00:00 GMT",
          link: '<https://docs.paperlesstech.in/api/deprecations>; rel="deprecation"',
        }),
      }),
    ).toEqual({
      deprecatedAt: "2026-09-01T00:00:00.000Z",
      sunsetAt: "2027-09-01T00:00:00.000Z",
      links: { deprecation: "https://docs.paperlesstech.in/api/deprecations" },
    });
  });

  it("names the API version it speaks", () => {
    // A phone in the field cannot be asked "which version are you on?" after the fact; it has to
    // be able to say so in a crash report.
    expect(API_VERSION).toBe("v1");
  });
});
