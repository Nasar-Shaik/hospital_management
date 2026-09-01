/**
 * Dispense — THE RECORD THAT DRUGS PHYSICALLY LEFT THE COUNTER.
 *
 * ── WHY THIS IS ITS OWN DOCUMENT AND NOT A FLAG ON THE PRESCRIPTION ─────────
 * A prescription for 10 tablets can be dispensed as 6 today and 4 on Thursday. That is
 * not an edge case — it is a pharmacy that has run out, which is every government
 * pharmacy in the country by mid-afternoon. So "was it dispensed" is not a boolean on the
 * prescription; it is a LEDGER of handovers, each with its own quantity, its own time and
 * its own pharmacist.
 *
 * Three things fall out of that, and each of them is the reason for this file:
 *
 *   1. BILLING. Each handover is separately chargeable, keyed on the DISPENSE id. Keyed
 *      on the prescription instead, `one_charge_per_cause` (migration 0014) would accept
 *      the first charge and silently swallow the second — the patient gets 10 tablets and
 *      pays for 6, and nothing anywhere reports an error.
 *   2. NARCOTICS. For a controlled drug the question asked by an inspector is "who handed
 *      over what, when" and the answer must be a row, not an inference from a counter.
 *   3. TRUTH. `dispensedQty` on the prescription line is a SUM of these rows. A total you
 *      can rebuild is a total you can audit; a total you can only increment is a total you
 *      have to trust.
 *
 * ── APPEND-ONLY ─────────────────────────────────────────────────────────────
 * There is no update path and no delete path. A handover that turns out to be wrong is
 * corrected by a return, which is another row — never by editing history so that it says
 * the drug was never given. The tablets are in the patient either way.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { tenantScopePlugin } from "../../core/db/plugins/tenantScope.js";
import { auditPlugin } from "../../core/db/plugins/auditPlugin.js";

export interface DispenseLine {
  /**
   * Which line of the prescription this is. The POSITION, because a prescription can
   * legitimately carry the same drug twice — paracetamol 500mg QID for fever AND
   * paracetamol 500mg SOS for pain is a real prescription, and the drug code alone cannot
   * tell those two lines apart.
   */
  lineIndex: number;
  /** Denormalized, so what was handed over survives the prescription being superseded. */
  drugCode: string;
  drugName: string;
  /** How many units crossed the counter in THIS handover. Never the prescribed total. */
  quantity: number;
}

export interface DispenseDoc {
  _id: Types.ObjectId;
  tenantId: string;
  branchId?: string;

  prescriptionId: Types.ObjectId;
  /** The visit, so the charge lands on the right bill. */
  encounterId: Types.ObjectId;
  patientId: Types.ObjectId;
  episodeId: Types.ObjectId;
  /** The `pharmacy` order this cleared, when the hospital dispenses in-house. */
  orderId?: Types.ObjectId;

  lines: DispenseLine[];

  /** The pharmacist. From the authenticated caller — this is a signature, in effect. */
  dispensedBy: string;
  dispensedAt: Date;

  /**
   * Client-supplied idempotency key. Unique when present (migration 0015).
   *
   * A pharmacist double-clicking "Dispense" must not hand over — and bill for — two lots
   * of the same drugs, and a retry after a timeout must not either: the first request may
   * well have succeeded before the connection dropped, which is exactly the case a
   * disabled button cannot save you from.
   */
  requestId?: string;

  /**
   * Present only when this handover put an admitted patient over their advance and a
   * clinician authorised dispensing on credit (`pharmacy:credit-override`). The audit
   * answer to "who let this go out unpaid, and why".
   */
  creditOverride?: {
    /** The authorising user (holds `pharmacy:credit-override`). */
    by: string;
    reason: string;
    /** Paise the advance was short at the moment of dispensing. */
    shortfall: number;
    at: Date;
  };

  createdAt: Date;
  updatedAt: Date;
}

const lineSchema = new Schema<DispenseLine>(
  {
    lineIndex: { type: Number, required: true, min: 0 },
    drugCode: { type: String, required: true, trim: true, maxlength: 64 },
    drugName: { type: String, required: true, trim: true, maxlength: 200 },
    quantity: { type: Number, required: true, min: 1, max: 1000 },
  },
  { _id: false },
);

const dispenseSchema = new Schema<DispenseDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String },

    prescriptionId: { type: Schema.Types.ObjectId, required: true },
    encounterId: { type: Schema.Types.ObjectId, required: true },
    patientId: { type: Schema.Types.ObjectId, required: true },
    episodeId: { type: Schema.Types.ObjectId, required: true },
    orderId: { type: Schema.Types.ObjectId },

    lines: { type: [lineSchema], required: true },

    dispensedBy: { type: String, required: true },
    dispensedAt: { type: Date, required: true },

    requestId: { type: String },

    creditOverride: {
      by: { type: String },
      reason: { type: String, trim: true, maxlength: 300 },
      shortfall: { type: Number },
      at: { type: Date },
    },
  },
  { timestamps: true, collection: "dispenses", autoIndex: false },
);

dispenseSchema.plugin(tenantScopePlugin);
/**
 * PHI. A dispense record names the drug, and a drug name is a diagnosis the patient never
 * consented to have written down — see `prescription.model.ts`. `lines` is out of the
 * audit diff for the same reason.
 */
dispenseSchema.plugin(auditPlugin, {
  resource: "dispense",
  category: "phi",
  ignore: ["lines"],
});

export function getDispenseModel(conn: Connection): Model<DispenseDoc> {
  return (
    (conn.models.Dispense as Model<DispenseDoc>) ??
    conn.model<DispenseDoc>("Dispense", dispenseSchema)
  );
}
