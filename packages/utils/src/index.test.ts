import { describe, expect, it } from "vitest";
import { addMoney, isNil, toMajorUnits, toMinorUnits } from "./index.js";

describe("money helpers (Constitution §3.4: integer minor units)", () => {
  it("converts major to minor units without float drift", () => {
    expect(toMinorUnits(199.99)).toBe(19999);
    expect(toMinorUnits(0.1)).toBe(10);
  });

  it("round-trips", () => {
    expect(toMajorUnits(toMinorUnits(1234.56))).toBe(1234.56);
  });

  it("adds same-currency money", () => {
    expect(addMoney({ amount: 100, currency: "INR" }, { amount: 250, currency: "INR" })).toEqual({
      amount: 350,
      currency: "INR",
    });
  });

  it("rejects cross-currency addition", () => {
    expect(() =>
      addMoney({ amount: 1, currency: "INR" }, { amount: 1, currency: "USD" }),
    ).toThrow(/currency mismatch/);
  });
});

describe("isNil", () => {
  it("detects null/undefined only", () => {
    expect(isNil(null)).toBe(true);
    expect(isNil(undefined)).toBe(true);
    expect(isNil(0)).toBe(false);
    expect(isNil("")).toBe(false);
  });
});
