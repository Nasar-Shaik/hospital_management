/**
 * Vitals — one set of physiological observations, taken at a moment in time.
 *
 * ── A READING BELONGS TO THE VISIT, NOT TO THE PERSON ───────────────────────
 * This is the opposite of an allergy, and deliberately so. An allergy is a standing fact about
 * a person ("still allergic ten years later"); a blood pressure is a fact about a MOMENT. It is
 * meaningless without the visit and the timestamp that frame it, so a reading hangs off
 * `encounterId` as well as `patientId`: the encounter answers "which visit was this?", the
 * patient answers "show me this person's trend across visits", and both reads are wanted.
 *
 * ── READINGS ARE APPEND-ONLY ────────────────────────────────────────────────
 * There is no update path and no delete path. A vitals record is an observation someone made
 * and acted on — a doctor may have prescribed against that blood pressure — so correcting it by
 * overwriting would destroy the reason a clinical decision looks the way it does. A wrong entry
 * is fixed by recording the right one; the sequence, with its timestamps, IS the chart.
 *
 * ── UNITS ARE FIXED AT THE MODEL, NEVER CARRIED PER-ROW ─────────────────────
 * Temperature is Celsius, weight kilograms, height centimetres — always. A `unit` column beside
 * a value is how a 37 becomes a 98.6 and a paediatric dose goes out by a factor of two. The UI
 * may offer °F for entry, but exactly one unit is ever stored, and conversion happens before it
 * reaches here.
 *
 * Every field is OPTIONAL except the identifiers: a nurse who could only get a pulse on a
 * distressed patient must be able to record the pulse. Requiring a full set would mean either a
 * refused save or invented numbers, and invented numbers in a chart are far worse than gaps.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { tenantScopePlugin } from "../../core/db/plugins/tenantScope.js";
import { auditPlugin } from "../../core/db/plugins/auditPlugin.js";

/**
 * How sick this patient looks, assigned by the person taking the observations.
 *
 * Deliberately a coarse three-point scale rather than a formal acuity index (ESI, MTS). Those
 * are training-dependent instruments whose numbers mean something specific to staff certified
 * in them; inventing a five-point lookalike here would produce a column that reads like a
 * clinical score and is not one. Three words a nurse cannot misread are honest about what this
 * is: a flag to pull someone forward in the queue.
 */
export const TRIAGE_LEVELS = ["routine", "urgent", "critical"] as const;
export type TriageLevel = (typeof TRIAGE_LEVELS)[number];

export interface VitalsDoc {
  _id: Types.ObjectId;
  tenantId: string;
  branchId?: string;

  encounterId: Types.ObjectId;
  patientId: Types.ObjectId;

  /** mmHg. */
  systolic?: number;
  diastolic?: number;
  /** Beats per minute. */
  pulse?: number;
  /** Breaths per minute. */
  respiratoryRate?: number;
  /** Degrees CELSIUS — see the header. One decimal place. */
  temperature?: number;
  /** Oxygen saturation, percent. */
  spo2?: number;
  /** Kilograms. One decimal place. */
  weightKg?: number;
  /** Centimetres. */
  heightCm?: number;
  /** 0–10 self-reported pain score. */
  painScore?: number;

  triageLevel?: TriageLevel;

  /** Free text — PHI, excluded from the audit diff. */
  notes?: string;

  recordedBy: string;
  recordedAt: Date;

  createdAt: Date;
  updatedAt: Date;
}

const vitalsSchema = new Schema<VitalsDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String },

    encounterId: { type: Schema.Types.ObjectId, required: true },
    patientId: { type: Schema.Types.ObjectId, required: true },

    // Bounds are the limits of PHYSICAL PLAUSIBILITY, not of health: a systolic of 250 is a
    // hypertensive emergency and must be recordable, while 2500 is a typo. Rejecting the
    // implausible catches slips; rejecting the merely abnormal would refuse to chart the
    // sickest patients in the hospital, who are the ones the chart exists for.
    systolic: { type: Number, min: 40, max: 300 },
    diastolic: { type: Number, min: 20, max: 200 },
    pulse: { type: Number, min: 20, max: 300 },
    respiratoryRate: { type: Number, min: 4, max: 90 },
    temperature: { type: Number, min: 25, max: 45 },
    spo2: { type: Number, min: 40, max: 100 },
    weightKg: { type: Number, min: 0.3, max: 500 },
    heightCm: { type: Number, min: 20, max: 260 },
    painScore: { type: Number, min: 0, max: 10 },

    triageLevel: { type: String, enum: TRIAGE_LEVELS },

    notes: { type: String, trim: true, maxlength: 2000 },

    recordedBy: { type: String, required: true },
    recordedAt: { type: Date, required: true },
  },
  // Indexes are owned by migration 0025, never autoIndex — see the patient model.
  { timestamps: true, collection: "vitals", autoIndex: false },
);

vitalsSchema.plugin(tenantScopePlugin);

/**
 * PHI. `notes` is excluded from the audit diff for the same reason a ward note's text is: the
 * trail records THAT observations were charted and by whom, and must not become a second copy
 * of the clinical detail behind weaker access controls than the chart itself.
 */
vitalsSchema.plugin(auditPlugin, {
  resource: "vitals",
  category: "phi",
  ignore: ["notes"],
});

export function getVitalsModel(conn: Connection): Model<VitalsDoc> {
  return (conn.models.Vitals as Model<VitalsDoc>) ?? conn.model<VitalsDoc>("Vitals", vitalsSchema);
}
