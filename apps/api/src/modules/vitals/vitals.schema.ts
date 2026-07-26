/**
 * Vitals DTOs (Doc 09 §5/§6). `.strict()` — an unexpected field is a 400.
 *
 * The bounds mirror the model's: the limits of physical PLAUSIBILITY, not of health. A systolic
 * of 250 must be recordable (it is an emergency, and the chart is what proves it); 2500 is a
 * keyboard slip. See the model header.
 */
import { z } from "@medicore/validation";
import { TRIAGE_LEVELS } from "./vitals.model.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "invalid id");

/** One decimal place is the resolution of every clinical thermometer and scale in use. */
const oneDecimal = (v: number) => Math.round(v * 10) / 10;

export const recordVitalsSchema = z
  .object({
    systolic: z.number().int().min(40).max(300).optional(),
    diastolic: z.number().int().min(20).max(200).optional(),
    pulse: z.number().int().min(20).max(300).optional(),
    respiratoryRate: z.number().int().min(4).max(90).optional(),
    temperature: z.number().min(25).max(45).transform(oneDecimal).optional(),
    spo2: z.number().int().min(40).max(100).optional(),
    weightKg: z.number().min(0.3).max(500).transform(oneDecimal).optional(),
    heightCm: z.number().min(20).max(260).transform(oneDecimal).optional(),
    painScore: z.number().int().min(0).max(10).optional(),

    triageLevel: z.enum(TRIAGE_LEVELS).optional(),
    notes: z.string().max(2000).optional(),
    /** ISO date-time. Omitted means "now"; supplied allows a paper chart to be caught up. */
    recordedAt: z.coerce.date().optional(),
  })
  .strict()
  /**
   * A diastolic at or above the systolic is not a severe patient, it is two numbers typed into
   * the wrong boxes — the single commonest vitals entry error. Caught here because once charted
   * it silently corrupts every mean-arterial-pressure and trend drawn from it.
   */
  .refine(
    (v) => v.systolic === undefined || v.diastolic === undefined || v.diastolic < v.systolic,
    {
      message:
        "diastolic must be lower than systolic — check the two figures are the right way round",
      path: ["diastolic"],
    },
  );

export const encounterIdParamSchema = z.object({ encounterId: objectId }).strict();
export const patientIdParamSchema = z.object({ patientId: objectId }).strict();

export const listPatientVitalsQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(100).optional() })
  .strict();

export type RecordVitalsBody = z.infer<typeof recordVitalsSchema>;
export type ListPatientVitalsQuery = z.infer<typeof listPatientVitalsQuerySchema>;
