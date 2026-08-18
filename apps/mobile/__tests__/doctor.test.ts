/**
 * THE DOCTOR'S READ PATH, END TO END — the real client, the real cache, a fake wire.
 *
 * ── WHAT IS REAL HERE ───────────────────────────────────────────────────────
 * The shipped `@medicore/api-client`, the real `createRuntime` wiring, the real stores and branch
 * controller, the real `QueryClient` with the app's own retry policy, and the real query
 * descriptors from `src/query/clinical.ts`. Substituted: the network and the Keychain — the two
 * edges a phone owns and a CI box does not.
 *
 * That boundary is what makes these tests worth writing. Mocking `ApiClient` would prove the app
 * calls methods that exist. Mocking `fetch` proves the app and the client together produce the
 * right REQUESTS — the right query string, the right `X-Active-Branch` — and survive the real
 * RESPONSES, including the envelope, the error codes and the paging metadata.
 *
 * `queryClient.fetchQuery` is used rather than a renderer: the descriptors are plain objects, so
 * the cache behaviour under a branch switch is testable without React at all.
 */
import { describe, expect, it } from "vitest";
import type { QueryClient } from "@tanstack/query-core";
import { BRANCH_CHN, BRANCH_HYD, PASSWORD, SLUG, USER, createHarness } from "./support/harness";
import { fail, ok, okPaged } from "./support/fakeApi";
import { criticalOrder, encounter, order, page, patient, vitals } from "./support/fixtures";
import { clinicalQueries, type InfiniteRead } from "../src/query/clinical";
import { scopeFor } from "../src/query/scope";
import { queryKeys, AGGREGATE } from "../src/query/keys";
import { isFeatureUnavailable, toUserMessage } from "../src/lib/net/errors";
import type { MobileRuntime } from "../src/lib/runtime";
import type { Paged } from "@medicore/api-client";

const ENCOUNTERS = "/api/v1/encounters";
const ORDERS = "/api/v1/orders";
const INPATIENTS = "/api/v1/inpatients";

/** The scope the app would build right now — the SAME derivation `useClinical` uses. */
function scopeOf(runtime: MobileRuntime) {
  const branch = runtime.branch.getState();
  return scopeFor(runtime.profile.slug, {
    validated: branch.validated,
    ...(branch.activeBranchId ? { activeBranchId: branch.activeBranchId } : {}),
  });
}

function queriesOf(runtime: MobileRuntime) {
  return clinicalQueries(runtime.api, scopeOf(runtime));
}

/**
 * Fetch the FIRST page of an infinite read, and hand back the page itself.
 *
 * `fetchQuery` would also "work" on an infinite descriptor — the extra fields are ignored — but it
 * calls `queryFn` with no `pageParam`, so the request goes out with no `page` at all and the test
 * quietly stops exercising pagination. `fetchInfiniteQuery` is what the screen uses, so it is what
 * these tests use.
 */
async function firstPage<T>(
  runtime: MobileRuntime,
  read: InfiniteRead<T>,
): Promise<{ items: T[]; meta: Paged<T>["meta"] }> {
  const result = await runtime.queryClient.fetchInfiniteQuery(read);
  const first = result.pages[0];
  if (!first) throw new Error("fetchInfiniteQuery resolved with no pages");
  return first;
}

/** A signed-in doctor at Hyderabad, with Chennai also reachable so a switch is possible. */
async function signedIn(options: { branches?: unknown[]; permissions?: string[] } = {}) {
  const h = createHarness();
  h.happyPath({
    branches: options.branches ?? [BRANCH_HYD, BRANCH_CHN],
    canAggregate: true,
    ...(options.permissions ? { permissions: options.permissions } : {}),
  });
  await h.runtime.auth.signIn(USER.email, PASSWORD, "device");
  await h.runtime.branches.select(USER.id, BRANCH_HYD.id);
  return h;
}

/** The last query string the fake transport saw for a path — the assertion surface for filters. */
function lastQuery(h: Awaited<ReturnType<typeof signedIn>>, path: string): URLSearchParams {
  const calls = h.api.calls.filter((c) => c.path === path);
  const last = calls.at(-1);
  return new URLSearchParams(last?.search ?? "");
}

/* ════════════════════════════════════════════════════════════════════════════
 * 2 · 3 · 4 — MY PATIENTS: loads, empty, pages
 * ══════════════════════════════════════════════════════════════════════════ */

describe("2. My patients loads the doctor's own list", () => {
  it("asks the SERVER to filter by doctor, and never filters for access on the phone", async () => {
    /**
     * The web app once fetched the whole queue and narrowed it in the browser, with a fallback
     * that showed every UNASSIGNED patient to every doctor — two consultants each believed the
     * same person was theirs. `doctorId` on the request means the wrong rows never leave the
     * database.
     */
    const h = await signedIn();
    h.api.on("GET", ENCOUNTERS, () => okPaged(page([encounter()])));

    const result = await firstPage(
      h.runtime,
      queriesOf(h.runtime).myPatients({ doctorId: USER.id, date: "2026-08-12" }),
    );

    expect(result.items).toHaveLength(1);
    const query = lastQuery(h, ENCOUNTERS);
    expect(query.get("doctorId")).toBe(USER.id);
    expect(query.get("date")).toBe("2026-08-12");
    expect(query.get("limit")).toBe("20");
    // The first page is asked for explicitly. An omitted `page` would mean this test was driving
    // the descriptor as a plain query and never exercising pagination at all.
    expect(query.get("page")).toBe("1");
  });

  it("passes the status and queued filters through to the server too", async () => {
    const h = await signedIn();
    h.api.on("GET", ENCOUNTERS, () => okPaged(page([])));

    await firstPage(
      h.runtime,
      queriesOf(h.runtime).myPatients({ doctorId: USER.id, queued: true }),
    );
    expect(lastQuery(h, ENCOUNTERS).get("queued")).toBe("true");

    await firstPage(
      h.runtime,
      queriesOf(h.runtime).myPatients({ doctorId: USER.id, status: "awaiting_results" }),
    );
    expect(lastQuery(h, ENCOUNTERS).get("status")).toBe("awaiting_results");
  });

  it("sends the branch header the app decided on, on the very same request", async () => {
    const h = await signedIn();
    h.api.on("GET", ENCOUNTERS, () => okPaged(page([encounter()])));

    await firstPage(h.runtime, queriesOf(h.runtime).myPatients({ doctorId: USER.id }));

    const call = h.api.callsTo("GET", ENCOUNTERS).at(-1);
    expect(call?.headers["x-active-branch"]).toBe(BRANCH_HYD.id);
  });
});

describe("3. an empty list is a fact, not a failure", () => {
  it("resolves to zero items with no error", async () => {
    const h = await signedIn();
    h.api.on("GET", ENCOUNTERS, () => okPaged(page([])));

    const result = await firstPage(
      h.runtime,
      queriesOf(h.runtime).myPatients({ doctorId: USER.id }),
    );

    expect(result.items).toEqual([]);
    expect(result.meta.total).toBe(0);
    // The screen distinguishes this from a failure by asking the query, not by testing `length` on
    // something that may never have loaded — see `QueryGate`.
    expect(result.meta.hasMore).toBe(false);
  });
});

describe("4. the list pages", () => {
  it("asks for page 2 only when the server said there was one", async () => {
    const h = await signedIn();
    const first = page([encounter({ id: "e1", token: 1 })], { page: 1, total: 2, hasMore: true });
    const second = page([encounter({ id: "e2", token: 2 })], { page: 2, total: 2, hasMore: false });

    h.api.on("GET", ENCOUNTERS, (call) =>
      okPaged(new URLSearchParams(call.search).get("page") === "2" ? second : first),
    );

    const read = queriesOf(h.runtime).myPatients({ doctorId: USER.id });
    const result = await h.runtime.queryClient.fetchInfiniteQuery({ ...read, pages: 2 });

    expect(result.pages.map((p) => p.items[0]?.id)).toEqual(["e1", "e2"]);
    expect(read.getNextPageParam(first)).toBe(2);
    // The last page ends it. A `getNextPageParam` that kept returning a number would page forever.
    expect(read.getNextPageParam(second)).toBeUndefined();
  });

  it("stops when a short page arrives and the server sent no hasMore", async () => {
    // Older responses omit `hasMore`. A short page is then the only end-of-list signal there is.
    const read = queriesOf((await signedIn()).runtime).myPatients({ doctorId: USER.id });
    expect(
      read.getNextPageParam(page([encounter()], { hasMore: undefined, total: undefined })),
    ).toBeUndefined();
    const full = page(
      Array.from({ length: 20 }, (_, i) => encounter({ id: `e${String(i)}` })),
      {
        hasMore: undefined,
        total: undefined,
      },
    );
    expect(read.getNextPageParam(full)).toBe(2);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 5 · 6 — THE BRANCH IS IN THE KEY, AND A SWITCH LEAVES NOTHING BEHIND
 * ══════════════════════════════════════════════════════════════════════════ */

describe("5. every branch-sensitive key carries the branch, and matches the header", () => {
  /**
   * ── EXHAUSTIVE, BECAUSE A HAND-MAINTAINED LIST GOES STALE (M3-S6) ───────────
   * This started as a list of reads and was extended twice, each time AFTER a falsification run
   * found it missing the newest feature: M3-S5A added the nurse's keys, and by M3-S5B the round's
   * key was already absent again. A list that has to be remembered will be forgotten, and the
   * symptom — the previous site's patients rendering for a frame after a switch — is a clinical
   * error rather than a rendering glitch.
   *
   * So the check now walks `queryKeys` ITSELF. Every exported key must be classified below; a key
   * added without a classification fails `covers every key` and there is nowhere to add it that
   * does not also state which side of the branch boundary it sits on.
   */
  /**
   * `notifications` joined this list at M4 and was branch-scoped before it. That was safe only
   * because nothing read it: an inbox is addressed to a PERSON, so keying it per branch would
   * drop a doctor's unread badge to zero the moment they switched sites — which looks exactly
   * like "nothing needs you".
   */
  const HOSPITAL_WIDE = ["me", "myBranches", "patientAllergies", "notifications"] as const;

  /** How to call each key with placeholder arguments. The MAP is what must stay complete. */
  function invoke(scope: {
    tenantSlug: string;
    branchId?: string;
  }): Record<string, readonly unknown[]> {
    const t = scope.tenantSlug;
    return {
      // Hospital-wide, deliberately — see `keys.ts` for each reason.
      me: queryKeys.me(t),
      myBranches: queryKeys.myBranches(t),
      patientAllergies: queryKeys.patientAllergies(t, "p1"),
      // An inbox is addressed to a person, not a site: branch-scoping it would empty the badge
      // on every switch. Moved here from the branch-scoped group when M4 gave it a real reader.
      notifications: queryKeys.notifications(t),

      // Branch-scoped: everything clinical or operational.
      patients: queryKeys.patients(scope),
      patient: queryKeys.patient(scope, "p1"),
      encounters: queryKeys.encounters(scope),
      encounter: queryKeys.encounter(scope, "e1"),
      orders: queryKeys.orders(scope),
      order: queryKeys.order(scope, "o1"),
      inpatients: queryKeys.inpatients(scope),
      encounterVitals: queryKeys.encounterVitals(scope, "e1"),
      patientVitals: queryKeys.patientVitals(scope, "p1"),
      consultation: queryKeys.consultation(scope, "e1"),
      prescription: queryKeys.prescription(scope, "rx1"),
      prescriptions: queryKeys.prescriptions(scope),
      catalogue: queryKeys.catalogue(scope),
      episodeTimeline: queryKeys.episodeTimeline(scope, "ep1"),
      bedBoard: queryKeys.bedBoard(scope),
      wardNotes: queryKeys.wardNotes(scope, "e1"),
      medications: queryKeys.medications(scope, "e1"),
      wardWorklist: queryKeys.wardWorklist(scope),
      medicationSchedule: queryKeys.medicationSchedule(scope, "e1"),
      medicationRound: queryKeys.medicationRound(scope),
    };
  }

  it("covers every key in queryKeys, so a new one cannot skip this check", async () => {
    const h = await signedIn();
    expect(Object.keys(invoke(scopeOf(h.runtime))).sort()).toEqual(Object.keys(queryKeys).sort());
  });

  it("prefixes tenant and branch on every key that is not hospital-wide", async () => {
    const h = await signedIn();
    const scope = scopeOf(h.runtime);
    expect(scope.branchId).toBe(BRANCH_HYD.id);

    for (const [name, key] of Object.entries(invoke(scope))) {
      if ((HOSPITAL_WIDE as readonly string[]).includes(name)) continue;
      expect(key.slice(0, 2), `${name} is missing the [tenant, branch] prefix`).toEqual([
        SLUG,
        BRANCH_HYD.id,
      ]);
    }
  });

  /**
   * The other direction, and it matters just as much: a branch on the allergy key would re-fetch
   * the same rows at every site and claim a distinction the server does not make. An allergy that
   * does not follow the patient can kill them (ADR-0015 §5).
   */
  it("keeps the branch OUT of every hospital-wide key", async () => {
    const h = await signedIn();
    const keys = invoke(scopeOf(h.runtime));

    for (const name of HOSPITAL_WIDE) {
      expect(keys[name], `${name} leaked a branch id`).not.toContain(BRANCH_HYD.id);
      expect(keys[name]?.[0]).toBe(SLUG);
    }
  });

  it("prefixes tenant and branch on every shipped read descriptor", async () => {
    const h = await signedIn();
    const q = queriesOf(h.runtime);

    const reads: readonly (readonly unknown[])[] = [
      q.myPatients({ doctorId: USER.id }).queryKey,
      q.roundToday({ doctorId: USER.id }).queryKey,
      q.patientEncounters("p1").queryKey,
      q.encounter("e1").queryKey,
      q.episodeTimeline("ep1").queryKey,
      q.inpatients().queryKey,
      q.patient("p1").queryKey,
      q.encounterVitals("e1").queryKey,
      q.patientVitals("p1").queryKey,
      q.consultation("e1").queryKey,
      q.patientOrders("p1").queryKey,
      q.orders().queryKey,
      q.outstandingResults().queryKey,
      q.order("o1").queryKey,
      q.prescriptions("p1").queryKey,
      q.bedBoard().queryKey,
      q.wardNotes("e1").queryKey,
      q.medications("e1").queryKey,
      q.medicationSchedule("e1").queryKey,
      q.wardWorklist().queryKey,
      q.medicationRound({ date: "2026-06-11" }).queryKey,
    ];

    for (const key of reads) {
      expect(key.slice(0, 2)).toEqual([SLUG, BRANCH_HYD.id]);
    }
  });

  it("gives no two key FAMILIES the same key, at their emptiest arguments", async () => {
    /**
     * ── THE COLLISION THAT WOULD NOT LOOK LIKE ONE ─────────────────────────────
     * `encounters(scope)` — the unfiltered list — is `[…, "encounters", ""]`. A detail key built as
     * `[…, "encounters", id]` is byte-identical to it whenever the id is `""`, which is what a
     * screen holds while a route param resolves and what a chart opened with no visit in context
     * holds forever. The disabled detail query would then observe the LIST's cache entry and hand
     * the screen a `Paged<Encounter>` typed as an `Encounter`: no error, no failed request, just a
     * chart rendering fields that are not there.
     *
     * Asserted against `queryKeys` rather than against the descriptors, deliberately. The
     * descriptors happen to pass a non-empty filter string today, so they would hide the collision
     * — and the next feature to call `queryKeys.encounters(scope)` with no filters, exactly as the
     * signature invites, would find it. Lists are plural and records singular so it cannot arise.
     */
    const h = await signedIn();
    const scope = scopeOf(h.runtime);

    const families: readonly (readonly unknown[])[] = [
      queryKeys.patients(scope),
      queryKeys.patient(scope, ""),
      queryKeys.encounters(scope),
      queryKeys.encounter(scope, ""),
      queryKeys.orders(scope),
      queryKeys.order(scope, ""),
      queryKeys.prescriptions(scope),
      queryKeys.prescription(scope, ""),
      queryKeys.catalogue(scope),
      queryKeys.catalogue(scope, "pharmacy"),
      queryKeys.inpatients(scope),
      queryKeys.notifications(SLUG),
      queryKeys.encounterVitals(scope, ""),
      queryKeys.patientVitals(scope, ""),
      queryKeys.consultation(scope, ""),
      queryKeys.episodeTimeline(scope, ""),
      queryKeys.patientAllergies(SLUG, ""),
    ];

    const serialised = families.map((key) => JSON.stringify(key));
    expect(new Set(serialised).size, `colliding keys: ${serialised.join(" | ")}`).toBe(
      families.length,
    );
  });

  it("keeps the shipped descriptors distinct too, at their emptiest arguments", async () => {
    const h = await signedIn();
    const q = queriesOf(h.runtime);

    const keys = [
      q.myPatients({ doctorId: "" }).queryKey,
      q.roundToday({ doctorId: "" }).queryKey,
      q.patientEncounters("").queryKey,
      q.encounter("").queryKey,
      q.episodeTimeline("").queryKey,
      q.inpatients().queryKey,
      q.patient("").queryKey,
      q.allergies("").queryKey,
      q.encounterVitals("").queryKey,
      q.patientVitals("").queryKey,
      q.consultation("").queryKey,
      q.patientOrders("").queryKey,
      q.orders().queryKey,
      q.outstandingResults().queryKey,
      q.order("").queryKey,
      q.prescriptions("").queryKey,
      q.prescription("").queryKey,
      q.catalogue().queryKey,
      q.catalogue("pharmacy").queryKey,
    ].map((key) => JSON.stringify(key));

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keys aggregate mode with a stable sentinel, never a hole", async () => {
    const h = await signedIn();
    await h.runtime.branches.select(USER.id, undefined);

    const key = queriesOf(h.runtime).myPatients({ doctorId: USER.id }).queryKey;
    expect(key.slice(0, 2)).toEqual([SLUG, AGGREGATE]);
    // …and the client genuinely sends no header, which is what makes the key honest.
    h.api.on("GET", ENCOUNTERS, () => okPaged(page([])));
    await firstPage(h.runtime, queriesOf(h.runtime).myPatients({ doctorId: USER.id }));
    expect(h.api.callsTo("GET", ENCOUNTERS).at(-1)?.headers["x-active-branch"]).toBeUndefined();
  });

  it("keys nothing to a branch before /me/branches has been read", async () => {
    /**
     * The window that matters: a remembered branch exists in preferences but has not been
     * re-validated. The client sends no header, so the server aggregates — and the key must say
     * `all` or an aggregate answer gets filed under a branch's name.
     */
    const h = createHarness();
    expect(
      scopeFor(SLUG, { validated: false, activeBranchId: BRANCH_CHN.id }).branchId,
    ).toBeUndefined();
    expect(h.runtime.branch.getState().validated).toBe(false);
  });

  it("keeps the allergy list OUT of the branch scope, because the server reads it hospital-wide", async () => {
    // The allergy routes are tenant-scoped and `scopeFilter` deliberately does not narrow them.
    // A branch prefix would claim a distinction the server does not make.
    const h = await signedIn();
    const key = queriesOf(h.runtime).allergies("p1").queryKey;
    expect(key).toEqual(queryKeys.patientAllergies(SLUG, "p1"));
    expect(key).not.toContain(BRANCH_HYD.id);
  });
});

describe("6. switching branch drops the other site's data entirely", () => {
  it("clears the cache and re-reads under a new key", async () => {
    const h = await signedIn();
    h.api.on("GET", ENCOUNTERS, (call) =>
      okPaged(
        page([
          encounter({
            id: call.headers["x-active-branch"] === BRANCH_CHN.id ? "chn-1" : "hyd-1",
            branchId: call.headers["x-active-branch"] ?? "",
          }),
        ]),
      ),
    );

    const hydRead = queriesOf(h.runtime).myPatients({ doctorId: USER.id });
    const inHyderabad = await firstPage(h.runtime, hydRead);
    expect(inHyderabad.items[0]?.id).toBe("hyd-1");
    expect(cached(h.runtime.queryClient, hydRead.queryKey)).toBeDefined();

    await h.runtime.branches.select(USER.id, BRANCH_CHN.id);

    /**
     * The strong claim: the previous site's answer is GONE, not merely stale. Showing Hyderabad's
     * list for one frame after switching to Chennai is a clinical error, not a rendering glitch —
     * so `onBranchChanged` clears the whole cache rather than reasoning about which keys are safe.
     */
    expect(cached(h.runtime.queryClient, hydRead.queryKey)).toBeUndefined();

    const chnRead = queriesOf(h.runtime).myPatients({ doctorId: USER.id });
    expect(chnRead.queryKey).not.toEqual(hydRead.queryKey);

    const inChennai = await firstPage(h.runtime, chnRead);
    expect(inChennai.items[0]?.id).toBe("chn-1");
    expect(h.api.callsTo("GET", ENCOUNTERS).at(-1)?.headers["x-active-branch"]).toBe(BRANCH_CHN.id);
  });

  it("cannot serve one branch's answer under the other's key even if the cache survived", async () => {
    /**
     * A second, independent guarantee. Suppose `queryClient.clear()` were removed tomorrow: the
     * keys THEMSELVES still differ, so the two answers cannot collide. Both belts are asserted
     * because either one alone is a single point of failure for the same clinical error.
     */
    const h = await signedIn();
    const hyd = queriesOf(h.runtime).myPatients({ doctorId: USER.id }).queryKey;
    await h.runtime.branches.select(USER.id, BRANCH_CHN.id);
    const chn = queriesOf(h.runtime).myPatients({ doctorId: USER.id }).queryKey;

    expect(hyd[1]).toBe(BRANCH_HYD.id);
    expect(chn[1]).toBe(BRANCH_CHN.id);
    expect(hyd.slice(2)).toEqual(chn.slice(2));
  });
});

function cached(client: QueryClient, key: readonly unknown[]): unknown {
  return client.getQueryData(key as unknown[]);
}

/* ════════════════════════════════════════════════════════════════════════════
 * 8 · 9 · 10 — VITALS AND RESULTS OVER THE WIRE
 * ══════════════════════════════════════════════════════════════════════════ */

describe("8. vitals come back parsed, with the server's own flags", () => {
  it("reads the visit chart and the patient trend from their own endpoints", async () => {
    const h = await signedIn();
    h.api.on("GET", "/api/v1/encounters/encounter-1/vitals", () => ok([vitals()]));
    h.api.on("GET", "/api/v1/patients/patient-1/vitals", () =>
      ok([vitals({ id: "v-2", recordedAt: "2026-08-01T04:00:00.000Z" })]),
    );

    const q = queriesOf(h.runtime);
    const visit = await h.runtime.queryClient.fetchQuery(q.encounterVitals("encounter-1"));
    const trend = await h.runtime.queryClient.fetchQuery(q.patientVitals("patient-1"));

    expect(visit[0]?.flags.systolic).toBe("high");
    expect(visit[0]?.abnormal).toBe(true);
    expect(trend[0]?.id).toBe("v-2");
    // The trend is asked for with a bound, so a chronic patient's chart is not unbounded.
    expect(new URLSearchParams(h.api.calls.at(-1)?.search ?? "").get("limit")).toBe("20");
  });
});

describe("9 · 10. results arrive with the release state and the critical flag intact", () => {
  it("carries `critical` and the per-value flag through the envelope", async () => {
    const h = await signedIn();
    h.api.on("GET", "/api/v1/orders/order-critical", () => ok(criticalOrder()));

    const result = await h.runtime.queryClient.fetchQuery(
      queriesOf(h.runtime).order("order-critical"),
    );

    expect(result.result?.critical).toBe(true);
    expect(result.result?.values?.[0]?.flag).toBe("critical_high");
    expect(result.status).toBe("released");
  });

  it("asks the server for what is outstanding rather than counting a page", async () => {
    const h = await signedIn();
    h.api.on("GET", ORDERS, () => okPaged(page([order()], { total: 37, limit: 1, hasMore: true })));

    const result = await h.runtime.queryClient.fetchQuery(
      queriesOf(h.runtime).outstandingResults(),
    );

    const query = lastQuery(h, ORDERS);
    expect(query.get("outstanding")).toBe("true");
    // One row over the wire, for a number. Paging twenty orders to render a count would be twenty
    // rows of PHI for nothing.
    expect(query.get("limit")).toBe("1");
    expect(result.meta.total).toBe(37);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 12 · 13 · 14 — FAILURES: the wire, the edition, and the wall
 * ══════════════════════════════════════════════════════════════════════════ */

describe("12. an API failure reaches the screen as something a clinician can read", () => {
  it("maps a 404 to 'may belong to another branch', with a traceId and no server prose", async () => {
    const h = await signedIn();
    h.api.on("GET", "/api/v1/patients/ghost", () =>
      fail(404, "HMS-GEN-404", "Patient 64f... not found in tenant apollo"),
    );

    const error = await h.runtime.queryClient
      .fetchQuery(queriesOf(h.runtime).patient("ghost"))
      .then(() => undefined)
      .catch((e: unknown) => e);

    const shown = toUserMessage(error);
    expect(shown.title).toBe("Not found");
    expect(shown.body).toContain("another branch");
    expect(shown.traceId).toBe("trace-test");
    // The developer-facing message never reaches a ward display, and neither does the id it quotes.
    expect(JSON.stringify(shown)).not.toContain("64f");
  });

  it("calls a dropped connection what it is, rather than an API error", async () => {
    const h = await signedIn();
    h.api.goOffline();

    const error = await h.runtime.queryClient
      .fetchQuery({ ...queriesOf(h.runtime).patient("p1"), retry: false })
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(toUserMessage(error).title).toBe("No connection");
  });
});

describe("13. the inpatient entry point is gated by the server's own refusal", () => {
  it("reads HMS-PLAN-002 as 'this hospital has no wards' and hides the card", async () => {
    /**
     * No clinician may read `/subscription` — it needs `subscription:manage`, an administrator's
     * permission. So the app cannot look up the feature list and must not pretend to: it asks for
     * the ward and believes the answer.
     */
    const h = await signedIn();
    h.api.on("GET", INPATIENTS, () => fail(403, "HMS-PLAN-002", "Feature not in your edition"));

    const error = await firstPage(h.runtime, queriesOf(h.runtime).inpatients())
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(isFeatureUnavailable(error)).toBe(true);
    expect(toUserMessage(error).title).toBe("Not included in this edition");
  });

  it("does NOT treat an ordinary permission refusal as a missing module", async () => {
    /**
     * The distinction is the whole point of two codes. "Not in your edition" means hide it — no
     * amount of role editing will help. "Insufficient permission" means the screen is right for
     * somebody else at this hospital, so it is reported rather than made to disappear.
     */
    const h = await signedIn();
    h.api.on("GET", INPATIENTS, () => fail(403, "HMS-AUTH-005", "Insufficient permission"));

    const error = await firstPage(h.runtime, queriesOf(h.runtime).inpatients())
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(isFeatureUnavailable(error)).toBe(false);
    expect(toUserMessage(error).title).toBe("You do not have access");
  });

  it("shows the ward when the hospital has one", async () => {
    const h = await signedIn();
    h.api.on("GET", INPATIENTS, () =>
      okPaged(
        page([
          encounter({
            id: "ip-1",
            class: "IP",
            status: "admitted",
            admittedAt: "2026-08-10T06:00:00.000Z",
            bed: { ward: "General Ward", bedCode: "A-12", tariffCode: "BED_GEN" },
          }),
        ]),
      ),
    );

    const first = await firstPage(h.runtime, queriesOf(h.runtime).inpatients());
    expect(first.items[0]?.bed?.bedCode).toBe("A-12");
    expect(first.items[0]?.class).toBe("IP");
    // Paged like every other list: the page is asked for explicitly, and `total` comes back.
    expect(h.api.callsTo("GET", INPATIENTS)[0]?.search).toContain("page=1");
    expect(first.meta.total).toBe(1);
  });
});

describe("14. a forbidden read is explained, never bounced to the login screen", () => {
  it("keeps the session alive on a 403 and asks no one to sign in again", async () => {
    const h = await signedIn();
    h.api.on("GET", ORDERS, () => fail(403, "HMS-AUTH-005", "Insufficient permission"));

    const error = await h.runtime.queryClient
      .fetchQuery(queriesOf(h.runtime).outstandingResults())
      .then(() => undefined)
      .catch((e: unknown) => e);

    const shown = toUserMessage(error);
    expect(shown.title).toBe("You do not have access");
    expect(shown.action).toBe("contactAdmin");
    // The session is untouched. A 403 is not a 401, and conflating them logs a doctor out of a
    // ward round because they tapped something their role does not include.
    expect(h.runtime.session.getState().status).toBe("signedIn");
    expect(h.sessionEndings).toEqual([]);
    expect(h.api.callsTo("POST", "/api/v1/auth/refresh")).toHaveLength(0);
  });

  it("retries nothing on a refusal — a 4xx does not become a 2xx by asking again", async () => {
    const h = await signedIn();
    let attempts = 0;
    h.api.on("GET", ORDERS, () => {
      attempts += 1;
      return fail(403, "HMS-AUTH-005", "Insufficient permission");
    });

    await h.runtime.queryClient
      .fetchQuery(queriesOf(h.runtime).outstandingResults())
      .catch(() => undefined);

    expect(attempts).toBe(1);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * The patient identity lookup — the one place the encounter contract falls short
 * ══════════════════════════════════════════════════════════════════════════ */

describe("a row's identity is fetched per patient and cached across screens", () => {
  it("reads each patient once, however many screens ask", async () => {
    /**
     * `GET /encounters` carries `patientId` and no name (encounter.contract.ts). The list row and
     * the chart therefore share ONE cache entry per patient rather than each pulling their own —
     * which is what keeps a twenty-row round to twenty requests instead of forty.
     */
    const h = await signedIn();
    h.api.on("GET", "/api/v1/patients/patient-1", () => ok(patient()));

    const read = queriesOf(h.runtime).patient("patient-1");
    await h.runtime.queryClient.fetchQuery({ ...read, staleTime: 60_000 });
    await h.runtime.queryClient.fetchQuery({ ...read, staleTime: 60_000 });

    expect(h.api.callsTo("GET", "/api/v1/patients/patient-1")).toHaveLength(1);
    expect(cached(h.runtime.queryClient, read.queryKey)).toMatchObject({ uhid: "APL000123" });
  });
});
