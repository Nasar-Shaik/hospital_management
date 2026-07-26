/**
 * Vitals repository — the ONLY code that queries `vitals` (Constitution §6).
 *
 * Two reads, and they answer different clinical questions:
 *   - by ENCOUNTER — "what were the observations on this visit?" (the chart, the IP day sheet);
 *   - by PATIENT — "how has this been trending?" (across visits, newest first, capped).
 *
 * Like allergies, the patient read is NOT branch-scoped: a weight recorded at one branch is the
 * same person's weight at another, and a trend broken by a branch boundary is a trend that lies.
 * `tenantScopePlugin` still forces `tenantId` onto every query, so this reaches every branch of
 * THIS hospital and no other.
 *
 * Append-only: there is no update and no delete (see the model).
 */
import { Types } from "mongoose";
import { getContext, getTenantDb } from "../../core/context/requestContext.js";
import { repointPatientId, type PatientMergeRef } from "../../core/db/repointPatient.js";
import { getVitalsModel, type TriageLevel, type VitalsDoc } from "./vitals.model.js";

/** What leaves the module. Never the raw Mongoose document (Doc 09 §5). */
export interface VitalsReading {
  id: string;
  encounterId: string;
  patientId: string;
  systolic?: number;
  diastolic?: number;
  pulse?: number;
  respiratoryRate?: number;
  temperature?: number;
  spo2?: number;
  weightKg?: number;
  heightCm?: number;
  painScore?: number;
  triageLevel?: TriageLevel;
  notes?: string;
  recordedBy: string;
  recordedAt: Date;
  branchId?: string;
}

/** The measurable fields, as a list — used to map, to validate "is anything here", and to chart. */
export const VITAL_FIELDS = [
  "systolic",
  "diastolic",
  "pulse",
  "respiratoryRate",
  "temperature",
  "spo2",
  "weightKg",
  "heightCm",
  "painScore",
] as const;
export type VitalField = (typeof VITAL_FIELDS)[number];

function toReading(doc: VitalsDoc): VitalsReading {
  const measured: Partial<Record<VitalField, number>> = {};
  for (const field of VITAL_FIELDS) {
    const value = doc[field];
    if (typeof value === "number") measured[field] = value;
  }

  return {
    id: doc._id.toString(),
    encounterId: doc.encounterId.toString(),
    patientId: doc.patientId.toString(),
    ...measured,
    recordedBy: doc.recordedBy,
    recordedAt: doc.recordedAt,
    ...(doc.triageLevel ? { triageLevel: doc.triageLevel } : {}),
    ...(doc.notes ? { notes: doc.notes } : {}),
    ...(doc.branchId ? { branchId: doc.branchId } : {}),
  };
}

export interface CreateVitalsInput extends Partial<Record<VitalField, number>> {
  encounterId: string;
  patientId: string;
  triageLevel?: TriageLevel;
  notes?: string;
  branchId?: string;
  recordedAt: Date;
}

export async function create(input: CreateVitalsInput): Promise<VitalsReading> {
  const ctx = getContext();

  const measured: Partial<Record<VitalField, number>> = {};
  for (const field of VITAL_FIELDS) {
    const value = input[field];
    if (typeof value === "number") measured[field] = value;
  }

  const doc = await getVitalsModel(getTenantDb()).create({
    tenantId: ctx.tenantId,
    encounterId: new Types.ObjectId(input.encounterId),
    patientId: new Types.ObjectId(input.patientId),
    ...measured,
    ...(input.triageLevel ? { triageLevel: input.triageLevel } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
    ...(input.branchId ? { branchId: input.branchId } : {}),
    // The person holding the cuff is the observer of record; `userId` is always set on a
    // request that reached an authorized route.
    recordedBy: ctx.userId ?? "system",
    recordedAt: input.recordedAt,
  });

  return toReading(doc.toObject() as VitalsDoc);
}

/** Every reading on one visit, oldest first — the order a chart is read in. */
export async function forEncounter(encounterId: string): Promise<VitalsReading[]> {
  if (!Types.ObjectId.isValid(encounterId)) return [];
  const docs = await getVitalsModel(getTenantDb())
    .find({ encounterId: new Types.ObjectId(encounterId) })
    .sort({ recordedAt: 1 })
    .lean<VitalsDoc[]>();
  return docs.map(toReading);
}

/**
 * This patient's recent readings across ALL visits, newest first.
 *
 * Capped because a chronic patient accumulates hundreds and a trend view needs the recent tail,
 * not the archive — an uncapped read here is the query that gets slow years after release.
 */
export async function forPatient(patientId: string, limit = 20): Promise<VitalsReading[]> {
  if (!Types.ObjectId.isValid(patientId)) return [];
  const docs = await getVitalsModel(getTenantDb())
    .find({ patientId: new Types.ObjectId(patientId) })
    .sort({ recordedAt: -1 })
    .limit(Math.min(Math.max(limit, 1), 100))
    .lean<VitalsDoc[]>();
  return docs.map(toReading);
}

/** The newest reading for each of several encounters — the "latest obs" column on a list. */
export async function latestForEncounters(
  encounterIds: string[],
): Promise<Map<string, VitalsReading>> {
  const ids = encounterIds
    .filter((id) => Types.ObjectId.isValid(id))
    .map((id) => new Types.ObjectId(id));
  if (ids.length === 0) return new Map();

  const docs = await getVitalsModel(getTenantDb())
    .find({ encounterId: { $in: ids } })
    .sort({ recordedAt: 1 })
    .lean<VitalsDoc[]>();

  // Ascending, so the last write for an encounter wins and the map holds the newest.
  const out = new Map<string, VitalsReading>();
  for (const doc of docs) out.set(doc.encounterId.toString(), toReading(doc));
  return out;
}

/** Moves readings onto the survivor when two patients are merged. */
export function repointPatient(ref: PatientMergeRef): Promise<number> {
  return repointPatientId(getVitalsModel(getTenantDb()), "patientId", ref, { objectId: true });
}
