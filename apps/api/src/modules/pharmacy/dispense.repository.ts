/**
 * Dispense repository — the ONLY code that queries `dispenses` (Constitution §6).
 */
import type { ClientSession } from "mongoose";
import { Types } from "mongoose";
import { getContext, getTenantDb } from "../../core/context/requestContext.js";
import { isDuplicateKey } from "../../core/db/mongoErrors.js";
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
  createdAt: Date;
}

function toDispense(doc: DispenseDoc): Dispense {
  return {
    id: doc._id.toString(),
    prescriptionId: doc.prescriptionId.toString(),
    encounterId: doc.encounterId.toString(),
    patientId: doc.patientId.toString(),
    episodeId: doc.episodeId.toString(),
    lines: doc.lines ?? [],
    dispensedBy: doc.dispensedBy,
    dispensedAt: doc.dispensedAt,
    createdAt: doc.createdAt,
    ...(doc.orderId ? { orderId: doc.orderId.toString() } : {}),
    ...(doc.requestId ? { requestId: doc.requestId } : {}),
    ...(doc.branchId ? { branchId: doc.branchId } : {}),
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
