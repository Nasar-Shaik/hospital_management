/**
 * Medico-legal DTOs (Doc 09 §5/§6). `.strict()` — an unexpected field is a 400.
 */
import { z } from "@medicore/validation";
import { CONSENT_TYPES, CONSENT_SIGNERS } from "./consent.model.js";
import { MANNER_OF_DEATH } from "./deathRecord.model.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "invalid id");

/* ── consent ─────────────────────────────────────────────────────────────── */

export const recordConsentSchema = z
  .object({
    patientId: objectId,
    encounterId: objectId.optional(),
    type: z.enum(CONSENT_TYPES),
    procedure: z.string().trim().min(1).max(200),
    risksExplained: z.string().trim().max(2000).optional(),
    signedBy: z.enum(CONSENT_SIGNERS).default("patient"),
    signerName: z.string().trim().min(1).max(160),
    relationship: z.string().trim().max(60).optional(),
    language: z.string().trim().max(40).optional(),
    witnessName: z.string().trim().max(160).optional(),
    // When the consent was signed. Defaults to now; may be back-dated to when it was actually taken.
    signedAt: z.coerce.date().optional(),
  })
  .strict();

export const withdrawConsentSchema = z
  .object({ reason: z.string().trim().min(1).max(500) })
  .strict();

/* ── death record ────────────────────────────────────────────────────────── */

export const recordDeathSchema = z
  .object({
    encounterId: objectId,
    diedAt: z.coerce.date(),
    pronouncedAt: z.coerce.date().optional(),
    immediateCause: z.string().trim().min(1).max(500),
    antecedentCause: z.string().trim().max(500).optional(),
    underlyingCause: z.string().trim().max(500).optional(),
    contributingConditions: z.string().trim().max(500).optional(),
    manner: z.enum(MANNER_OF_DEATH).default("natural"),
    medicoLegal: z.boolean().default(false),
    postmortemRequired: z.boolean().default(false),
    bodyHandedTo: z.string().trim().max(160).optional(),
    bodyHandedRelationship: z.string().trim().max(60).optional(),
    remarks: z.string().trim().max(1000).optional(),
  })
  .strict();

/* ── params / query ──────────────────────────────────────────────────────── */

export const patientQuerySchema = z.object({ patientId: objectId }).strict();
export const encounterQuerySchema = z.object({ encounterId: objectId }).strict();
export const idParamSchema = z.object({ id: objectId }).strict();

export type RecordConsentBody = z.infer<typeof recordConsentSchema>;
export type WithdrawConsentBody = z.infer<typeof withdrawConsentSchema>;
export type RecordDeathBody = z.infer<typeof recordDeathSchema>;
export type PatientQuery = z.infer<typeof patientQuerySchema>;
export type EncounterQuery = z.infer<typeof encounterQuerySchema>;
