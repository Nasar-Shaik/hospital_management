/**
 * Dispense repository — the ONLY code that queries `dispenses` (Constitution §6).
 */
import type { ClientSession } from "mongoose";
import { Types } from "mongoose";
import { getContext, getTenantDb } from "../../core/context/requestContext.js";
import { isDuplicateKey } from "../../core/db/mongoErrors.js";
import { repointPatientId, type PatientMergeRef } from "../../core/db/repointPatient.js";
import { getDispenseModel, type DispenseDoc, type DispenseLine } from "./dispense.model.js";

export { isDuplicateKey };

/** What leaves the module. Never the raw Mongoose document (Doc 09 §5). */
export interface Dispense {
  id: string;
  prescriptionId: string;
  encounterId: string;
  patientId: string;
  episodeId: string;
  orderId?: string;
  lines: DispenseLine[];
  dispensedBy: string;
  dispensedAt: Date;
  requestId?: string;
  branchId?: string;
  /** Set when this handover was authorised on credit over an admitted patient's advance. */
  creditOverride?: { by: string; reason: string; shortfall: number; at: Date };
  createdAt: Date;
}

function toDispense(doc: DispenseDoc): Dispense {
  return {
    id: doc._id.toString(),
    prescriptionId: doc.prescriptionId.toString(),
    encounterId: doc.encounterId.toString(),
    patientId: doc.patientId.toString(),
    episodeId: doc.episodeId.toString(),
    // Fields listed rather than handed on whole, for the same reason as `toPrescription`: a
    // record read back with `.lean()` is a plain object, but the one `create()` returns is a
    // hydrated Mongoose document whose subdocuments serialize as their own internals — including
    // a `$__parent` back-reference carrying the entire raw document. Naming the fields is
    // correct on both paths.
    lines: (doc.lines ?? []).map((l) => ({
      lineIndex: l.lineIndex,
      drugCode: l.drugCode,
      drugName: l.drugName,
      quantity: l.quantity,
    })),
    dispensedBy: doc.dispensedBy,
    dispensedAt: doc.dispensedAt,
    createdAt: doc.createdAt,
    ...(doc.orderId ? { orderId: doc.orderId.toString() } : {}),
    ...(doc.requestId ? { requestId: doc.requestId } : {}),
    ...(doc.branchId ? { branchId: doc.branchId } : {}),
    // Tested on `by`, not on the object. `creditOverride` is declared as a nested path GROUP
    // rather than a subdocument, so a hydrated document always materializes it — every ordinary
    // handover was answering with `creditOverride: {}`, an empty object where the type promises
    // either a complete authorisation record or nothing at all. A `.lean()` read of the same
    // dispense omits the key entirely, so the two paths disagreed about the shape as well.
    ...(doc.creditOverride?.by
      ? {
          creditOverride: {
            by: doc.creditOverride.by,
            reason: doc.creditOverride.reason,
            shortfall: doc.creditOverride.shortfall,
            at: doc.creditOverride.at,
          },
        }
      : {}),
  };
}

export interface CreateDispenseInput {
  prescriptionId: string;
  encounterId: string;
  patientId: string;
  episodeId: string;
  orderId?: string;
  lines: DispenseLine[];
  requestId?: string;
  branchId?: string;
  creditOverride?: { by: string; reason: string; shortfall: number; at: Date };
}

/**
 * Records the handover.
 *
 * Throws a duplicate-key error when `requestId` has already been used — by design. The
 * service catches it and hands back the dispense that already exists, because a
 * pharmacist whose click timed out and retried wants one handover, not two.
 */
export async function create(
  input: CreateDispenseInput,
  session?: ClientSession,
): Promise<Dispense> {
  const ctx = getContext();

  const [doc] = await getDispenseModel(getTenantDb()).create(
    [
      {
        tenantId: ctx.tenantId,
        prescriptionId: new Types.ObjectId(input.prescriptionId),
        encounterId: new Types.ObjectId(input.encounterId),
        patientId: new Types.ObjectId(input.patientId),
        episodeId: new Types.ObjectId(input.episodeId),
        lines: input.lines,
        // The pharmacist who handed the drugs over. From the authenticated caller: this
        // is a signature, and a signature you can pass in a body is not one.
        dispensedBy: ctx.userId ?? "system",
        dispensedAt: new Date(),
        ...(input.orderId ? { orderId: new Types.ObjectId(input.orderId) } : {}),
        ...(input.requestId ? { requestId: input.requestId } : {}),
        ...(input.branchId ? { branchId: input.branchId } : {}),
        ...(input.creditOverride ? { creditOverride: input.creditOverride } : {}),
      },
    ],
    session ? { session } : {},
  );

  if (!doc) throw new Error("dispense insert returned nothing");
  return toDispense(doc);
}

export async function findByRequestId(requestId: string): Promise<Dispense | undefined> {
  const doc = await getDispenseModel(getTenantDb()).findOne({ requestId }).lean<DispenseDoc>();
  return doc ? toDispense(doc) : undefined;
}

/** The handover ledger for one prescription, oldest first. */
export async function listForPrescription(prescriptionId: string): Promise<Dispense[]> {
  const docs = await getDispenseModel(getTenantDb())
    .find({ prescriptionId: new Types.ObjectId(prescriptionId) })
    .sort({ dispensedAt: 1 })
    .lean<DispenseDoc[]>();

  return docs.map(toDispense);
}

/**
 * Move a merged patient's dispense records onto the survivor (patient.patients.merged).
 * Idempotent — see repointPatientId.
 */
export async function repointPatient(ref: PatientMergeRef): Promise<number> {
  return repointPatientId(getDispenseModel(getTenantDb()), "patientId", ref, { objectId: true });
}
