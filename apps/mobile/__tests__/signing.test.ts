/**
 * SIGNING — the one operation in M2 with no idempotency key, tested exhaustively.
 *
 * ── WHAT IS ACTUALLY AT RISK ────────────────────────────────────────────────
 * Not a double signature: the transition table allows `draft → signed` and nothing else into
 * `signed`, so a second attempt is refused before it reaches the record. What is at risk is a LIE
 * — the signature lands, the reply is lost on the ward wifi, and the doctor is told it failed.
 * They press again and get `HMS-STATE-001`, "invalid state transition", about a prescription the
 * pharmacy already has.
 *
 * Every test below is about that: the outcome must be classified from the RECORD, not from
 * whatever the transport managed to report.
 */
import { describe, expect, it, vi } from "vitest";
import { ApiClientError, type Prescription } from "@medicore/api-client";
import { attemptSign, isEditable, isSigned, reconcile } from "../src/clinical/signing";
import { prescription } from "./support/fixtures";

const DRAFT: Prescription = prescription({
  status: "draft",
  signedBy: undefined,
  signedAt: undefined,
});
const SIGNED: Prescription = prescription();

/** The refusal the server sends when the prescription is already past `draft`. */
const stateError = (from: string): ApiClientError =>
  new ApiClientError(422, "HMS-STATE-001", "Invalid state transition", {
    from,
    to: "signed",
    allowed: "see STATE_MACHINE_CATALOG §6",
  });

const networkFailure = (): TypeError => new TypeError("Network request failed");

describe("`signedAt` is the oracle, not `status`", () => {
  it("calls a signed prescription signed", () => {
    expect(isSigned(SIGNED)).toBe(true);
    expect(isSigned(DRAFT)).toBe(false);
  });

  it.each(["partially_dispensed", "dispensed", "cancelled"] as const)(
    "still calls it signed at %s — the signature happened, whatever came after",
    (status) => {
      /**
       * The trap that `status === "signed"` walks into. A dispensed prescription is not "unsigned";
       * its drugs are in the patient. Reporting it as unsigned would invite a doctor to sign it a
       * second time, and the refusal they got would look like a bug rather than a safeguard.
       */
      expect(isSigned(prescription({ status }))).toBe(true);
    },
  );

  it("does not call a discarded draft signed", () => {
    // Discarded is the one dead end that was never signed — no `signedAt` was ever set.
    expect(isSigned(prescription({ status: "discarded", signedAt: undefined }))).toBe(false);
  });

  it("refuses to call a signed prescription editable", () => {
    expect(isEditable(DRAFT)).toBe(true);
    expect(isEditable(SIGNED)).toBe(false);
    expect(isEditable(prescription({ status: "dispensed" }))).toBe(false);
  });
});

describe("17. the ordinary path", () => {
  it("signs, and does not re-read anything it did not need to", async () => {
    const sign = vi.fn().mockResolvedValue(SIGNED);
    const reload = vi.fn();

    const outcome = await attemptSign({ sign, reload });

    expect(outcome).toEqual({ outcome: "signed", prescription: SIGNED, reconciled: false });
    expect(sign).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });

  it("passes an override reason through when one was given", async () => {
    const sign = vi.fn().mockResolvedValue(SIGNED);
    await attemptSign({ sign, reload: vi.fn() }, "prior reaction was a mild rash");
    expect(sign).toHaveBeenCalledWith("prior reaction was a mild rash");
  });
});

describe("18. the response is lost after the signature landed", () => {
  it("reloads, finds it signed, and reports SUCCESS", async () => {
    /**
     * The scenario this whole module exists for. The write committed; the reply did not arrive.
     * A client that trusted the transport would tell the doctor their prescription failed.
     */
    const sign = vi.fn().mockRejectedValue(networkFailure());
    const reload = vi.fn().mockResolvedValue(SIGNED);

    const outcome = await attemptSign({ sign, reload });

    expect(outcome).toMatchObject({ outcome: "signed", reconciled: true });
    expect(sign).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("marks it `reconciled`, so the screen can say how it found out", async () => {
    const outcome = await attemptSign({
      sign: vi.fn().mockRejectedValue(networkFailure()),
      reload: vi.fn().mockResolvedValue(SIGNED),
    });
    // Not cosmetic: "the connection dropped, this was checked against the record, nothing was
    // prescribed twice" is a different sentence from a plain success, and the doctor who watched
    // it fail needs the longer one.
    expect(outcome).toHaveProperty("reconciled", true);
  });
});

describe("19. HMS-STATE-001 on a prescription that is already signed", () => {
  it("is a SUCCESS, not an error", async () => {
    const sign = vi.fn().mockRejectedValue(stateError("signed"));
    const reload = vi.fn().mockResolvedValue(SIGNED);

    const outcome = await attemptSign({ sign, reload });

    expect(outcome).toMatchObject({ outcome: "signed", reconciled: true });
  });

  it("reads it the same way when the prescription has moved past signed", async () => {
    // A retry that arrives after the pharmacy has already dispensed. `from: "dispensed"`, and the
    // honest answer is still "your signature worked".
    const outcome = await attemptSign({
      sign: vi.fn().mockRejectedValue(stateError("dispensed")),
      reload: vi.fn().mockResolvedValue(prescription({ status: "dispensed" })),
    });
    expect(outcome).toMatchObject({ outcome: "signed" });
  });

  it("does NOT treat HMS-STATE-001 as success when the record says otherwise", async () => {
    /**
     * The state error has other causes — a discarded draft, a closed encounter. Trusting the CODE
     * instead of the record would report those as signed prescriptions that do not exist.
     */
    const outcome = await attemptSign({
      sign: vi.fn().mockRejectedValue(stateError("discarded")),
      reload: vi.fn().mockResolvedValue(prescription({ status: "discarded", signedAt: undefined })),
    });
    expect(outcome).toMatchObject({ outcome: "unsigned" });
  });
});

describe("20. still unsigned after a failed attempt", () => {
  it("says so, and leaves a retry available", async () => {
    const outcome = await attemptSign({
      sign: vi.fn().mockRejectedValue(networkFailure()),
      reload: vi.fn().mockResolvedValue(DRAFT),
    });
    expect(outcome).toMatchObject({ outcome: "unsigned" });
  });

  it("says so even when the reload ALSO fails", async () => {
    /**
     * We genuinely do not know. "Unsigned" is still the right answer, because the only thing it
     * enables is pressing Sign again — and the state machine guarantees a second attempt on a
     * signed prescription is refused rather than duplicated. The cost of being wrong is one
     * wasted request; the cost of guessing "signed" would be a prescription nobody signed.
     */
    const outcome = await attemptSign({
      sign: vi.fn().mockRejectedValue(networkFailure()),
      reload: vi.fn().mockRejectedValue(networkFailure()),
    });
    expect(outcome).toMatchObject({ outcome: "unsigned" });
  });

  it("reports the ORIGINAL failure, not the reload's", async () => {
    // The reload failing on top is our problem. Replacing the useful message with it would tell
    // the doctor about a request they never made.
    const original = stateError("draft");
    const outcome = await attemptSign({
      sign: vi.fn().mockRejectedValue(original),
      reload: vi.fn().mockRejectedValue(new TypeError("also broken")),
    });
    expect(outcome).toMatchObject({ outcome: "unsigned", error: original });
  });
});

describe("the attempt signs AT MOST ONCE — never a loop", () => {
  it.each([
    ["a network failure", networkFailure()],
    ["HMS-STATE-001", stateError("draft")],
    ["a 500", new ApiClientError(500, "HMS-GEN-500", "boom")],
  ])("calls sign exactly once after %s", async (_label, error) => {
    /**
     * The requirement, as a machine check: "Do NOT blindly retry the signing mutation multiple
     * times" and "make HMS-STATE-001 automatically retry forever" is a falsification control.
     * Reconciliation READS; it never signs.
     */
    const sign = vi.fn().mockRejectedValue(error);
    const reload = vi.fn().mockResolvedValue(DRAFT);

    await attemptSign({ sign, reload });

    expect(sign).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("a contraindication is a review step, not a failure", () => {
  it("classifies HMS-RX-001 as blocked and hands back the alerts", async () => {
    const alerts = [
      {
        kind: "allergy" as const,
        severity: "contraindicated" as const,
        drugCodes: ["AMOX500"],
        allergen: "penicillins",
        message: "Patient is allergic to penicillins (anaphylaxis).",
      },
    ];
    const sign = vi
      .fn()
      .mockRejectedValue(new ApiClientError(422, "HMS-RX-001", "blocked", { alerts }));
    const reload = vi.fn();

    const outcome = await attemptSign({ sign, reload });

    expect(outcome).toMatchObject({ outcome: "blocked" });
    if (outcome.outcome === "blocked") expect(outcome.alerts).toEqual(alerts);
    // Nothing was written, so there is nothing to reconcile — and a round trip here would be a
    // wasted one on the path where the doctor is already waiting.
    expect(reload).not.toHaveBeenCalled();
  });

  it("survives a refusal whose details carry no alerts", async () => {
    const outcome = await attemptSign({
      sign: vi.fn().mockRejectedValue(new ApiClientError(422, "HMS-RX-001", "blocked", {})),
      reload: vi.fn(),
    });
    expect(outcome).toMatchObject({ outcome: "blocked", alerts: [] });
  });
});

describe("errors decided BEFORE the write are not reconciled", () => {
  it.each([
    ["403", new ApiClientError(403, "HMS-AUTH-005", "Insufficient permission")],
    ["401", new ApiClientError(401, "HMS-AUTH-002", "Session ended")],
    ["400", new ApiClientError(400, "HMS-VAL-001", "Validation failed")],
    ["404", new ApiClientError(404, "HMS-GEN-404", "Not found")],
  ])("fails fast on %s without re-reading", async (_label, error) => {
    /**
     * These are refused before the transaction, so the record cannot have changed. Re-reading
     * would be a wasted round trip and — worse — would make the code read as though a permission
     * failure might have signed something.
     */
    const reload = vi.fn();
    const outcome = await attemptSign({ sign: vi.fn().mockRejectedValue(error), reload });

    expect(outcome).toMatchObject({ outcome: "failed", error });
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("reconcile is usable on its own", () => {
  it("answers the same question for a screen returning from the background", async () => {
    // A doctor who backgrounds the app mid-signature and comes back needs the same answer from
    // the same code path, not a hopeful refetch whose result nobody classifies.
    const outcome = await reconcile(
      { sign: vi.fn(), reload: vi.fn().mockResolvedValue(SIGNED) },
      networkFailure(),
    );
    expect(outcome).toMatchObject({ outcome: "signed", reconciled: true });
  });
});
