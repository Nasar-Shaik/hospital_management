/**
 * Allergy repository — the ONLY code that queries `allergies` (Constitution §6).
 *
 * ── READS ARE KEYED ON THE PATIENT, AND NEVER ON THE BRANCH ──────────────────
 * This is the safety property the whole feature rests on, so it lives in the one place that
 * could break it. `scopeFilter()` is NOT called here. An allergy recorded at one branch must
 * be visible when the patient is prescribed for at another; a branch filter would hide it,
 * and the prescribing check would see an empty list and wave the fatal drug through. Tenant
 * isolation still holds — `tenantScopePlugin` forces `tenantId` onto every query — so this
 * reaches every branch of THIS hospital and no other. That is exactly the reach an allergy
 * should have, which is why `allergy:read` is scoped `tenant` rather than `branch`.
 *
 * There is no hard-delete path. The lifecycle is `active → refuted` (see the model).
 */
import type { ClientSession } from "mongoose";
import { Types } from "mongoose";
import { getContext, getTenantDb } from "../../core/context/requestContext.js";
import { isDuplicateKey } from "../../core/db/mongoErrors.js";
import { repointPatientId, type PatientMergeRef } from "../../core/db/repointPatient.js";
import {
  getAllergyModel,
  type AllergyDoc,
  type AllergySeverity,
  type AllergyStatus,
} from "./allergy.model.js";

export { isDuplicateKey };

/** What leaves the module. Never the raw Mongoose document (Doc 09 §5). */
export interface Allergy {
  id: string;
  patientId: string;
  allergen: string;
  severity: AllergySeverity;
  reaction?: string;
  status: AllergyStatus;
  notedBy: string;
  notedAt: Date;
  refutedBy?: string;
  refutedAt?: Date;
  refutedReason?: string;
  branchId?: string;
}

function toAllergy(doc: AllergyDoc): Allergy {
  return {
    id: doc._id.toString(),
    patientId: doc.patientId.toString(),
    allergen: doc.allergen,
    severity: doc.severity,
    status: doc.status,
    notedBy: doc.notedBy,
    notedAt: doc.notedAt,
    ...(doc.reaction ? { reaction: doc.reaction } : {}),
    ...(doc.refutedBy ? { refutedBy: doc.refutedBy } : {}),
    ...(doc.refutedAt ? { refutedAt: doc.refutedAt } : {}),
    ...(doc.refutedReason ? { refutedReason: doc.refutedReason } : {}),
    ...(doc.branchId ? { branchId: doc.branchId } : {}),
  };
}

export interface CreateAllergyInput {
  patientId: string;
  allergen: string;
  severity: AllergySeverity;
  reaction?: string;
  branchId?: string;
}

/**
 * Records an allergy.
 *
 * Throws a duplicate-key error when the SAME active allergen is recorded twice for one
 * patient — by design (migration 0017). Two "active penicillin allergy" rows are not more
 * information; they are one fact entered twice, and they would make the prescribing alert
 * fire in duplicate for no reason.
 */
export async function create(input: CreateAllergyInput, session?: ClientSession): Promise<Allergy> {
  const ctx = getContext();

  const [doc] = await getAllergyModel(getTenantDb()).create(
    [
      {
        tenantId: ctx.tenantId,
        patientId: new Types.ObjectId(input.patientId),
        allergen: input.allergen,
        severity: input.severity,
        status: "active",
        // The recorder is the authenticated caller, never the body.
        notedBy: ctx.userId ?? "system",
        notedAt: new Date(),
        ...(input.reaction ? { reaction: input.reaction } : {}),
        ...(input.branchId ? { branchId: input.branchId } : {}),
      },
    ],
    session ? { session } : {},
  );

  if (!doc) throw new Error("allergy insert returned nothing");
  return toAllergy(doc);
}

/**
 * Every allergy on the patient, most recent first — for the management screen, which shows
 * refuted ones too (greyed) so a clinician can see what was ruled out and not re-add it.
 */
export async function listForPatient(patientId: string): Promise<Allergy[]> {
  const docs = await getAllergyModel(getTenantDb())
    .find({ patientId: new Types.ObjectId(patientId) })
    .sort({ notedAt: -1 })
    .lean<AllergyDoc[]>();

  return docs.map(toAllergy);
}

/**
 * The ACTIVE allergens the prescribing check screens against. Deliberately the narrow read:
 * a refuted allergy must not fire the block, and returning the whole list here would put that
 * decision in the caller, where it would eventually be gotten wrong.
 */
export async function listActiveForPatient(patientId: string): Promise<Allergy[]> {
  const docs = await getAllergyModel(getTenantDb())
    .find({ patientId: new Types.ObjectId(patientId), status: "active" })
    .lean<AllergyDoc[]>();

  return docs.map(toAllergy);
}

export async function findById(id: string): Promise<Allergy | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getAllergyModel(getTenantDb())
    .findById(new Types.ObjectId(id))
    .lean<AllergyDoc>();
  return doc ? toAllergy(doc) : undefined;
}

/**
 * Rules an allergy out. Compare-and-swap on `status: "active"` so two clinicians refuting the
 * same row at once cannot both "win" and overwrite each other's reason — a miss means it was
 * already refuted, which the service turns into a clear message rather than a silent no-op.
 */
export async function refute(id: string, reason: string): Promise<Allergy | undefined> {
  const ctx = getContext();
  const doc = await getAllergyModel(getTenantDb())
    .findOneAndUpdate(
      { _id: new Types.ObjectId(id), status: "active" },
      {
        $set: {
          status: "refuted",
          refutedBy: ctx.userId ?? "system",
          refutedAt: new Date(),
          refutedReason: reason,
        },
      },
      { new: true },
    )
    .lean<AllergyDoc>();

  return doc ? toAllergy(doc) : undefined;
}

/**
 * Move every allergy off a merged patient onto the survivor (patient.patients.merged).
 *
 * The most safety-critical re-point in the system: an allergy left pointing at the
 * merged record is an allergy `drugSafety.screen()` will never see, and the fatal drug
 * goes through. Idempotent — see repointPatientId.
 */
export async function repointPatient(ref: PatientMergeRef): Promise<number> {
  return repointPatientId(getAllergyModel(getTenantDb()), "patientId", ref, { objectId: true });
}
