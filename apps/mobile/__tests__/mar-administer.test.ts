/**
 * Answering one scheduled dose (M3-S5A).
 *
 * ── THE FOUR PROPERTIES ─────────────────────────────────────────────────────
 *
 *   1. IDENTITY IS THE TRIPLE, NEVER THE DRUG. `prescriptionId` + `lineIndex` + `scheduledFor`.
 *      A prescription may carry the same drug on a scheduled line AND a PRN line, so matching on
 *      `drugCode` charts the wrong one — the single worst pair to confuse.
 *
 *   2. THE SLOT IS THE ORACLE. After an ambiguous failure the question is "is this slot answered?",
 *      asked of the server. Never "is there a recent row with this drug name", and never anything
 *      involving the device clock.
 *
 *   3. A 409 IS AN ANSWER, NOT A FAILURE. `HMS-MAR-001` means somebody already gave this dose. It
 *      must render as that, with who and when, and must NEVER offer a retry.
 *
 *   4. NOTHING IS "GIVEN" UNTIL THE SERVER SAYS SO. No optimistic state, no local duplicate check
 *      standing in for the unique index.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ApiClient,
  ApiClientError,
  marSlotTaken,
  type DoseSlot,
  type MedicationAdministration,
} from "@medicore/api-client";
import { clinicalMutations } from "../src/query/mutations";
import { queryKeys } from "../src/query/keys";
import { toUserMessage } from "../src/lib/net/errors";
import {
  OUTCOMES,
  actorLabel,
  answeredAs,
  attemptAdministration,
  canConfirm,
  findSlot,
  isOpen,
  isOwnAnswer,
  outcomeOption,
  reviewLines,
  sameSlot,
  type AdministerDeps,
  type AdministerOutcome,
  type SlotRef,
} from "../src/clinical/marAdminister";

const scope = { tenantSlug: "apollo", branchId: "branch-a" };

const REF: SlotRef = {
  prescriptionId: "rx1",
  lineIndex: 0,
  scheduledFor: "2026-06-11T08:00:00.000Z",
};

function slot(over: Partial<DoseSlot> = {}): DoseSlot {
  return {
    prescriptionId: "rx1",
    lineIndex: 0,
    drugCode: "DRUG_AMOX_500",
    drugName: "Amoxicillin 500mg",
    dose: "500 mg",
    route: "oral",
    frequency: "TDS",
    scheduledFor: "2026-06-11T08:00:00.000Z",
    state: "due",
    ...over,
  };
}

function administration(over: Partial<MedicationAdministration> = {}): MedicationAdministration {
  return {
    id: "a1",
    encounterId: "e1",
    patientId: "p1",
    prescriptionId: "rx1",
    lineIndex: 0,
    drugCode: "DRUG_AMOX_500",
    drugName: "Amoxicillin 500mg",
    dose: "500 mg",
    route: "oral",
    status: "given",
    scheduledFor: "2026-06-11T08:00:00.000Z",
    administeredAt: "2026-06-11T08:03:00.000Z",
    administeredBy: "nurse-1",
    ...over,
  };
}

/* ── 1. slot identity ──────────────────────────────────────────────────────── */

describe("a dose is identified by its slot, not by its drug", () => {
  it("matches on prescription, line AND scheduled time together", () => {
    expect(sameSlot(slot(), REF)).toBe(true);
  });

  /**
   * ── THE DUPLICATE-DRUG-LINE CONTROL ───────────────────────────────────────
   * Paracetamol QID on the round and paracetamol SOS for breakthrough fever is a textbook pair,
   * and nothing forbids it. Two lines, same drug code, same instant — only `lineIndex` separates
   * them, and charting the wrong one copies the wrong dose and frequency into a medico-legal
   * record.
   */
  it("does not confuse two lines carrying the same drug", () => {
    const prn = slot({ lineIndex: 1, frequency: "SOS" });
    expect(sameSlot(prn, REF)).toBe(false);
    expect(findSlot([prn, slot()], REF)?.lineIndex).toBe(0);
  });

  it("does not confuse two rounds of the same line", () => {
    const evening = slot({ scheduledFor: "2026-06-11T20:00:00.000Z" });
    expect(sameSlot(evening, REF)).toBe(false);
  });

  it("does not confuse the same line on another prescription", () => {
    expect(sameSlot(slot({ prescriptionId: "rx2" }), REF)).toBe(false);
  });

  it("finds nothing rather than guessing when the slot is gone", () => {
    expect(findSlot([slot({ scheduledFor: "2026-06-11T14:00:00.000Z" })], REF)).toBeUndefined();
    expect(findSlot(undefined, REF)).toBeUndefined();
  });
});

/* ── 2. which slots may be answered ────────────────────────────────────────── */

describe("slot state gates the actions", () => {
  it("treats due and overdue as open — an overdue dose is still very much giveable", () => {
    expect(isOpen(slot({ state: "due" }))).toBe(true);
    expect(isOpen(slot({ state: "overdue" }))).toBe(true);
  });

  for (const state of ["given", "held", "refused", "not_available"] as const) {
    it(`treats ${state} as answered`, () => {
      expect(isOpen(slot({ state }))).toBe(false);
      expect(answeredAs(slot({ state }))).toBe(state);
    });
  }

  it("reports no answer on an open slot", () => {
    expect(answeredAs(slot({ state: "overdue" }))).toBeUndefined();
  });

  it("refuses to confirm against an answered slot", () => {
    expect(
      canConfirm({ slot: slot({ state: "given" }), outcome: "given", reason: "", inFlight: false }),
    ).toBe(false);
  });

  it("refuses to confirm while a request is in flight", () => {
    expect(canConfirm({ slot: slot(), outcome: "given", reason: "", inFlight: true })).toBe(false);
  });

  it("refuses to confirm when the slot could not be loaded", () => {
    expect(canConfirm({ slot: undefined, outcome: "given", reason: "", inFlight: false })).toBe(
      false,
    );
  });
});

/* ── 3. the three outcomes ─────────────────────────────────────────────────── */

describe("outcomes", () => {
  /**
   * ── THIS PAIR USED TO PIN THE OPPOSITE, AND THE PIN DID ITS JOB ─────────────
   * S5A asserted "offers give, hold and refused" AND "deliberately does not offer not_available in
   * this slice" — an explicit deferral, recorded so it stayed a decision rather than a drift. It is
   * being taken up, not overridden: `not_available` has always been a real, persisted, audited
   * `MAR_STATUS` that the app already DISPLAYS, and S5A's own note said what leaving it out costs —
   * a nurse who cannot record it records HELD with a reason, filing a supply failure in the
   * clinical-decision column, where the next nurse reads it as a decision about the patient.
   *
   * Inverted rather than deleted, and still exhaustive: a fifth status cannot be quietly added, and
   * none of these four can be quietly dropped.
   */
  it("offers every outcome the record can hold, in bedside order", () => {
    expect(OUTCOMES.map((o) => o.status)).toEqual(["given", "held", "refused", "not_available"]);
  });

  /** A stock-out is charted as a stock-out. The whole point — it must not land as `held`. */
  it("records a stock-out as not_available, never as held or refused", () => {
    const option = outcomeOption("not_available");
    expect(option.status).toBe("not_available");
    expect(option.recordAs).toBe("Not available");
    expect(outcomeOption("held").status).toBe("held");
    expect(outcomeOption("refused").status).toBe("refused");
  });

  /** The server refuses a held dose with no reason. Mirrored, not invented — and only for held. */
  it("requires a reason for hold, and only for hold", () => {
    expect(outcomeOption("held").reasonRequired).toBe(true);
    expect(outcomeOption("given").reasonRequired).toBe(false);
    expect(outcomeOption("refused").reasonRequired).toBe(false);
    expect(outcomeOption("not_available").reasonRequired).toBe(false);
  });

  it("allows a stock-out with no reason — the server does not demand one", () => {
    expect(
      canConfirm({ slot: slot(), outcome: "not_available", reason: "", inFlight: false }),
    ).toBe(true);
  });

  it("blocks confirming a hold with no reason, and allows it with one", () => {
    const base = { slot: slot(), outcome: "held" as const, inFlight: false };
    expect(canConfirm({ ...base, reason: "" })).toBe(false);
    expect(canConfirm({ ...base, reason: "   " })).toBe(false);
    expect(canConfirm({ ...base, reason: "systolic 84" })).toBe(true);
  });

  it("allows a refusal with no reason — the server does not demand one", () => {
    expect(canConfirm({ slot: slot(), outcome: "refused", reason: "", inFlight: false })).toBe(
      true,
    );
  });

  it("uses clinical words on the action, never a vague Submit", () => {
    expect(outcomeOption("given").label).toBe("Give medication");
    expect(OUTCOMES.map((o) => o.label).join(" ")).not.toMatch(/submit|save/i);
  });
});

/* ── 4. the confirmation ───────────────────────────────────────────────────── */

describe("what the nurse confirms", () => {
  const lines = reviewLines({
    patientName: "Asha Rao",
    uhid: "UHID-42",
    slot: slot(),
    scheduledLabel: "11 Jun 2026, 08:00 IST",
    outcome: "given",
  });

  /** The five rights, in the order that catches the catastrophic error first: WHO. */
  it("leads with the patient and shows the identifier", () => {
    expect(lines[0]).toEqual({ label: "Patient", value: "Asha Rao", identity: true });
    expect(lines[1]).toEqual({ label: "UHID", value: "UHID-42", identity: true });
  });

  it("names the medication, dose, route and scheduled time", () => {
    expect(lines.map((l) => l.label)).toEqual([
      "Patient",
      "UHID",
      "Medication",
      "Dose",
      "Route",
      "Scheduled",
      "Recording",
    ]);
    expect(lines.find((l) => l.label === "Dose")?.value).toBe("500 mg");
    expect(lines.find((l) => l.label === "Route")?.value).toBe("oral");
  });

  it("shows the outcome that will be recorded", () => {
    expect(lines.at(-1)).toEqual({ label: "Recording", value: "Given" });
    expect(reviewLines({ slot: slot(), scheduledLabel: "x", outcome: "held" }).at(-1)?.value).toBe(
      "Held",
    );
  });

  /**
   * A missing name must never render as blank. A blank where the patient's name belongs is the
   * one thing on this screen a nurse could read straight past.
   */
  it("says so in words when identity has not loaded", () => {
    const bare = reviewLines({ slot: slot(), scheduledLabel: "x", outcome: "given" });
    expect(bare[0]?.value).toBe("Not loaded");
    expect(bare[1]?.value).toBe("Not loaded");
  });

  /** The time arrives pre-formatted in the WARD's zone — this module never formats one. */
  it("shows the scheduled time exactly as the caller formatted it", () => {
    expect(lines.find((l) => l.label === "Scheduled")?.value).toBe("11 Jun 2026, 08:00 IST");
  });
});

/* ── 5. the write, and the slot oracle ─────────────────────────────────────── */

function deps(over: Partial<AdministerDeps> = {}): AdministerDeps {
  return {
    record: () => Promise.reject(new Error("network")),
    reloadSchedule: () => Promise.resolve([slot()]),
    ref: REF,
    ...over,
  };
}

const conflict = (existing?: MedicationAdministration) =>
  new ApiClientError(409, "HMS-MAR-001", "This dose has already been administered", {
    scheduledFor: REF.scheduledFor,
    drugName: "Amoxicillin 500mg",
    ...(existing ? { existing } : {}),
  });

describe("recording a dose", () => {
  it("reports a clean 201 as recorded", async () => {
    const entry = administration();
    const result = await attemptAdministration(deps({ record: () => Promise.resolve(entry) }));
    expect(result).toEqual({ outcome: "recorded", entry });
  });

  /**
   * ── THE CONCURRENT CASE ───────────────────────────────────────────────────
   * Nurse A and nurse B both have the dose open. A gives it. B presses Give and the database
   * refuses — and `details.existing` says who won. This must never surface as a generic failure.
   */
  it("renders a 409 as an answer, carrying who gave it", async () => {
    const existing = administration({ administeredBy: "nurse-2" });
    const result = await attemptAdministration(
      deps({ record: () => Promise.reject(conflict(existing)) }),
    );
    expect(result).toEqual({
      outcome: "alreadyAnswered",
      drugName: "Amoxicillin 500mg",
      existing,
    });
  });

  /** The winner may sit in a branch this caller cannot read. The refusal stands; we say so. */
  it("still reports already-answered when the server cannot name the winner", async () => {
    const result = await attemptAdministration(deps({ record: () => Promise.reject(conflict()) }));
    expect(result).toMatchObject({ outcome: "alreadyAnswered" });
    expect(result).not.toHaveProperty("existing");
  });

  /**
   * ── THE LOST-RESPONSE CASE ────────────────────────────────────────────────
   * The dose was charted, the response never came back. Re-reading the SLOT — not scanning rows
   * for a matching drug name — finds it answered.
   */
  it("asks the slot after an ambiguous failure and finds it answered", async () => {
    const result = await attemptAdministration(
      deps({
        reloadSchedule: () =>
          Promise.resolve([
            slot({
              state: "given",
              administrationId: "a1",
              administeredBy: "nurse-1",
              administeredAt: "2026-06-11T08:03:00.000Z",
            }),
          ]),
      }),
    );
    expect(result).toMatchObject({ outcome: "alreadyAnswered", drugName: "Amoxicillin 500mg" });
    expect((result as { existing?: MedicationAdministration }).existing).toMatchObject({
      id: "a1",
      status: "given",
      administeredBy: "nurse-1",
    });
  });

  /**
   * ── THE ASYMMETRY, AND WHY IT DIFFERS FROM VITALS ─────────────────────────
   * The slot still reads due, so the dose was almost certainly not charted — but "almost" is why
   * this is `unknown` and not `notSaved`. A nurse told "not saved" gives the dose again; a nurse
   * told "we could not confirm" checks. The cost of being wrong here is a second dose.
   */
  it("reports unknown — never notSaved — when the slot still reads due", async () => {
    const result = await attemptAdministration(deps());
    expect(result.outcome).toBe("unknown");
  });

  it("reports unknown when the schedule itself cannot be read", async () => {
    const result = await attemptAdministration(
      deps({ reloadSchedule: () => Promise.reject(new Error("still offline")) }),
    );
    expect(result.outcome).toBe("unknown");
  });

  /**
   * ── THE ONE 5xx THAT IS NOT AMBIGUOUS ─────────────────────────────────────
   * A 5xx normally means "ask the slot": the write may have committed before the connection died.
   * `HMS-MAR-002` is the exception, because of WHERE it is raised — `assertChartingIsSafe()` is
   * the first line of `recordAdministration`, so the refusal happens before the service has read
   * the prescription, let alone written anything.
   *
   * Reconciling it was not unsafe (the slot correctly read open) but it cost the nurse the answer.
   * `unknown` renders "we could not confirm whether this dose was recorded… press again", so she
   * was told to keep pressing a button that cannot succeed for another minute, while the
   * instruction the server actually sent — chart on paper and escalate — was thrown away.
   */
  it("classifies HMS-MAR-002 as failed, not unknown — the server refused before writing", async () => {
    const refusal = new ApiClientError(
      503,
      "HMS-MAR-002",
      "Charting is unavailable on this system — chart on paper and escalate",
      { missing: [{ rule: "one_administration_per_dose_slot", migration: "0049-mar" }] },
    );

    const result = await attemptAdministration(deps({ record: () => Promise.reject(refusal) }));

    expect(result.outcome).toBe("failed");
    // And it carries the error through, so the screen can render the paper instruction.
    expect((result as { error?: unknown }).error).toBe(refusal);
  });

  /**
   * The control that keeps the exception narrow. An ordinary 5xx — a proxy, a dropped connection,
   * a genuine server fault — may well have committed the dose, so it must still ask the slot.
   * Widening the rule to "any 503" would tell a nurse "not recorded" about a dose already in the
   * patient, which is the failure this whole classifier exists to prevent.
   */
  it("still reconciles an ORDINARY 5xx rather than calling it failed", async () => {
    const generic = new ApiClientError(503, "HMS-GEN-503", "upstream unavailable");
    const result = await attemptAdministration(deps({ record: () => Promise.reject(generic) }));
    expect(result.outcome).toBe("unknown");
  });

  /** The order was stopped, or the ward day rolled over. Nothing may be concluded from that. */
  it("reports unknown when the slot has left today's schedule", async () => {
    const result = await attemptAdministration(deps({ reloadSchedule: () => Promise.resolve([]) }));
    expect(result.outcome).toBe("unknown");
  });

  /**
   * The oracle must be the SLOT. A row for the same drug at a different time is not evidence that
   * this dose was given — it is evidence that a different dose was.
   */
  it("does not accept another slot's answer as this one's", async () => {
    const result = await attemptAdministration(
      deps({
        reloadSchedule: () =>
          Promise.resolve([
            slot({
              scheduledFor: "2026-06-11T14:00:00.000Z",
              state: "given",
              administrationId: "other",
            }),
            slot(),
          ]),
      }),
    );
    expect(result.outcome).toBe("unknown");
  });

  /* ── errors that need no reconciliation ── */

  const definite: [string, ApiClientError][] = [
    ["a validation refusal", new ApiClientError(400, "HMS-VAL-001", "Validation failed")],
    ["no permission", new ApiClientError(403, "HMS-AUTH-005", "Forbidden")],
    ["an expired session", new ApiClientError(401, "HMS-AUTH-002", "Unauthenticated")],
    ["a missing prescription", new ApiClientError(404, "HMS-GEN-404", "Not found")],
    ["an unsigned order", new ApiClientError(422, "HMS-STATE-001", "Invalid state")],
    ["a reused key on a different body", new ApiClientError(409, "HMS-REQ-002", "Conflict")],
  ];

  for (const [what, error] of definite) {
    it(`reports ${what} as failed without asking the slot`, async () => {
      let asked = false;
      const result = await attemptAdministration(
        deps({
          record: () => Promise.reject(error),
          reloadSchedule: () => {
            asked = true;
            return Promise.resolve([slot()]);
          },
        }),
      );
      expect(result.outcome).toBe("failed");
      expect(asked).toBe(false);
    });
  }

  /** The first attempt may be committing right now — only the slot can say. */
  it("asks the slot for an in-flight duplicate rather than declaring it failed", async () => {
    const result = await attemptAdministration(
      deps({
        record: () => Promise.reject(new ApiClientError(409, "HMS-REQ-004", "In progress")),
        reloadSchedule: () => Promise.resolve([slot({ state: "given", administrationId: "a1" })]),
      }),
    );
    expect(result.outcome).toBe("alreadyAnswered");
  });

  it("asks the slot after a 5xx", async () => {
    const result = await attemptAdministration(
      deps({
        record: () => Promise.reject(new ApiClientError(500, "HMS-GEN-500", "Server error")),
        reloadSchedule: () => Promise.resolve([slot({ state: "held", administrationId: "a1" })]),
      }),
    );
    expect(result).toMatchObject({ outcome: "alreadyAnswered" });
  });
});

/* ── 6. one slot, one answer ───────────────────────────────────────────────── */

describe("a held or refused slot is answered", () => {
  /**
   * The unique index does not include `status`, so a held row occupies the slot exactly as a given
   * one does. The UI must agree: after Hold there is no Give action left.
   */
  for (const state of ["held", "refused"] as const) {
    it(`offers no further action once the slot is ${state}`, () => {
      expect(isOpen(slot({ state }))).toBe(false);
      expect(
        canConfirm({ slot: slot({ state }), outcome: "given", reason: "", inFlight: false }),
      ).toBe(false);
    });
  }
});

/* ── 7. who answered it ────────────────────────────────────────────────────── */

describe("naming the actor", () => {
  /**
   * The app cannot resolve a staff id to a name — the user directory needs `user:manage`, which
   * NURSE does not hold. So it says the distinction that changes what the nurse does next, and
   * never prints a raw id.
   */
  it("distinguishes my own lost attempt from a colleague's dose", () => {
    expect(actorLabel("nurse-1", "nurse-1")).toBe("by you");
    expect(actorLabel("nurse-2", "nurse-1")).toBe("by another member of staff");
  });

  it("does not print a raw user id", () => {
    expect(actorLabel("64b7f0000000000000000001", "nurse-1")).not.toContain("64b7f");
  });

  it("says something honest when the server did not name anybody", () => {
    expect(actorLabel(undefined, "nurse-1")).toBe("by another member of staff");
  });

  it("recognises its own answer only on an exact match", () => {
    expect(isOwnAnswer(administration({ administeredBy: "nurse-1" }), "nurse-1")).toBe(true);
    expect(isOwnAnswer(administration({ administeredBy: "nurse-2" }), "nurse-1")).toBe(false);
    expect(isOwnAnswer(undefined, "nurse-1")).toBe(false);
    // No signed-in id is not a match — it must never fall through to "that was you".
    expect(isOwnAnswer(administration({ administeredBy: "nurse-1" }), undefined)).toBe(false);
  });
});

/* ── 8. the wire contract for a taken slot ─────────────────────────────────── */

describe("reading HMS-MAR-001 off the wire", () => {
  it("extracts the slot, the drug and the existing administration", () => {
    const existing = administration();
    expect(marSlotTaken(conflict(existing))).toEqual({
      scheduledFor: REF.scheduledFor,
      drugName: "Amoxicillin 500mg",
      existing,
    });
  });

  it("ignores any other error", () => {
    expect(marSlotTaken(new ApiClientError(409, "HMS-REQ-002", "Conflict"))).toBeUndefined();
    expect(marSlotTaken(new Error("network"))).toBeUndefined();
  });

  it("ignores a malformed payload rather than inventing one", () => {
    expect(marSlotTaken(new ApiClientError(409, "HMS-MAR-001", "x", {}))).toBeUndefined();
  });
});

/* ── 9. the message a nurse sees ───────────────────────────────────────────── */

describe("HMS-MAR-001 never invites a retry", () => {
  const message = toUserMessage(
    new ApiClientError(409, "HMS-MAR-001", "This dose has already been administered"),
  );

  /**
   * ── THE CONTROL THAT MATTERS MOST IN THIS FILE ────────────────────────────
   * Before S5A this code was not in the error map at all, so it fell through to the generic
   * "Something went wrong — please try again" WITH a retry action. On a duplicate dose that
   * wording tells a nurse whose colleague has already given the antibiotic to press again.
   */
  it("does not offer retry", () => {
    expect(message.action).not.toBe("retry");
    expect(message.action).toBe("reload");
  });

  it("says the dose is already given, not that something went wrong", () => {
    expect(message.title).toBe("Already given");
    expect(message.body).toMatch(/already been recorded/i);
    expect(message.body).toMatch(/do not give it again/i);
  });

  it("is not the generic fallback", () => {
    expect(message.title).not.toBe("Something went wrong");
  });
});

/* ── 10. cache keys ────────────────────────────────────────────────────────── */

describe("MAR query keys", () => {
  /** "What is due" and "what was given" must never serve one another. */
  it("keeps the schedule and the administration record apart", () => {
    expect(queryKeys.medicationSchedule(scope, "e1")).not.toEqual(
      queryKeys.medications(scope, "e1"),
    );
  });

  it("carries the branch on both", () => {
    const other = { tenantSlug: "apollo", branchId: "branch-b" };
    expect(queryKeys.medicationSchedule(scope, "e1")).not.toEqual(
      queryKeys.medicationSchedule(other, "e1"),
    );
    expect(queryKeys.medications(scope, "e1")).not.toEqual(queryKeys.medications(other, "e1"));
  });

  it("does not collide with the visit's other per-encounter reads", () => {
    const keys = [
      queryKeys.medicationSchedule(scope, "e1"),
      queryKeys.medications(scope, "e1"),
      queryKeys.encounterVitals(scope, "e1"),
      queryKeys.wardNotes(scope, "e1"),
      queryKeys.consultation(scope, "e1"),
      queryKeys.encounter(scope, "e1"),
    ].map((k) => JSON.stringify(k));
    expect(new Set(keys).size).toBe(keys.length);
  });

  /**
   * The allergy read stays hospital-wide — S3/S4's rule, restated where MAR depends on it: the
   * drug-allergy context on the confirmation screen is worthless if it is filtered to a site.
   *
   * Asserted as an EXACT key rather than "does not contain the branch id". The weaker form was
   * what I wrote first, and falsification walked straight through it — injecting a segment called
   * `"branch-scoped"` narrowed the key without ever mentioning `branch-a`.
   */
  it("keeps the allergy key hospital-wide, with no scope segment of any kind", () => {
    expect(queryKeys.patientAllergies("apollo", "p1")).toEqual([
      "apollo",
      "patient",
      "p1",
      "allergies",
    ]);
  });
});

/* ── 11. structural ────────────────────────────────────────────────────────── */

describe("what the administration code may not contain", () => {
  const read = (path: string): string =>
    readFileSync(join(__dirname, "..", path), "utf8")
      .replace(/\/\*\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

  const model = read("src/clinical/marAdminister.ts");
  const screen = read("app/administer/[encounterId].tsx");
  const mutations = read("src/query/mutations.ts");

  /**
   * ── THE CLOCK CONTROL ─────────────────────────────────────────────────────
   * Whether a dose is due, late or answered is the SERVER's judgement, made in the ward's zone.
   * A handset with the wrong time must not be able to make a late antibiotic look on time, and the
   * only way that stays true is if this module cannot read a clock at all.
   */
  it("reads no clock in the administration model", () => {
    expect(model).not.toContain("Date.now(");
    expect(model).not.toContain("new Date(");
  });

  /**
   * ── THE SCREEN'S ZONE COMES FROM THE BRANCH, STRUCTURALLY ─────────────────
   * `zoneForRecord` is already proven to follow the branch (clinical.test.ts §11b). What that
   * cannot prove is that THIS screen asks it. Added in M3-S5A after falsification: swapping the
   * screen to `Intl.DateTimeFormat().resolvedOptions().timeZone` broke nothing, which meant no
   * test tied the confirmation's scheduled time to the ward's clock — the one number on the screen
   * a nurse checks a dose against.
   */
  it("takes the scheduled time's zone from the visit's branch, never from the device", () => {
    expect(screen).toContain("zoneFor(visit?.branchId)");
    expect(screen).not.toContain("resolvedOptions()");
    expect(screen).not.toMatch(/toLocaleTimeString|toLocaleDateString|toLocaleString/);
  });

  it("derives no due/overdue state of its own", () => {
    expect(model).not.toMatch(/OVERDUE_AFTER|isOverdue|dueAt/);
  });

  /**
   * ── THE CHIPS ARE THE OUTCOME TABLE, NOT A HAND-WRITTEN LIST ───────────────
   * `OUTCOMES` is proven exhaustive above, but that proves nothing about the screen if the screen
   * enumerates its own chips. It did not — and this is what keeps it that way, because a
   * hard-coded three would have made `not_available` unreachable again while every unit test above
   * still passed. RN screens are not rendered here (the house rule), so the structure is asserted
   * on the source, exactly as the clock and zone controls above are.
   */
  it("renders its outcome chips from OUTCOMES and sends the option's own status", () => {
    expect(screen).toContain("OUTCOMES.map(");
    expect(screen).toContain("onOutcome(o.status)");
    // No literal status anywhere on the screen — that is the table's job, and only the table's.
    expect(screen).not.toMatch(/status:\s*["'](given|held|refused|not_available)["']/);
  });

  /** The screen renders a server instant in the branch zone, and never invents one. */
  it("sends no client-generated administration time", () => {
    expect(screen).not.toContain("administeredAt:");
    expect(mutations).not.toContain("administeredAt:");
  });

  /**
   * ── THE DUPLICATE-CHECK CONTROL ───────────────────────────────────────────
   * A client-side "has this been given?" test cannot be authoritative — another nurse's dose fits
   * between the check and the request — and writing one creates a second, weaker answer to a
   * question the unique index already answers exactly.
   */
  it("performs no local duplicate check", () => {
    expect(model).not.toMatch(/alreadyGiven|hasBeenGiven|duplicateOf/);
    expect(screen).not.toMatch(/alreadyGiven\(|hasBeenGiven\(/);
  });

  /** Identity is the triple. The drug code goes on the request for cross-checking, never as a key. */
  it("never resolves a slot by drug code or drug name", () => {
    expect(model).not.toMatch(/drugCode\s*===/);
    expect(model).not.toMatch(/drugName\s*===/);
  });

  it("sends the line index on every administration", () => {
    expect(mutations).toContain("lineIndex: context.ref.lineIndex");
    expect(mutations).toContain("scheduledFor: context.ref.scheduledFor");
  });

  /* ── the write path ── */

  it("passes an idempotency key through to the API call", () => {
    expect(mutations).toContain("context.key");
    expect(screen).toContain("keys.keyFor(outcome)");
  });

  /**
   * ── ONE KEY PER DECISION ──────────────────────────────────────────────────
   * Give, Hold and Refuse are three different clinical actions. A shared key would mean that
   * changing your mind after a lost response replays the FIRST decision — the record would say the
   * opposite of what the nurse chose. `keyFor(outcome)` is what keeps them apart.
   */
  it("keys the intent by outcome, not by slot", () => {
    expect(screen).toContain("keys.keyFor(outcome)");
    expect(screen).not.toMatch(/keyFor\("dose"\)|keyFor\(slot/);
  });

  /** `\b` so React Query's own `refetch()` does not read as a raw transport call. */
  it("never bypasses the api-client with a raw fetch", () => {
    expect(screen).not.toMatch(/\bfetch\s*\(/);
    expect(screen).not.toContain("XMLHttpRequest");
  });

  /**
   * ── THE OPTIMISTIC-STATE CONTROL ──────────────────────────────────────────
   * A MAR that briefly shows a dose that was not charted is a MAR nobody can trust.
   */
  it("writes no clinical state into the cache before the server confirms", () => {
    expect(screen).not.toContain("setQueryData");
    expect(mutations).not.toContain("onMutate");
    expect(mutations).not.toContain("optimistic");
  });

  it('says "Recording…" in flight, never "Given"', () => {
    const start = screen.indexOf("if (inFlight) {");
    expect(start).toBeGreaterThanOrEqual(0);
    const branch = screen.slice(start, screen.indexOf("\n  }", start));
    expect(branch).toContain("Recording");
    expect(branch).not.toContain("Given");
    expect(branch).not.toContain("Recorded");
  });

  /** The uncertain outcome must be named as uncertain, and must never say the dose failed. */
  it("names the uncertain case as uncertain", () => {
    expect(screen).toContain("Not confirmed");
    expect(screen).toContain("could not confirm");
  });

  it("reconciles rather than retrying blindly", () => {
    expect(mutations).toContain("attemptAdministration");
    expect(screen).not.toContain("retry: true");
  });

  /* ── allergy context ── */

  /**
   * ── NO SAFETY ENGINE, AND NO FALSE REASSURANCE ────────────────────────────
   * An empty allergy list means nobody has asked the patient. Rendering it as "no allergies" would
   * turn a gap in the record into clearance to give a drug.
   */
  it("never calls a drug safe and never matches drugs against allergies", () => {
    expect(screen).not.toMatch(/\bsafe\b/i);
    expect(screen).not.toMatch(/allergyMatch|matchesAllergy|contraindicat/i);
  });

  /**
   * The empty case, stated exactly.
   *
   * The forbidden phrasings are the ones that turn a gap in the record into clearance: "no known
   * allergies", "no allergies" as a standalone claim. The screen's actual sentence — "Nothing has
   * been recorded for this patient. That is not the same as no allergies." — contains the words
   * and means the opposite, which is why this asserts on the CLAIM rather than the vocabulary. My
   * first version of this scan did the blunt thing and failed on the honest wording.
   */
  it("renders an empty allergy list as a gap in the record, never as clearance", () => {
    expect(screen).toContain("None recorded");
    expect(screen).toContain("not the same as no allergies");
    expect(screen).not.toMatch(/No known allergies/i);
    expect(screen).not.toMatch(/(Patient has|This patient has) no allergies/i);
  });

  /** Hospital-wide: the allergy read must not gain a branch on the way into this screen. */
  it("reads allergies through the hospital-wide query", () => {
    expect(screen).toContain("queries.allergies(");
    expect(screen).not.toMatch(/allergies\([^)]*branch/i);
  });
});

/* ── the request that leaves the phone (F-3) ───────────────────────────────── */

/**
 * ── THE WRITE PATH HAD NO WIRE TEST AT ALL ──────────────────────────────────
 * Everything above proves the DECISIONS — the classifier, the slot identity, what the nurse is
 * shown. Nothing proved which URL the phone actually calls or what it puts in the body; the screen
 * scans check the source text, which is not the same thing.
 *
 * That gap is why `not_available` gets one here: exposing an outcome is only worth anything if the
 * outcome reaches the server as itself. The real `ApiClient` over a stub fetch, so the assertion is
 * about what leaves the device.
 */
describe("the administration request", () => {
  interface Sent {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown> | undefined;
  }

  function server() {
    const sent: Sent[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const record: Sent = {
        method: init?.method ?? "GET",
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
      };
      sent.push(record);
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            id: "mar-1",
            encounterId: "e1",
            patientId: "p1",
            prescriptionId: REF.prescriptionId,
            lineIndex: REF.lineIndex,
            drugCode: "DRUG_AMOX_500",
            drugName: "Amoxicillin 500mg",
            dose: "500 mg",
            route: "oral",
            status: (record.body?.status as string) ?? "given",
            administeredAt: "2026-06-11T08:05:00.000Z",
            administeredBy: "nurse-1",
          },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const api = new ApiClient({
      baseUrl: "http://api.test",
      tenantHost: "apollo.medicore.test",
      fetchImpl,
      getAccessToken: () => "access-1",
      getActiveBranch: () => "branch-a",
    });
    return { sent, posts: () => sent.filter((s) => s.method === "POST"), api };
  }

  const chart = async (status: AdministerOutcome, key: string) => {
    const s = server();
    await clinicalMutations(s.api, scope)
      .administerDose("e1", { ref: REF, key })
      .mutationFn({ status, drugCode: "DRUG_AMOX_500" });
    return s;
  };

  it("sends a stock-out as not_available, to the MAR endpoint, with the slot named", async () => {
    const s = await chart("not_available", "k-unavailable");

    expect(s.posts()).toHaveLength(1);
    const post = s.posts()[0];
    expect(post?.url).toBe("http://api.test/api/v1/encounters/e1/medication-administrations");
    expect(post?.body).toMatchObject({
      status: "not_available",
      prescriptionId: REF.prescriptionId,
      // The line INDEX, not the drug code alone — a prescription may carry the drug twice.
      lineIndex: REF.lineIndex,
      scheduledFor: REF.scheduledFor,
    });
    // It must arrive as itself, never folded into a clinical decision.
    expect(post?.body?.status).not.toBe("held");
    expect(post?.body?.status).not.toBe("refused");
    // No reason invented on the nurse's behalf when they typed none.
    expect(post?.body).not.toHaveProperty("reason");
  });

  it("carries the token, the tenant host and the active branch, like every clinical write", async () => {
    const s = await chart("not_available", "k-unavailable-headers");
    const post = s.posts()[0];

    expect(post?.headers.authorization).toBe("Bearer access-1");
    expect(post?.headers["x-active-branch"]).toBe("branch-a");
    expect(post?.headers["idempotency-key"]).toBe("k-unavailable-headers");
  });

  it("still sends the other three outcomes exactly as before", async () => {
    for (const status of ["given", "held", "refused"] as const) {
      const s = await chart(status, `k-${status}`);
      expect(s.posts()[0]?.body).toMatchObject({ status });
    }
  });
});
