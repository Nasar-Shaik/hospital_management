/**
 * Medication Administration Record — the MAR (Module D5 / nursing, Doc 02).
 *
 * ── WHAT THIS CLOSES ────────────────────────────────────────────────────────
 * The drug chain was: a doctor SIGNS a prescription, the pharmacy DISPENSES against it. The missing
 * link — the one that matters most at the bedside — is who actually gave the dose to the patient,
 * and when. That is the MAR: one row per administration of one drug to one inpatient. It is the
 * record a nurse signs, the record a handover reads, and the record that answers "was the 2pm
 * antibiotic given?" — a question the prescription and the dispense log cannot.
 *
 * ── AN ADMINISTRATION IS NOT ALWAYS A DOSE GIVEN ────────────────────────────
 * A nurse withholds a dose (BP too low), a patient refuses it, the drug is not on the ward. Each of
 * those is a real, chartable event — a blank in the MAR is a question, a recorded `held`/`refused`
 * is an answer. So `status` carries the outcome, not just "given", and a reason rides with it.
 *
 * The drug's identity (`drugCode`, `drugName`, `dose`, `route`) is DENORMALIZED from the signed
 * prescription line at the moment of administration. A signed prescription is immutable (see the
 * prescription model), so the copy can never drift — and the MAR row stays legible even if the
 * prescription is later superseded.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { tenantScopePlugin } from "../../core/db/plugins/tenantScope.js";
import { auditPlugin } from "../../core/db/plugins/auditPlugin.js";

/**
 * The outcome of a scheduled administration.
 * - `given`        — the dose went in.
 * - `held`         — the nurse withheld it (a clinical decision — low BP, NBM); reason expected.
 * - `refused`      — the patient declined it.
 * - `not_available`— the drug was not on the ward to give.
 */
export const MAR_STATUSES = ["given", "held", "refused", "not_available"] as const;
export type MarStatus = (typeof MAR_STATUSES)[number];

export interface MedicationAdministrationDoc {
  _id: Types.ObjectId;
  tenantId: string;
  branchId?: string;

  encounterId: Types.ObjectId;
  patientId: string;
  prescriptionId: Types.ObjectId;

  /**
   * WHICH LINE of the prescription — the ordered medication's true identity (M3-S1).
   *
   * `drugCode` is not it. A prescription may legitimately carry the same drug twice: paracetamol
   * 500mg QID as a regular round AND paracetamol 500mg SOS for breakthrough fever is a textbook
   * pair, and `prescription.schema.ts` places no uniqueness rule on `lines`. Keying on the code
   * alone would treat those two as one medication — merging a scheduled line with a PRN one, which
   * is the single worst pair to confuse.
   *
   * The INDEX is the identity because a signed prescription's `lines` array is immutable:
   * `updateDraftLines` filters on `status: "draft"`, and an amendment supersedes rather than edits.
   * By the time a line is administrable its position can no longer move. That is what makes a
   * position safe to use as a key, and it is why no `_id` had to be backfilled into historical
   * prescriptions — which would have meant rewriting signed legal instruments to fix a MAR bug.
   *
   * Optional only for rows written before this existed.
   */
  lineIndex?: number;

  /** Denormalized from the signed prescription line (immutable there), so the row is self-describing. */
  drugCode: string;
  drugName: string;
  dose: string;
  route: string;

  status: MarStatus;
  /**
   * The dose slot this administration answers — the 08:00 round, not the moment it was charted.
   *
   * ABSENT means "this administration belongs to no slot": a PRN dose (given on demand, legitimately
   * repeatable) or a genuine back-charting outside any round's tolerance. Present means the row is
   * covered by the unique index in migration 0049, and a second attempt at the same slot is refused
   * by the database.
   *
   * This field is the whole safety spine. `administeredAt` cannot do the job: it is when the nurse
   * pressed the button, so two nurses charting the same round produce two different values and
   * nothing detects it.
   */
  scheduledFor?: Date;
  /** When the dose was given (or the decision made). Defaults to now; a nurse may set the real time. */
  administeredAt: Date;
  /** Why it was held / refused / unavailable — expected for anything but `given`. */
  reason?: string;
  note?: string;

  /** The nurse who signed it — an opaque user id, like `encounter.doctorId`. */
  administeredBy?: string;

  createdAt: Date;
  updatedAt: Date;
}

const marSchema = new Schema<MedicationAdministrationDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String },

    encounterId: { type: Schema.Types.ObjectId, required: true },
    patientId: { type: String, required: true },
    prescriptionId: { type: Schema.Types.ObjectId, required: true },
    lineIndex: { type: Number, min: 0 },

    drugCode: { type: String, required: true, trim: true, maxlength: 64 },
    drugName: { type: String, required: true, trim: true, maxlength: 200 },
    dose: { type: String, required: true, trim: true, maxlength: 64 },
    route: { type: String, required: true, trim: true, maxlength: 32 },

    status: { type: String, enum: MAR_STATUSES, required: true, default: "given" },
    scheduledFor: { type: Date },
    administeredAt: { type: Date, required: true },
    reason: { type: String, trim: true, maxlength: 500 },
    note: { type: String, trim: true, maxlength: 1000 },

    administeredBy: { type: String },
  },
  // Indexes owned by migration 0040, never autoIndex — see the patient model.
  { timestamps: true, collection: "medicationAdministrations", autoIndex: false },
);

marSchema.plugin(tenantScopePlugin);

// A dose given to a patient is PHI, like a vitals reading or a ward note.
marSchema.plugin(auditPlugin, { resource: "medicationAdministration", category: "phi" });

export function getMarModel(conn: Connection): Model<MedicationAdministrationDoc> {
  return (
    (conn.models.MedicationAdministration as Model<MedicationAdministrationDoc>) ??
    conn.model<MedicationAdministrationDoc>("MedicationAdministration", marSchema)
  );
}
