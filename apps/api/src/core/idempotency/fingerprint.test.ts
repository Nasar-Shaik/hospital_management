/**
 * The idempotency fingerprint — what makes two requests "the same".
 *
 * ── WHY THIS FILE EXISTS (M3-S5A) ───────────────────────────────────────────
 * `fingerprint()` is one pure function guarding every idempotent write in the product, and until
 * M3-S5A it had no unit test at all. The integration suites exercised it only through routes whose
 * bodies happened to be strings and numbers, so a whole category of value — the `Date` — went
 * unhashed for as long as the mechanism has existed.
 *
 * `Object.keys(new Date())` is `[]`. The canonicaliser's generic object branch therefore turned
 * every date into `{}`, and two requests differing ONLY by a date produced an identical
 * fingerprint. `validate()` runs before `idempotent()` and Zod's `z.coerce.date()` yields real
 * `Date` objects, so this reached every date-bearing idempotent route: `scheduledFor` and
 * `administeredAt` on a medication administration, `recordedAt` on a vitals reading.
 *
 * The consequence was the dangerous direction. A key reused across two different requests was not
 * refused with `HMS-REQ-002`; it was REPLAYED — the second caller got the first request's 201 and
 * nothing was written. A nurse charting the 18:00 dose under a stale key would have been shown the
 * 12:00 dose's success.
 *
 * These tests are all about VALUES, deliberately. Asserting the hash of a particular body would
 * pin an implementation detail and break on any harmless change; asserting which pairs of bodies
 * agree and which differ pins the actual contract.
 */
import { describe, expect, it } from "vitest";
import { fingerprint } from "./idempotencyStore.js";

const base = {
  method: "POST",
  path: "/api/v1/encounters/abc/medication-administrations",
  query: {},
};

const print = (body: unknown, over: Partial<typeof base> & { branchId?: string } = {}) =>
  fingerprint({ ...base, ...over, body });

describe("dates are hashed by value", () => {
  /** The regression. Two different rounds of the same drug are two different requests. */
  it("distinguishes two different dates", () => {
    expect(print({ scheduledFor: new Date("2026-08-13T12:00:00Z") })).not.toBe(
      print({ scheduledFor: new Date("2026-08-13T18:00:00Z") }),
    );
  });

  it("still treats the same instant as the same request", () => {
    expect(print({ scheduledFor: new Date("2026-08-13T12:00:00Z") })).toBe(
      print({ scheduledFor: new Date("2026-08-13T12:00:00Z") }),
    );
  });

  /**
   * A retry that re-parses `"…T12:00:00.000Z"` into a new `Date` must hash the same as the first —
   * the fingerprint describes the request the server saw, and both saw the same instant.
   */
  it("does not depend on object identity", () => {
    const iso = "2026-08-13T12:00:00.000Z";
    expect(print({ at: new Date(iso) })).toBe(print({ at: new Date(iso) }));
  });

  /**
   * A date hashes as the instant it represents, so the coerced `Date` and the ISO string it came
   * from agree. That is the right way round: the fingerprint's job is to say whether two requests
   * would DO the same thing, and these two would. It also means a schema gaining or losing a
   * `z.coerce.date()` does not invalidate keys already in the store.
   */
  it("agrees with the ISO string the same instant was coerced from", () => {
    expect(print({ at: new Date("2026-08-13T12:00:00Z") })).toBe(
      print({ at: "2026-08-13T12:00:00.000Z" }),
    );
  });

  it("sees a date nested inside an object or an array", () => {
    expect(print({ window: { from: new Date("2026-01-01T00:00:00Z") } })).not.toBe(
      print({ window: { from: new Date("2026-01-02T00:00:00Z") } }),
    );
    expect(print({ slots: [new Date("2026-01-01T00:00:00Z")] })).not.toBe(
      print({ slots: [new Date("2026-01-02T00:00:00Z")] }),
    );
  });
});

describe("what makes two requests the same", () => {
  it("ignores key order", () => {
    expect(print({ a: 1, b: 2 })).toBe(print({ b: 2, a: 1 }));
  });

  it("separates two paths, two methods and two branches", () => {
    expect(print({ a: 1 })).not.toBe(print({ a: 1 }, { path: "/api/v1/other" }));
    expect(print({ a: 1 })).not.toBe(print({ a: 1 }, { method: "PUT" }));
    expect(print({ a: 1 }, { branchId: "b1" })).not.toBe(print({ a: 1 }, { branchId: "b2" }));
  });

  it("separates an absent field from a present one", () => {
    expect(print({ a: 1 })).not.toBe(print({ a: 1, reason: "held" }));
  });

  it("distinguishes null from absent, and from a string", () => {
    expect(print({ a: null })).not.toBe(print({}));
    expect(print({ a: null })).not.toBe(print({ a: "null" }));
  });

  /** No clock, no trace id, no nonce — or every legitimate retry would look like a new request. */
  it("is stable across time", () => {
    const body = { pulse: 72 };
    expect(print(body)).toBe(print(body));
  });
});

describe("an unhashable value is refused rather than silently dropped", () => {
  /**
   * The general form of the Date bug: any object whose identity does not live in its own
   * enumerable keys would canonicalise to `{}`. Failing loudly is the only safe answer — a
   * fingerprint that quietly ignores part of the request is worse than none, because the client
   * believes it is protected.
   */
  it("throws on an opaque object with no enumerable keys", () => {
    class Opaque {
      readonly #hidden = 1;
      value(): number {
        return this.#hidden;
      }
    }
    expect(() => print({ thing: new Opaque() })).toThrow(/cannot be hashed by value/);
  });

  it("still accepts an ordinary empty object", () => {
    expect(() => print({ meta: {} })).not.toThrow();
  });
});
