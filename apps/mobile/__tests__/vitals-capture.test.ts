/**
 * Charting observations from the phone (M3-S4).
 *
 * ── THE THREE PROPERTIES THIS SUITE EXISTS FOR ──────────────────────────────
 *
 *   1. THE PHONE NEVER DECIDES WHAT IS ABNORMAL. It checks a figure is PLAUSIBLE — a typo guard,
 *      mirroring the server's own bounds — and stops. `high` / `low` / `normal` come from the
 *      API's `assess()`, and there is a structural scan below that stops a reference range from
 *      creeping into the entry code later.
 *
 *   2. A NURSE'S FIGURE IS NEVER SILENTLY CHANGED. Nothing is clamped, rounded into range, or
 *      dropped without being flagged. A 350 systolic gets "check this figure" and stays 350 on
 *      screen; it does not become 300.
 *
 *   3. A LOST RESPONSE NEVER PRODUCES A SECOND READING, AND NEVER A FALSE "SAVED". The idempotency
 *      key makes the retry a replay; the reconciliation tells the nurse which of the two things
 *      actually happened, and refuses to conclude "saved" without evidence.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ApiClientError, VITAL_FIELDS, type VitalsReading } from "@medicore/api-client";
import { queryKeys } from "../src/query/keys";
import {
  ENTRY_ORDER,
  FIELD_RULES,
  canSubmit,
  isDirty,
  parseDraft,
  problemsByField,
  problemsFor,
  reviewLines,
  toPayload,
  type VitalsDraft,
} from "../src/clinical/vitalsEntry";
import {
  attemptVitals,
  matchingReading,
  newReadingsSince,
  type VitalsWriteDeps,
} from "../src/clinical/vitalsWrite";

const scope = { tenantSlug: "apollo", branchId: "branch-a" };

function reading(over: Partial<VitalsReading> = {}): VitalsReading {
  return {
    id: "v1",
    encounterId: "e1",
    patientId: "p1",
    pulse: 72,
    recordedBy: "nurse-1",
    recordedAt: "2026-06-11T09:00:00.000Z",
    flags: { pulse: "normal" },
    abnormal: false,
    ...over,
  };
}

/* ── 1. reading what was typed ─────────────────────────────────────────────── */

describe("parsing a draft", () => {
  it("omits a blank box rather than sending zero", () => {
    const parsed = parseDraft({ pulse: "72", systolic: "", temperature: "   " });
    expect(parsed.values).toEqual({ pulse: 72 });
    expect(parsed.problems).toEqual([]);
  });

  /**
   * The single most dangerous default in a clinical form. A blank pulse box that becomes `pulse:
   * 0` charts a cardiac arrest on a patient who is sitting up talking.
   */
  it("never turns an empty field into a measurement", () => {
    expect(toPayload({ pulse: "", spo2: "" })).toEqual({});
  });

  it("accepts a decimal only where the domain has decimals", () => {
    expect(parseDraft({ temperature: "37.4" }).values).toEqual({ temperature: 37.4 });
    expect(parseDraft({ pulse: "72.5" }).problems[0]?.field).toBe("pulse");
  });

  it("rejects text that is not a number", () => {
    expect(parseDraft({ pulse: "abc" }).problems[0]?.message).toContain("must be a number");
  });
});

/* ── 2. plausible is not the same as normal ────────────────────────────────── */

describe("plausibility, not clinical judgement", () => {
  /**
   * The distinction this whole module rests on. A systolic of 250 is a hypertensive emergency and
   * the chart is what PROVES it — refusing to record it would be refusing to chart the sickest
   * patients in the hospital, who are the ones the chart exists for.
   */
  it("accepts a frighteningly abnormal but physically possible figure", () => {
    const parsed = parseDraft({ systolic: "250", diastolic: "130", spo2: "82", pulse: "180" });
    expect(parsed.problems).toEqual([]);
    expect(parsed.values).toEqual({ systolic: 250, diastolic: 130, spo2: 82, pulse: 180 });
  });

  it("refuses a figure outside physical possibility", () => {
    expect(parseDraft({ systolic: "2500" }).problems[0]?.field).toBe("systolic");
  });

  /**
   * ── THE NO-CLAMP CONTROL ──────────────────────────────────────────────────
   * The out-of-bounds value must not survive into the payload in ANY form — not clamped to the
   * maximum, not rounded, not silently dropped while the nurse believes it was taken. It is
   * withheld AND reported, so the figure on screen and the figure in the chart can never differ
   * without somebody being told.
   */
  it("does not clamp an out-of-range figure to the boundary", () => {
    const draft: VitalsDraft = { systolic: "350", pulse: "80" };
    expect(toPayload(draft).systolic).toBeUndefined();
    expect(toPayload(draft)).not.toMatchObject({ systolic: 300 });
    expect(problemsFor(draft).map((p) => p.field)).toEqual(["systolic"]);
    // …and the entry is not submittable while the figure is unresolved.
    expect(canSubmit(draft)).toBe(false);
  });

  it("words an out-of-range message as a prompt to check, not to delete", () => {
    expect(problemsFor({ spo2: "5" })[0]?.message).toContain("Check this figure");
  });

  /**
   * The bounds are the SERVER's, copied. If `vitals.schema.ts` ever changes one, this table has
   * to change with it — the phone rejecting what the API accepts is a box a nurse cannot fill in,
   * and the phone accepting what the API rejects is a round trip that fails at the bedside.
   */
  it("mirrors the server's plausibility bounds exactly", () => {
    expect(FIELD_RULES.systolic).toMatchObject({ min: 40, max: 300 });
    expect(FIELD_RULES.diastolic).toMatchObject({ min: 20, max: 200 });
    expect(FIELD_RULES.pulse).toMatchObject({ min: 20, max: 300 });
    expect(FIELD_RULES.respiratoryRate).toMatchObject({ min: 4, max: 90 });
    expect(FIELD_RULES.temperature).toMatchObject({ min: 25, max: 45 });
    expect(FIELD_RULES.spo2).toMatchObject({ min: 40, max: 100 });
    expect(FIELD_RULES.weightKg).toMatchObject({ min: 0.3, max: 500 });
    expect(FIELD_RULES.heightCm).toMatchObject({ min: 20, max: 260 });
    expect(FIELD_RULES.painScore).toMatchObject({ min: 0, max: 10 });
  });

  /** Every measurable field the API knows must be enterable, or it is a box nobody can fill. */
  it("offers every field the API accepts", () => {
    expect([...ENTRY_ORDER].sort()).toEqual([...VITAL_FIELDS].sort());
  });
});

/* ── 3. the one cross-field rule ───────────────────────────────────────────── */

describe("blood pressure the right way round", () => {
  it("refuses a diastolic at or above the systolic", () => {
    expect(problemsFor({ systolic: "80", diastolic: "120" })[0]?.field).toBe("diastolic");
    expect(problemsFor({ systolic: "120", diastolic: "120" })[0]?.field).toBe("diastolic");
  });

  it("accepts the pair the right way round", () => {
    expect(problemsFor({ systolic: "120", diastolic: "80" })).toEqual([]);
  });

  it("says nothing when only one half was measured", () => {
    expect(problemsFor({ systolic: "120" })).toEqual([]);
  });
});

/* ── 4. what may be sent at all ────────────────────────────────────────────── */

describe("submitting", () => {
  it("allows a single measurement — a pulse alone is a real observation", () => {
    expect(canSubmit({ pulse: "72" })).toBe(true);
  });

  it("allows a triage level with no measurements, exactly as the server does", () => {
    expect(canSubmit({ triageLevel: "urgent" })).toBe(true);
  });

  it("refuses an empty form", () => {
    expect(canSubmit({})).toBe(false);
    expect(canSubmit({ notes: "patient asleep" })).toBe(false);
  });

  it("refuses while any figure is unresolved", () => {
    expect(canSubmit({ pulse: "72", spo2: "999" })).toBe(false);
  });

  it("counts a note alone as unsaved work worth warning about", () => {
    expect(isDirty({ notes: "hello" })).toBe(true);
    expect(isDirty({})).toBe(false);
  });

  /**
   * `recordedAt` is deliberately NOT sent. The observation is stamped by the SERVER's clock; a
   * handset with the wrong time must not be able to backdate a real reading, and the API's
   * back-dating path exists for a paper catch-up at a desk, not a phone at a bedside.
   */
  it("never sends a client-generated timestamp", () => {
    expect(toPayload({ pulse: "72" })).not.toHaveProperty("recordedAt");
  });

  it("trims a note and drops an empty one", () => {
    expect(toPayload({ pulse: "72", notes: "  left arm  " }).notes).toBe("left arm");
    expect(toPayload({ pulse: "72", notes: "   " })).not.toHaveProperty("notes");
  });
});

/* ── 5. the review shows what will be sent ─────────────────────────────────── */

describe("review before save", () => {
  it("reads blood pressure as one figure, with its unit", () => {
    const lines = reviewLines({ systolic: "120", diastolic: "80" });
    expect(lines[0]).toEqual({ label: "Blood pressure", value: "120/80 mmHg" });
    // …and not also as two separate rows, which would read as four numbers.
    expect(lines.map((l) => l.label)).toEqual(["Blood pressure"]);
  });

  it("shows a lone systolic as its own row rather than inventing a pair", () => {
    expect(reviewLines({ systolic: "120" })).toEqual([{ label: "BP systolic", value: "120 mmHg" }]);
  });

  /** In `ENTRY_ORDER` — the order taken at the bedside — not the order the object was built in. */
  it("puts a unit on every measurement, in entry order", () => {
    const lines = reviewLines({ temperature: "38.2", spo2: "94", painScore: "6" });
    expect(lines.map((l) => l.value)).toEqual(["94 %", "38.2 °C", "6 /10"]);
  });

  /**
   * The review is built from the PAYLOAD, so a rejected box cannot appear on it. Confirming a
   * figure that will never be sent is the one thing a review stage must not allow.
   */
  it("never shows a figure the payload will not carry", () => {
    const lines = reviewLines({ pulse: "72", spo2: "999" });
    expect(lines.map((l) => l.label)).toEqual(["Pulse"]);
  });
});

/* ── 6. field errors reach the right box ───────────────────────────────────── */

describe("error placement", () => {
  it("indexes problems by field in the shape the input renders", () => {
    const byField = problemsByField(problemsFor({ systolic: "9999", pulse: "abc" }));
    expect(byField.systolic).toHaveLength(1);
    expect(byField.pulse).toHaveLength(1);
    expect(byField.spo2).toBeUndefined();
  });
});

/* ── 7. a lost response ────────────────────────────────────────────────────── */

const before = [reading({ id: "old" })];

function deps(over: Partial<VitalsWriteDeps> = {}): VitalsWriteDeps {
  return {
    record: () => Promise.reject(new Error("network")),
    reload: () => Promise.resolve([...before]),
    before,
    recordedBy: "nurse-1",
    ...over,
  };
}

describe("saving when the network is not certain", () => {
  it("reports a clean 201 as saved, not reconciled", async () => {
    const fresh = reading({ id: "new" });
    const outcome = await attemptVitals(deps({ record: () => Promise.resolve(fresh) }));
    expect(outcome).toEqual({ outcome: "saved", reading: fresh, reconciled: false });
  });

  /**
   * The case the whole module exists for: the observation landed, the response did not come back.
   * Re-reading the chart finds a reading that was not there before and reports it as saved —
   * because the alternative is a nurse who charts it again.
   */
  it("finds a reading that landed after a dropped connection", async () => {
    const landed = reading({ id: "new" });
    const outcome = await attemptVitals(
      deps({ reload: () => Promise.resolve([...before, landed]) }),
    );
    expect(outcome).toEqual({ outcome: "saved", reading: landed, reconciled: true });
  });

  it("reports notSaved when the chart is unchanged", async () => {
    expect((await attemptVitals(deps())).outcome).toBe("notSaved");
  });

  /**
   * ── THE ASYMMETRY RULE ────────────────────────────────────────────────────
   * No snapshot means no conclusion. Wrongly saying "saved" loses an observation permanently;
   * wrongly saying "not saved" costs, at worst, a replayed request that writes nothing.
   */
  it("refuses to conclude anything without a baseline", async () => {
    const outcome = await attemptVitals(deps({ before: undefined }));
    expect(outcome.outcome).toBe("notSaved");
  });

  it("reports notSaved when the re-read also fails", async () => {
    const outcome = await attemptVitals(
      deps({ reload: () => Promise.reject(new Error("still offline")) }),
    );
    expect(outcome.outcome).toBe("notSaved");
  });

  /**
   * A colleague charting the same patient at the same moment must not have their reading claimed
   * as ours — that would report a save that never happened and lose the nurse's observation.
   */
  it("does not claim another nurse's reading as ours", async () => {
    const theirs = reading({ id: "new", recordedBy: "nurse-2" });
    const outcome = await attemptVitals(
      deps({ reload: () => Promise.resolve([...before, theirs]) }),
    );
    expect(outcome.outcome).toBe("notSaved");
  });

  /** Identical VALUES from an earlier reading are not evidence: only a new id is. */
  it("matches on identity, never on the numbers", () => {
    const identical = [reading({ id: "old", pulse: 72 })];
    expect(matchingReading(identical, identical, "nurse-1")).toBeUndefined();
    expect(newReadingsSince(identical, identical)).toEqual([]);
  });

  it("returns the oldest of several new readings — the one this attempt created", () => {
    const first = reading({ id: "a", recordedAt: "2026-06-11T09:05:00.000Z" });
    const second = reading({ id: "b", recordedAt: "2026-06-11T09:06:00.000Z" });
    expect(matchingReading(before, [...before, second, first], "nurse-1")?.id).toBe("a");
  });

  /* ── errors that need no reconciliation ── */

  const definite: [string, ApiClientError][] = [
    ["a validation refusal", new ApiClientError(400, "HMS-VAL-001", "Validation failed")],
    ["no permission", new ApiClientError(403, "HMS-AUTH-005", "Forbidden")],
    ["an expired session", new ApiClientError(401, "HMS-AUTH-002", "Unauthenticated")],
    ["a missing encounter", new ApiClientError(404, "HMS-GEN-404", "Not found")],
    ["a reused key on a different body", new ApiClientError(409, "HMS-REQ-002", "Conflict")],
  ];

  for (const [what, error] of definite) {
    it(`reports ${what} as failed without re-reading the chart`, async () => {
      let reloaded = false;
      const outcome = await attemptVitals(
        deps({
          record: () => Promise.reject(error),
          reload: () => {
            reloaded = true;
            return Promise.resolve([...before]);
          },
        }),
      );
      expect(outcome.outcome).toBe("failed");
      expect(reloaded).toBe(false);
    });
  }

  /**
   * `HMS-REQ-004` — the same key is still in flight — is NOT definite. The first attempt may be
   * committing right now, so the only honest answer comes from the chart.
   */
  it("reconciles an in-flight duplicate rather than declaring it failed", async () => {
    const landed = reading({ id: "new" });
    const outcome = await attemptVitals(
      deps({
        record: () => Promise.reject(new ApiClientError(409, "HMS-REQ-004", "In progress")),
        reload: () => Promise.resolve([...before, landed]),
      }),
    );
    expect(outcome).toMatchObject({ outcome: "saved", reconciled: true });
  });
});

/* ── 8. cache keys ─────────────────────────────────────────────────────────── */

describe("vitals query keys", () => {
  it("keeps the visit's chart and the patient's trend apart", () => {
    expect(queryKeys.encounterVitals(scope, "x")).not.toEqual(queryKeys.patientVitals(scope, "x"));
  });

  /** Same id, different meaning: an encounter's readings are not a patient's readings. */
  it("cannot collide when an encounter and a patient share an id string", () => {
    expect(queryKeys.encounterVitals(scope, "same")).not.toEqual(
      queryKeys.patientVitals(scope, "same"),
    );
  });

  it("carries the branch on both", () => {
    const other = { tenantSlug: "apollo", branchId: "branch-b" };
    expect(queryKeys.encounterVitals(scope, "e1")).not.toEqual(
      queryKeys.encounterVitals(other, "e1"),
    );
    expect(queryKeys.patientVitals(scope, "p1")).not.toEqual(queryKeys.patientVitals(other, "p1"));
  });

  it("does not collide with the visit's other per-encounter reads", () => {
    const keys = [
      queryKeys.encounterVitals(scope, "e1"),
      queryKeys.wardNotes(scope, "e1"),
      queryKeys.medications(scope, "e1"),
      queryKeys.medicationSchedule(scope, "e1"),
      queryKeys.consultation(scope, "e1"),
    ].map((k) => JSON.stringify(k));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

/* ── 9. structural: what the capture code may not contain ──────────────────── */

describe("the phone decides nothing clinical", () => {
  const read = (path: string): string =>
    readFileSync(join(__dirname, "..", path), "utf8")
      .replace(/\/\*\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

  const entry = read("src/clinical/vitalsEntry.ts");
  const screen = read("app/vitals/[encounterId].tsx");

  /**
   * ── THE SERVER-AUTHORITY CONTROL ──────────────────────────────────────────
   * The words that make something a clinical verdict rather than a typo guard. If a reference
   * range is ever pasted into the entry model, the phone starts disagreeing with the web app about
   * the same patient the first time the server's ranges are corrected — silently, and in the
   * direction nobody reviews.
   */
  for (const word of ["abnormal", "normal", "hypertens", "tachycard", "febrile", "hypox"]) {
    it(`does not use the word "${word}" to judge a value`, () => {
      expect(entry.toLowerCase()).not.toContain(word);
    });
  }

  it("never compares a measurement against a reference band", () => {
    // The plausibility bounds live in FIELD_RULES and are compared by name; a second table of
    // low/high pairs is what a smuggled-in reference range looks like.
    expect(entry).not.toMatch(/\b(RANGES|REFERENCE|NORMAL_RANGE)\b/);
    expect(entry).not.toMatch(/low:\s*\d/);
  });

  /** The saved reading's assessment is rendered from the server's response, never recomputed. */
  it("paints the server's own assessment after the save", () => {
    expect(screen).toContain("outcome.reading.abnormal");
  });

  /**
   * ── THE CLOCK CONTROL ─────────────────────────────────────────────────────
   * The entry model must hold no clock at all. A `recordedAt` built from the handset would let a
   * phone with the wrong time backdate a real observation into the middle of yesterday's chart.
   */
  it("reads no clock in the entry model", () => {
    expect(entry).not.toContain("Date.now(");
    expect(entry).not.toContain("new Date(");
  });

  it("sends no client timestamp from the screen either", () => {
    expect(screen).not.toContain("recordedAt:");
  });
});

/* ── 10. structural: the write path ────────────────────────────────────────── */

describe("the write path", () => {
  const read = (path: string): string =>
    readFileSync(join(__dirname, "..", path), "utf8")
      .replace(/\/\*\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

  const screen = read("app/vitals/[encounterId].tsx");
  const mutations = read("src/query/mutations.ts");

  /**
   * ── THE IDEMPOTENCY CONTROL ───────────────────────────────────────────────
   * `keyFor` returns the SAME string until `reset()`. Minting a key per press — the obvious
   * implementation — protects nothing: two presses become two keys and the server sees two
   * unrelated observations.
   */
  it("holds one intent key across the retries of one submission", () => {
    expect(screen).toContain('keys.keyFor("vitals")');
    expect(screen).toContain("keys.reset()");
  });

  it("passes the key through to the API call", () => {
    expect(mutations).toContain("api.recordVitals(encounterId, input, context.key)");
  });

  /** Every request goes through ApiClient — the only thing that carries auth and the branch. */
  it("never bypasses the api-client with a raw fetch", () => {
    expect(screen).not.toContain("fetch(");
    expect(screen).not.toContain("XMLHttpRequest");
  });

  /**
   * ── THE OPTIMISTIC-SUCCESS CONTROL ────────────────────────────────────────
   * No clinical record may be manufactured into the cache before the server confirms it. A row
   * that appears on the chart and then vanishes is worse than one that arrives a second late: the
   * nurse who saw it walks away.
   */
  it("creates no optimistic record", () => {
    expect(screen).not.toContain("setQueryData");
    expect(mutations).not.toContain("onMutate");
    expect(mutations).not.toContain("optimistic");
  });

  /**
   * "Saved" is said only about a CONFIRMED outcome, never about a pending one.
   *
   * ── THIS TEST WAS REWRITTEN BECAUSE FALSIFICATION DEFEATED IT ─────────────
   * The first version compared the file position of `label="Saved"` against the first
   * `outcome === "saved"` — and passed while the in-flight branch cheerfully rendered "Saved",
   * because an earlier unrelated occurrence of the guard satisfied the ordering. A control that
   * cannot fail is not a control.
   *
   * It now reads the in-flight branch ITSELF: whatever `WriteStatus` renders while the request is
   * outstanding must not claim anything landed. That is the property, stated directly.
   */
  it('never says "Saved" while the request is still in flight', () => {
    const start = screen.indexOf("if (saving) {");
    expect(start).toBeGreaterThanOrEqual(0);
    // The branch runs to its closing `}` at the same indentation — enough to read one block.
    const branch = screen.slice(start, screen.indexOf("\n  }", start));
    expect(branch).not.toContain("Saved");
    expect(branch).not.toContain("Recorded");
  });

  /** …and the confirmed branch is the one that may. */
  it('says "Saved" only under a confirmed outcome', () => {
    const confirmed = screen.indexOf('outcome?.outcome === "saved"');
    const claim = screen.indexOf('label="Saved"');
    expect(confirmed).toBeGreaterThanOrEqual(0);
    expect(claim).toBeGreaterThan(confirmed);
  });

  /** The uncertain outcome must never be reported as a plain failure. */
  it("names the uncertain case as uncertain", () => {
    expect(screen).toContain("Not confirmed");
    expect(screen).toContain("could not confirm");
  });

  it("reconciles rather than retrying blindly", () => {
    expect(mutations).toContain("attemptVitals");
    expect(screen).not.toContain("retry: true");
  });
});
