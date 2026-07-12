/**
 * Dependency-free shared helpers (Doc 04 §1). Domain math lives here so it is
 * unit-testable without any framework (Doc 09 §3).
 */

/**
 * Money is always integer minor units + currency code (Constitution §3.4).
 * These are the ONLY conversion helpers — never use floats for money.
 */
export interface Money {
  /** Integer minor units (paise, cents). */
  amount: number;
  /** ISO 4217, e.g. "INR". */
  currency: string;
}

export function toMinorUnits(major: number, minorPerMajor = 100): number {
  return Math.round(major * minorPerMajor);
}

export function toMajorUnits(minor: number, minorPerMajor = 100): number {
  return minor / minorPerMajor;
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new Error(`currency mismatch: ${a.currency} vs ${b.currency}`);
  }
  return { amount: a.amount + b.amount, currency: a.currency };
}

/** Isomorphic sleep — typed via globalThis so this package needs no runtime lib types. */
export function sleep(ms: number): Promise<void> {
  const timers = globalThis as unknown as { setTimeout: (fn: () => void, ms: number) => unknown };
  return new Promise((resolve) => timers.setTimeout(resolve, ms));
}

export function isNil(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}
