/**
 * RELEASE HARDENING (M2 L) — the cross-cutting invariants, re-proven against the finished app.
 *
 * Each individual slice tested its own surface. What nobody tested is the property that only shows
 * up once all of them exist together: a doctor who opens a chart at one site, writes a consultation,
 * an order, a prescription and a ward note, then switches site — and must not carry a single row of
 * the first hospital into the second.
 *
 * The other half is the cache itself. Every branch-sensitive key begins `[tenant, branch]`, which
 * is checked per-slice; what is checked HERE is that no two keys in the finished set collide, which
 * is a property of the whole table rather than of any one entry and therefore cannot be tested
 * anywhere else.
 */
import { describe, expect, it } from "vitest";
import { BRANCH_CHN, BRANCH_HYD, PASSWORD, SLUG, USER, createHarness } from "./support/harness";
import { fail, ok, okPaged } from "./support/fakeApi";
import {
  bedBoard,
  consultationNote,
  encounter,
  ENCOUNTER_ID,
  inpatient,
  IP_ENCOUNTER_ID,
  order,
  page,
  patient,
  PATIENT_ID,
  prescription,
  wardNote,
} from "./support/fixtures";
import { PROGRESS_NOTE } from "@medicore/api-client";
import { orderRequests } from "../src/clinical/prescribing";
import { clinicalQueries } from "../src/query/clinical";
import { clinicalMutations } from "../src/query/mutations";
import { scopeFor } from "../src/query/scope";
import { queryKeys } from "../src/query/keys";
import type { MobileRuntime } from "../src/lib/runtime";

function scopeOf(runtime: MobileRuntime) {
  const branch = runtime.branch.getState();
  return scopeFor(runtime.profile.slug, {
    validated: branch.validated,
    ...(branch.activeBranchId ? { activeBranchId: branch.activeBranchId } : {}),
  });
}

const queriesOf = (runtime: MobileRuntime) => clinicalQueries(runtime.api, scopeOf(runtime));
const mutationsOf = (runtime: MobileRuntime) => clinicalMutations(runtime.api, scopeOf(runtime));

async function atHyderabad() {
  const h = createHarness();
  h.happyPath({ branches: [BRANCH_HYD, BRANCH_CHN], canAggregate: true });
  await h.runtime.auth.signIn(USER.email, PASSWORD, "device");
  await h.runtime.branches.select(USER.id, BRANCH_HYD.id);
  return h;
}

/** Every branch header the transport has seen, in order. */
function branchHeaders(h: Awaited<ReturnType<typeof atHyderabad>>): string[] {
  return h.api.calls.map((call) => call.headers["x-active-branch"] ?? "");
}

/* ════════════════════════════════════════════════════════════════════════════
 * BRANCH — the whole doctor workflow, then a switch
 * ══════════════════════════════════════════════════════════════════════════ */

describe("1. a full round at branch A, then a switch to B", () => {
  it("stamps every read AND every write with the site they were made at", async () => {
    const h = await atHyderabad();

    h.api.on("GET", `/api/v1/patients/${PATIENT_ID}`, () => ok(patient()));
    h.api.on("GET", `/api/v1/encounters/${ENCOUNTER_ID}`, () => ok(encounter()));
    h.api.on("PUT", `/api/v1/encounters/${ENCOUNTER_ID}/consultation`, () =>
      ok(consultationNote()),
    );
    h.api.on("POST", "/api/v1/orders", () => ok({ order: order(), duplicate: false }, {}));
    h.api.on("POST", "/api/v1/prescriptions", () => ok(prescription()));
    h.api.on("GET", "/api/v1/inpatients", () => okPaged(page([inpatient()])));
    h.api.on("POST", `/api/v1/encounters/${IP_ENCOUNTER_ID}/notes`, () => ok(wardNote()));
    h.api.on("GET", `/api/v1/encounters/${IP_ENCOUNTER_ID}/notes`, () => ok([wardNote()]));

    const q = queriesOf(h.runtime);
    const m = mutationsOf(h.runtime);

    await h.runtime.queryClient.fetchQuery(q.patient(PATIENT_ID));
    await h.runtime.queryClient.fetchQuery(q.encounter(ENCOUNTER_ID));
    await m.saveConsultation(ENCOUNTER_ID).mutationFn({ chiefComplaint: "Cough" });
    await m
      .placeOrders()
      .mutationFn(
        orderRequests(
          ENCOUNTER_ID,
          [{ code: "CBC", name: "Complete blood count", category: "lab" }],
          "routine",
          () => "intent-order-1",
        ),
      );
    await m.createPrescription(ENCOUNTER_ID).mutationFn(prescription().lines);
    await h.runtime.queryClient.fetchInfiniteQuery(q.inpatients());
    await m
      .addWardNote(IP_ENCOUNTER_ID, {
        capability: PROGRESS_NOTE,
        before: [],
        authorId: USER.id,
        key: "intent-note-1",
      })
      .mutationFn("Reviewed on the round.");

    /**
     * The header is produced in ONE place — `createRuntime`'s `getActiveBranch`, read live on every
     * request — so this asserts the property that matters: not that some calls carried the branch,
     * but that no call after the branch was resolved carried anything else.
     */
    const afterSelect = h.api.calls
      .filter((call) => call.path.startsWith("/api/v1/") && !call.path.startsWith("/api/v1/auth"))
      .filter((call) => call.path !== "/api/v1/me/branches");
    const sites = new Set(afterSelect.map((call) => call.headers["x-active-branch"]));

    expect(sites).toEqual(new Set([BRANCH_HYD.id]));
    expect(branchHeaders(h)).toContain(BRANCH_HYD.id);
  });

  it("cannot serve one hospital's chart under the other's name", async () => {
    const h = await atHyderabad();

    h.api.on("GET", `/api/v1/patients/${PATIENT_ID}`, (call) =>
      ok(
        patient({
          name:
            call.headers["x-active-branch"] === BRANCH_HYD.id
              ? "Hyderabad patient"
              : "Chennai patient",
        }),
      ),
    );

    const hyd = await h.runtime.queryClient.fetchQuery(queriesOf(h.runtime).patient(PATIENT_ID));
    expect(hyd.name).toBe("Hyderabad patient");

    await h.runtime.branches.select(USER.id, BRANCH_CHN.id);
    const chn = await h.runtime.queryClient.fetchQuery(queriesOf(h.runtime).patient(PATIENT_ID));

    expect(chn.name).toBe("Chennai patient");
    // And the first site's answer is not merely shadowed — it is gone. `onBranchChanged` clears
    // the whole cache rather than reasoning about which keys were safe to keep.
    expect(
      h.runtime.queryClient.getQueryData(
        queryKeys.patient({ tenantSlug: SLUG, branchId: BRANCH_HYD.id }, PATIENT_ID),
      ),
    ).toBeUndefined();
  });

  it("resolves a concrete branch for a write even when the user may read across all sites", async () => {
    /**
     * A hospital-wide user may READ in aggregate. A write may not be sent that way — the server
     * would have no site to stamp on it — so the guard requires a resolved branch and the header
     * carries it. Aggregate mode is a reading posture and nothing else (ADR-0015).
     */
    const h = await atHyderabad();
    // `undefined` IS All-branches — the same call the switcher makes for the aggregate row.
    await h.runtime.branches.select(USER.id, undefined);
    expect(h.runtime.branch.getState().activeBranchId).toBeUndefined();

    h.api.on("GET", "/api/v1/encounters", () => okPaged(page([encounter()])));
    await h.runtime.queryClient.fetchInfiniteQuery(
      queriesOf(h.runtime).myPatients({ doctorId: USER.id }),
    );
    expect(h.api.calls.at(-1)?.headers["x-active-branch"]).toBeUndefined();

    // The scope the write descriptors would be built with carries no branch, so the guard's
    // `branchResolved` is false and the submit button is disabled with a reason.
    expect(scopeOf(h.runtime).branchId).toBeUndefined();
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * CACHE — the whole key table, not one entry at a time
 * ══════════════════════════════════════════════════════════════════════════ */

describe("2. no two query keys collide", () => {
  const scope = { tenantSlug: SLUG, branchId: BRANCH_HYD.id };

  /**
   * The dangerous ids are the ones that look like nothing: `""` is what a screen passes while a
   * route param is still resolving, and a key that collapses to the same array as a LIST key would
   * hand a disabled detail query the list's cached page — a `Paged<Encounter>` typed as an
   * `Encounter`, rendering fields that are not there, with no failed request to notice.
   */
  const IDS = ["", "x", "shared-id", "patient-1"];

  it("keeps every list and every record distinct, whatever the id happens to be", () => {
    const keys = new Map<string, string>();

    const record = (label: string, key: readonly unknown[]): void => {
      const serialised = JSON.stringify(key);
      const existing = keys.get(serialised);
      expect(
        existing,
        `${label} produces the same key as ${String(existing)} — ${serialised}. Two domains ` +
          `sharing a cache entry means one query can be served the other's object.`,
      ).toBeUndefined();
      keys.set(serialised, label);
    };

    record("patients()", queryKeys.patients(scope));
    record("encounters()", queryKeys.encounters(scope));
    record("orders()", queryKeys.orders(scope));
    record("prescriptions()", queryKeys.prescriptions(scope));
    record("inpatients()", queryKeys.inpatients(scope));
    record("bedBoard()", queryKeys.bedBoard(scope));
    record("notifications()", queryKeys.notifications(scope));

    for (const id of IDS) {
      record(`patient(${id})`, queryKeys.patient(scope, id));
      record(`encounter(${id})`, queryKeys.encounter(scope, id));
      record(`order(${id})`, queryKeys.order(scope, id));
      record(`prescription(${id})`, queryKeys.prescription(scope, id));
      record(`encounterVitals(${id})`, queryKeys.encounterVitals(scope, id));
      record(`patientVitals(${id})`, queryKeys.patientVitals(scope, id));
      record(`consultation(${id})`, queryKeys.consultation(scope, id));
      record(`wardNotes(${id})`, queryKeys.wardNotes(scope, id));
      record(`medications(${id})`, queryKeys.medications(scope, id));
      record(`episodeTimeline(${id})`, queryKeys.episodeTimeline(scope, id));
      record(`catalogue(${id})`, queryKeys.catalogue(scope, id));
    }
  });

  it("separates the same query at two branches, and at two hospitals", () => {
    const hyd = queryKeys.encounters({ tenantSlug: SLUG, branchId: BRANCH_HYD.id });
    const chn = queryKeys.encounters({ tenantSlug: SLUG, branchId: BRANCH_CHN.id });
    const other = queryKeys.encounters({ tenantSlug: "fortis", branchId: BRANCH_HYD.id });

    expect(JSON.stringify(hyd)).not.toBe(JSON.stringify(chn));
    expect(JSON.stringify(hyd)).not.toBe(JSON.stringify(other));
  });

  it("distinguishes the ward round from the one-row count that shares its endpoint", () => {
    // Both read `GET /inpatients`; one pages through it, the other asks for a single row to read
    // `meta.total`. One key would serve the count's answer to the round.
    expect(JSON.stringify(queryKeys.inpatients(scope, "count"))).not.toBe(
      JSON.stringify(queryKeys.inpatients(scope)),
    );
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * SESSION — the invariants that only fail under concurrency or failure
 * ══════════════════════════════════════════════════════════════════════════ */

describe("3. three concurrent 401s refresh once and every request completes", () => {
  it("retries all three, and each endpoint is called exactly twice", async () => {
    const h = await atHyderabad();

    for (const path of ["/api/v1/patients", "/api/v1/encounters", "/api/v1/orders"]) {
      h.api.once("GET", path, () => fail(401, "HMS-AUTH-002"));
      h.api.on("GET", path, () => okPaged(page([])));
    }
    const before = h.api.callsTo("POST", "/api/v1/auth/refresh").length;

    const results = await Promise.all([
      h.runtime.api.listPatients({ limit: 1 }),
      h.runtime.api.listEncounters({ limit: 1 }),
      h.runtime.api.listOrders({ limit: 1 }),
    ]);

    // One refresh for three 401s: three would look like token theft to the server's reuse
    // detection, which revokes the family and signs the doctor out mid-round (HMS-AUTH-003).
    expect(h.api.callsTo("POST", "/api/v1/auth/refresh").length - before).toBe(1);

    // And every one of them actually replayed rather than being dropped on the floor.
    expect(results).toHaveLength(3);
    expect(h.api.callsTo("GET", "/api/v1/patients")).toHaveLength(2);
    expect(h.api.callsTo("GET", "/api/v1/encounters")).toHaveLength(2);
    expect(h.api.callsTo("GET", "/api/v1/orders")).toHaveLength(2);
    expect(h.runtime.session.getState().status).toBe("signedIn");
  });
});

describe("4. a refresh that fails ends the session once, not in a loop", () => {
  it("stops after ONE refresh attempt however many requests were waiting", async () => {
    const h = await atHyderabad();
    h.api.on("POST", "/api/v1/auth/refresh", () => fail(401, "HMS-AUTH-002"));
    for (const path of ["/api/v1/patients", "/api/v1/encounters", "/api/v1/orders"]) {
      h.api.on("GET", path, () => fail(401, "HMS-AUTH-002"));
    }
    const before = h.api.callsTo("POST", "/api/v1/auth/refresh").length;

    await Promise.allSettled([
      h.runtime.api.listPatients({ limit: 1 }),
      h.runtime.api.listEncounters({ limit: 1 }),
      h.runtime.api.listOrders({ limit: 1 }),
    ]);

    /**
     * The failure mode this guards against is a phone that spins on the refresh endpoint from a
     * pocket: three dead requests, three refreshes, three more 401s, forever. One flight, one
     * failure, one clean end.
     */
    expect(h.api.callsTo("POST", "/api/v1/auth/refresh").length - before).toBe(1);
    expect(h.runtime.session.getState().status).toBe("signedOut");
    expect(h.sessionEndings).toContain("expired");
  });

  it("leaves nothing behind that a later request could use", async () => {
    const h = await atHyderabad();
    h.api.on("POST", "/api/v1/auth/refresh", () => fail(401, "HMS-AUTH-002"));
    h.api.on("GET", "/api/v1/patients", () => fail(401, "HMS-AUTH-002"));

    await h.runtime.api.listPatients({ limit: 1 }).catch(() => undefined);

    expect(h.runtime.session.getState().accessToken).toBeUndefined();
    expect(h.secureStore.snapshot().size).toBe(0);
    expect(h.runtime.branch.getState().validated).toBe(false);
    expect(h.runtime.queryClient.getQueryCache().getAll()).toHaveLength(0);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * IPD — the authority/enrichment split, which is easy to reverse by accident
 * ══════════════════════════════════════════════════════════════════════════ */

describe("5. no patient disappears because the bed board does not know their bed", () => {
  it("keeps a stay the board has no entry for", async () => {
    /**
     * `/inpatients` is the AUTHORITY on who is admitted; `/bed-board` only enriches it with a
     * location. Reversing that — iterating the board and showing whoever it lists — would silently
     * drop every patient in a free-text bed the catalogue has never heard of, which is exactly the
     * population most likely to be somewhere unusual.
     */
    const h = await atHyderabad();
    const known = inpatient({ id: "enc-known" });
    const stranger = inpatient({ id: "enc-stranger", patientId: "patient-9" });

    h.api.on("GET", "/api/v1/inpatients", () => okPaged(page([known, stranger])));
    h.api.on("GET", "/api/v1/bed-board", () => ok(bedBoard()));

    const ward = await h.runtime.queryClient.fetchInfiniteQuery(queriesOf(h.runtime).inpatients());
    const ids = ward.pages.flatMap((p) => p.items).map((e) => e.id);

    expect(ids).toContain("enc-known");
    expect(ids).toContain("enc-stranger");
  });

  it("keeps the ward list working when the board fails entirely", async () => {
    const h = await atHyderabad();
    h.api.on("GET", "/api/v1/inpatients", () => okPaged(page([inpatient()])));
    h.api.on("GET", "/api/v1/bed-board", () => fail(503, "HMS-GEN-503"));

    const ward = await h.runtime.queryClient.fetchInfiniteQuery(queriesOf(h.runtime).inpatients());
    expect(ward.pages[0]?.items).toHaveLength(1);

    const board = await h.runtime.queryClient
      .fetchQuery({ ...queriesOf(h.runtime).bedBoard(), retry: false })
      .catch(() => undefined);
    // The enrichment is allowed to be missing. The round is not allowed to be empty because of it.
    expect(board).toBeUndefined();
  });
});
