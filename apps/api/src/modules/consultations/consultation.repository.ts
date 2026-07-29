/**
 * Consultation note repository — the ONLY code that queries `consultationNotes` (Constitution §6).
 * Branch-aware; one note per encounter, written by upsert.
 */
import { Types } from "mongoose";
import { getContext, getTenantDb } from "../../core/context/requestContext.js";
import { writeBranchId } from "../../core/context/activeBranch.js";
import { scopeFilter } from "../../middleware/authorize.js";
import {
  getConsultationNoteModel,
  type ConsultationNoteDoc,
  type Diagnosis,
} from "./consultation.model.js";

export interface ConsultationNote {
  encounterId: string;
  patientId: string;
  doctorId?: string;
  chiefComplaint?: string;
  history?: string;
  examination?: string;
  diagnoses: Diagnosis[];
  plan?: string;
  followUpDays?: number;
  branchId?: string;
  updatedAt: string;
}

function toNote(doc: ConsultationNoteDoc): ConsultationNote {
  return {
    encounterId: doc.encounterId.toString(),
    patientId: doc.patientId,
    ...(doc.doctorId ? { doctorId: doc.doctorId } : {}),
    ...(doc.chiefComplaint ? { chiefComplaint: doc.chiefComplaint } : {}),
    ...(doc.history ? { history: doc.history } : {}),
    ...(doc.examination ? { examination: doc.examination } : {}),
    diagnoses: doc.diagnoses ?? [],
    ...(doc.plan ? { plan: doc.plan } : {}),
    ...(doc.followUpDays != null ? { followUpDays: doc.followUpDays } : {}),
    ...(doc.branchId ? { branchId: doc.branchId } : {}),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export async function findByEncounter(encounterId: string): Promise<ConsultationNote | undefined> {
  if (!Types.ObjectId.isValid(encounterId)) return undefined;
  const doc = await getConsultationNoteModel(getTenantDb())
    .findOne({ encounterId: new Types.ObjectId(encounterId), ...scopeFilter() })
    .lean<ConsultationNoteDoc>();
  return doc ? toNote(doc) : undefined;
}

export interface UpsertNoteInput {
  chiefComplaint?: string;
  history?: string;
  examination?: string;
  diagnoses?: Diagnosis[];
  plan?: string;
  followUpDays?: number;
}

/**
 * Writes the visit's note. `set` carries the fields the doctor supplied; a blank string or empty
 * list CLEARS its field (the doctor wiped the box), so the note never keeps a stale line the screen
 * no longer shows. Keyed on the encounter — the note is 1:1 with the visit.
 */
export async function upsert(
  encounterId: string,
  patientId: string,
  doctorId: string | undefined,
  input: UpsertNoteInput,
): Promise<ConsultationNote> {
  const ctx = getContext();
  const branchId = await writeBranchId();

  const set: Record<string, unknown> = {};
  const unset: Record<string, unknown> = {};
  for (const key of ["chiefComplaint", "history", "examination", "plan"] as const) {
    const value = input[key];
    if (value === undefined) continue;
    const trimmed = value.trim();
    if (trimmed) set[key] = trimmed;
    else unset[key] = "";
  }
  if (input.diagnoses !== undefined) {
    if (input.diagnoses.length > 0) set.diagnoses = input.diagnoses;
    else unset.diagnoses = "";
  }
  if (input.followUpDays !== undefined) {
    if (input.followUpDays > 0) set.followUpDays = input.followUpDays;
    else unset.followUpDays = "";
  }
  if (ctx.userId) set.updatedBy = ctx.userId;

  const doc = await getConsultationNoteModel(getTenantDb()).findOneAndUpdate(
    { encounterId: new Types.ObjectId(encounterId), ...scopeFilter() },
    {
      $set: set,
      ...(Object.keys(unset).length ? { $unset: unset } : {}),
      $setOnInsert: {
        tenantId: ctx.tenantId,
        encounterId: new Types.ObjectId(encounterId),
        patientId,
        ...(doctorId ? { doctorId } : {}),
        ...(branchId ? { branchId } : {}),
      },
    },
    { new: true, upsert: true },
  );
  return toNote(doc);
}
