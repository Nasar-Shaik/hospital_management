/**
 * Admission response contracts — ward notes and the bed board.
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves, type Returns } from "../../core/http/contract.js";
import { ROOM_KINDS, WARD_KINDS, WARD_STATUSES } from "../wards/index.js";
import { WARD_NOTE_TYPES } from "./wardNote.model.js";
import type { WorklistRow } from "./worklist.js";
import type { WardNote } from "./wardNote.repository.js";
import type { BedBoard } from "./bedBoard.js";
import type { dischargeWithSummary, recordOutcome, transferBed } from "./admission.service.js";

export const wardNote = contract(
  "WardNote",
  z.object({
    id: z.string(),
    encounterId: z.string(),
    patientId: z.string(),
    episodeId: z.string(),
    type: z.enum(WARD_NOTE_TYPES),
    text: z.string(),
    diagnosis: z.string().optional(),
    advice: z.string().optional(),
    followUpOn: z.string().optional(),
    authorId: z.string(),
    at: z.string(),
    branchId: z.string().optional(),
  }),
);
export type WardNoteProof = Proves<Matches<typeof wardNote, WardNote>>;

const counts = z.object({
  total: z.number(),
  free: z.number(),
  occupied: z.number(),
  blocked: z.number(),
});

export const bedBoardOccupant = contract(
  "BedBoardOccupant",
  z.object({
    encounterId: z.string(),
    patientId: z.string(),
    patientName: z.string(),
    uhid: z.string(),
    admittedAt: z.string().optional(),
    doctorId: z.string().optional(),
  }),
);

export const bedBoardBed = contract(
  "BedBoardBed",
  z.object({
    bedId: z.string(),
    code: z.string(),
    /** LEGACY free-text room label — shown only when the bed has no first-class room. */
    room: z.string().optional(),
    roomId: z.string().optional(),
    roomName: z.string().optional(),
    roomKind: z.enum(ROOM_KINDS).optional(),
    tariffCode: z.string(),
    state: z.enum(["free", "occupied", "blocked"]),
    blockedReason: z.string().optional(),
    occupant: bedBoardOccupant.optional(),
  }),
);

export const bedBoardWard = contract(
  "BedBoardWard",
  z.object({
    wardId: z.string(),
    name: z.string(),
    kind: z.enum(WARD_KINDS),
    status: z.enum(WARD_STATUSES),
    tariffCode: z.string(),
    beds: z.array(bedBoardBed),
    counts,
  }),
);

/** An admitted patient whose recorded ward/bed matches no bed in the inventory. */
export const bedBoardUnlisted = contract(
  "BedBoardUnlisted",
  z.object({
    encounterId: z.string(),
    patientId: z.string(),
    patientName: z.string(),
    uhid: z.string(),
    ward: z.string(),
    bedCode: z.string(),
    admittedAt: z.string().optional(),
  }),
);

export const bedBoard = contract(
  "BedBoard",
  z.object({
    wards: z.array(bedBoardWard),
    totals: counts,
    unlisted: z.array(bedBoardUnlisted),
  }),
);
export type BedBoardProof = Proves<Matches<typeof bedBoard, BedBoard>>;

/** Discharge writes the summary AND ends the stay; the client needs both facts. */
export const dischargeResult = contract(
  "DischargeResult",
  z.object({ summary: wardNote, encounterId: z.string() }),
);
export type DischargeResultProof = Proves<
  Matches<typeof dischargeResult, Returns<typeof dischargeWithSummary>>
>;

/** A non-routine ending — LAMA, absconded, or a death. */
export const outcomeResult = contract(
  "OutcomeResult",
  z.object({ note: wardNote, encounterId: z.string() }),
);
export type OutcomeResultProof = Proves<
  Matches<typeof outcomeResult, Returns<typeof recordOutcome>>
>;

const bedRef = z.object({ ward: z.string(), bedCode: z.string() });
export const transferBedResult = contract(
  "TransferBedResult",
  z.object({ from: bedRef, to: bedRef }),
);
export type TransferBedResultProof = Proves<
  Matches<typeof transferBedResult, Returns<typeof transferBed>>
>;

/**
 * One line of the ward worklist (M3-S3).
 *
 * Deliberately a SUMMARY, not a chart: counts and flags a nurse triages from, with the detail one
 * tap away through the per-patient endpoints. Identity is not repeated here — `/bed-board` already
 * resolves name and UHID for every occupied bed in one query, and duplicating it would create a
 * second place for a patient's name to be wrong.
 */
export const worklistRow = contract(
  "WorklistRow",
  z.object({
    encounterId: z.string(),
    patientId: z.string(),
    ward: z.string().optional(),
    bedCode: z.string().optional(),
    admittedAt: z.string().optional(),
    status: z.string(),
    /** Active allergen CODES. Empty means none recorded — never "none". */
    allergens: z.array(z.string()),
    severeAllergy: z.boolean(),
    /** Doses expected today that nobody has answered. Server-computed, in the ward's timezone. */
    dosesDue: z.number(),
    /** Of those, the ones already past their round. A subset of `dosesDue`. */
    dosesOverdue: z.number(),
  }),
);
export type WorklistRowProof = Proves<Matches<typeof worklistRow, WorklistRow>>;
