/**
 * Prescription DTOs (Doc 09 §5/§6). `.strict()` — an unexpected field is a 400.
 */
import { z } from "@medicore/validation";
import { DRUG_FREQUENCIES, DRUG_ROUTES, PRESCRIPTION_STATUSES } from "./prescription.model.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "invalid id");

/**
 * One drug on the prescription.
 *
 * ── `route` AND `frequency` ARE ENUMS, NOT STRINGS ──────────────────────────
 * A free-text route is how "IV" becomes "iv push" becomes "intrathecal" — and vincristine
 * given intrathecally instead of intravenously kills the patient. That is not a
 * hypothetical; it is a recurring, documented, fatal medication error. An enum cannot
 * prevent a doctor choosing the wrong one, but it makes the set of things they can choose
 * a set somebody has looked at.
 *
 * ── `dispensedQty` IS ABSENT, DELIBERATELY ──────────────────────────────────
 * With `.strict()`, sending it is a 400. Only the pharmacy moves that number, and only by
 * dispensing — a prescription that could arrive claiming its drugs were already handed
 * over is a prescription that is dispensed on paper and never actually given.
 */
const lineSchema = z
  .object({
    drugCode: z.string().min(1).max(64),
    drugName: z.string().min(1).max(200),
    /** `500 mg`, `5 ml`, `1 puff` — the unit is part of the instruction. */
    dose: z.string().min(1).max(64),
    route: z.enum(DRUG_ROUTES),
    frequency: z.enum(DRUG_FREQUENCIES),
    durationDays: z.coerce.number().int().min(1).max(365).optional(),
    /**
     * How many units to hand over. Capped at 1000: a real prescription for more than a
     * thousand units of anything is a typo, and the cap is the last thing between a
     * slipped keypress and a pharmacist counting out 5000 tablets.
     */
    quantity: z.coerce.number().int().min(1).max(1000),
    instructions: z.string().max(500).optional(),
  })
  .strict();

export const createPrescriptionSchema = z
  .object({
    /** REQUIRED. A prescription belongs to a visit, never to a note (ADR-0013 §3). */
    encounterId: objectId,
    /**
     * Up to 20 drugs. A prescription longer than that is not a prescription, it is a
     * medication list, and it belongs to the chart rather than to one signature.
     *
     * Empty IS allowed here — a draft you have not finished typing is a normal thing to
     * save. Signing an empty one is refused (`prescription.service.ts`), because that
     * would be a legal instrument authorising nothing.
     */
    lines: z.array(lineSchema).max(20),
    notes: z.string().max(1000).optional(),
  })
  .strict();

/** Note there is no `patientId` — it is taken from the ENCOUNTER, like an order's. */

export const updatePrescriptionSchema = z
  .object({
    lines: z.array(lineSchema).max(20),
    notes: z.string().max(1000).optional(),
  })
  .strict();

export const listPrescriptionsQuerySchema = z
  .object({
    encounterId: objectId.optional(),
    patientId: objectId.optional(),
    status: z.enum(PRESCRIPTION_STATUSES).optional(),
    /** Hide superseded versions — a chart shows what is in force, not what it replaced. */
    current: z.coerce.boolean().optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export const idParamSchema = z.object({ id: objectId }).strict();

/**
 * The sign body. Empty on the ordinary path; `overrideReason` is present only when the
 * prescriber is signing THROUGH a blocking safety alert. The service refuses the override
 * unless a blocking alert actually exists, so this cannot be used to pre-emptively silence
 * a check that has not fired.
 */
export const signPrescriptionSchema = z
  .object({ overrideReason: z.string().min(3).max(1000).optional() })
  .strict();

/** Stopping a drug REQUIRES a reason. "Cancelled" with no why is useless to the next doctor. */
export const cancelPrescriptionSchema = z.object({ reason: z.string().min(3).max(500) }).strict();

export type CreatePrescriptionBody = z.infer<typeof createPrescriptionSchema>;
export type UpdatePrescriptionBody = z.infer<typeof updatePrescriptionSchema>;
export type ListPrescriptionsQuery = z.infer<typeof listPrescriptionsQuerySchema>;
