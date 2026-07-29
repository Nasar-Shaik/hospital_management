/**
 * Informed consent (Module C3 / medico-legal record) — the STRUCTURED capture of a consent the
 * hospital took, not a scan of a signed page.
 *
 * ── WHY THIS EXISTS WHEN `documents` ALREADY HAS A "consent" CATEGORY ────────
 * A document is the IMAGE of a form — bytes a human must open and read. This is the FACTS on it,
 * queryable: what was consented to, who signed and in what relationship, in which language it was
 * explained, whether it was later withdrawn. The two are complementary — the scan is the evidence,
 * this is the record — and only the record can answer "does a valid surgical consent exist for this
 * admission?" before the patient is wheeled in. That question is the whole point.
 *
 * ── CONSENT CAN BE WITHDRAWN, SO IT IS NOT IMMUTABLE ────────────────────────
 * Unlike a signed prescription, consent is a standing permission a patient may revoke at any time.
 * So the record carries a `status` and a withdrawal stamp rather than being frozen at signing — the
 * history of who explained it and when is kept, but "is it in force now?" is a live field.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { tenantScopePlugin } from "../../core/db/plugins/tenantScope.js";
import { auditPlugin } from "../../core/db/plugins/auditPlugin.js";

/** What kind of consent it is — drives the label and which risks a form would list. */
export const CONSENT_TYPES = [
  "general",
  "admission",
  "surgical",
  "anaesthesia",
  "procedure",
  "blood_transfusion",
  "high_risk",
  "hiv_test",
  "dnr",
  "research",
] as const;
export type ConsentType = (typeof CONSENT_TYPES)[number];

/** Who put their name to it — the patient, or a relative when the patient cannot. */
export const CONSENT_SIGNERS = ["patient", "guardian", "spouse", "parent", "next_of_kin"] as const;
export type ConsentSigner = (typeof CONSENT_SIGNERS)[number];

/** Whether the consent is still in force. */
export const CONSENT_STATUSES = ["active", "withdrawn"] as const;
export type ConsentStatus = (typeof CONSENT_STATUSES)[number];

export interface ConsentDoc {
  _id: Types.ObjectId;
  tenantId: string;
  branchId?: string;

  patientId: Types.ObjectId;
  /** The visit it belongs to, when it is visit-specific (a surgical consent always is). */
  encounterId?: Types.ObjectId;

  type: ConsentType;
  /** What is being consented to — "Laparoscopic cholecystectomy", "General ward admission". */
  procedure: string;
  /** The material risks disclosed before the signature. */
  risksExplained?: string;

  signedBy: ConsentSigner;
  /** The name of the person who signed — may not be the patient. */
  signerName: string;
  /** Their relationship to the patient, when the signer is not the patient ("son", "wife"). */
  relationship?: string;
  /** The language the consent was explained in — legally material in a multilingual country. */
  language?: string;
  witnessName?: string;

  /** The clinician who explained it (userId). Set from the caller's context. */
  explainedBy?: string;
  signedAt: Date;

  status: ConsentStatus;
  withdrawnAt?: Date;
  withdrawalReason?: string;

  createdBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const consentSchema = new Schema<ConsentDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String },

    patientId: { type: Schema.Types.ObjectId, required: true },
    encounterId: { type: Schema.Types.ObjectId },

    type: { type: String, enum: CONSENT_TYPES, required: true },
    procedure: { type: String, required: true, trim: true, maxlength: 200 },
    risksExplained: { type: String, trim: true, maxlength: 2000 },

    signedBy: { type: String, enum: CONSENT_SIGNERS, required: true, default: "patient" },
    signerName: { type: String, required: true, trim: true, maxlength: 160 },
    relationship: { type: String, trim: true, maxlength: 60 },
    language: { type: String, trim: true, maxlength: 40 },
    witnessName: { type: String, trim: true, maxlength: 160 },

    explainedBy: { type: String },
    signedAt: { type: Date, required: true },

    status: { type: String, enum: CONSENT_STATUSES, required: true, default: "active" },
    withdrawnAt: { type: Date },
    withdrawalReason: { type: String, trim: true, maxlength: 500 },

    createdBy: { type: String },
  },
  // Indexes owned by migration 0042, never autoIndex — see the patient model.
  { timestamps: true, collection: "consents", autoIndex: false },
);

consentSchema.plugin(tenantScopePlugin);

// PHI — a consent's `procedure` ("HIV test", "termination of pregnancy") can disclose a diagnosis,
// so it is patient health information and audited as such, not `admin` config.
consentSchema.plugin(auditPlugin, { resource: "consent", category: "phi" });

export function getConsentModel(conn: Connection): Model<ConsentDoc> {
  return (
    (conn.models.Consent as Model<ConsentDoc>) ?? conn.model<ConsentDoc>("Consent", consentSchema)
  );
}
