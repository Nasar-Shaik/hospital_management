/**
 * Emergency department response contracts.
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves } from "../../core/http/contract.js";
import { TRIAGE_PRIORITIES } from "./emergency.model.js";
import type { Triage } from "./emergency.repository.js";
import type { EdBoardRow } from "./emergency.service.js";

export const triage = contract(
  "EdTriage",
  z.object({
    encounterId: z.string(),
    patientId: z.string(),
    priority: z.enum(TRIAGE_PRIORITIES).optional(),
    chiefComplaint: z.string().optional(),
    triagedAt: z.string().optional(),
    triagedBy: z.string().optional(),
    transferredTo: z.string().optional(),
    transferNote: z.string().optional(),
    transferredAt: z.string().optional(),
  }),
);
export type TriageProof = Proves<Matches<typeof triage, Triage>>;

/** One line on the board — the patient, how sick, how long, and where they are up to. */
export const edBoardRow = contract(
  "EdBoardRow",
  z.object({
    encounterId: z.string(),
    patientId: z.string(),
    patientName: z.string(),
    uhid: z.string(),
    arrivedAt: z.string(),
    waitingMinutes: z.number(),
    priority: z.enum(TRIAGE_PRIORITIES).optional(),
    chiefComplaint: z.string().optional(),
    triagedAt: z.string().optional(),
    status: z.string(),
    doctorId: z.string().optional(),
    token: z.number().optional(),
  }),
);
export type EdBoardRowProof = Proves<Matches<typeof edBoardRow, EdBoardRow>>;
