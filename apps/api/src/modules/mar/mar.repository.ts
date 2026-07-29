/**
 * MAR repository — the ONLY code that queries `medicationAdministrations` (Constitution §6).
 * Branch-aware; append-only in spirit (a given dose is a fact, never edited away).
 */
import { Types } from "mongoose";
import { getContext, getTenantDb } from "../../core/context/requestContext.js";
import { writeBranchId } from "../../core/context/activeBranch.js";
import { scopeFilter } from "../../middleware/authorize.js";
import { getMarModel, type MedicationAdministrationDoc, type MarStatus } from "./mar.model.js";

export interface MedicationAdministration {
  id: string;
  encounterId: string;
  patientId: string;
  prescriptionId: string;
  drugCode: string;
  drugName: string;
  dose: string;
  route: string;
  status: MarStatus;
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
    drugCode: doc.drugCode,
    drugName: doc.drugName,
    dose: doc.dose,
    route: doc.route,
    status: doc.status,
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

export interface RecordInput {
  encounterId: string;
  patientId: string;
  prescriptionId: string;
  drugCode: string;
  drugName: string;
  dose: string;
  route: string;
  status: MarStatus;
  administeredAt: Date;
  reason?: string;
  note?: string;
}

export async function record(input: RecordInput): Promise<MedicationAdministration> {
  const ctx = getContext();
  const branchId = await writeBranchId();
  const doc = await getMarModel(getTenantDb()).create({
    tenantId: ctx.tenantId,
    encounterId: new Types.ObjectId(input.encounterId),
    patientId: input.patientId,
    prescriptionId: new Types.ObjectId(input.prescriptionId),
    drugCode: input.drugCode,
    drugName: input.drugName,
    dose: input.dose,
    route: input.route,
    status: input.status,
    administeredAt: input.administeredAt,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.note ? { note: input.note } : {}),
    ...(ctx.userId ? { administeredBy: ctx.userId } : {}),
    ...(branchId ? { branchId } : {}),
  });
  return toEntry(doc.toObject() as MedicationAdministrationDoc);
}
