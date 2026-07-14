/**
 * Patient master (tenant DB `patients`, Doc 03 §6, Doc 02 C1).
 *
 * THE FIRST COLLECTION IN THIS CODEBASE THAT HOLDS PHI. Everything before it was
 * platform machinery — tenants, users, roles, plans. From here on the data is a
 * person's health information, and three things follow that did not before:
 *
 *   1. `auditPlugin` runs with `category: "phi"`. Reads are not audited (that
 *      would double the write load of every list screen); every WRITE is.
 *   2. The row scope on `patient:read` is `branch` (see the permission catalog),
 *      so a clerk at one branch does not browse another branch's patients.
 *   3. Nothing here is ever hard-deleted. A patient record is a legal document
 *      with a statutory retention period (DATA_RETENTION_POLICY) — the only
 *      "removal" is a merge, which preserves both rows and links them.
 *
 * ── UHID ─────────────────────────────────────────────────────────────────────
 * The Unique Hospital Identifier (DOMAIN_GLOSSARY) — tenant-scoped, permanent,
 * issued once at first registration and stable across every visit and branch for
 * the rest of the patient's life. It is the number on the wristband and the number
 * the patient reads out on the phone. It is NOT the `_id`: an ObjectId is a
 * database detail, and a human being cannot read one over a counter.
 *
 * ── WHY THERE IS NO `deleted` FLAG AND NO `status: "inactive"` ───────────────
 * A patient does not become inactive. They may not have visited for ten years and
 * they are still the same person with the same allergies. The only lifecycle this
 * record has is the one in STATE_MACHINE_CATALOG §13: `active → merged`.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { tenantScopePlugin } from "../../core/db/plugins/tenantScope.js";
import { auditPlugin } from "../../core/db/plugins/auditPlugin.js";

/** STATE_MACHINE_CATALOG §13. `merged` is terminal — a merged record is never revived. */
export const PATIENT_STATUSES = ["active", "merged"] as const;
export type PatientStatus = (typeof PATIENT_STATUSES)[number];

export const GENDERS = ["male", "female", "other", "unknown"] as const;
export type Gender = (typeof GENDERS)[number];

/**
 * `unknown` is not a diversity checkbox — it is the unconscious patient wheeled in
 * from a road accident. Registration must never be blocked by a field nobody can
 * answer yet, so gender and date of birth are both allowed to be unknown and
 * corrected later (BUSINESS_WORKFLOWS §1: "emergency unknown patient → temp UHID,
 * reconcile later"). A registration form that cannot describe an emergency is a
 * registration form that gets bypassed on paper.
 */
export const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-", "unknown"] as const;
export type BloodGroup = (typeof BLOOD_GROUPS)[number];

export interface PatientDoc {
  _id: Types.ObjectId;
  tenantId: string;
  /** The branch that registered them. Row scope (`branch`) is applied against this. */
  branchId?: string;

  uhid: string;
  name: string;
  /**
   * Normalized name for duplicate detection: lowercased, punctuation and spacing
   * removed. Stored rather than computed at query time so the MPI lookup is an
   * index hit instead of a collection scan — the search runs on every single
   * registration, at a busy front desk, while a patient stands and waits.
   */
  nameKey: string;
  dob?: Date;
  gender: Gender;
  bloodGroup?: BloodGroup;

  contact: {
    phone?: string;
    email?: string;
  };
  address?: {
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  };

  status: PatientStatus;
  /** Set only on a merged record: the survivor this one was folded into. */
  mergedInto?: Types.ObjectId;
  mergedAt?: Date;

  /**
   * Recorded when a clerk registered someone the MPI believed was already here.
   * Kept because a wrong override is how a duplicate chart is born, and the
   * person who has to clean it up six months later needs to know it was a
   * decision rather than an accident.
   */
  duplicateOverride?: {
    at: Date;
    by: string;
    candidateIds: string[];
  };

  registeredBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const patientSchema = new Schema<PatientDoc>(
  {
    branchId: { type: String },

    uhid: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    nameKey: { type: String, required: true },
    dob: { type: Date },
    gender: { type: String, enum: GENDERS, required: true, default: "unknown" },
    bloodGroup: { type: String, enum: BLOOD_GROUPS },

    contact: {
      phone: { type: String, trim: true },
      email: { type: String, lowercase: true, trim: true },
    },
    address: {
      line1: { type: String, trim: true },
      line2: { type: String, trim: true },
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      postalCode: { type: String, trim: true },
      country: { type: String, trim: true },
    },

    status: { type: String, enum: PATIENT_STATUSES, required: true, default: "active" },
    mergedInto: { type: Schema.Types.ObjectId },
    mergedAt: { type: Date },

    duplicateOverride: {
      type: {
        at: { type: Date, required: true },
        by: { type: String, required: true },
        // `default: undefined` — Mongoose silently defaults an array path to [],
        // which once made the audit hash-chain report tampering on an untouched
        // trail (PROJECT_MEMORY §8). The same trap applies to anything audited.
        candidateIds: { type: [String], default: undefined },
      },
      default: undefined,
      _id: false,
    },

    registeredBy: { type: String },
  },
  // Indexes belong to migration 0008, never to autoIndex — index creation on a
  // live hospital is a reviewable step, not a side effect of a deploy.
  { timestamps: true, collection: "patients", autoIndex: false },
);

patientSchema.plugin(tenantScopePlugin);

/**
 * PHI category. This is the entry a regulator asks for by name: who touched this
 * patient's demographics, when, and from where.
 *
 * `nameKey` is ignored — it is a derived index key, not a fact about the patient,
 * and a "nameKey changed" line in a clinical audit trail is noise that pushes the
 * real change off the screen. The `name` change beside it carries the meaning.
 */
patientSchema.plugin(auditPlugin, {
  resource: "patient",
  category: "phi",
  ignore: ["nameKey"],
});

export function getPatientModel(conn: Connection): Model<PatientDoc> {
  return (
    (conn.models.Patient as Model<PatientDoc>) ?? conn.model<PatientDoc>("Patient", patientSchema)
  );
}

/**
 * The MPI's matching key. Two people are the same person far more often than two
 * strings are equal: "Ramesh Kumar", "ramesh  kumar" and "Ramesh-Kumar" are one
 * patient standing at the desk three times.
 *
 * Deliberately NOT phonetic (Soundex/Metaphone). Those are tuned for English and
 * mangle Indian names — they would merrily match "Sana" with "Sonu", and a false
 * MERGE is unrecoverable in a way a false duplicate is not. Conservative here is
 * the safe direction: the cost of a missed match is a duplicate chart someone
 * cleans up; the cost of a wrong match is one person's allergies on another
 * person's record.
 */
export function nameKeyOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}
