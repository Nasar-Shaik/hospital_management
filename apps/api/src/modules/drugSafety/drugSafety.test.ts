/**
 * A unit test, deliberately — the screener is pure and touches no database.
 *
 * It exists because this is the one place in the product where a WRONG answer is silent
 * and dangerous: a check that fails to fire looks exactly like a patient with no allergy,
 * and nobody notices until the drug is in the vein. So the properties defended here are the
 * ones a life depends on — the block fires when it must, and it does NOT fire when it must
 * not (a false block that a prescriber overrides ten times a day is how the real block gets
 * ignored).
 */
import { describe, expect, it } from "vitest";
import { screen, hasBlocking, isBlocking, allergensFor, type ScreenAllergy } from "./drugSafety.js";

const amox = { drugCode: "DRUG_AMOX_500", drugName: "Amoxicillin 500mg Capsule" };
const para = { drugCode: "DRUG_PARA_500", drugName: "Paracetamol 500mg Tablet" };
const ceft = { drugCode: "DRUG_INJ_CEFT", drugName: "Ceftriaxone 1g Injection" };
const ibu = { drugCode: "DRUG_IBU_400", drugName: "Ibuprofen 400mg Tablet" };
const diclo = { drugCode: "DRUG_INJ_DICLO", drugName: "Diclofenac 75mg Injection" };
const azith = { drugCode: "DRUG_AZITH_500", drugName: "Azithromycin 500mg Tablet" };
const ondan = { drugCode: "DRUG_ONDAN_4", drugName: "Ondansetron 4mg Tablet" };

const allergicTo = (allergen: ScreenAllergy["allergen"]): ScreenAllergy[] => [{ allergen }];

describe("the allergy block — the one that must never silently fail", () => {
  it("blocks a penicillin for a penicillin-allergic patient", () => {
    const alerts = screen([amox], allergicTo("penicillins"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe("allergy");
    expect(alerts[0].severity).toBe("contraindicated");
    expect(hasBlocking(alerts)).toBe(true);
  });

  it("does NOT block a drug the patient is not allergic to", () => {
    const alerts = screen([para], allergicTo("penicillins"));
    expect(alerts).toHaveLength(0);
    expect(hasBlocking(alerts)).toBe(false);
  });

  it("does NOT block anything for a patient with no allergies", () => {
    expect(screen([amox, ceft, ibu], [])).toHaveLength(0);
  });

  it("names the offending drug and allergen so the alert is actionable, not just red", () => {
    const [alert] = screen([amox], allergicTo("penicillins"));
    expect(alert.message).toContain("Amoxicillin");
    expect(alert.message).toContain("Penicillins");
    expect(alert.allergen).toBe("penicillins");
    expect(alert.drugCodes).toEqual(["DRUG_AMOX_500"]);
  });
});

describe("cross-reactivity WARNS but does not block", () => {
  it("flags a cephalosporin for a penicillin-allergic patient as major, not contraindicated", () => {
    const alerts = screen([ceft], allergicTo("penicillins"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe("cross_sensitivity");
    expect(alerts[0].severity).toBe("major");
    // The prescriber decides — a warning must not stand in the way of a signature.
    expect(hasBlocking(alerts)).toBe(false);
  });

  it("a direct cephalosporin allergy IS a block, not a mere cross-warning", () => {
    const alerts = screen([ceft], allergicTo("cephalosporins"));
    expect(alerts[0].severity).toBe("contraindicated");
    expect(hasBlocking(alerts)).toBe(true);
  });
});

describe("duplicate therapy and interactions inform without blocking", () => {
  it("flags two NSAIDs as duplicate therapy", () => {
    const alerts = screen([ibu, diclo], []);
    const dup = alerts.find((a) => a.kind === "duplicate_therapy");
    expect(dup).toBeDefined();
    expect(dup?.drugCodes.sort()).toEqual(["DRUG_IBU_400", "DRUG_INJ_DICLO"]);
    expect(hasBlocking(alerts)).toBe(false);
  });

  it("does not call ONE nsaid a duplicate of itself", () => {
    expect(screen([ibu], []).some((a) => a.kind === "duplicate_therapy")).toBe(false);
  });

  it("flags the azithromycin + ondansetron QT interaction as major", () => {
    const alerts = screen([azith, ondan], []);
    const inter = alerts.find((a) => a.kind === "interaction");
    expect(inter?.severity).toBe("major");
    expect(inter?.message).toContain("QT");
    expect(hasBlocking(alerts)).toBe(false);
  });

  it("finds the interaction regardless of the order the drugs were prescribed in", () => {
    expect(screen([ondan, azith], []).some((a) => a.kind === "interaction")).toBe(true);
  });
});

describe("severity ordering and non-drug allergens", () => {
  it("returns the contraindication first when a block and a warning coexist", () => {
    // Penicillin allergy + amoxicillin (block) and a cephalosporin (cross-warn), together.
    const alerts = screen([ceft, amox], allergicTo("penicillins"));
    expect(alerts[0].severity).toBe("contraindicated");
    expect(hasBlocking(alerts)).toBe(true);
  });

  it("a food or latex allergy never matches a drug", () => {
    expect(screen([amox, para, ibu], allergicTo("peanuts"))).toHaveLength(0);
    expect(screen([amox, para, ibu], allergicTo("latex"))).toHaveLength(0);
  });

  it("an unknown drug code matches no allergen — honest, not falsely reassuring", () => {
    expect(allergensFor("DRUG_NOT_IN_CATALOGUE")).toEqual([]);
    expect(
      screen(
        [{ drugCode: "DRUG_NOT_IN_CATALOGUE", drugName: "Mystery" }],
        allergicTo("penicillins"),
      ),
    ).toHaveLength(0);
  });

  it("isBlocking agrees with the severity it is derived from", () => {
    expect(
      isBlocking({ kind: "allergy", severity: "contraindicated", drugCodes: [], message: "" }),
    ).toBe(true);
    expect(isBlocking({ kind: "interaction", severity: "major", drugCodes: [], message: "" })).toBe(
      false,
    );
  });
});
