/**
 * MAR repository — the ONLY code that queries `medicationAdministrations` (Constitution §6).
 * Branch-aware; append-only in spirit (a given dose is a fact, never edited away).
 */
import { Types } from "mongoose";
import { getContext, getTenantDb } from "../../core/context/requestContext.js";
import { writeBranchId } from "../../core/context/activeBranch.js";
import { isDuplicateKey } from "../../core/db/mongoErrors.js";
import { scopeFilter } from "../../middleware/authorize.js";
import { getMarModel, type MedicationAdministrationDoc, type MarStatus } from "./mar.model.js";
import { repointPatientId, type PatientMergeRef } from "../../core/db/repointPatient.js";

export interface MedicationAdministration {
  id: string;
  encounterId: string;
  patientId: string;
  prescriptionId: string;
  /** Which line of the prescription — see `mar.model.ts`. Absent on rows predating M3-S1. */
  lineIndex?: number;
  drugCode: string;
  drugName: string;
  dose: string;
  route: string;
  status: MarStatus;
  /** The dose slot answered, if any. Absent for PRN and out-of-window back-charting. */
  scheduledFor?: string;
  administeredAt: string;
  reason?: string;
  note?: string;
  administeredBy?: string;
}

function toEntry(doc: MedicationAdministrationDoc): MedicationAdministration {
  return {
    id: doc._id.toString(),
    encounterId: doc.encounterId.toString(),
    patientId: doc.patientId,
    prescriptionId: doc.prescriptionId.toString(),
    ...(doc.lineIndex !== undefined ? { lineIndex: doc.lineIndex } : {}),
    drugCode: doc.drugCode,
    drugName: doc.drugName,
    dose: doc.dose,
    route: doc.route,
    status: doc.status,
    ...(doc.scheduledFor ? { scheduledFor: doc.scheduledFor.toISOString() } : {}),
    administeredAt: doc.administeredAt.toISOString(),
    ...(doc.reason ? { reason: doc.reason } : {}),
    ...(doc.note ? { note: doc.note } : {}),
    ...(doc.administeredBy ? { administeredBy: doc.administeredBy } : {}),
  };
}

/** The MAR for a visit, most recent first — the ward's chart and the handover read this. */
export async function listByEncounter(encounterId: string): Promise<MedicationAdministration[]> {
  if (!Types.ObjectId.isValid(encounterId)) return [];
  const docs = await getMarModel(getTenantDb())
    .find({ encounterId: new Types.ObjectId(encounterId), ...scopeFilter() })
    .sort({ administeredAt: -1 })
    .lean<MedicationAdministrationDoc[]>();
  return docs.map(toEntry);
}

/**
 * Administrations for MANY stays at once — the ward worklist's single query.
 *
 * Branch-scoped like its per-encounter sibling: a dose given at another site is not this ward's
 * business, and the worklist only ever asks about stays it can already see.
 */
export async function listByEncounters(
  encounterIds: readonly string[],
): Promise<MedicationAdministration[]> {
  const ids = encounterIds
    .filter((id) => Types.ObjectId.isValid(id))
    .map((id) => new Types.ObjectId(id));
  if (ids.length === 0) return [];
  const docs = await getMarModel(getTenantDb())
    .find({ encounterId: { $in: ids }, ...scopeFilter() })
    .lean<MedicationAdministrationDoc[]>();
  return docs.map(toEntry);
}

/** The administration already holding a dose slot, if one does. The 409's oracle. */
export async function findBySlot(
  prescriptionId: string,
  lineIndex: number,
  scheduledFor: Date,
): Promise<MedicationAdministration | undefined> {
  if (!Types.ObjectId.isValid(prescriptionId)) return undefined;
  const doc = await getMarModel(getTenantDb())
    .findOne({
      prescriptionId: new Types.ObjectId(prescriptionId),
      lineIndex,
      scheduledFor,
      ...scopeFilter(),
    })
    .lean<MedicationAdministrationDoc>();
  return doc ? toEntry(doc) : undefined;
}

export interface RecordInput {
  encounterId: string;
  patientId: string;
  prescriptionId: string;
  lineIndex: number;
  drugCode: string;
  drugName: string;
  dose: string;
  route: string;
  status: MarStatus;
  /** Omitted for PRN and out-of-window back-charting — those rows are unconstrained. */
  scheduledFor?: Date;
  administeredAt: Date;
  reason?: string;
  note?: string;
}

/**
 * Either the row was written, or the slot was already taken.
 *
 * A discriminated result rather than a thrown error because a taken slot is **not a failure** —
 * it is the answer the caller asked for, and the row that took it is the useful part of that
 * answer. Mapping it to HTTP is the service's job; this layer does not know what a 409 is.
 */
export type RecordResult =
  | { outcome: "recorded"; entry: MedicationAdministration }
  | { outcome: "duplicate"; existing?: MedicationAdministration };

/**
 * Charts one administration.
 *
 * ── THE INSERT IS THE CONCURRENCY CONTROL ───────────────────────────────────
 * There is deliberately NO read-then-write check for an existing administration here. Between a
 * check and an insert, a second nurse's request fits — that is the whole shape of the race, and
 * a service-level guard would close it only for requests that happen not to interleave. The
 * unique index (migration 0049) is what actually arbitrates, so the insert simply proceeds and
 * E11000 is read as "somebody else got this slot first".
 */
export async function record(input: RecordInput): Promise<RecordResult> {
  const ctx = getContext();
  const branchId = await writeBranchId();
  try {
    const doc = await getMarModel(getTenantDb()).create({
      tenantId: ctx.tenantId,
      encounterId: new Types.ObjectId(input.encounterId),
      patientId: input.patientId,
      prescriptionId: new Types.ObjectId(input.prescriptionId),
      lineIndex: input.lineIndex,
      drugCode: input.drugCode,
      drugName: input.drugName,
      dose: input.dose,
      route: input.route,
      status: input.status,
      ...(input.scheduledFor ? { scheduledFor: input.scheduledFor } : {}),
      administeredAt: input.administeredAt,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.note ? { note: input.note } : {}),
      ...(ctx.userId ? { administeredBy: ctx.userId } : {}),
      ...(branchId ? { branchId } : {}),
    });
    return { outcome: "recorded", entry: toEntry(doc.toObject() as MedicationAdministrationDoc) };
  } catch (err) {
    if (!isDuplicateKey(err) || !input.scheduledFor) throw err;
    // Read back who holds it. `existing` may be undefined if the winner sits in another branch,
    // which `scopeFilter` correctly hides — the refusal still stands, we just cannot name it.
    return {
      outcome: "duplicate",
      existing: await findBySlot(input.prescriptionId, input.lineIndex, input.scheduledFor),
    };
  }
}

/**
 * The medication administration record follows the person, and this is the one on this list with a
 * safety argument rather than a tidiness one: "what has this patient already been given?" is asked
 * before every dose, and an answer that silently omits everything charted under the duplicate is
 * how a dose gets repeated.
 *
 * `patientId` is a STRING in this collection.
 */
export async function repointPatient(ref: PatientMergeRef): Promise<number> {
  return repointPatientId(getMarModel(getTenantDb()), "patientId", ref, { objectId: false });
}
