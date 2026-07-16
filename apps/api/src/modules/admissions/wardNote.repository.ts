/**
 * Ward note repository — the ONLY code that queries `wardNotes` (Constitution §6).
 *
 * There is no `update` and no `delete`, deliberately. See the model.
 */
import type { ClientSession } from "mongoose";
import { Types } from "mongoose";
import { getContext, getTenantDb } from "../../core/context/requestContext.js";
import { isDuplicateKey } from "../../core/db/mongoErrors.js";
import { scopeFilter } from "../../middleware/authorize.js";
import { getWardNoteModel, type WardNoteDoc, type WardNoteType } from "./wardNote.model.js";

export { isDuplicateKey };

/** What leaves the module. Never the raw Mongoose document (Doc 09 §5). */
export interface WardNote {
  id: string;
  encounterId: string;
  patientId: string;
  episodeId: string;
  type: WardNoteType;
  text: string;
  diagnosis?: string;
  advice?: string;
  followUpOn?: Date;
  authorId: string;
  at: Date;
  branchId?: string;
}

function toNote(doc: WardNoteDoc): WardNote {
  return {
    id: doc._id.toString(),
    encounterId: doc.encounterId.toString(),
    patientId: doc.patientId.toString(),
    episodeId: doc.episodeId.toString(),
    type: doc.type,
    text: doc.text,
    authorId: doc.authorId,
    at: doc.at,
    ...(doc.diagnosis ? { diagnosis: doc.diagnosis } : {}),
    ...(doc.advice ? { advice: doc.advice } : {}),
    ...(doc.followUpOn ? { followUpOn: doc.followUpOn } : {}),
    ...(doc.branchId ? { branchId: doc.branchId } : {}),
  };
}

export interface CreateWardNoteInput {
  encounterId: string;
  patientId: string;
  episodeId: string;
  type: WardNoteType;
  text: string;
  diagnosis?: string;
  advice?: string;
  followUpOn?: Date;
  branchId?: string;
}

/**
 * Writes a note.
 *
 * Throws a duplicate-key error when a SECOND discharge summary is written for the same
 * admission — by design (migration 0016). One admission, one summary: two would mean the
 * patient goes home holding one document while the hospital's record says another, and
 * nothing anywhere says which is current.
 */
export async function create(
  input: CreateWardNoteInput,
  session?: ClientSession,
): Promise<WardNote> {
  const ctx = getContext();

  const [doc] = await getWardNoteModel(getTenantDb()).create(
    [
      {
        tenantId: ctx.tenantId,
        encounterId: new Types.ObjectId(input.encounterId),
        patientId: new Types.ObjectId(input.patientId),
        episodeId: new Types.ObjectId(input.episodeId),
        type: input.type,
        text: input.text,
        // The author is the authenticated caller, never the body. A note is a signature.
        authorId: ctx.userId ?? "system",
        at: new Date(),
        ...(input.diagnosis ? { diagnosis: input.diagnosis } : {}),
        ...(input.advice ? { advice: input.advice } : {}),
        ...(input.followUpOn ? { followUpOn: input.followUpOn } : {}),
        ...(input.branchId ? { branchId: input.branchId } : {}),
      },
    ],
    session ? { session } : {},
  );

  if (!doc) throw new Error("ward note insert returned nothing");
  return toNote(doc);
}

/** The chart for one admission, oldest first — the order a ward round reads it in. */
export async function listForEncounter(
  encounterId: string,
  type?: WardNoteType,
): Promise<WardNote[]> {
  const docs = await getWardNoteModel(getTenantDb())
    .find({
      ...scopeFilter("authorId"),
      encounterId: new Types.ObjectId(encounterId),
      ...(type ? { type } : {}),
    })
    .sort({ at: 1 })
    .lean<WardNoteDoc[]>();

  return docs.map(toNote);
}

export async function findDischargeSummary(encounterId: string): Promise<WardNote | undefined> {
  const doc = await getWardNoteModel(getTenantDb())
    .findOne({ encounterId: new Types.ObjectId(encounterId), type: "discharge_summary" })
    .lean<WardNoteDoc>();

  return doc ? toNote(doc) : undefined;
}
