/**
 * Wallet DTOs (Doc 09 §5/§6: Zod is the single source of DTO truth; `.strict()` so an
 * unexpected field is a 400, not a silently ignored one).
 *
 * `amount` is PAISE — a positive integer, capped so a fat-fingered extra zero is a 400 rather
 * than a ₹10-lakh phantom advance. `method` mirrors a payment method (cash, card, upi…).
 */
import { z } from "@medicore/validation";

/** Paise. Positive integer; ceiling ₹10,00,000 (1e8 paise) — a sane single-transaction cap. */
const paise = z
  .number()
  .int("amount must be a whole number of paise")
  .positive("amount must be positive")
  .max(100_000_000, "amount is implausibly large — enter paise, not rupees");

const method = z.string().trim().min(1).max(40);
const reference = z.string().trim().max(120).optional();
const reason = z.string().trim().max(200).optional();

export const depositSchema = z
  .object({
    amount: paise,
    method,
    reference,
    reason,
    encounterId: z.string().trim().length(24).optional(),
  })
  .strict();

export const refundSchema = z
  .object({
    amount: paise,
    method,
    reference,
    reason,
  })
  .strict();

export type DepositBody = z.infer<typeof depositSchema>;
export type RefundBody = z.infer<typeof refundSchema>;
