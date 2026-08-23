/**
 * Problem repository — the ONLY code that queries `problems` (Constitution §6).
 *
 * ══════════════════════════════════════════════════════════════════════════════
 *  DO NOT ADD `scopeFilter()` TO THIS FILE.
 * ══════════════════════════════════════════════════════════════════════════════
 * It is the property the whole feature rests on, so it is stated where it could be broken —
 * the same warning `patient.repository.ts` and `allergy.repository.ts` carry, for the same
 * reason. A problem list is the patient's, not the site's: hidden behind a branch filter, a
 * patient referred from one hospital site to another arrives with an EMPTY problem list, and an
 * empty list does not read as "we have not looked", it reads as "nothing wrong with them".
 *
 * Tenant isolation still holds without it — `tenantScopePlugin` forces `tenantId` onto every
 * query — so these reads reach every branch of THIS hospital and no other. `branchId` is stored
 * and returned as provenance; nothing filters on it.
 *
 * `emr:read` is declared `branch`-scoped in the permission catalogue, which LOOKS like it
 * disagrees. It does not: the declared scope drives `scopeFilter()`, and reach is decided by
 * whether a repository calls it. Allergies are the same shape one permission over
 * (`allergy:read` is `tenant`, `allergy:manage` is `branch`), and `authorize.ts` says so in as
 * many words. `problems.int.test.ts` §"a problem list crosses branches" is what keeps this true
 * if someone later "fixes" the missing call.
 *
 * There is no hard-delete path. The lifecycle is `active → resolved` (see the model).
 */
import type { ClientSession } from "mongoose";
import { Types } from "mongoose";
import { getContext, getTenantDb } from "../../core/context/requestContext.js";
import { isDuplicateKey } from "../../core/db/mongoErrors.js";
import { repointPatientId, type PatientMergeRef } from "../../core/db/repointPatient.js";
import { getProblemModel, type ProblemDoc, type ProblemStatus } from "./problem.model.js";

export { isDuplicateKey };

/** What leaves the module. Never the raw Mongoose document (Doc 09 §5). */
export interface Problem {
  id: string;
  patientId: string;
  code?: string;
  title: string;
  status: ProblemStatus;
  onsetDate?: Date;
  sourceEncounterId?: string;
  notedBy: string;
  notedAt: Date;
  resolvedBy?: string;
  resolvedAt?: Date;
  resolvedReason?: string;
  branchId?: string;
}

function toProblem(doc: ProblemDoc): Problem {
  return {
    id: doc._id.toString(),
    patientId: doc.patientId.toString(),
    title: doc.title,
    status: doc.status,
    notedBy: doc.notedBy,
    notedAt: doc.notedAt,
    ...(doc.code ? { code: doc.code } : {}),
    ...(doc.onsetDate ? { onsetDate: doc.onsetDate } : {}),
    ...(doc.sourceEncounterId ? { sourceEncounterId: doc.sourceEncounterId.toString() } : {}),
    ...(doc.resolvedBy ? { resolvedBy: doc.resolvedBy } : {}),
    ...(doc.resolvedAt ? { resolvedAt: doc.resolvedAt } : {}),
    ...(doc.resolvedReason ? { resolvedReason: doc.resolvedReason } : {}),
    ...(doc.branchId ? { branchId: doc.branchId } : {}),
  };
}

export interface CreateProblemInput {
  patientId: string;
  title: string;
  code?: string;
  onsetDate?: Date;
  sourceEncounterId?: string;
  /** Provenance fallback — the branch to record when no branch is selected. See `create`. */
  branchId?: string;
}

/**
 * Adds a problem to the list.
 *
 * Throws a duplicate-key error when the same CODED problem is already active for this patient
 * (migration 0056) — two active "E11.9 Type 2 diabetes" rows are one fact entered twice, and the
 * likeliest way to produce them is promoting the same diagnosis twice in one sitting.
 */
export async function create(input: CreateProblemInput, session?: ClientSession): Promise<Problem> {
  const ctx = getContext();

  /**
   * Provenance, resolved so it can never REFUSE the write. `writeBranchId()` is the usual way to
   * stamp a branch, and it throws HMS-BRANCH-001 when a hospital-wide caller has selected none —
   * correct for an operational record that must belong somewhere, wrong here, where the field is
   * written and never read back. A clinician must not be blocked from recording a diagnosis
   * because they are in "All branches" mode.
   */
  const [doc] = await getProblemModel(getTenantDb()).create(
    [
      {
        tenantId: ctx.tenantId,
        patientId: new Types.ObjectId(input.patientId),
        title: input.title,
        status: "active",
        // The recorder is the authenticated caller, never the body.
        notedBy: ctx.userId ?? "system",
        notedAt: new Date(),
        ...(input.code ? { code: input.code } : {}),
        ...(input.onsetDate ? { onsetDate: input.onsetDate } : {}),
        ...(input.sourceEncounterId
          ? { sourceEncounterId: new Types.ObjectId(input.sourceEncounterId) }
          : {}),
        ...(ctx.activeBranchId
          ? { branchId: ctx.activeBranchId }
          : input.branchId
            ? { branchId: input.branchId }
            : {}),
      },
    ],
    session ? { session } : {},
  );

  if (!doc) throw new Error("problem insert returned nothing");
  return toProblem(doc);
}

/**
 * The whole list — active first, then resolved, each newest first.
 *
 * The order is applied here rather than left to the caller because it is the answer to a clinical
 * question ("what is wrong with this patient?"), and a screen that sorted resolved problems into
 * the middle would bury the ones that matter. Sorted in memory after one indexed read: a patient's
 * problem list is tens of rows, and an `active` < `resolved` alphabetical sort would be a
 * correctness dependency on the spelling of a status.
 */
export async function listForPatient(patientId: string): Promise<Problem[]> {
  if (!Types.ObjectId.isValid(patientId)) return [];
  const docs = await getProblemModel(getTenantDb())
    .find({ patientId: new Types.ObjectId(patientId) })
    .sort({ notedAt: -1 })
    .lean<ProblemDoc[]>();

  const rows = docs.map(toProblem);
  return [
    ...rows.filter((p) => p.status === "active"),
    ...rows.filter((p) => p.status !== "active"),
  ];
}

/**
 * Just the ACTIVE problems — the narrow read the chart banner and the consultation screen use.
 * Deliberately its own query rather than a filter in the caller: "which of these still applies"
 * is the decision that must not be gotten wrong twice in two screens.
 */
export async function listActiveForPatient(patientId: string): Promise<Problem[]> {
  if (!Types.ObjectId.isValid(patientId)) return [];
  const docs = await getProblemModel(getTenantDb())
    .find({ patientId: new Types.ObjectId(patientId), status: "active" })
    .sort({ notedAt: -1 })
    .lean<ProblemDoc[]>();
  return docs.map(toProblem);
}

export async function findById(id: string): Promise<Problem | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getProblemModel(getTenantDb())
    .findById(new Types.ObjectId(id))
    .lean<ProblemDoc>();
  return doc ? toProblem(doc) : undefined;
}

/**
 * Closes a problem. Compare-and-swap on `status: "active"`, so two clinicians resolving the same
 * row at once cannot both "win" and overwrite each other's reason — a miss means it was already
 * resolved, which the service turns into a clear message rather than a silent no-op.
 *
 * `{ new: true }` is required, not stylistic: an audited write must hand the plugin the document
 * it produced (D17, `auditPlugin.ts`).
 */
export async function resolve(id: string, reason?: string): Promise<Problem | undefined> {
  const ctx = getContext();
  const doc = await getProblemModel(getTenantDb())
    .findOneAndUpdate(
      { _id: new Types.ObjectId(id), status: "active" },
      {
        $set: {
          status: "resolved",
          resolvedBy: ctx.userId ?? "system",
          resolvedAt: new Date(),
          ...(reason ? { resolvedReason: reason } : {}),
        },
      },
      { new: true },
    )
    .lean<ProblemDoc>();

  return doc ? toProblem(doc) : undefined;
}

/**
 * Move every problem off a merged patient onto the survivor (patient.patients.merged).
 *
 * A problem left pointing at the retired chart is a condition the surviving chart does not show,
 * and the symptom is an absence — the same failure the merge audit found across thirteen other
 * collections. Idempotent — see repointPatientId.
 */
export async function repointPatient(ref: PatientMergeRef): Promise<number> {
  return repointPatientId(getProblemModel(getTenantDb()), "patientId", ref, { objectId: true });
}
