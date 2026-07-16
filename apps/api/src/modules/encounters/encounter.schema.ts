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

export const idParamSchema = z.object({ id: objectId }).strict();

/** Cancellation REQUIRES a reason — "cancelled" with no why is useless downstream. */
export const cancelEncounterSchema = z.object({ reason: z.string().min(3).max(500) }).strict();

export const closeEncounterSchema = z.object({ reason: z.string().max(500).optional() }).strict();

export type StartEncounterBody = z.infer<typeof startEncounterSchema>;
export type ListEncountersQuery = z.infer<typeof listEncountersQuerySchema>;
