/**
 * Encounter DTOs (Doc 09 §5/§6). `.strict()` — an unexpected field is a 400.
 */
import { z } from "@medicore/validation";
import { ENCOUNTER_CLASSES, ENCOUNTER_ORIGINS, ENCOUNTER_STATUSES } from "./encounter.model.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "invalid id");

export const startEncounterSchema = z
  .object({
    patientId: objectId,
    /**
     * Defaults to `walk_in`, and that default is the point of this module.
     *
     * The commonest way a patient enters a hospital is by walking through the door.
     * An API that made you say so explicitly — or worse, made you invent an
     * appointment first — would be modelling the majority journey as an exception
     * (ADR-0013).
     */
    origin: z.enum(ENCOUNTER_ORIGINS).default("walk_in"),
    class: z.enum(ENCOUNTER_CLASSES).default("OP"),
    /** One of these is required — which one depends on `encounterPolicy.routing`. */
    doctorId: objectId.optional(),
    departmentId: objectId.optional(),
    reason: z.string().max(500).optional(),
    /** A paid fast-track OP visit — priority in the queue plus an express surcharge. */
    express: z.boolean().default(false),
    branchId: objectId.optional(),
  })
  .strict();

export const listEncountersQuerySchema = z
  .object({
    status: z.enum(ENCOUNTER_STATUSES).optional(),
    doctorId: objectId.optional(),
    departmentId: objectId.optional(),
    patientId: objectId.optional(),
    /** The queue board: everyone waiting or being seen, in token order. */
    queued: z.coerce.boolean().optional(),
    /**
     * The day the patient arrived — `YYYY-MM-DD`, in the HOSPITAL's timezone.
     *
     * This is what the front desk actually asks for ("show me today"), and it is a
     * DATE rather than a timestamp range because a receptionist thinks in days, not
     * in instants. The service turns it into a half-open range; doing that here would
     * put timezone arithmetic in a validator.
     */
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
      .optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

/**
 * The ward round's list. Same `page`/`limit` pair as every other list on this API.
 *
 * ── THE DEFAULT IS 100, NOT 20, AND THAT IS THE COMPATIBILITY PROMISE ───────
 * This endpoint took no parameters at all and the controller called the repository with a
 * hard-coded `{ limit: 100, skip: 0 }`, so a caller that sends nothing has always received up to a
 * hundred stays. Defaulting to the usual 20 would silently shrink every existing client's ward
 * list by 80% — the exact "patients disappear" failure this change exists to fix, introduced from
 * the other direction. The default therefore preserves today's behaviour EXACTLY, and `page` is
 * what makes the rest reachable.
 *
 * The `max(100)` cap is the house limit and is unchanged from what the controller enforced.
 */
export const listInpatientsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(100),
  })
  .strict();

export type ListInpatientsQuery = z.infer<typeof listInpatientsQuerySchema>;

export const idParamSchema = z.object({ id: objectId }).strict();

/** Cancellation REQUIRES a reason — "cancelled" with no why is useless downstream. */
export const cancelEncounterSchema = z.object({ reason: z.string().min(3).max(500) }).strict();

export const closeEncounterSchema = z.object({ reason: z.string().max(500).optional() }).strict();

/**
 * The OP visit summary for the OPD slip. Both optional and both may be an EMPTY string — that is a
 * deliberate clear (the doctor wiped the box), which the service turns into `$unset`.
 */
export const visitSummarySchema = z
  .object({
    diagnosis: z.string().max(2000).optional(),
    advice: z.string().max(2000).optional(),
  })
  .strict();

export type VisitSummaryBody = z.infer<typeof visitSummarySchema>;

/**
 * Admitting a patient.
 *
 * TWO WAYS IN, ONE OF THEM PREFERRED:
 *  - `bedId` — pick a bed from the inventory (B4). The ward name, bed code and tariff are taken
 *    from the catalogue, so a typo can no longer invent an untraceable bed and the tariff is the
 *    one configured for that bed.
 *  - `ward` + `bedCode` + `tariffCode` — the legacy free-text path, kept for hospitals that have
 *    not built their bed inventory yet (and for the existing tests). `tariffCode` is chosen by the
 *    admitter rather than derived from the ward name: "ICU" is not a price, and renaming a ward
 *    must not silently re-price every bed in it.
 *
 * Exactly one shape must be present — `bedId`, OR all three free-text fields.
 */
export const admitSchema = z
  .object({
    bedId: objectId.optional(),
    ward: z.string().min(1).max(100).optional(),
    bedCode: z.string().min(1).max(32).optional(),
    tariffCode: z.string().min(1).max(64).optional(),
    /** The consultant on the ward. Defaults to the OP doctor when omitted. */
    doctorId: objectId.optional(),
    reason: z.string().max(500).optional(),
  })
  .strict()
  .refine((b) => (b.bedId ? true : Boolean(b.ward && b.bedCode && b.tariffCode)), {
    message: "pick a bed (bedId) or give the ward, bedCode and tariffCode",
    path: ["bedId"],
  });

/**
 * Handing the patient to another doctor.
 *
 * The reason is REQUIRED and is not bureaucracy: it is the handover note, and it is the
 * only thing the receiving doctor has to go on. "Who was responsible for this patient at
 * 4pm, and why did that change" is asked exactly once, in the worst circumstances.
 */
export const transferSchema = z
  .object({
    doctorId: objectId,
    reason: z.string().min(3).max(500),
  })
  .strict();

export type StartEncounterBody = z.infer<typeof startEncounterSchema>;
export type AdmitBody = z.infer<typeof admitSchema>;
export type TransferBody = z.infer<typeof transferSchema>;
export type ListEncountersQuery = z.infer<typeof listEncountersQuerySchema>;
