/**
 * Lab test catalogue — the service master for the laboratory (Module D6 / LIS depth).
 *
 * ── WHAT THIS CLOSES ────────────────────────────────────────────────────────
 * An order's test `code`/`name` were "free text until a service master exists" (order.model.ts),
 * and at result entry the technician RE-TYPED the analyte names, units and reference ranges for
 * every single report. That is how a reference range becomes wrong: typed from memory, at 2am, on
 * the report that matters. This is that master — each test defined ONCE, with its analytes and their
 * ranges, so ordering picks a real test and result entry pre-fills the grid and flags the numbers.
 *
 * ── THE RANGE IS STORED TWICE, ON PURPOSE ───────────────────────────────────
 * `refLow`/`refHigh` are NUMBERS, for the machine: they are what lets result entry mark a value
 * `low` or `high` without a human eyeballing it. `refText` is the STRING that prints on the report
 * ("12–15", "< 200", "Non-reactive") — because a real reference range is often not a plain interval,
 * and the printed form is the clinician's, not the computer's. When `refText` is absent it is derived
 * from the numbers; when present it wins for display. The two never fight because each owns a job.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { tenantScopePlugin } from "../../core/db/plugins/tenantScope.js";
import { auditPlugin } from "../../core/db/plugins/auditPlugin.js";

/** One measured parameter of a test — Haemoglobin within a CBC, Sodium within an electrolyte panel. */
export interface Analyte {
  /** Stable code within the test — `HB`, `NA`. Carried onto the order result value. */
  code: string;
  label: string;
  unit?: string;
  /** Numeric reference bounds, for auto-flagging. Either, both, or neither may be set. */
  refLow?: number;
  refHigh?: number;
  /** The printable reference range; derived from the numbers when absent. */
  refText?: string;
}

export interface LabTestDoc {
  _id: Types.ObjectId;
  tenantId: string;
  branchId?: string;

  /** The catalogue code an order carries — `CBC`, `LFT`. Unique per tenant. */
  code: string;
  name: string;
  /** The specimen it needs — `Whole blood (EDTA)`, `Serum`, `Urine`. Free text; drives collection. */
  specimenType?: string;
  analytes: Analyte[];
  active: boolean;

  createdBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const analyteSchema = new Schema<Analyte>(
  {
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 32 },
    label: { type: String, required: true, trim: true, maxlength: 120 },
    unit: { type: String, trim: true, maxlength: 32 },
    refLow: { type: Number },
    refHigh: { type: Number },
    refText: { type: String, trim: true, maxlength: 64 },
  },
  { _id: false },
);

const labTestSchema = new Schema<LabTestDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String },

    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 64 },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    specimenType: { type: String, trim: true, maxlength: 120 },
    analytes: { type: [analyteSchema], default: undefined },
    active: { type: Boolean, required: true, default: true },

    createdBy: { type: String },
  },
  // Indexes owned by migration 0041, never autoIndex — see the patient model.
  { timestamps: true, collection: "labTests", autoIndex: false },
);

labTestSchema.plugin(tenantScopePlugin);

// The lab's service master — clinical CONFIGURATION, not PHI. `admin`, like `wards` and `departments`.
labTestSchema.plugin(auditPlugin, { resource: "labTest", category: "admin" });

export function getLabTestModel(conn: Connection): Model<LabTestDoc> {
  return (
    (conn.models.LabTest as Model<LabTestDoc>) ?? conn.model<LabTestDoc>("LabTest", labTestSchema)
  );
}
