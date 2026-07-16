/**
 * Prescription — WHAT THE DOCTOR DECIDED THE PATIENT SHOULD TAKE
 * (STATE_MACHINE_CATALOG §6, ADR-0013 §3).
 *
 * ── A PRESCRIPTION IS NOT AN ORDER, AND NOT A NOTE ──────────────────────────
 * It hangs off the ENCOUNTER, like everything else clinical. It is not part of a
 * consultation note, because a note can be amended and a prescription must not silently
 * change underneath the pharmacist holding it; and it is not merely an Order, because an
 * order says "somebody do this" while a prescription says "this human takes 500mg of
 * this, by this route, this often, for this many days" — and every one of those five
 * fields is a way to hurt somebody.
 *
 * The Order is still the SPINE: signing an in-house prescription places a `pharmacy`
 * order, and that order is what makes the Rx appear on the pharmacy's worklist with no
 * hand-off step (see `prescription.service.ts`). The order carries the WORK; this
 * carries the CLINICAL CONTENT. Neither one can do the other's job.
 *
 * ── WHY `signed` IS IMMUTABLE ───────────────────────────────────────────────
 * The moment a prescription is signed it is a legal instrument: a pharmacist dispenses
 * against it, and in the case of a controlled drug the signature is the entire authority
 * for that drug leaving the shelf. If a signed prescription could be edited, then "what
 * was I authorised to hand over?" would have no stable answer, and the record of what a
 * doctor ordered would be whatever it was last changed to.
 *
 * So a change is a NEW VERSION (`amendPrescription`), superseding the old one, and the
 * original stays exactly as it was signed. That is not bureaucracy — it is the only way
 * a dose change is distinguishable from a dose that was never what we now say it was.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { tenantScopePlugin } from "../../core/db/plugins/tenantScope.js";
import { auditPlugin } from "../../core/db/plugins/auditPlugin.js";

/**
 * STATE_MACHINE_CATALOG §6, verbatim.
 *
 * ── THE DISPENSING STATES ARE DERIVED, NOT CHOSEN ───────────────────────────
 * Nobody clicks "partially dispensed". It is what is true when some lines have been
 * handed over and some have not — computed from the quantities in `pharmacy.service.ts`.
 * A status somebody sets by hand is a status that will eventually disagree with the
 * quantities it claims to summarise.
 */
export const PRESCRIPTION_STATUSES = [
  "draft",
  "signed",
  "partially_dispensed",
  "dispensed",
  "discarded",
  "cancelled",
] as const;
export type PrescriptionStatus = (typeof PRESCRIPTION_STATUSES)[number];

/**
 * ── WHY `partially_dispensed → cancelled` EXISTS ────────────────────────────
 * §6: "already-administered doses unaffected". A doctor stops an antibiotic on day two
 * because a culture came back; three of the ten tablets are already in the patient. The
 * prescription is cancelled from here on, and the three tablets are still a fact — they
 * were dispensed, they were charged, and they are in the record. Cancellation stops the
 * FUTURE, it does not rewrite the past.
 *
 * There is no `dispensed → cancelled`: once everything has been handed over there is
 * nothing left to stop. Telling the patient to stop taking it is a clinical instruction,
 * not a state change on a document that has already been fully executed.
 */
export const TRANSITIONS: Record<PrescriptionStatus, readonly PrescriptionStatus[]> = {
  draft: ["signed", "discarded"],
  signed: ["partially_dispensed", "dispensed", "cancelled"],
  partially_dispensed: ["dispensed", "cancelled"],

  // Terminal.
  dispensed: [],
  discarded: [],
  cancelled: [],
};

export function canTransition(from: PrescriptionStatus, to: PrescriptionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** A signed prescription can still be dispensed against; a draft or a dead one cannot. */
const DISPENSABLE: readonly PrescriptionStatus[] = ["signed", "partially_dispensed"];
export function isDispensable(status: PrescriptionStatus): boolean {
  return DISPENSABLE.includes(status);
}

/**
 * How the drug gets in. NOT free text.
 *
 * Vincristine given intrathecally instead of intravenously kills the patient, and it has
 * killed real patients, repeatedly, in hospitals with better funding than ours. A route
 * that is a typed enum can be checked; a route that is a string is a sentence somebody
 * wrote in a hurry.
 */
export const DRUG_ROUTES = [
  "oral",
  "iv",
  "im",
  "sc",
  "sublingual",
  "topical",
  "inhaled",
  "rectal",
  "ophthalmic",
  "otic",
  "nasal",
] as const;
export type DrugRoute = (typeof DRUG_ROUTES)[number];

/**
 * How often, in the abbreviations an Indian prescription is actually written in.
 *
 * `SOS` (as needed) and `STAT` (now, once) are deliberately in the same list: they are
 * frequencies to the person reading the chart, whatever a pharmacology textbook says.
 */
export const DRUG_FREQUENCIES = [
  "OD",
  "BD",
  "TDS",
  "QID",
  "HS",
  "SOS",
  "STAT",
  "Q4H",
  "Q6H",
  "Q8H",
  "WEEKLY",
] as const;
export type DrugFrequency = (typeof DRUG_FREQUENCIES)[number];

export interface PrescriptionLine {
  /** The tariff/drug-master code — `DRUG_PARA_500`. This is what gets charged at dispense. */
  drugCode: string;
  /** Denormalized, so renaming the drug master never rewrites a signed prescription. */
  drugName: string;
  /** `500 mg`, `5 ml`, `1 puff`. A string because the unit is part of the instruction. */
  dose: string;
  route: DrugRoute;
  frequency: DrugFrequency;
  durationDays?: number;
  /** How many units to hand over. This — not the dose — is what the pharmacy counts. */
  quantity: number;
  /**
   * How many have actually been handed over. Starts at 0; only `pharmacy` moves it.
   *
   * The gap between this and `quantity` is the whole of `partially_dispensed`, and it is
   * why the status is computed rather than set.
   */
  dispensedQty: number;
  /** "After food", "do not drive". The bit the patient actually needs. */
  instructions?: string;
}

export interface PrescriptionHistoryEntry {
  from: PrescriptionStatus;
  to: PrescriptionStatus;
  at: Date;
  by?: string;
  reason?: string;
}

export interface PrescriptionDoc {
  _id: Types.ObjectId;
  tenantId: string;
  branchId?: string;

  /** The visit it was written during. Required, immutable — ADR-0013 §3. */
  encounterId: Types.ObjectId;
  /**
   * Denormalized from the encounter, exactly as on `orders`, and for the same reason:
   * the pharmacy must know whose drugs these are without joining through a visit that
   * may well have closed by the time they are collected.
   */
  patientId: Types.ObjectId;
  /** The care story (ADR-0013 §4) — so an admission inherits the OP's prescriptions. */
  episodeId: Types.ObjectId;

  status: PrescriptionStatus;
  lines: PrescriptionLine[];

  /** The prescriber. Taken from the authenticated caller, never from a request body. */
  prescribedBy: string;
  prescribedAt: Date;
  signedBy?: string;
  signedAt?: Date;

  /**
   * The `pharmacy` order this prescription raised when it was signed.
   *
   * Absent when the hospital's `encounterPolicy.pharmacy` is `external` — the patient
   * walks out with a piece of paper and buys the drugs somewhere else, and there is no
   * work for a pharmacy that we do not have. See `prescription.service.ts`.
   */
  orderId?: Types.ObjectId;

  /** 1, 2, 3… A signed prescription is amended by superseding it, never by editing it. */
  version: number;
  /** The prescription this one replaces. */
  supersedesId?: Types.ObjectId;
  /** The prescription that replaced this one. Set on the OLD one when it is superseded. */
  supersededById?: Types.ObjectId;

  cancelReason?: string;
  notes?: string;

  /**
   * Recorded ONLY when a prescriber signed THROUGH a blocking safety alert — an allergy
   * contraindication (`drugSafety.screen`). This is the medicolegal record of an informed
   * override: what the machine warned, who chose to proceed anyway, and why. Absent on the
   * ordinary case where nothing blocked, which is the overwhelming majority.
   *
   * The alerts are snapshotted, not re-derived: the reference data can change, and the
   * question at a review is "what was this doctor shown at the moment they signed", not
   * "what would we show today".
   */
  safetyOverride?: {
    reason: string;
    by: string;
    at: Date;
    alerts: { kind: string; severity: string; allergen?: string; message: string }[];
  };

  history: PrescriptionHistoryEntry[];
  createdAt: Date;
  updatedAt: Date;
}

const lineSchema = new Schema<PrescriptionLine>(
  {
    drugCode: { type: String, required: true, trim: true, maxlength: 64 },
    drugName: { type: String, required: true, trim: true, maxlength: 200 },
    dose: { type: String, required: true, trim: true, maxlength: 64 },
    route: { type: String, enum: DRUG_ROUTES, required: true },
    frequency: { type: String, enum: DRUG_FREQUENCIES, required: true },
    durationDays: { type: Number, min: 1, max: 365 },
    quantity: { type: Number, required: true, min: 1, max: 1000 },
    dispensedQty: { type: Number, required: true, default: 0, min: 0 },
    instructions: { type: String, trim: true, maxlength: 500 },
  },
  { _id: false },
);

const prescriptionSchema = new Schema<PrescriptionDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String },

    encounterId: { type: Schema.Types.ObjectId, required: true },
    patientId: { type: Schema.Types.ObjectId, required: true },
    episodeId: { type: Schema.Types.ObjectId, required: true },

    status: { type: String, enum: PRESCRIPTION_STATUSES, required: true, default: "draft" },
    lines: { type: [lineSchema], required: true, default: [] },

    prescribedBy: { type: String, required: true },
    prescribedAt: { type: Date, required: true },
    signedBy: { type: String },
    signedAt: { type: Date },

    orderId: { type: Schema.Types.ObjectId },

    version: { type: Number, required: true, default: 1 },
    supersedesId: { type: Schema.Types.ObjectId },
    supersededById: { type: Schema.Types.ObjectId },

    cancelReason: { type: String, trim: true, maxlength: 500 },
    notes: { type: String, trim: true, maxlength: 1000 },

    safetyOverride: {
      type: {
        reason: { type: String, required: true },
        by: { type: String, required: true },
        at: { type: Date, required: true },
        alerts: {
          type: [
            {
              _id: false,
              kind: { type: String, required: true },
              severity: { type: String, required: true },
              allergen: { type: String },
              message: { type: String, required: true },
            },
          ],
          // `default: undefined` — never [], which the audit hash-chain reads as tampering
          // on an untouched trail (see the same trap on patient.duplicateOverride).
          default: undefined,
        },
      },
      default: undefined,
      _id: false,
    },

    history: [
      {
        _id: false,
        from: { type: String, required: true },
        to: { type: String, required: true },
        at: { type: Date, required: true },
        by: { type: String },
        reason: { type: String },
      },
    ],
  },
  { timestamps: true, collection: "prescriptions", autoIndex: false },
);

prescriptionSchema.plugin(tenantScopePlugin);
/**
 * PHI, and the most self-describing kind there is. A drug name IS a diagnosis: lithium
 * says bipolar, tenofovir says HIV, methotrexate says cancer or rheumatoid arthritis.
 * The prescription leaks the condition even when no diagnosis was ever written down.
 *
 * `lines` is excluded from the audit diff for the same reason `orders.result` is — the
 * audit log records THAT the chart was touched, and must never become a second copy of
 * the chart sitting behind weaker access controls than the chart itself.
 */
prescriptionSchema.plugin(auditPlugin, {
  resource: "prescription",
  category: "phi",
  // `safetyOverride` joins `lines` and `history`: its alert snapshot names drugs and
  // allergens, and a drug name is a diagnosis. The audit records THAT the prescription was
  // signed; the override detail lives on the document, not as a second PHI copy in the log.
  ignore: ["lines", "history", "safetyOverride"],
});

export function getPrescriptionModel(conn: Connection): Model<PrescriptionDoc> {
  return (
    (conn.models.Prescription as Model<PrescriptionDoc>) ??
    conn.model<PrescriptionDoc>("Prescription", prescriptionSchema)
  );
}
