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
import { repointPatientId, type PatientMergeRef } from "../../core/db/repointPatient.js";

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
  /** The day the follow-up falls on — `2026-08-30`. Derived from `followUpDays` (see the model). */
  followUpOn?: string;
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
    ...(doc.followUpOn ? { followUpOn: doc.followUpOn } : {}),
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
  /**
   * The day `followUpDays` lands on, computed by the SERVICE — it is the only caller that knows
   * the encounter's arrival instant and the site's clock. Written and cleared together with
   * `followUpDays`, never on its own: two fields that can disagree about the same instruction is
   * a chart that says "come back in 7 days" beside "due 3 March".
   */
  followUpOn?: string;
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
    if (input.followUpDays > 0) {
      set.followUpDays = input.followUpDays;
      // The pair moves as one. A `followUpDays` with no date is invisible to the desk; a date
      // with no days is an instruction nobody can explain.
      if (input.followUpOn) set.followUpOn = input.followUpOn;
      else unset.followUpOn = "";
    } else {
      unset.followUpDays = "";
      unset.followUpOn = "";
    }
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

/**
 * One follow-up instruction that has come due, as the note holds it. No clinical content — see
 * `dueFollowUps`.
 */
export interface DueFollowUpRow {
  encounterId: string;
  patientId: string;
  doctorId?: string;
  followUpOn: string;
}

/**
 * Follow-up instructions whose day has arrived or passed, oldest first.
 *
 * ── BRANCH-SCOPED, AND THAT IS THE PRODUCT DECISION, NOT AN ACCIDENT ────────
 * `scopeFilter()` IS called here, unlike the problem list and the allergy list next door. A
 * follow-up belongs to the clinic that issued it: the Hyderabad doctor who said "come back in a
 * week" is who the patient is coming back to, and the Chennai desk has no business in that
 * worklist and no way to act on it. Identity is tenant-wide; a chase list is not identity.
 *
 * ── THE LOOKBACK IS BOUNDED, ON PURPOSE ─────────────────────────────────────
 * Without a floor this list only grows: two years in, every patient who ever missed a review is
 * on it, the desk stops reading it, and the feature is dead. `from` is the caller's floor and the
 * service sets it from a constant — a query parameter would invite somebody to pass 3650 and
 * rediscover the same problem.
 *
 * Returns ONLY the four operational fields. The note's diagnoses, history and examination are in
 * the same document and must never leave through this door: the desk holds `encounter:read`, not
 * `emr:read`. The projection is the enforcement — a `toNote()` here would ship the whole chart.
 */
export async function dueFollowUps(range: {
  from: string;
  to: string;
  limit: number;
}): Promise<DueFollowUpRow[]> {
  const docs = await getConsultationNoteModel(getTenantDb())
    .find({ followUpOn: { $gte: range.from, $lte: range.to }, ...scopeFilter() })
    .select("encounterId patientId doctorId followUpOn")
    .sort({ followUpOn: 1 })
    .limit(range.limit)
    .lean<
      Pick<ConsultationNoteDoc, "_id" | "encounterId" | "patientId" | "doctorId" | "followUpOn">[]
    >();

  return docs.map((d) => ({
    encounterId: d.encounterId.toString(),
    patientId: d.patientId,
    followUpOn: d.followUpOn as string,
    ...(d.doctorId ? { doctorId: d.doctorId } : {}),
  }));
}

/**
 * The note follows the person. A consultation is the doctor's account of one visit, and a merge
 * says the visit belonged to the survivor all along — a note left pointing at the duplicate is a
 * paragraph of the patient's history that their chart no longer shows.
 *
 * `patientId` is a STRING here, not an ObjectId. The flag is not a guess: a mismatch matches
 * nothing and re-points silently zero rows.
 */
export async function repointPatient(ref: PatientMergeRef): Promise<number> {
  return repointPatientId(getConsultationNoteModel(getTenantDb()), "patientId", ref, {
    objectId: false,
  });
}
