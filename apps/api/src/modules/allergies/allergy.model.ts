/**
 * Allergies — a patient's recorded intolerances, and the reason the prescribing check
 * has anything to check against.
 *
 * ── AN ALLERGY BELONGS TO THE PERSON, NOT THE VISIT OR THE BRANCH ───────────
 * The patient model already says it: "they may not have visited for ten years and they are
 * still the same person with the same allergies." So an allergy hangs off `patientId`, not
 * off an encounter, and it is read hospital-WIDE — an allergy recorded at one branch must be
 * seen when the patient is prescribed for at another, or the safety net has a hole exactly
 * the width of a referral. The repository keys reads on the patient and never on the branch;
 * `allergy:read` is scoped `tenant` to say so.
 *
 * ── WHY IT IS RECORDED AS A CLASS, NOT FREE TEXT ────────────────────────────
 * `allergen` is a code from the drug-safety catalogue (`ALLERGENS`), never a typed string.
 * A free-text "penicilin" is a note a human reads and a machine cannot match, and a check
 * that silently never fires is worse than no check — it manufactures false confidence. The
 * label the clinician sees is derived from the code, so the record and the check speak the
 * same vocabulary by construction.
 *
 * ── AN ALLERGY IS NEVER DELETED, ONLY REFUTED ───────────────────────────────
 * "The patient is allergic to penicillin" and "we later established they are not" are two
 * different facts, and the second does not erase the first — a reaction was observed, or
 * reported, and that it was later ruled out is itself part of the record. So there is no
 * delete path; the lifecycle is `active → refuted`, and a refuted allergy stops firing the
 * check but stays visible with who ruled it out and why.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { tenantScopePlugin } from "../../core/db/plugins/tenantScope.js";
import { auditPlugin } from "../../core/db/plugins/auditPlugin.js";

/** `active` fires the prescribing check; `refuted` is kept for the record but never fires. */
export const ALLERGY_STATUSES = ["active", "refuted"] as const;
export type AllergyStatus = (typeof ALLERGY_STATUSES)[number];

/**
 * How bad the reaction was. It does NOT change whether the check blocks — a "mild" rash to
 * penicillin still blocks penicillin — but it is what a clinician reads first when deciding
 * whether to override, so it is a first-class field, not a note.
 */
export const ALLERGY_SEVERITIES = ["mild", "moderate", "severe", "anaphylaxis"] as const;
export type AllergySeverity = (typeof ALLERGY_SEVERITIES)[number];

export interface AllergyDoc {
  _id: Types.ObjectId;
  tenantId: string;
  /** Where it was recorded — kept for provenance, NOT used to scope reads (see the header). */
  branchId?: string;

  patientId: Types.ObjectId;

  /** A code from `ALLERGENS`. Validated in the service against that catalogue. */
  allergen: string;
  severity: AllergySeverity;
  /** What actually happened — "rash", "throat swelling". Free text, PHI, excluded from audit diff. */
  reaction?: string;

  status: AllergyStatus;

  notedBy: string;
  notedAt: Date;

  /** Set only when refuted: who ruled it out, when, and why. */
  refutedBy?: string;
  refutedAt?: Date;
  refutedReason?: string;

  createdAt: Date;
  updatedAt: Date;
}

const allergySchema = new Schema<AllergyDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String },

    patientId: { type: Schema.Types.ObjectId, required: true },

    allergen: { type: String, required: true, trim: true },
    severity: { type: String, enum: ALLERGY_SEVERITIES, required: true, default: "moderate" },
    reaction: { type: String, trim: true, maxlength: 2000 },

    status: { type: String, enum: ALLERGY_STATUSES, required: true, default: "active" },

    notedBy: { type: String, required: true },
    notedAt: { type: Date, required: true },

    refutedBy: { type: String },
    refutedAt: { type: Date },
    refutedReason: { type: String, trim: true, maxlength: 2000 },
  },
  // Indexes are owned by migration 0017, never autoIndex — see the patient model.
  { timestamps: true, collection: "allergies", autoIndex: false },
);

allergySchema.plugin(tenantScopePlugin);

/**
 * PHI. `reaction` is excluded from the audit diff for the same reason a ward note's text is:
 * the audit trail records THAT the allergy list changed and by whom, and must not become a
 * second copy of the clinical detail behind weaker access controls than the list itself.
 */
allergySchema.plugin(auditPlugin, {
  resource: "allergy",
  category: "phi",
  ignore: ["reaction"],
});

export function getAllergyModel(conn: Connection): Model<AllergyDoc> {
  return (
    (conn.models.Allergy as Model<AllergyDoc>) ?? conn.model<AllergyDoc>("Allergy", allergySchema)
  );
}
