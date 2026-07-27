/**
 * Pharmacy DTOs (Doc 09 §5/§6). `.strict()` — an unexpected field is a 400.
 */
import { z } from "@medicore/validation";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "invalid id");

const itemSchema = z
  .object({
    /** The POSITION on the prescription — the same drug can appear on it twice. */
    lineIndex: z.coerce.number().int().min(0).max(19),
    /** How many units cross the counter NOW. Partial handovers are normal. */
    quantity: z.coerce.number().int().min(1).max(1000),
  })
  .strict();

export const dispenseSchema = z
  .object({
    /**
     * At least one item: a handover of nothing is a mis-click, and it would write a
     * ledger row and an event saying drugs moved when none did.
     */
    items: z.array(itemSchema).min(1).max(20),
    /**
     * Idempotency key. The UI should ALWAYS send one — a pharmacist double-clicking
     * "Dispense" must not hand over two lots of a controlled drug and bill for both, and
     * a retry after a timeout must not either.
     */
    requestId: z.string().min(8).max(64).optional(),
    /**
     * Present only when knowingly dispensing OVER an admitted patient's advance — the
     * "authorise on credit" acknowledgement. The API still refuses it unless the caller
     * holds `pharmacy:credit-override` (HMS-PHM-003).
     */
    creditOverride: z
      .object({ reason: z.string().min(3).max(300) })
      .strict()
      .optional(),
  })
  .strict();

/** Note there is no `dispensedBy` — the pharmacist is the authenticated caller. */

export const idParamSchema = z.object({ id: objectId }).strict();

export type DispenseBody = z.infer<typeof dispenseSchema>;
