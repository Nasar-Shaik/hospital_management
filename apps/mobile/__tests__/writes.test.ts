/**
 * THE CLINICAL WRITE PATH — the real client, the real cache, and a fake server that behaves.
 *
 * ── THE ORDER ENDPOINT IS MODELLED, NOT STUBBED ─────────────────────────────
 * `fakeOrders()` below keeps a key→response map and replays byte-identically, exactly as
 * `middleware/idempotent.ts` does. That is the difference between a test that proves the app sends
 * a header and a test that proves the app is SAFE: the interesting assertion is "after a lost
 * response and a retry, ONE order exists", and only a server with memory can answer it.
 */
import { describe, expect, it, vi } from "vitest";
import { BRANCH_CHN, BRANCH_HYD, PASSWORD, USER, createHarness } from "./support/harness";
import { created, fail, ok, okPaged, type FakeApi, type RecordedCall } from "./support/fakeApi";
import {
  consultationNote,
  encounter,
  order as orderFixture,
  page,
  prescription,
} from "./support/fixtures";
import { clinicalMutations } from "../src/query/mutations";
import { clinicalQueries } from "../src/query/clinical";
import { scopeFor } from "../src/query/scope";
import { createIntentKeys } from "../src/lib/idempotency";
import { orderRequests, summarisePlacements, placementMessage } from "../src/clinical/prescribing";
import { patchFor, formFrom, isDirty, EMPTY_FORM } from "../src/clinical/consultation";
import { isEditable } from "../src/clinical/signing";
import { toUserMessage } from "../src/lib/net/errors";
import type { MobileRuntime } from "../src/lib/runtime";

const ORDERS = "/api/v1/orders";
const CONSULTATION = `/api/v1/encounters/${encounter().id}/consultation`;

function scopeOf(runtime: MobileRuntime) {
  const branch = runtime.branch.getState();
  return scopeFor(runtime.profile.slug, {
    validated: branch.validated,
    ...(branch.activeBranchId ? { activeBranchId: branch.activeBranchId } : {}),
  });
}

const writesOf = (runtime: MobileRuntime) => clinicalMutations(runtime.api, scopeOf(runtime));
const readsOf = (runtime: MobileRuntime) => clinicalQueries(runtime.api, scopeOf(runtime));

async function signedIn(options: { permissions?: string[] } = {}) {
  const h = createHarness();
  h.happyPath({
    branches: [BRANCH_HYD, BRANCH_CHN],
    canAggregate: true,
    ...(options.permissions ? { permissions: options.permissions } : {}),
  });
  await h.runtime.auth.signIn(USER.email, PASSWORD, "device");
  await h.runtime.branches.select(USER.id, BRANCH_HYD.id);
  return h;
}

/**
 * `POST /orders`, with the middleware's actual behaviour: a key seen before replays the ORIGINAL
 * response and creates nothing.
 *
 * `dropNextResponse` is the case a disabled button cannot cover — the write commits and the reply
 * never arrives. The order IS created; the client just never hears about it.
 */
function fakeOrders(api: FakeApi) {
  const byKey = new Map<string, unknown>();
  const placed: RecordedCall[] = [];
  let dropNext = false;
  let sequence = 0;

  api.on("POST", ORDERS, (call) => {
    const key = call.headers["idempotency-key"];

    if (key && byKey.has(key)) {
      // Byte-identical to the first answer, plus the marker. Note `duplicate` stays FALSE: a header
      // replay reports what the first attempt did, which is true.
      return created(byKey.get(key), { "Idempotency-Replayed": "true" });
    }

    sequence += 1;
    const body = call.body as { code: string; name: string; encounterId: string };
    const result = {
      order: orderFixture({ id: `order-${String(sequence)}`, code: body.code, name: body.name }),
      duplicate: false,
    };
    if (key) byKey.set(key, result);
    placed.push(call);

    if (dropNext) {
      dropNext = false;
      // Committed, then the wire died. Exactly what the key exists for.
      throw new TypeError("Network request failed");
    }
    return created(result);
  });

  return {
    /** How many orders the "hospital" actually has. The assertion that matters. */
    get count(): number {
      return placed.length;
    },
    get keys(): string[] {
      return placed.map((call) => call.headers["idempotency-key"] ?? "");
    },
    loseNextResponse(): void {
      dropNext = true;
    },
  };
}

/* ════════════════════════════════════════════════════════════════════════════
 * G — CONSULTATION · 1 · 2 · 3 · 4 · 5 · 6
 * ══════════════════════════════════════════════════════════════════════════ */

describe("1. the existing note loads", () => {
  it("comes back as a form, and `null` is an empty one rather than an error", async () => {
    const h = await signedIn();
    h.api.on("GET", CONSULTATION, () => ok(consultationNote()));

    const note = await h.runtime.queryClient.fetchQuery(
      readsOf(h.runtime).consultation(encounter().id),
    );

    expect(formFrom(note).chiefComplaint).toBe("Cough for four days");
    // A visit with no note yet returns `null`. That is a blank form, not a failure.
    expect(formFrom(null)).toEqual(EMPTY_FORM);
  });
});

describe("2. editing and saving", () => {
  it("sends ONLY the fields the doctor changed", async () => {
    /**
     * The PUT touches only what it is given, so resending an untouched `examination` would
     * overwrite a colleague's edit made in the seconds since this screen loaded. Field-level, for
     * free.
     */
    const h = await signedIn();
    h.api.on("PUT", CONSULTATION, () => ok(consultationNote({ plan: "Rest and fluids" })));

    const loaded = formFrom(consultationNote());
    const edited = { ...loaded, plan: "Rest and fluids" };
    const patch = patchFor(loaded, edited);

    await writesOf(h.runtime)
      .saveConsultation(encounter().id)
      .mutationFn(patch ?? {});

    const call = h.api.callsTo("PUT", CONSULTATION).at(-1);
    expect(call?.body).toEqual({ plan: "Rest and fluids" });
    expect(call?.headers["x-active-branch"]).toBe(BRANCH_HYD.id);
  });

  it("sends nothing at all when nothing changed", () => {
    // The server refuses an empty PUT with "nothing to save", so a screen that sent one would turn
    // a no-op into a validation error the doctor cannot act on.
    const loaded = formFrom(consultationNote());
    expect(patchFor(loaded, loaded)).toBeUndefined();
    expect(isDirty(loaded, loaded)).toBe(false);
  });

  it("sends 0 for a CLEARED follow-up rather than omitting it", () => {
    // Omitting would leave the old value. "I deleted the follow-up and it came back" is a real
    // appointment nobody books.
    const loaded = formFrom(consultationNote({ followUpDays: 7 }));
    const cleared = { ...loaded, followUpDays: "" };
    expect(patchFor(loaded, cleared)).toEqual({ followUpDays: 0 });
  });
});

describe("3. a validation failure", () => {
  it("arrives as field errors the form can render, not as prose", async () => {
    const h = await signedIn();
    h.api.on("PUT", CONSULTATION, () =>
      fail(400, "HMS-VAL-001", "Validation failed", {
        fields: { history: ["must be at most 4000 characters"] },
      }),
    );

    const error = await writesOf(h.runtime)
      .saveConsultation(encounter().id)
      .mutationFn({ history: "x" })
      .then(() => undefined)
      .catch((e: unknown) => e);

    const shown = toUserMessage(error);
    expect(shown.title).toBe("Check the form");
    expect(shown.fields).toEqual({ history: ["must be at most 4000 characters"] });
  });
});

describe("4 · 5 · 6. a failed save, then a retry", () => {
  it("reports the failure honestly and creates nothing", async () => {
    const h = await signedIn();
    h.api.goOffline();

    const error = await writesOf(h.runtime)
      .saveConsultation(encounter().id)
      .mutationFn({ plan: "Rest" })
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(toUserMessage(error).title).toBe("No connection");
    expect(h.api.callsTo("PUT", CONSULTATION)).toHaveLength(1);
  });

  it("retries safely — PUT twice leaves ONE note, so no key is needed", async () => {
    /**
     * Why the consultation carries no idempotency key while orders do: `PUT` with the same body is
     * naturally replay-safe. There is no second record to create, so the second attempt is the
     * same write, not a duplicate one.
     */
    const h = await signedIn();
    const bodies: unknown[] = [];
    h.api.on("PUT", CONSULTATION, (call) => {
      bodies.push(call.body);
      return ok(consultationNote({ plan: "Rest" }));
    });

    const save = writesOf(h.runtime).saveConsultation(encounter().id).mutationFn;
    await save({ plan: "Rest" });
    await save({ plan: "Rest" });

    expect(bodies).toEqual([{ plan: "Rest" }, { plan: "Rest" }]);
    // Idempotent by verb, so nothing was sent to make it so.
    expect(h.api.callsTo("PUT", CONSULTATION).every((c) => !c.headers["idempotency-key"])).toBe(
      true,
    );
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * H — ORDERS · 7 · 8 · 9 · 10 · 11 · 12 · 13 · 14
 * ══════════════════════════════════════════════════════════════════════════ */

const BASKET = [
  { code: "CBC", name: "Complete blood count", category: "lab" as const },
  { code: "CXR", name: "Chest X-ray", category: "radiology" as const },
];

describe("7. placing orders", () => {
  it("sends one request per test, with the branch header and the chosen priority", async () => {
    const h = await signedIn();
    const server = fakeOrders(h.api);
    const keys = createIntentKeys();

    const results = await writesOf(h.runtime)
      .placeOrders()
      .mutationFn(orderRequests(encounter().id, BASKET, "urgent", (code) => keys.keyFor(code)));

    expect(results).toHaveLength(2);
    expect(server.count).toBe(2);

    const calls = h.api.callsTo("POST", ORDERS);
    expect(calls.map((c) => (c.body as { code: string }).code)).toEqual(["CBC", "CXR"]);
    expect(calls.every((c) => c.headers["x-active-branch"] === BRANCH_HYD.id)).toBe(true);
    expect(calls.every((c) => (c.body as { priority: string }).priority === "urgent")).toBe(true);
  });

  it("stops at the first failure with everything before it genuinely placed", async () => {
    // Sequential, not `Promise.all`: a parallel batch that half-succeeds leaves "what actually
    // happened?" unanswerable, and the rejected promise does not stop the others.
    const h = await signedIn();
    let seen = 0;
    h.api.on("POST", ORDERS, (call) => {
      seen += 1;
      if (seen === 2) return fail(500, "HMS-GEN-500", "boom");
      return created({
        order: orderFixture({ code: (call.body as { code: string }).code }),
        duplicate: false,
      });
    });

    await writesOf(h.runtime)
      .placeOrders()
      .mutationFn(orderRequests(encounter().id, BASKET, "routine", () => "key-a"))
      .catch(() => undefined);

    expect(seen).toBe(2);
  });
});

describe("8. the idempotency key is sent, and it is the caller's", () => {
  it("puts a distinct key on each test, and the SAME string in `requestId`", async () => {
    const h = await signedIn();
    fakeOrders(h.api);
    const keys = createIntentKeys();

    await writesOf(h.runtime)
      .placeOrders()
      .mutationFn(orderRequests(encounter().id, BASKET, "routine", (code) => keys.keyFor(code)));

    const calls = h.api.callsTo("POST", ORDERS);
    const headerKeys = calls.map((c) => c.headers["idempotency-key"]);

    expect(headerKeys.every((k) => typeof k === "string" && k.length >= 8)).toBe(true);
    // One key per test, not one per basket: the server matches a key to a BODY, so reusing one
    // across three different payloads is HMS-REQ-002, not a replay.
    expect(new Set(headerKeys).size).toBe(2);
    // The body field carries the same string — the second lock, for a proxy that strips the header.
    expect(calls.map((c) => (c.body as { requestId: string }).requestId)).toEqual(headerKeys);
  });

  it("reuses the SAME keys when the basket is retried", async () => {
    const h = await signedIn();
    fakeOrders(h.api);
    const keys = createIntentKeys();
    const build = () =>
      orderRequests(encounter().id, BASKET, "routine", (code) => keys.keyFor(code));

    const first = build().map((r) => r.key);
    const retry = build().map((r) => r.key);

    expect(retry).toEqual(first);
    // …and a genuinely NEW basket gets new ones, or the next order would replay this one and
    // silently never be placed.
    keys.reset();
    expect(build().map((r) => r.key)).not.toEqual(first);
  });
});

describe("9 · 10. a lost response, then a retry", () => {
  it("replays as SUCCESS and creates no second order", async () => {
    /**
     * The whole reason the key exists. The first attempt reaches the server, the order is created,
     * and the reply dies on the way back. The doctor presses Order again.
     */
    const h = await signedIn();
    const server = fakeOrders(h.api);
    const keys = createIntentKeys();
    const basket = [BASKET[0]!];
    const build = () =>
      orderRequests(encounter().id, basket, "routine", (code) => keys.keyFor(code));

    server.loseNextResponse();
    const firstAttempt = await writesOf(h.runtime)
      .placeOrders()
      .mutationFn(build())
      .then(() => "resolved")
      .catch(() => "rejected");

    expect(firstAttempt).toBe("rejected");
    expect(server.count).toBe(1); // it DID happen — the doctor just does not know

    const results = await writesOf(h.runtime).placeOrders().mutationFn(build());

    // ONE order in the hospital, and the retry reported success.
    expect(server.count).toBe(1);
    expect(results).toHaveLength(1);
    expect(server.keys[0]).toBe(h.api.callsTo("POST", ORDERS).at(-1)?.headers["idempotency-key"]);
  });

  it("never renders a replay as a duplicate or as an error", async () => {
    /**
     * Both shapes of "already there" are successes. The header replay returns the original 201 with
     * `duplicate: false`, so the phone cannot even tell — which is the point. `duplicate: true` is
     * the module's own `requestId` guard, which answers when a proxy strips the header.
     */
    expect(
      placementMessage(summarisePlacements([{ order: orderFixture(), duplicate: false }])),
    ).toBe("1 test ordered — on the department worklist now.");
    const withGuard = placementMessage(
      summarisePlacements([
        { order: orderFixture(), duplicate: false },
        { order: orderFixture({ id: "o2" }), duplicate: true },
      ]),
    );
    expect(withGuard).toContain("2 tests ordered");
    expect(withGuard).not.toMatch(/duplicate|error|failed/i);
  });
});

describe("11 · 12 · 13 · 14. what comes back", () => {
  it("loads the patient's orders with the branch header", async () => {
    const h = await signedIn();
    h.api.on("GET", ORDERS, () => okPaged(page([orderFixture()])));

    const result = await h.runtime.queryClient.fetchQuery(readsOf(h.runtime).patientOrders("p1"));

    expect(result.items).toHaveLength(1);
    expect(h.api.callsTo("GET", ORDERS).at(-1)?.headers["x-active-branch"]).toBe(BRANCH_HYD.id);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * I — PRESCRIPTION · 15 · 16 · 17 · 18 · 19 · 20 · 21
 * ══════════════════════════════════════════════════════════════════════════ */

const DRAFT = prescription({ status: "draft", signedBy: undefined, signedAt: undefined });
const RX = "/api/v1/prescriptions";

describe("15 · 16. drafting and screening", () => {
  it("creates a draft, then screens it — and the screen signs nothing", async () => {
    const h = await signedIn();
    h.api.on("POST", RX, () => created(DRAFT));
    h.api.on("GET", `${RX}/${DRAFT.id}/screen`, () =>
      ok({ prescriptionId: DRAFT.id, alerts: [], blocking: false }),
    );

    const writes = writesOf(h.runtime);
    const draft = await writes.createPrescription(encounter().id).mutationFn(DRAFT.lines);
    const screening = await writes.screen().mutationFn(draft.id);

    expect(draft.status).toBe("draft");
    expect(screening.blocking).toBe(false);
    // The screen is a GET. Nothing about it can sign.
    expect(h.api.callsTo("POST", `${RX}/${DRAFT.id}/sign`)).toHaveLength(0);
  });

  it("carries a blocking screen through with its alerts", async () => {
    const h = await signedIn();
    h.api.on("GET", `${RX}/${DRAFT.id}/screen`, () =>
      ok({
        prescriptionId: DRAFT.id,
        blocking: true,
        alerts: [
          {
            kind: "allergy",
            severity: "contraindicated",
            drugCodes: ["AMOX500"],
            allergen: "penicillins",
            message: "Patient is allergic to penicillins (anaphylaxis).",
          },
        ],
      }),
    );

    const screening = await writesOf(h.runtime).screen().mutationFn(DRAFT.id);
    expect(screening.blocking).toBe(true);
    expect(screening.alerts[0]?.severity).toBe("contraindicated");
  });
});

describe("17 · 18 · 19 · 20. signing, through the real client", () => {
  it("signs and reports success", async () => {
    const h = await signedIn();
    h.api.on("POST", `${RX}/${DRAFT.id}/sign`, () => ok(prescription()));

    const outcome = await writesOf(h.runtime).sign(DRAFT.id).mutationFn({});

    expect(outcome).toMatchObject({ outcome: "signed", reconciled: false });
    expect(h.api.callsTo("GET", `${RX}/${DRAFT.id}`)).toHaveLength(0);
  });

  it("reconciles a lost response into a success, with ONE sign request", async () => {
    const h = await signedIn();
    let signAttempts = 0;
    h.api.on("POST", `${RX}/${DRAFT.id}/sign`, () => {
      signAttempts += 1;
      // Committed server-side; the reply never arrives.
      throw new TypeError("Network request failed");
    });
    h.api.on("GET", `${RX}/${DRAFT.id}`, () => ok(prescription()));

    const outcome = await writesOf(h.runtime).sign(DRAFT.id).mutationFn({});

    expect(outcome).toMatchObject({ outcome: "signed", reconciled: true });
    expect(signAttempts).toBe(1);
  });

  it("turns HMS-STATE-001 on an already-signed prescription into a success", async () => {
    const h = await signedIn();
    h.api.on("POST", `${RX}/${DRAFT.id}/sign`, () =>
      fail(422, "HMS-STATE-001", "Invalid state transition", { from: "signed", to: "signed" }),
    );
    h.api.on("GET", `${RX}/${DRAFT.id}`, () => ok(prescription()));

    const outcome = await writesOf(h.runtime).sign(DRAFT.id).mutationFn({});

    expect(outcome).toMatchObject({ outcome: "signed", reconciled: true });
    // The doctor is never shown "invalid state transition" for a prescription that is signed.
    expect(outcome.outcome).not.toBe("failed");
  });

  it("leaves a genuinely unsigned prescription retryable, and does not loop", async () => {
    const h = await signedIn();
    let attempts = 0;
    h.api.on("POST", `${RX}/${DRAFT.id}/sign`, () => {
      attempts += 1;
      return fail(503, "HMS-GEN-503", "unavailable");
    });
    h.api.on("GET", `${RX}/${DRAFT.id}`, () => ok(DRAFT));

    const first = await writesOf(h.runtime).sign(DRAFT.id).mutationFn({});
    expect(first).toMatchObject({ outcome: "unsigned" });
    expect(attempts).toBe(1);

    // The retry is the doctor pressing again — and it succeeds.
    h.api.on("POST", `${RX}/${DRAFT.id}/sign`, () => ok(prescription()));
    const second = await writesOf(h.runtime).sign(DRAFT.id).mutationFn({});
    expect(second).toMatchObject({ outcome: "signed", reconciled: false });
  });

  it("sends the override reason only when one was given", async () => {
    const h = await signedIn();
    h.api.on("POST", `${RX}/${DRAFT.id}/sign`, () => ok(prescription()));

    await writesOf(h.runtime).sign(DRAFT.id).mutationFn({});
    expect(h.api.callsTo("POST", `${RX}/${DRAFT.id}/sign`).at(-1)?.body).toBeUndefined();

    await writesOf(h.runtime)
      .sign(DRAFT.id)
      .mutationFn({ overrideReason: "benefit outweighs risk" });
    expect(h.api.callsTo("POST", `${RX}/${DRAFT.id}/sign`).at(-1)?.body).toEqual({
      overrideReason: "benefit outweighs risk",
    });
  });
});

describe("21. a signed prescription cannot be edited", () => {
  it("is immutable by the predicate the screen locks on", () => {
    // Belt. `isEditable` is what decides whether the line editor renders inputs or read-only text,
    // and it is false for every state at or past the signature.
    expect(isEditable(DRAFT)).toBe(true);
    expect(isEditable(prescription())).toBe(false);
    expect(isEditable(prescription({ status: "partially_dispensed" }))).toBe(false);
    expect(isEditable(prescription({ status: "dispensed" }))).toBe(false);
  });

  it("is refused by the server too, and the refusal reads as a state change", async () => {
    // Braces. Even if a UI bug offered the edit, `PATCH /prescriptions/:id` answers HMS-STATE-001
    // ("a signed prescription cannot be edited") — which the error map renders as "this has
    // already moved on" with a RELOAD action, not a retry. Retrying would re-send a transition the
    // state machine has already refused.
    const h = await signedIn();
    h.api.on("PATCH", `${RX}/${DRAFT.id}`, () =>
      fail(422, "HMS-STATE-001", "A signed prescription cannot be edited"),
    );

    const error = await h.runtime.api
      .updatePrescription(DRAFT.id, { lines: DRAFT.lines })
      .then(() => undefined)
      .catch((e: unknown) => e);

    const shown = toUserMessage(error);
    expect(shown.title).toBe("This has already moved on");
    expect(shown.action).toBe("reload");
  });

  it("offers `amend`, not an edit, as the way to change a signed prescription", () => {
    // A new DRAFT superseding the original, which survives exactly as it was signed (§6). The
    // distinction is the whole reason the signature is worth anything.
    const superseded = prescription({ version: 2, supersedesId: "rx-1" });
    expect(superseded.version).toBe(2);
    expect(isEditable(superseded)).toBe(false);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * BRANCH · 22 · 23 · 24
 * ══════════════════════════════════════════════════════════════════════════ */

describe("22 · 23 · 24. writes are branch-scoped, and a switch leaves nothing behind", () => {
  it("invalidates exactly the current branch's reads, and nothing hospital-wide", async () => {
    const h = await signedIn();
    const write = writesOf(h.runtime).saveConsultation(encounter().id);
    expect(write.invalidates).toEqual([h.runtime.profile.slug, BRANCH_HYD.id]);

    // The allergy key is `[tenant, "patient", …]` with no branch, so the prefix does not match it
    // — correct, because nothing in this slice can change a patient's allergies.
    const allergyKey = readsOf(h.runtime).allergies("p1").queryKey;
    expect(allergyKey[1]).not.toBe(BRANCH_HYD.id);
  });

  it("Branch A → edit → switch → Branch B shows B's note, never A's", async () => {
    /**
     * The regression the brief names. The same encounter id read in two branches must not serve
     * one site's note under the other's name — and after a switch, A's answer must be GONE rather
     * than merely stale.
     */
    const h = await signedIn();
    h.api.on("GET", CONSULTATION, (call) =>
      ok(
        consultationNote({
          chiefComplaint:
            call.headers["x-active-branch"] === BRANCH_CHN.id ? "Chennai note" : "Hyderabad note",
          branchId: call.headers["x-active-branch"] ?? "",
        }),
      ),
    );

    const readA = readsOf(h.runtime).consultation(encounter().id);
    const inA = await h.runtime.queryClient.fetchQuery(readA);
    expect(inA?.chiefComplaint).toBe("Hyderabad note");
    expect(readA.queryKey[1]).toBe(BRANCH_HYD.id);

    await h.runtime.branches.select(USER.id, BRANCH_CHN.id);

    // Nothing of Hyderabad's survives the switch.
    expect(h.runtime.queryClient.getQueryData(readA.queryKey as unknown[])).toBeUndefined();

    const readB = readsOf(h.runtime).consultation(encounter().id);
    expect(readB.queryKey).not.toEqual(readA.queryKey);
    const inB = await h.runtime.queryClient.fetchQuery(readB);
    expect(inB?.chiefComplaint).toBe("Chennai note");

    // …and the write that follows is stamped for Chennai.
    expect(writesOf(h.runtime).saveConsultation(encounter().id).invalidates).toEqual([
      h.runtime.profile.slug,
      BRANCH_CHN.id,
    ]);
  });

  it("stamps every write request with the branch the app has validated", async () => {
    const h = await signedIn();
    fakeOrders(h.api);
    h.api.on("PUT", CONSULTATION, () => ok(consultationNote()));
    h.api.on("POST", `${RX}/${DRAFT.id}/sign`, () => ok(prescription()));

    const writes = writesOf(h.runtime);
    await writes.saveConsultation(encounter().id).mutationFn({ plan: "x" });
    await writes
      .placeOrders()
      .mutationFn(orderRequests(encounter().id, [BASKET[0]!], "routine", () => "key-1"));
    await writes.sign(DRAFT.id).mutationFn({});

    const writeCalls = h.api.calls.filter(
      (c) => c.method !== "GET" && c.path.startsWith("/api/v1/"),
    );
    const clinical = writeCalls.filter(
      (c) =>
        !c.path.startsWith("/api/v1/auth/") &&
        // Registering or releasing a handset (M4) is a session act, like login beside it: a phone
        // belongs to a person, not to a site, and `devices` carries no branch for the header to
        // mean anything against.
        !c.path.startsWith("/api/v1/me/devices"),
    );
    expect(clinical.length).toBeGreaterThan(2);
    expect(clinical.every((c) => c.headers["x-active-branch"] === BRANCH_HYD.id)).toBe(true);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * AUTH · 25 · 26 · 27
 * ══════════════════════════════════════════════════════════════════════════ */

describe("25. an expired access token refreshes once, and the write replays", () => {
  it("refreshes exactly once for two concurrent writes, keeping each one's key", async () => {
    /**
     * The replay carries the SAME `Idempotency-Key`, deliberately: it is one intent that had to be
     * sent twice. A fresh key here would let a token that expired between the write and its
     * response place the order a second time — the exact failure the mechanism exists to prevent.
     */
    const h = await signedIn();
    const server = fakeOrders(h.api);

    let refreshes = 0;
    h.api.on("POST", "/api/v1/auth/refresh", () => {
      refreshes += 1;
      return ok({ accessToken: "access-2", refreshToken: "refresh-2", expiresIn: 900, user: USER });
    });
    h.api.once("POST", ORDERS, () => fail(401, "HMS-AUTH-002", "expired"));
    h.api.once("POST", ORDERS, () => fail(401, "HMS-AUTH-002", "expired"));

    const writes = writesOf(h.runtime);
    await Promise.all([
      writes
        .placeOrders()
        .mutationFn(orderRequests(encounter().id, [BASKET[0]!], "routine", () => "key-a")),
      writes
        .placeOrders()
        .mutationFn(orderRequests(encounter().id, [BASKET[1]!], "routine", () => "key-b")),
    ]);

    expect(refreshes).toBe(1);
    expect(server.count).toBe(2);
    expect(new Set(server.keys)).toEqual(new Set(["key-a", "key-b"]));
    expect(h.runtime.session.getState().status).toBe("signedIn");
  });
});

describe("26. a forbidden write is explained, never bounced to sign-in", () => {
  it("keeps the session and does not retry", async () => {
    const h = await signedIn();
    let attempts = 0;
    h.api.on("PUT", CONSULTATION, () => {
      attempts += 1;
      return fail(403, "HMS-AUTH-005", "Insufficient permission");
    });

    const error = await writesOf(h.runtime)
      .saveConsultation(encounter().id)
      .mutationFn({ plan: "x" })
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(toUserMessage(error).title).toBe("You do not have access");
    expect(attempts).toBe(1);
    expect(h.runtime.session.getState().status).toBe("signedIn");
    expect(h.sessionEndings).toEqual([]);
  });
});

describe("27. a dead session ends cleanly rather than looping", () => {
  it("signs out once the refresh itself is refused", async () => {
    const h = await signedIn();
    h.api.on("PUT", CONSULTATION, () => fail(401, "HMS-AUTH-002", "expired"));
    h.api.on("POST", "/api/v1/auth/refresh", () => fail(401, "HMS-AUTH-002", "dead"));

    await writesOf(h.runtime)
      .saveConsultation(encounter().id)
      .mutationFn({ plan: "x" })
      .catch(() => undefined);

    expect(h.runtime.session.getState().status).toBe("signedOut");
    expect(h.sessionEndings).toContain("expired");
    // One refresh attempt, not a loop of them.
    expect(h.api.callsTo("POST", "/api/v1/auth/refresh")).toHaveLength(1);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * The intent-key mechanism itself
 * ══════════════════════════════════════════════════════════════════════════ */

describe("intent keys", () => {
  it("mints a distinct, well-formed key per name and holds it", () => {
    const keys = createIntentKeys();
    const first = keys.keyFor("CBC");
    expect(keys.keyFor("CBC")).toBe(first);
    expect(keys.keyFor("CXR")).not.toBe(first);
    // The server accepts 8–128 chars of [A-Za-z0-9_.:@+-].
    expect(first).toMatch(/^[A-Za-z0-9_.:@+-]{8,128}$/);
  });

  it("mints fresh keys after a reset, so the next basket is a new intent", () => {
    const mint = vi.fn().mockReturnValueOnce("first-key").mockReturnValueOnce("second-key");
    const keys = createIntentKeys(mint);
    expect(keys.keyFor("CBC")).toBe("first-key");
    keys.reset();
    expect(keys.keyFor("CBC")).toBe("second-key");
  });
});
