/**
 * Money, for humans.
 *
 * ── EVERY AMOUNT IN THIS PRODUCT IS AN INTEGER NUMBER OF PAISE ──────────────
 * ₹150.50 is 15050. It is paise in the database, paise over the wire, paise in the
 * client — and this file is the ONLY place it ever becomes a decimal, at the last
 * moment before a human reads it.
 *
 * Nothing computes on the divided number. `0.1 + 0.2 !== 0.3`, and a hospital that
 * cannot reconcile its day's takings to the rupee stops trusting the software —
 * rightly. If you find yourself wanting to add two `rupees()` results together, you
 * want to add the paise and format once.
 */

/** `15050` → `"₹150.50"`. Indian digit grouping (1,50,000 — not 150,000). */
export function rupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * `"150.50"` → `15050`. For the one place a human types an amount (a payment).
 *
 * Rounds rather than truncates: `Math.round(1.005 * 100)` is the difference between
 * taking ₹1.00 and ₹1.01 from someone, and a cashier's drawer has to balance.
 */
export function toPaise(rupeeInput: string): number {
  const value = Number(rupeeInput);
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.round(value * 100);
}
