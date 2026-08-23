/**
 * The PROBLEM LIST — what is true of this patient TODAY.
 *
 * ── WHY A THIRD COLLECTION, WHEN TWO ALREADY HOLD DIAGNOSES ─────────────────
 * They answer different questions, and neither answers this one:
 *
 *   consultation.diagnoses[]   TESTIMONY       what the clinician concluded at ONE visit.
 *                              Immutable in meaning: "dengue, provisional, 14 March" stays true
 *                              forever, even after the dengue resolves.
 *   encounterCoding.codes[]    CLASSIFICATION  what the hospital tells the state about ONE visit.
 *                              Revisable by a coder, deliberately separate from the note.
 *   problems (here)            PATIENT STATE   what a clinician needs to know before they see
 *                              this person, across every visit — and it has a LIFECYCLE the
 *                              other two must never grow: active → resolved.
 *
 * So this is not a third diagnosis system. It is derived from the first (a clinician PROMOTES a
 * consultation diagnosis, keeping `sourceEncounterId` as the pointer back) and speaks the
 * vocabulary of the second (`code` is a real key into the `icdCodes` master). Neither existing
 * collection is read differently, written differently, or reinterpreted because this exists.
 *
 * ── A PROBLEM BELONGS TO THE PERSON, NOT THE VISIT OR THE BRANCH ────────────
 * Exactly the allergy argument, and the reason this model is shaped like `allergy.model.ts`: a
 * problem list confined to one branch is a problem list that is empty at the site the patient was
 * referred to, which reads as "nothing wrong with them" rather than "we did not look". `branchId`
 * is recorded as PROVENANCE and is never filtered on — see `problem.repository.ts`, which states
 * in its header why `scopeFilter()` must not appear there.
 *
 * ── A PROBLEM IS RESOLVED, NEVER DELETED ────────────────────────────────────
 * "This patient has hypertension" and "the hypertension has resolved" are two facts, and the
 * second does not erase the first. There is no delete path; a resolved problem leaves the active
 * list and stays on the record with who closed it, when and why.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { tenantScopePlugin } from "../../core/db/plugins/tenantScope.js";
import { auditPlugin } from "../../core/db/plugins/auditPlugin.js";

/** `active` is what the chart shows first; `resolved` is history, kept and never deleted. */
export const PROBLEM_STATUSES = ["active", "resolved"] as const;
export type ProblemStatus = (typeof PROBLEM_STATUSES)[number];

export interface ProblemDoc {
  _id: Types.ObjectId;
  tenantId: string;
  /** Where it was recorded — provenance, NOT used to scope reads (see the header). */
  branchId?: string;

  patientId: Types.ObjectId;

  /**
   * An ICD-10 code from the `icdCodes` master, when there is one. OPTIONAL on purpose: a real
   * problem list carries entries that have not been coded yet ("post-operative wound, left leg"),
   * and refusing them would push clinicians back to writing the problem in a free-text note where
   * nothing can find it. Validated against the master by the service when supplied — an
   * unvalidated code is the free-text `consultation.diagnoses[].code` again, which is precisely
   * the thing this collection exists to be better than.
   */
  code?: string;
  /** The condition in words — ALWAYS present. A code with no name is unreadable at the bedside. */
  title: string;

  status: ProblemStatus;

  /** When the condition began, as far as anyone knows. Rarely precise, often useful. */
  onsetDate?: Date;
  /** The visit whose diagnosis this was promoted from. Absent when added directly. */
  sourceEncounterId?: Types.ObjectId;

  notedBy: string;
  notedAt: Date;

  /** Set only when resolved: who closed it, when, and — if they said — why. */
  resolvedBy?: string;
  resolvedAt?: Date;
  resolvedReason?: string;

  createdAt: Date;
  updatedAt: Date;
}

const problemSchema = new Schema<ProblemDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String },

    patientId: { type: Schema.Types.ObjectId, required: true },

    code: { type: String, trim: true, uppercase: true, maxlength: 16 },
    title: { type: String, required: true, trim: true, maxlength: 300 },

    status: { type: String, enum: PROBLEM_STATUSES, required: true, default: "active" },

    onsetDate: { type: Date },
    sourceEncounterId: { type: Schema.Types.ObjectId },

    notedBy: { type: String, required: true },
    notedAt: { type: Date, required: true },

    resolvedBy: { type: String },
    resolvedAt: { type: Date },
    resolvedReason: { type: String, trim: true, maxlength: 2000 },
  },
  // Indexes are owned by migration 0056, never autoIndex — see the patient model.
  { timestamps: true, collection: "problems", autoIndex: false },
);

problemSchema.plugin(tenantScopePlugin);

/**
 * PHI — a problem list IS the diagnosis, like `encounterCodings`. `resolvedReason` is excluded
 * from the diff for the same reason an allergy's `reaction` is: the trail records THAT the list
 * changed and by whom, and must not become a second copy of the clinical detail behind a longer
 * retention period than the record itself.
 */
problemSchema.plugin(auditPlugin, {
  resource: "problem",
  category: "phi",
  ignore: ["resolvedReason"],
});

export function getProblemModel(conn: Connection): Model<ProblemDoc> {
  return (
    (conn.models.Problem as Model<ProblemDoc>) ?? conn.model<ProblemDoc>("Problem", problemSchema)
  );
}
