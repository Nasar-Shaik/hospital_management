/**
 * Charting a dose safely (W3) — the decisions, in Node.
 *
 * The rendering is tested next door in `medicationRecord.test.tsx`, against a real `ApiClient`.
 * What is tested HERE is everything that can be decided without a browser: what the nurse is
 * asked to confirm, what the server is told, and — the part that matters most — what the nurse is
 * told afterwards when we do not know what happened.
 */
import { describe, it, expect, vi } from "vitest";
import { ApiClientError, type DoseSlot, type MedicationAdministration } from "@medicore/api-client";
import {
  OUTCOMES,
  actorLabel,
  attemptDose,
  attemptNotice,
  canConfirm,
  confirmLines,
  isOwnAnswer,
  outcomeOption,
  type DrugLine,
} from "../lib/marAdminister";

const SCHEDULED: DrugLine = {
  prescriptionId: "rx1",
  lineIndex: 1,
  drugCode: "PARA500",
  drugName: "Paracetamol",
  dose: "500 mg",
  route: "oral",
  frequency: "TDS",
  scheduledFor: "2026-08-13T08:00:00.000Z",
};

const PRN: DrugLine = {
  prescriptionId: "rx1",
  lineIndex: 2,
  drugCode: "PARA500",
  drugName: "Paracetamol",
  dose: "500 mg",
  route: "oral",
  frequency: "SOS",
};

const REF = { prescriptionId: "rx1", lineIndex: 1, scheduledFor: "2026-08-13T08:00:00.000Z" };

function entry(over: Partial<MedicationAdministration> = {}): MedicationAdministration {
  return {
    id: "mar1",
    encounterId: "e1",
    patientId: "p1",
    prescriptionId: "rx1",
    lineIndex: 1,
    drugCode: "PARA500",
    drugName: "Paracetamol",
    dose: "500 mg",
    route: "oral",
    status: "given",
    administeredAt: "2026-08-13T08:04:00.000Z",
    ...over,
  };
}

function slot(over: Partial<DoseSlot> = {}): DoseSlot {
  return {
    prescriptionId: "rx1",
    lineIndex: 1,
    drugCode: "PARA500",
    drugName: "Paracetamol",
    dose: "500 mg",
    route: "oral",
    frequency: "TDS",
    scheduledFor: "2026-08-13T08:00:00.000Z",
    state: "due",
    ...over,
  };
}

const err = (status: number, code: string, details?: unknown): ApiClientError =>
  new ApiClientError(status, code, "boom", details);

/** The label function the component injects. Fixed here so the tests never touch a real clock. */
const clock = (iso: string): string => `[${iso}]`;

describe("1. the outcomes offered", () => {
  it("requires a reason for a HOLD and not for the others — the server's rule, mirrored", () => {
    expect(outcomeOption("held").reasonRequired).toBe(true);
    expect(outcomeOption("given").reasonRequired).toBe(false);
    expect(outcomeOption("refused").reasonRequired).toBe(false);
    // `not_available` too: `recordAdministration` demands a reason for `held` and nothing else, and
    // a client-side rule the server does not have would block a nurse charting a true fact.
    expect(outcomeOption("not_available").reasonRequired).toBe(false);
  });

  /**
   * ── THIS ASSERTION USED TO READ "exactly the three bedside decisions" ───────
   * It pinned a deliberate S5A/W3 deferral: `not_available` was a real, persisted, audited
   * `MAR_STATUS` that no client offered. The deferral was not free — both surfaces said so in
   * their own comments — because a nurse who cannot record "not available" records HELD with a
   * reason, filing a supply failure in the clinical-decision column.
   *
   * It is inverted rather than deleted: the list is still pinned, so a fifth status cannot be
   * quietly added or one of these quietly dropped. `not_available` is LAST because it is the only
   * one that is not a decision about the patient.
   */
  it("offers every outcome the record can hold, in bedside order", () => {
    expect(OUTCOMES.map((o) => o.status)).toEqual(["given", "held", "refused", "not_available"]);
  });

  /** The word on the button is the word on the chart — see `MAR_LABEL` in `MedicationRecord`. */
  it("records a stock-out as Not available, never as Held", () => {
    expect(outcomeOption("not_available").recordAs).toBe("Not available");
    expect(outcomeOption("not_available").status).toBe("not_available");
    expect(outcomeOption("held").recordAs).toBe("Held");
  });

  it("lets a stock-out be confirmed with no reason typed", () => {
    expect(canConfirm({ outcome: "not_available", reason: "", inFlight: false })).toBe(true);
  });

  it("blocks confirming a hold with no reason, and blanks do not count", () => {
    expect(canConfirm({ outcome: "held", reason: "", inFlight: false })).toBe(false);
    expect(canConfirm({ outcome: "held", reason: "   ", inFlight: false })).toBe(false);
    expect(canConfirm({ outcome: "held", reason: "systolic 84", inFlight: false })).toBe(true);
  });

  it("blocks confirming while a request is already in flight", () => {
    expect(canConfirm({ outcome: "given", reason: "", inFlight: true })).toBe(false);
    expect(canConfirm({ outcome: "given", reason: "", inFlight: false })).toBe(true);
  });
});

describe("2. what the nurse is asked to confirm", () => {
  const lines = confirmLines({
    patientName: "Asha Rao",
    uhid: "UH-1001",
    line: SCHEDULED,
    scheduledLabel: "08:00",
    outcome: "given",
  });
  const value = (label: string): string => lines.find((l) => l.label === label)?.value ?? "";

  it("leads with the patient — the check that catches the catastrophic error", () => {
    expect(lines[0]?.label).toBe("Patient");
    expect(lines[1]?.label).toBe("UHID");
  });

  it("carries every one of the five rights", () => {
    expect(value("Patient")).toBe("Asha Rao");
    expect(value("UHID")).toBe("UH-1001");
    expect(value("Medication")).toBe("Paracetamol");
    expect(value("Dose")).toBe("500 mg");
    expect(value("Route")).toBe("oral");
    expect(value("Scheduled")).toBe("08:00");
  });

  it("says what will be recorded, so the verb is never a surprise", () => {
    expect(value("Recording")).toBe("Given");
  });

  it("never silently omits an identity it does not have", () => {
    const missing = confirmLines({
      line: SCHEDULED,
      scheduledLabel: "08:00",
      outcome: "given",
    });
    expect(missing.find((l) => l.label === "Patient")?.value).toBe("Not loaded");
    expect(missing.find((l) => l.label === "UHID")?.value).toBe("Not loaded");
  });
});

describe("3. a scheduled dose — the slot is the oracle", () => {
  it("reports what the server wrote, and only that", async () => {
    const written = entry();
    const result = await attemptDose({
      record: () => Promise.resolve(written),
      reloadSchedule: () => Promise.reject(new Error("must not be asked")),
      ref: REF,
    });
    expect(result).toEqual({ outcome: "recorded", entry: written });
  });

  it("treats HMS-MAR-001 as an ANSWER and carries who holds the slot", async () => {
    const holder = entry({ administeredBy: "nurse-2", status: "given" });
    const result = await attemptDose({
      record: () =>
        Promise.reject(
          err(409, "HMS-MAR-001", {
            scheduledFor: REF.scheduledFor,
            drugName: "Paracetamol",
            existing: holder,
          }),
        ),
      reloadSchedule: () => Promise.reject(new Error("must not be asked")),
      ref: REF,
    });
    expect(result.outcome).toBe("alreadyAnswered");
    if (result.outcome === "alreadyAnswered") {
      expect(result.existing?.administeredBy).toBe("nurse-2");
      expect(result.drugName).toBe("Paracetamol");
    }
  });

  it("does NOT reconcile an error that was decided before anything could be written", async () => {
    const reload = vi.fn(() => Promise.resolve([slot()]));
    const result = await attemptDose({
      record: () => Promise.reject(err(403, "HMS-AUTH-005")),
      reloadSchedule: reload,
      ref: REF,
    });
    expect(result.outcome).toBe("failed");
    expect(reload).not.toHaveBeenCalled();
  });

  /**
   * THE LOST RESPONSE. The server committed and the answer never arrived. Nothing in the failure
   * says so — only the slot does.
   */
  it("finds the dose already charted after a lost response, and never says 'not saved'", async () => {
    const result = await attemptDose({
      record: () => Promise.reject(new TypeError("Failed to fetch")),
      reloadSchedule: () =>
        Promise.resolve([
          slot({
            state: "given",
            administrationId: "mar1",
            administeredBy: "me",
            administeredAt: "2026-08-13T08:04:00.000Z",
          }),
        ]),
      ref: REF,
    });

    expect(result.outcome).toBe("alreadyAnswered");
    const notice = attemptNotice(result, "me", clock);
    expect(notice.tone).not.toBe("danger");
    expect(notice.text).not.toMatch(/not saved|try again/i);
  });

  it("says UNKNOWN — not 'failed' — when the slot is still open after an ambiguous failure", async () => {
    const result = await attemptDose({
      record: () => Promise.reject(err(500, "HMS-GEN-500")),
      reloadSchedule: () => Promise.resolve([slot({ state: "due" })]),
      ref: REF,
    });
    expect(result.outcome).toBe("unknown");
  });

  it("says UNKNOWN when the oracle itself cannot be reached", async () => {
    const result = await attemptDose({
      record: () => Promise.reject(err(500, "HMS-GEN-500")),
      reloadSchedule: () => Promise.reject(new Error("offline")),
      ref: REF,
    });
    expect(result.outcome).toBe("unknown");
  });

  it("asks the slot when our own key is still in flight — that attempt may be committing now", async () => {
    const reload = vi.fn(() => Promise.resolve([slot({ state: "given", administrationId: "m1" })]));
    const result = await attemptDose({
      record: () => Promise.reject(err(409, "HMS-REQ-004")),
      reloadSchedule: reload,
      ref: REF,
    });
    expect(reload).toHaveBeenCalled();
    expect(result.outcome).toBe("alreadyAnswered");
  });

  it("reconciles against THIS slot only, never a neighbouring dose of the same drug", async () => {
    const result = await attemptDose({
      record: () => Promise.reject(err(500, "HMS-GEN-500")),
      reloadSchedule: () =>
        Promise.resolve([
          // The 14:00 dose of the same drug, already given. It says nothing about the 08:00 one.
          slot({
            scheduledFor: "2026-08-13T14:00:00.000Z",
            state: "given",
            administrationId: "m9",
          }),
          slot({ state: "due" }),
        ]),
      ref: REF,
    });
    expect(result.outcome).toBe("unknown");
  });
});

describe("4. a PRN dose — no slot, so no oracle, and it says so", () => {
  it("records one normally", async () => {
    const written = entry({ lineIndex: 2 });
    const result = await attemptDose({
      record: () => Promise.resolve(written),
      reloadSchedule: () => Promise.resolve([]),
    });
    expect(result).toEqual({ outcome: "recorded", entry: written });
  });

  /**
   * A PRN line is unconstrained by the unique index BY DESIGN — "as needed" has to stay
   * repeatable. So an ambiguous failure here can never be resolved by asking the server, and the
   * screen must not pretend otherwise. The idempotency key is the whole protection, which is why
   * the component holds the key across exactly this case.
   */
  it("never claims a PRN dose was not given, whatever the failure", async () => {
    for (const failure of [
      new TypeError("Failed to fetch"),
      err(500, "HMS-GEN-500"),
      err(403, "HMS-AUTH-005"),
    ]) {
      const result = await attemptDose({
        record: () => Promise.reject(failure),
        reloadSchedule: () => Promise.resolve([]),
      });
      expect(result.outcome).toBe("unknown");
      expect(attemptNotice(result, "me", clock).text).not.toMatch(/not saved/i);
    }
  });

  it("does not invent a scheduled time for a dose that has none", () => {
    expect(PRN.scheduledFor).toBeUndefined();
    const lines = confirmLines({
      patientName: "Asha Rao",
      uhid: "UH-1001",
      line: PRN,
      scheduledLabel: "PRN",
      outcome: "given",
    });
    // The nurse must see that this dose answers no round — not a plausible-looking clock time.
    expect(lines.find((l) => l.label === "Scheduled")?.value).toBe("PRN");
  });

  it("does not consult the schedule for a line that has no slot in it", async () => {
    const reload = vi.fn(() => Promise.resolve([slot()]));
    await attemptDose({
      record: () => Promise.reject(err(500, "HMS-GEN-500")),
      reloadSchedule: reload,
    });
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("5. what the nurse is told — the wording IS the safety feature", () => {
  it("claims success only for a dose the server confirmed", () => {
    const notice = attemptNotice({ outcome: "recorded", entry: entry() }, "me", clock);
    expect(notice.tone).toBe("success");
    expect(notice.text).toMatch(/Paracetamol given/);
  });

  it("does not paint an already-answered dose as a fault", () => {
    const notice = attemptNotice(
      {
        outcome: "alreadyAnswered",
        drugName: "Paracetamol",
        existing: entry({ administeredBy: "nurse-2" }),
      },
      "me",
      clock,
    );
    expect(notice.tone).toBe("warning");
    expect(notice.text).toMatch(/another member of staff/);
    expect(notice.text).toMatch(/Nothing was charted again/);
  });

  it("tells a nurse when the slot was taken by their OWN lost attempt", () => {
    const notice = attemptNotice(
      {
        outcome: "alreadyAnswered",
        drugName: "Paracetamol",
        existing: entry({ administeredBy: "me" }),
      },
      "me",
      clock,
    );
    expect(notice.text).toMatch(/by you/);
  });

  it("says the refusal stands even when the server could not name who holds the slot", () => {
    const notice = attemptNotice(
      { outcome: "alreadyAnswered", drugName: "Paracetamol" },
      "me",
      clock,
    );
    expect(notice.text).toMatch(/already been answered/);
    expect(notice.text).not.toMatch(/not saved|was not given/i);
  });

  it("sends the nurse to the chart on UNKNOWN, and never invites another dose", () => {
    const notice = attemptNotice({ outcome: "unknown", error: new Error("x") }, "me", clock);
    expect(notice.text).toMatch(/could not confirm/i);
    expect(notice.text).toMatch(/Check the chart/i);
    expect(notice.text).not.toMatch(/not saved|try again/i);
    expect(notice.canRecheck).toBe(true);
  });

  /**
   * ── THE SCHEMA REFUSAL REACHES THE NURSE IN THE SERVER'S OWN WORDS ────────
   * `HMS-MAR-002` is raised by `assertChartingIsSafe()`, the first line of `recordAdministration`,
   * so nothing was written and the shared classifier answers `failed` rather than `unknown`.
   *
   * That routing is what matters here. `unknown` says "we could not confirm… check the chart",
   * which is true of a dropped connection and wrong for this: the server knows exactly what
   * happened and sent an instruction — chart on paper and escalate. `failed` renders that
   * instruction verbatim, because on WEB the server's message is what a refusal shows.
   *
   * (Mobile deliberately never renders server text, so it needed its own mapping of the same five
   * codes. Same defect, two different fixes, because the two clients made opposite choices about
   * trusting server wording.)
   */
  it("passes a schema refusal through as the instruction it is, not as 'unconfirmed'", () => {
    const refusal = new ApiClientError(
      503,
      "HMS-MAR-002",
      "Charting is unavailable on this system — chart on paper and escalate",
    );

    const notice = attemptNotice({ outcome: "failed", error: refusal }, "me", clock);
    expect(notice.text).toMatch(/chart on paper/i);
    expect(notice.tone).toBe("danger");
    // Not an invitation to press again — the verdict cannot change for 60 seconds.
    expect(notice.canRecheck).toBe(false);
  });

  /** And the routing itself, through the real attempt path rather than by constructing the result. */
  it("routes a schema refusal to `failed`, so it never renders as unconfirmed", async () => {
    const refusal = new ApiClientError(503, "HMS-MAR-002", "chart on paper and escalate");
    const result = await attemptDose({
      record: () => Promise.reject(refusal),
      reloadSchedule: () => Promise.reject(new Error("should not be asked")),
      ref: { prescriptionId: "rx1", lineIndex: 0, scheduledFor: "2026-06-11T08:00:00.000Z" },
    });
    expect(result.outcome).toBe("failed");
  });

  it("renders the existing administration's time through the injected ward clock", () => {
    const notice = attemptNotice(
      {
        outcome: "alreadyAnswered",
        drugName: "Paracetamol",
        existing: entry({ administeredAt: "2026-08-13T08:04:00.000Z" }),
      },
      "me",
      clock,
    );
    expect(notice.text).toContain("[2026-08-13T08:04:00.000Z]");
  });
});

describe("6. attribution", () => {
  it("distinguishes my own lost attempt from a colleague's dose", () => {
    expect(actorLabel("me", "me")).toBe("by you");
    expect(actorLabel("nurse-2", "me")).toBe("by another member of staff");
  });

  it("does not claim a dose is mine when either side is unknown", () => {
    expect(actorLabel(undefined, "me")).toBe("by another member of staff");
    expect(actorLabel("me", undefined)).toBe("by another member of staff");
    expect(isOwnAnswer(undefined, "me")).toBe(false);
    expect(isOwnAnswer({ administeredBy: "me" }, undefined)).toBe(false);
    expect(isOwnAnswer({ administeredBy: "me" }, "me")).toBe(true);
  });

  it("never leaks a raw user id into what the nurse reads", () => {
    expect(actorLabel("64f0c1a2b3d4e5f60718293a", "me")).not.toMatch(/64f0c1a2/);
  });
});

/* ── guards: the mistakes this slice removed must not walk back in ─────────── */

function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

async function readSource(relative: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  return codeOf(await readFile(join(process.cwd(), relative), "utf8"));
}

describe("7. the defects cannot come back unnoticed", () => {
  it("the decision module holds no clock and no formatter", async () => {
    const source = await readSource("lib/marAdminister.ts");
    expect(source).not.toMatch(/new Date\(\)|Date\.now\(\)/);
    expect(source).not.toMatch(/toLocaleTimeString|toLocaleString|Intl\./);
  });

  it("no medication surface asks for a reason with window.prompt", async () => {
    for (const file of ["components/MedicationRecord.tsx", "lib/marAdminister.ts"]) {
      expect(await readSource(file)).not.toMatch(/window\.prompt|\bprompt\(/);
    }
  });

  /**
   * `drugCode` alone is not an identity: a prescription may carry the same drug on a regular round
   * AND as a PRN line. Every administration this screen sends must name the LINE.
   */
  it("the component sends lineIndex with every administration", async () => {
    const source = await readSource("components/MedicationRecord.tsx");
    const call = /recordMedicationAdministration\([\s\S]*?\n {8}\)/.exec(source)?.[0] ?? "";
    expect(call).toMatch(/lineIndex:/);
    expect(call).toMatch(/prescriptionId:/);
  });

  it("the component never renders a medication time in the reader's zone", async () => {
    const source = await readSource("components/MedicationRecord.tsx");
    expect(source).not.toMatch(/toLocaleTimeString|toLocaleString|toLocaleDateString/);
  });

  it("the component computes no clinical status of its own", async () => {
    const source = await readSource("components/MedicationRecord.tsx");
    // "due" and "overdue" are the SERVER's verdict, read off the slot — never derived from a
    // comparison against the browser's clock.
    expect(source).not.toMatch(/Date\.now\(\)|new Date\(\)\s*[<>]/);
  });
});
