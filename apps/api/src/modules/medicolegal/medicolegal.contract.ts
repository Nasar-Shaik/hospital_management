/**
 * Medico-legal response contracts — consents and death records.
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves } from "../../core/http/contract.js";
import { CONSENT_SIGNERS, CONSENT_STATUSES, CONSENT_TYPES } from "./consent.model.js";
import { MANNER_OF_DEATH } from "./deathRecord.model.js";
import type { Consent } from "./consent.repository.js";
import type { DeathRecord } from "./deathRecord.repository.js";

export const consent = contract(
  "Consent",
  z.object({
    id: z.string(),
    patientId: z.string(),
    encounterId: z.string().optional(),
    type: z.enum(CONSENT_TYPES),
    procedure: z.string(),
    risksExplained: z.string().optional(),
    /** WHO signed — a guardian's consent is a different legal fact from the patient's. */
    signedBy: z.enum(CONSENT_SIGNERS),
    signerName: z.string(),
    relationship: z.string().optional(),
    /** The language it was explained in — part of whether consent was informed. */
    language: z.string().optional(),
    witnessName: z.string().optional(),
    explainedBy: z.string().optional(),
    signedAt: z.string(),
    status: z.enum(CONSENT_STATUSES),
    withdrawnAt: z.string().optional(),
    withdrawalReason: z.string().optional(),
    createdAt: z.string(),
  }),
);
export type ConsentProof = Proves<Matches<typeof consent, Consent>>;

export const deathRecord = contract(
  "DeathRecord",
  z.object({
    id: z.string(),
    patientId: z.string(),
    encounterId: z.string(),
    diedAt: z.string(),
    pronouncedAt: z.string().optional(),
    /** The certificate's causal chain, immediate first — the WHO form's structure. */
    immediateCause: z.string(),
    antecedentCause: z.string().optional(),
    underlyingCause: z.string().optional(),
    contributingConditions: z.string().optional(),
    manner: z.enum(MANNER_OF_DEATH),
    /** True when the police must be involved before the body is released. */
    medicoLegal: z.boolean(),
    postmortemRequired: z.boolean(),
    certifiedBy: z.string().optional(),
    bodyHandedTo: z.string().optional(),
    bodyHandedRelationship: z.string().optional(),
    remarks: z.string().optional(),
    createdAt: z.string(),
  }),
);
export type DeathRecordProof = Proves<Matches<typeof deathRecord, DeathRecord>>;
