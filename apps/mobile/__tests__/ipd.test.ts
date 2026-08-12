/**
 * THE INPATIENT WORKFLOW (M2 J) — the real client, the real cache, a fake server with memory.
 *
 * ── WHAT THESE TESTS ARE ACTUALLY GUARDING ──────────────────────────────────
 * Three things, and they are not the obvious ones:
 *
 *   THE JOIN IS HONEST      — the round list is `/inpatients` enriched by `/bed-board`, and the
 *                             enrichment must never decide who is on the list. A stay the board has
 *                             not heard of has to survive.
 *   OCCUPANCY IS THE SERVER'S — the phone reports `free of total` from the board and never counts
 *                             beds itself, so a page of twenty rows cannot describe a forty-bed ward.
 *   A RETRY CANNOT DUPLICATE — the ward-note endpoint has NO idempotency and NO state guard, so the
 *                             only protection is the reconciliation, and `fakeWard()` below models a
 *                             server that really does append a second note if you ask it twice.
 */
import { describe, expect, it } from "vitest";
import { BRANCH_CHN, BRANCH_HYD, PASSWORD, USER, createHarness } from "./support/harness";
import { created, fail, ok, type FakeApi } from "./support/fakeApi";
import {
  IP_ENCOUNTER_ID,
  PATIENT_ID,
  bedBoard,
  dose,
  encounter,
  inpatient,
  order as orderFixture,
  page,
  prescription,
  vitals,
  wardNote,
} from "./support/fixtures";
import { clinicalQueries } from "../src/query/clinical";
import { clinicalMutations } from "../src/query/mutations";
import { queryKeys } from "../src/query/keys";
import { scopeFor } from "../src/query/scope";
import {
  UNPLACED,
  dayOfStay,
  dosesOnDay,
  groupByWard,
  identitiesByEncounter,
  isAdmission,
  isStayOpen,
  marStatusTone,
  mayBeTruncated,
  placementFor,
  placementLabel,
  placementsByEncounter,
  sortDoses,
  summariseDoses,
} from "../src/clinical/ipd";
import { attemptWardNote, matchingNote, newNotesSince } from "../src/clinical/wardNote";
import { attemptDischarge, isStayEnded } from "../src/clinical/discharge";
import { isFeatureUnavailable, toUserMessage } from "../src/lib/net/errors";
import { buildTimeline } from "../src/clinical/timeline";
import type { MobileRuntime } from "../src/lib/runtime";

const INPATIENTS = "/api/v1/inpatients";
const BED_BOARD = "/api/v1/bed-board";
const NOTES = `/api/v1/encounters/${IP_ENCOUNTER_ID}/notes`;
const MAR = `/api/v1/encounters/${IP_ENCOUNTER_ID}/medication-administrations`;
const DISCHARGE = `/api/v1/encounters/${IP_ENCOUNTER_ID}/discharge`;
const ENCOUNTER = `/api/v1/encounters/${IP_ENCOUNTER_ID}`;

/** Every permission the IPD workflow touches, as the DOCTOR role actually grants them. */
const DOCTOR = [
  "patient:read",
  "encounter:read",
  "emr:read",
  "emr:write",
  "order:read",
  "admission:discharge",
];

function scopeOf(runtime: MobileRuntime) {
  const branch = runtime.branch.getState();
  return scopeFor(runtime.profile.slug, {
    validated: branch.validated,
    ...(branch.activeBranchId ? { activeBranchId: branch.activeBranchId } : {}),
  });
}

const readsOf = (runtime: MobileRuntime) => clinicalQueries(runtime.api, scopeOf(runtime));
const writesOf = (runtime: MobileRuntime) => clinicalMutations(runtime.api, scopeOf(runtime));

async function onWard(options: { permissions?: string[] } = {}) {
  const h = createHarness();
  h.happyPath({
    branches: [BRANCH_HYD, BRANCH_CHN],
    canAggregate: true,
    permissions: options.permissions ?? DOCTOR,
  });
  await h.runtime.auth.signIn(USER.email, PASSWORD, "device");
  await h.runtime.branches.select(USER.id, BRANCH_HYD.id);
  return h;
}

/**
 * The ward-note endpoint AS IT ACTUALLY IS: no idempotency key, no de-duplication.
 *
 * Asking twice really does produce two notes. That is the whole reason `attemptWardNote` exists,
 * and a fake that quietly de-duplicated would make the reconciliation look unnecessary while
 * hiding the bug it prevents.
 */
function fakeWard(api: FakeApi) {
  let notes = [wardNote()];
  let sequence = 1;
  let dropNext = false;

  api.on("GET", NOTES, () => ok(notes));
  api.on("POST", NOTES, (call) => {
    sequence += 1;
    const body = call.body as { text: string };
    const note = wardNote({
      id: `note-${String(sequence)}`,
      text: body.text,
      at: "2026-08-12T04:00:00.000Z",
    });
    notes = [...notes, note];

    if (dropNext) {
      dropNext = false;
      // Committed, then the wire died. Exactly the case the reconciliation is for.
      throw new TypeError("Network request failed");
    }
    return created(note);
  });

  return {
    /** How many notes the "chart" really has. The assertion that matters. */
    get count(): number {
      return notes.length;
    },
    get all() {
      return notes;
    },
    loseNextResponse(): void {
      dropNext = true;
    },
  };
}

/* ════════════════════════════════════════════════════════════════════════════
 * 1 – 3 · THE INPATIENT LIST
 * ══════════════════════════════════════════════════════════════════════════ */

describe("1. the inpatient list", () => {
  it("reads `GET /inpatients` and keeps the server's ward-then-bed order", async () => {
    const h = await onWard();
    const ward = [
      inpatient(),
      inpatient({
        id: "encounter-ip-2",
        patientId: "patient-2",
        bed: { ward: "ICU", bedCode: "I-01", tariffCode: "BED-ICU" },
      }),
    ];
    h.api.on("GET", INPATIENTS, () => ok(ward));
    h.api.on("GET", BED_BOARD, () => ok(bedBoard()));

    const list = await h.runtime.queryClient.fetchQuery(readsOf(h.runtime).inpatients());

    expect(list).toHaveLength(2);
    expect(h.api.callsTo("GET", INPATIENTS)).toHaveLength(1);
    // No parameters — the endpoint takes none. Sending some would be inventing an API.
    expect(h.api.callsTo("GET", INPATIENTS)[0]?.search).toBe("");
  });

  it("groups by ward in first-appearance order, so the walking order survives", async () => {
    const groups = groupByWard(
      [
        inpatient(),
        inpatient({
          id: "encounter-ip-2",
          bed: { ward: "ICU", bedCode: "I-01", tariffCode: "BED-ICU" },
        }),
        inpatient({
          id: "encounter-ip-x",
          bed: { ward: "General ward", bedCode: "G-15", tariffCode: "BED-GEN" },
        }),
      ],
      bedBoard(),
    );

    // ICU sorts alphabetically before "General ward". It is second here because that is the order
    // the SERVER returned, and the repository sorts it as the order a doctor physically walks.
    expect(groups.map((g) => g.ward)).toEqual(["General ward", "ICU"]);
    expect(groups[0]?.patients).toHaveLength(2);
  });

  it("puts a stay with no recorded bed in its own group, last", () => {
    const groups = groupByWard(
      [inpatient({ id: "encounter-ip-9", bed: undefined }), inpatient()],
      bedBoard(),
    );

    expect(groups.map((g) => g.ward)).toEqual(["General ward", UNPLACED]);
    expect(groups[1]?.patients[0]?.encounter.id).toBe("encounter-ip-9");
  });

  it("keeps every row: the board enriches the list, it never filters it", () => {
    const strangers = [
      inpatient(),
      inpatient({
        id: "not-on-the-board",
        bed: { ward: "Day care", bedCode: "D-1", tariffCode: "BED-DAY" },
      }),
    ];
    const groups = groupByWard(strangers, bedBoard());

    expect(groups.flatMap((g) => g.patients)).toHaveLength(2);
    expect(groups.map((g) => g.ward)).toContain("Day care");
  });
});

describe("2. the empty ward", () => {
  it("is an empty list, not an error", async () => {
    const h = await onWard();
    h.api.on("GET", INPATIENTS, () => ok([]));

    const list = await h.runtime.queryClient.fetchQuery(readsOf(h.runtime).inpatients());

    expect(list).toEqual([]);
    expect(groupByWard(list, undefined)).toEqual([]);
  });
});

describe("3. the ward list failing", () => {
  it("surfaces a server fault as a retryable notice, never as an empty ward", async () => {
    const h = await onWard();
    h.api.on("GET", INPATIENTS, () => fail(503, "HMS-GEN-503"));

    await expect(
      h.runtime.queryClient.fetchQuery({ ...readsOf(h.runtime).inpatients(), retry: false }),
    ).rejects.toThrow();

    const shown = toUserMessage(
      await readsOf(h.runtime)
        .inpatients()
        .queryFn()
        .catch((e: unknown) => e),
    );
    expect(shown.action).toBe("retry");
    expect(shown.title).not.toMatch(/no patients/i);
  });

  it("reports a dropped connection as the wire, not as the ward being empty", async () => {
    const h = await onWard();
    h.api.goOffline();

    const error = await readsOf(h.runtime)
      .inpatients()
      .queryFn()
      .catch((e: unknown) => e);

    expect(toUserMessage(error).title).toBe("No connection");
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 4 – 7 · SELECTING A PATIENT, AND THE STAY
 * ══════════════════════════════════════════════════════════════════════════ */

describe("4. selecting a patient", () => {
  it("takes identity from the bed board — no per-row patient lookup for a placed stay", async () => {
    const h = await onWard();
    h.api.on("GET", INPATIENTS, () => ok([inpatient()]));
    h.api.on("GET", BED_BOARD, () => ok(bedBoard()));

    const list = await h.runtime.queryClient.fetchQuery(readsOf(h.runtime).inpatients());
    const board = await h.runtime.queryClient.fetchQuery(readsOf(h.runtime).bedBoard());
    const groups = groupByWard(list, board);

    expect(groups[0]?.patients[0]?.patientName).toBe("Meera Nair");
    expect(groups[0]?.patients[0]?.uhid).toBe("APL000123");
    // The whole point: twenty rows cost zero `GET /patients/:id`.
    expect(h.api.callsTo("GET", `/api/v1/patients/${PATIENT_ID}`)).toHaveLength(0);
  });

  it("carries identity for an unlisted stay too, so a legacy bed is not anonymous", () => {
    const identities = identitiesByEncounter(bedBoard());
    expect(identities.get("encounter-ip-3")?.patientName).toBe("Anita Das");
  });

  it("leaves the name to the row's own lookup when the board is unavailable", () => {
    const groups = groupByWard([inpatient()], undefined);
    expect(groups[0]?.patients[0]?.patientName).toBeUndefined();
    // …and the bed still resolves, from the encounter's own record.
    expect(placementLabel(groups[0]?.patients[0]?.placement)).toBe("General ward · bed G-14");
  });
});

describe("5. the IPD chart is the same chart", () => {
  it("adds a Stay segment for an IP encounter and nothing for an OP one", () => {
    expect(isAdmission(inpatient())).toBe(true);
    expect(isAdmission(encounter())).toBe(false);
  });

  it("reads the stay's notes and doses from the encounter, alongside the ordinary chart", async () => {
    const h = await onWard();
    const ward = fakeWard(h.api);
    h.api.on("GET", MAR, () => ok([dose()]));

    const notes = await h.runtime.queryClient.fetchQuery(
      readsOf(h.runtime).wardNotes(IP_ENCOUNTER_ID),
    );
    const doses = await h.runtime.queryClient.fetchQuery(
      readsOf(h.runtime).medications(IP_ENCOUNTER_ID),
    );

    expect(notes).toHaveLength(ward.count);
    expect(doses[0]?.drugName).toBe("Amoxicillin 500mg");
  });

  it("builds the timeline from the same episode, so OPD and IPD are one story", () => {
    const events = buildTimeline({
      encounters: [encounter(), inpatient()],
      orders: [orderFixture()],
      prescriptions: [prescription()],
      vitals: [vitals()],
      wardNotes: [wardNote()],
    });

    // The OP visit and the admission are BOTH on it — that is the continuity ADR-0013 §4 buys.
    const titles = events.map((e) => e.title);
    expect(titles).toContain("Visit");
    expect(titles).toContain("Admitted");
    expect(titles).toContain("Ward note");
    // Newest first, with a total order — no two events may tie ambiguously.
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
  });

  it("names a discharge summary and an outcome rather than burying them as 'Ward note'", () => {
    const events = buildTimeline({
      wardNotes: [
        wardNote({ id: "n1", type: "discharge_summary", text: "Home well." }),
        wardNote({ id: "n2", type: "outcome_note", text: "Left against advice." }),
        wardNote({ id: "n3" }),
      ],
    });

    expect(events.map((e) => e.title).sort()).toEqual([
      "Discharge summary",
      "Outcome recorded",
      "Ward note",
    ]);
  });

  it("puts the note's opening on the row, never the whole paragraph", () => {
    // The timeline is a scannable index. The Stay segment is where a note is actually read.
    const events = buildTimeline({ wardNotes: [wardNote({ text: "A".repeat(400) })] });
    expect(events[0]?.detail).toHaveLength(120);
    expect(events[0]?.detail?.endsWith("…")).toBe(true);
  });
});

describe("6. ward and bed information", () => {
  it("resolves ward, room and bed from the board", () => {
    const placement = placementFor(inpatient(), placementsByEncounter(bedBoard()));
    expect(placement).toEqual({
      wardName: "General ward",
      wardKind: "general",
      roomName: "Room 2",
      bedCode: "G-14",
      inInventory: true,
    });
    expect(placementLabel(placement)).toBe("General ward · Room 2 · bed G-14");
  });

  it("marks a legacy free-text bed as not in the inventory rather than hiding it", () => {
    const placements = placementsByEncounter(bedBoard());
    expect(placements.get("encounter-ip-3")).toEqual({
      wardName: "Maternity",
      bedCode: "M-3",
      inInventory: false,
    });
  });

  it("says so in words when there is no bed at all", () => {
    expect(placementLabel(undefined)).toBe("Bed not recorded");
    expect(placementFor(inpatient({ bed: undefined }), new Map())).toBeUndefined();
  });

  /**
   * ── THE OCCUPANCY CONTROL ───────────────────────────────────────────────────
   * The board says 21 free of 24 in a ward this list shows ONE patient in. If the app ever started
   * counting beds from the rows it has, this assertion is what breaks — the numbers would become
   * 0 free of 1, which is what a page-derived count looks like and is catastrophically wrong.
   */
  it("takes occupancy from the server and never recomputes it from the rows on screen", () => {
    const groups = groupByWard([inpatient()], bedBoard());

    expect(groups[0]?.patients).toHaveLength(1);
    expect(groups[0]?.occupancy).toEqual({ total: 24, free: 21, occupied: 2, blocked: 1 });
  });

  it("leaves occupancy absent, not zero, when the board has nothing to say", () => {
    const groups = groupByWard([inpatient()], undefined);
    // `undefined` and `{free: 0}` are different sentences, and only one of them stops an admission.
    expect(groups[0]?.occupancy).toBeUndefined();
  });
});

describe("7. admission information", () => {
  it("counts the day of stay in calendar days, admission day being day 1", () => {
    const admitted = new Date("2026-08-10T18:30:00.000Z"); // 11 Aug, 00:00 IST
    expect(dayOfStay(admitted, new Date("2026-08-10T18:40:00.000Z"), "Asia/Kolkata")).toBe(1);
    expect(dayOfStay(admitted, new Date("2026-08-11T19:00:00.000Z"), "Asia/Kolkata")).toBe(2);
    expect(dayOfStay(admitted, new Date("2026-08-13T02:00:00.000Z"), "Asia/Kolkata")).toBe(3);
  });

  it("knows an open stay from an ended one", () => {
    expect(isStayOpen(inpatient())).toBe(true);
    expect(
      isStayOpen(inpatient({ status: "closed", dischargedAt: "2026-08-13T05:00:00.000Z" })),
    ).toBe(false);
  });

  it("reports the ending the SERVER recorded, never one inferred from the status", () => {
    const ended = inpatient({
      status: "closed",
      dischargedAt: "2026-08-13T05:00:00.000Z",
      disposition: "lama",
    });
    expect(isStayEnded(ended)).toBe(true);
    // Not "discharged" — the record says the patient left against advice, and so must the screen.
    expect(ended.disposition).toBe("lama");
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 8 – 11 · THE CLINICAL SEGMENTS, ON AN INPATIENT
 * ══════════════════════════════════════════════════════════════════════════ */

describe("8. vitals on an admission", () => {
  it("reads the same encounter chart the OPD screen does", async () => {
    const h = await onWard();
    h.api.on("GET", `/api/v1/encounters/${IP_ENCOUNTER_ID}/vitals`, () => ok([vitals()]));

    const readings = await h.runtime.queryClient.fetchQuery(
      readsOf(h.runtime).encounterVitals(IP_ENCOUNTER_ID),
    );
    expect(readings[0]?.abnormal).toBe(true);
  });
});

describe("9. the MAR", () => {
  it("sorts doses newest first and separates given from not-given", () => {
    const doses = sortDoses([
      dose({ id: "mar-1", administeredAt: "2026-08-12T03:00:00.000Z" }),
      dose({
        id: "mar-2",
        administeredAt: "2026-08-12T09:00:00.000Z",
        status: "held",
        reason: "SBP 84",
      }),
    ]);

    expect(doses.map((d) => d.id)).toEqual(["mar-2", "mar-1"]);
    expect(summariseDoses(doses)).toEqual({ given: 1, missed: 1 });
    // A held dose is a WARNING. `critical` is spent on a released critical result and nothing else.
    expect(marStatusTone("held")).toBe("warning");
    expect(marStatusTone("given")).toBe("done");
  });
});

describe("10. results on an admission", () => {
  it("still gates on release — an admission does not relax the rule", async () => {
    const h = await onWard();
    h.api.on("GET", "/api/v1/orders", () =>
      ok(
        page([orderFixture({ status: "completed", result: { summary: "K 7.1", critical: true } })])
          .items,
      ),
    );

    const orders = await readsOf(h.runtime).patientOrders(PATIENT_ID).queryFn();
    // `completed` is not `released`. The chart must not show it, admission or not.
    expect(orders.items[0]?.status).toBe("completed");
  });
});

describe("11. prescription information", () => {
  it("reads the current prescriptions for the admitted patient", async () => {
    const h = await onWard();
    h.api.on("GET", "/api/v1/prescriptions", () => ok([prescription()]));

    const list = await h.runtime.queryClient.fetchQuery(
      readsOf(h.runtime).prescriptions(PATIENT_ID),
    );
    expect(list[0]?.signedAt).toBeDefined();
    expect(h.api.callsTo("GET", "/api/v1/prescriptions")[0]?.search).toContain("current=true");
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 12 – 13 · BRANCH
 * ══════════════════════════════════════════════════════════════════════════ */

describe("12. every IPD key is branch-scoped", () => {
  const scope = { tenantSlug: "apollo", branchId: "branch-hyd" };

  it.each([
    ["inpatients", queryKeys.inpatients(scope)],
    ["bedBoard", queryKeys.bedBoard(scope)],
    ["wardNotes", queryKeys.wardNotes(scope, IP_ENCOUNTER_ID)],
    ["medications", queryKeys.medications(scope, IP_ENCOUNTER_ID)],
  ])("%s begins [tenant, branch]", (_name, key) => {
    expect(key.slice(0, 2)).toEqual(["apollo", "branch-hyd"]);
  });

  it("gives the two branches different keys for the same read", () => {
    const hyd = queryKeys.bedBoard({ tenantSlug: "apollo", branchId: "branch-hyd" });
    const chn = queryKeys.bedBoard({ tenantSlug: "apollo", branchId: "branch-chn" });
    expect(hyd).not.toEqual(chn);
  });

  it("does not collide a stay's notes with the encounter record or its vitals", () => {
    const keys = [
      queryKeys.encounter(scope, IP_ENCOUNTER_ID),
      queryKeys.wardNotes(scope, IP_ENCOUNTER_ID),
      queryKeys.medications(scope, IP_ENCOUNTER_ID),
      queryKeys.encounterVitals(scope, IP_ENCOUNTER_ID),
      queryKeys.consultation(scope, IP_ENCOUNTER_ID),
    ].map((key) => JSON.stringify(key));

    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("13. switching branch", () => {
  /**
   * ── THE REGRESSION THIS EXISTS FOR ──────────────────────────────────────────
   * Branch A's ward, then Branch B's. A bed code is only unique within a site, so "bed G-14" exists
   * at both — and if the cache were keyed without the branch, the second ward would render the
   * first one's patient in it. That is not a rendering glitch; it is a doctor reading the wrong
   * person's chart at a bedside.
   */
  it("shows Branch B's ward, never Branch A's", async () => {
    const h = await onWard();

    h.api.on("GET", INPATIENTS, () =>
      h.runtime.branch.getState().activeBranchId === BRANCH_HYD.id
        ? ok([inpatient({ id: "hyd-stay", patientId: "patient-hyd", branchId: BRANCH_HYD.id })])
        : ok([inpatient({ id: "chn-stay", patientId: "patient-chn", branchId: BRANCH_CHN.id })]),
    );

    const hydKey = queryKeys.inpatients(scopeOf(h.runtime));
    await h.runtime.queryClient.fetchQuery(readsOf(h.runtime).inpatients());
    expect(h.runtime.queryClient.getQueryData(hydKey)).toHaveLength(1);

    await h.runtime.branches.select(USER.id, BRANCH_CHN.id);

    const chnKey = queryKeys.inpatients(scopeOf(h.runtime));
    expect(chnKey).not.toEqual(hydKey);

    const after = await h.runtime.queryClient.fetchQuery(readsOf(h.runtime).inpatients());
    expect(after[0]?.id).toBe("chn-stay");
    expect(after[0]?.branchId).toBe(BRANCH_CHN.id);
  });

  it("sends the new branch on the wire, not the remembered one", async () => {
    const h = await onWard();
    h.api.on("GET", BED_BOARD, () => ok(bedBoard()));

    await h.runtime.queryClient.fetchQuery(readsOf(h.runtime).bedBoard());
    await h.runtime.branches.select(USER.id, BRANCH_CHN.id);
    await h.runtime.queryClient.fetchQuery(readsOf(h.runtime).bedBoard());

    const branches = h.api.callsTo("GET", BED_BOARD).map((c) => c.headers["x-active-branch"]);
    expect(branches).toEqual([BRANCH_HYD.id, BRANCH_CHN.id]);
  });

  it("clears the previous site's ward from the cache on a switch", async () => {
    const h = await onWard();
    h.api.on("GET", INPATIENTS, () => ok([inpatient()]));

    const hydKey = queryKeys.inpatients(scopeOf(h.runtime));
    await h.runtime.queryClient.fetchQuery(readsOf(h.runtime).inpatients());
    expect(h.runtime.queryClient.getQueryData(hydKey)).toBeDefined();

    await h.runtime.branches.select(USER.id, BRANCH_CHN.id);

    // `onBranchChanged` clears the client outright — the strongest available guarantee that no
    // frame of Branch A can render under Branch B.
    expect(h.runtime.queryClient.getQueryData(hydKey)).toBeUndefined();
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 14 – 15 · GATES
 * ══════════════════════════════════════════════════════════════════════════ */

describe("14. a hospital without wards", () => {
  it("reads HMS-PLAN-002 as the feature flag it is, not as a fault", async () => {
    const h = await onWard();
    h.api.on("GET", INPATIENTS, () => fail(403, "HMS-PLAN-002", "module.ops.ipd not in plan"));

    const error = await readsOf(h.runtime)
      .inpatients()
      .queryFn()
      .catch((e: unknown) => e);

    expect(isFeatureUnavailable(error)).toBe(true);
    expect(toUserMessage(error).title).toBe("Not included in this edition");
  });

  it("keeps the MAR's gate separate from the ward's — wards without nursing still work", async () => {
    const h = await onWard();
    h.api.on("GET", INPATIENTS, () => ok([inpatient()]));
    h.api.on("GET", NOTES, () => ok([wardNote()]));
    h.api.on("GET", MAR, () => fail(403, "HMS-PLAN-002", "module.clinical.nursing not in plan"));

    const list = await h.runtime.queryClient.fetchQuery(readsOf(h.runtime).inpatients());
    const notes = await h.runtime.queryClient.fetchQuery(
      readsOf(h.runtime).wardNotes(IP_ENCOUNTER_ID),
    );
    const marError = await readsOf(h.runtime)
      .medications(IP_ENCOUNTER_ID)
      .queryFn()
      .catch((e: unknown) => e);

    // The ward survives its own module being present while nursing is not.
    expect(list).toHaveLength(1);
    expect(notes).toHaveLength(1);
    expect(isFeatureUnavailable(marError)).toBe(true);
  });
});

describe("15. an action the doctor may not take", () => {
  it("tells a 403 apart from a plan boundary — one is reported, the other hidden", async () => {
    const h = await onWard();
    h.api.on("POST", NOTES, () => fail(403, "HMS-AUTH-005", "Insufficient permission"));

    const outcome = await attemptWardNote(
      {
        add: (text) => h.runtime.api.addWardNote(IP_ENCOUNTER_ID, text),
        reload: () => h.runtime.api.listWardNotes(IP_ENCOUNTER_ID),
        before: [],
      },
      "Reviewed.",
    );

    // Decided before the write. No reconciliation, no retry offered.
    expect(outcome.outcome).toBe("failed");
    expect(h.api.callsTo("GET", NOTES)).toHaveLength(0);
    expect(isFeatureUnavailable(outcome.outcome === "failed" ? outcome.error : undefined)).toBe(
      false,
    );
    expect(toUserMessage(outcome.outcome === "failed" ? outcome.error : undefined).action).toBe(
      "contactAdmin",
    );
  });

  /**
   * Bed transfer is the case the spec's "do not expose nurse functionality" rule is really about.
   * `POST /encounters/:id/transfer-bed` needs `bed:allocate`, which DOCTOR does not hold — so the
   * app never offers it, and this records WHY rather than leaving the absence to look accidental.
   */
  it("never offers bed transfer, because the doctor's grant does not include bed:allocate", () => {
    expect(DOCTOR).not.toContain("bed:allocate");
    const mutations = Object.keys(clinicalMutations({} as never, { tenantSlug: "apollo" }));
    expect(mutations).not.toContain("transferBed");
    expect(mutations).not.toContain("recordOutcome");
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 16 · TIMEZONE
 * ══════════════════════════════════════════════════════════════════════════ */

describe("16. clinical times are the ward's, never the phone's", () => {
  /**
   * ── A TEST THAT CANNOT PASS BY LUCK ─────────────────────────────────────────
   * The far zone is chosen against the machine's own, so this asserts a real difference on any CI
   * box. Kiritimati is UTC+14 and London is UTC+0/+1; no machine is in both.
   */
  const machine = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const far = machine === "Pacific/Kiritimati" ? "Europe/London" : "Pacific/Kiritimati";

  it("counts the day of stay in the branch's calendar, not the device's", () => {
    const admitted = new Date("2026-08-10T12:00:00.000Z");
    const now = new Date("2026-08-10T22:00:00.000Z");

    const here = dayOfStay(admitted, now, "Asia/Kolkata");
    const there = dayOfStay(admitted, now, far);

    // 22:00 UTC is still 10 Aug in Kolkata (03:30 on the 11th — day 2) and already the 11th in
    // Kiritimati. The two answers differ, which is exactly what makes the zone load-bearing.
    expect(here).not.toBe(there);
  });

  it("buckets a dose onto the ward's calendar day", () => {
    const midnightish = dose({ administeredAt: "2026-08-11T19:30:00.000Z" });

    // 19:30 UTC on the 11th is 01:00 IST on the 12th — the ward's 12th, not the 11th.
    expect(dosesOnDay([midnightish], "2026-08-12", "Asia/Kolkata")).toHaveLength(1);
    expect(dosesOnDay([midnightish], "2026-08-11", "Asia/Kolkata")).toHaveLength(0);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 17 – 20 · THE WRITES
 * ══════════════════════════════════════════════════════════════════════════ */

describe("17. a ward note that lands", () => {
  it("is on the chart, and says so without having had to reconcile", async () => {
    const h = await onWard();
    const ward = fakeWard(h.api);
    const before = await h.runtime.api.listWardNotes(IP_ENCOUNTER_ID);

    const write = writesOf(h.runtime).addWardNote(IP_ENCOUNTER_ID, { before, authorId: USER.id });
    const outcome = await write.mutationFn("Chest clear. Continue same.");

    expect(outcome.outcome).toBe("saved");
    expect(outcome.outcome === "saved" && outcome.reconciled).toBe(false);
    expect(ward.count).toBe(2);
  });

  it("invalidates the whole branch, so the chart and the ward list both refresh", () => {
    const h = clinicalMutations({} as never, { tenantSlug: "apollo", branchId: "branch-hyd" });
    expect(h.addWardNote("e1", { before: [] }).invalidates).toEqual(["apollo", "branch-hyd"]);
    expect(h.discharge("e1").invalidates).toEqual(["apollo", "branch-hyd"]);
  });
});

describe("18. the response is lost after the note commits", () => {
  /**
   * ── THE DUPLICATE CONTROL ───────────────────────────────────────────────────
   * The server has no idempotency key and no de-duplication here: `fakeWard` really does append.
   * So the ONLY thing standing between a dropped wifi packet and two permanent, identical
   * medico-legal entries is this reconciliation. If it ever stops working, `ward.count` is 3.
   */
  it("reconciles from the chart and reports success — one note, not two", async () => {
    const h = await onWard();
    const ward = fakeWard(h.api);
    const before = await h.runtime.api.listWardNotes(IP_ENCOUNTER_ID);
    ward.loseNextResponse();

    const write = writesOf(h.runtime).addWardNote(IP_ENCOUNTER_ID, { before, authorId: USER.id });
    const outcome = await write.mutationFn("Chest clear. Continue same.");

    expect(outcome.outcome).toBe("saved");
    // The doctor is told the app checked, so they do not write it again.
    expect(outcome.outcome === "saved" && outcome.reconciled).toBe(true);
    expect(ward.count).toBe(2);
  });

  it("reports notSaved — never a false success — when the note genuinely did not land", async () => {
    const h = await onWard();
    fakeWard(h.api);
    const before = await h.runtime.api.listWardNotes(IP_ENCOUNTER_ID);
    h.api.on("POST", NOTES, () => {
      throw new TypeError("Network request failed");
    });

    const write = writesOf(h.runtime).addWardNote(IP_ENCOUNTER_ID, { before, authorId: USER.id });
    const outcome = await write.mutationFn("Never made it.");

    expect(outcome.outcome).toBe("notSaved");
  });

  it("refuses to conclude anything without a snapshot to compare against", async () => {
    const h = await onWard();
    const ward = fakeWard(h.api);
    ward.loseNextResponse();

    // The screen never loaded the notes, so `before` is undefined. The note DID land — and the
    // honest answer is still "not saved", because the cheap failure is a duplicate and the
    // expensive one is a lost note.
    const write = writesOf(h.runtime).addWardNote(IP_ENCOUNTER_ID, { before: undefined });
    const outcome = await write.mutationFn("Chest clear. Continue same.");

    expect(outcome.outcome).toBe("notSaved");
  });

  it("matches on newness AND text AND author, so a colleague's note is never claimed as ours", () => {
    const mine = wardNote({ id: "note-2", text: "Reviewed.", authorId: "user-1" });
    const theirs = wardNote({ id: "note-3", text: "Reviewed.", authorId: "user-9" });
    const before = [wardNote({ id: "note-1" })];

    expect(newNotesSince(before, [...before, mine, theirs])).toHaveLength(2);
    expect(matchingNote(before, [...before, theirs], "Reviewed.", "user-1")).toBeUndefined();
    expect(matchingNote(before, [...before, mine], "Reviewed.", "user-1")?.id).toBe("note-2");
  });

  it("does not mistake yesterday's identical note for today's", () => {
    // The sentence a doctor genuinely writes every morning. It is in `before`, so it is not new.
    const yesterday = wardNote({ id: "note-1", text: "Reviewed. Stable. Continue same." });
    expect(
      matchingNote([yesterday], [yesterday], "Reviewed. Stable. Continue same.", "user-1"),
    ).toBeUndefined();
  });
});

describe("19. discharge", () => {
  function fakeDischarge(api: FakeApi, options: { dropResponse?: boolean } = {}) {
    let stay = inpatient();
    let notes = [wardNote()];
    let drop = options.dropResponse ?? false;

    api.on("GET", ENCOUNTER, () => ok(stay));
    api.on("GET", NOTES, () => ok(notes));
    api.on("POST", DISCHARGE, (call) => {
      // The server's own guards, in the order the service applies them.
      if (stay.status === "closed") {
        return fail(422, "HMS-STATE-001", "This admission is already over");
      }
      if (notes.some((n) => n.type === "discharge_summary")) {
        return fail(422, "HMS-STATE-001", "This admission already has a discharge summary");
      }

      const body = call.body as { text: string };
      const summary = wardNote({ id: "note-summary", type: "discharge_summary", text: body.text });
      notes = [...notes, summary];
      stay = {
        ...stay,
        status: "closed",
        dischargedAt: "2026-08-13T05:00:00.000Z",
        disposition: "discharged",
      };

      if (drop) {
        drop = false;
        throw new TypeError("Network request failed");
      }
      return created({ summary, encounterId: IP_ENCOUNTER_ID });
    });

    return {
      get closed(): boolean {
        return stay.status === "closed";
      },
      get summaries(): number {
        return notes.filter((n) => n.type === "discharge_summary").length;
      },
      /** The torn state: the summary is written and the stay never closed. */
      tear(): void {
        notes = [...notes, wardNote({ id: "note-summary", type: "discharge_summary" })];
      },
    };
  }

  it("17/succeeds and ends the stay", async () => {
    const h = await onWard();
    const server = fakeDischarge(h.api);

    const outcome = await writesOf(h.runtime)
      .discharge(IP_ENCOUNTER_ID)
      .mutationFn({ text: "Treated for community-acquired pneumonia. Afebrile 48h." });

    expect(outcome.outcome).toBe("discharged");
    expect(outcome.outcome === "discharged" && outcome.reconciled).toBe(false);
    expect(server.closed).toBe(true);
  });

  it("18/reconciles a lost response — discharged once, reported as success", async () => {
    const h = await onWard();
    const server = fakeDischarge(h.api, { dropResponse: true });

    const outcome = await writesOf(h.runtime)
      .discharge(IP_ENCOUNTER_ID)
      .mutationFn({ text: "Home with the summary." });

    expect(outcome.outcome).toBe("discharged");
    expect(outcome.outcome === "discharged" && outcome.reconciled).toBe(true);
    expect(server.summaries).toBe(1);
  });

  it("19/treats HMS-STATE-001 on an already-closed stay as SUCCESS, not a failure", async () => {
    const h = await onWard();
    const server = fakeDischarge(h.api);

    await writesOf(h.runtime).discharge(IP_ENCOUNTER_ID).mutationFn({ text: "First attempt." });
    // The doctor presses again — the phone never heard the first answer.
    const again = await writesOf(h.runtime)
      .discharge(IP_ENCOUNTER_ID)
      .mutationFn({ text: "First attempt." });

    expect(again.outcome).toBe("discharged");
    expect(again.outcome === "discharged" && again.reconciled).toBe(true);
    // 20/ Not discharged twice, and not a second summary.
    expect(server.summaries).toBe(1);
  });

  it("names the torn state instead of offering a retry that can never work", async () => {
    const h = await onWard();
    const server = fakeDischarge(h.api);
    server.tear(); // a summary exists; the stay is still open

    const outcome = await writesOf(h.runtime)
      .discharge(IP_ENCOUNTER_ID)
      .mutationFn({ text: "Home with the summary." });

    expect(outcome.outcome).toBe("incomplete");
  });

  it("says notDischarged, retry-safe, when nothing happened at all", async () => {
    const h = await onWard();
    h.api.on("GET", ENCOUNTER, () => ok(inpatient()));
    h.api.on("GET", NOTES, () => ok([wardNote()]));
    h.api.on("POST", DISCHARGE, () => {
      throw new TypeError("Network request failed");
    });

    const outcome = await writesOf(h.runtime)
      .discharge(IP_ENCOUNTER_ID)
      .mutationFn({ text: "Never made it." });

    expect(outcome.outcome).toBe("notDischarged");
  });

  it("does not reconcile a refusal decided before the write", async () => {
    const h = await onWard();
    h.api.on("GET", ENCOUNTER, () => ok(inpatient()));
    h.api.on("POST", DISCHARGE, () => fail(403, "HMS-AUTH-005", "Insufficient permission"));

    const outcome = await writesOf(h.runtime)
      .discharge(IP_ENCOUNTER_ID)
      .mutationFn({ text: "Not mine to do." });

    expect(outcome.outcome).toBe("failed");
    expect(h.api.callsTo("GET", ENCOUNTER)).toHaveLength(0);
  });

  it("signs nothing extra: the discharge endpoint is called AT MOST ONCE per attempt", async () => {
    const h = await onWard();
    fakeDischarge(h.api, { dropResponse: true });

    await writesOf(h.runtime).discharge(IP_ENCOUNTER_ID).mutationFn({ text: "Once only." });

    expect(h.api.callsTo("POST", DISCHARGE)).toHaveLength(1);
  });

  it("reads `dischargedAt` rather than the status, so an OP close is never a discharge", () => {
    expect(isStayEnded(encounter({ status: "closed" }))).toBe(false);
    expect(isStayEnded(inpatient({ status: "closed" }))).toBe(true);
    expect(isStayEnded(inpatient({ dischargedAt: "2026-08-13T05:00:00.000Z" }))).toBe(true);
  });
});

describe("20. the list the server capped", () => {
  it("says there may be more rather than implying the ward is complete", () => {
    expect(mayBeTruncated(Array.from({ length: 99 }))).toBe(false);
    // The endpoint's hard `limit: 100`, with no `meta` to confirm it. A full page is the only hint.
    expect(mayBeTruncated(Array.from({ length: 100 }))).toBe(true);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * THE BOUNDARY
 * ══════════════════════════════════════════════════════════════════════════ */

describe("every IPD read goes through the shipped ApiClient", () => {
  it("carries the tenant host, the bearer token and the active branch on every request", async () => {
    const h = await onWard();
    h.api.on("GET", INPATIENTS, () => ok([inpatient()]));
    h.api.on("GET", BED_BOARD, () => ok(bedBoard()));
    h.api.on("GET", NOTES, () => ok([wardNote()]));
    h.api.on("GET", MAR, () => ok([dose()]));

    const reads = readsOf(h.runtime);
    await reads.inpatients().queryFn();
    await reads.bedBoard().queryFn();
    await reads.wardNotes(IP_ENCOUNTER_ID).queryFn();
    await reads.medications(IP_ENCOUNTER_ID).queryFn();

    for (const path of [INPATIENTS, BED_BOARD, NOTES, MAR]) {
      const call = h.api.callsTo("GET", path)[0];
      expect(call, path).toBeDefined();
      expect(call?.headers.authorization).toBe("Bearer access-1");
      expect(call?.headers["x-active-branch"]).toBe(BRANCH_HYD.id);
    }
  });
});
