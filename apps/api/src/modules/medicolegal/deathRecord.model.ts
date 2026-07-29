/**
 * Death record (Module C3 / medico-legal record) — the STRUCTURED statutory capture of a death,
 * the record a death certificate is written from.
 *
 * ── WHY THIS IS MORE THAN THE `deceased` DISPOSITION ────────────────────────
 * The encounter already closes carrying `disposition: "deceased"`, and the admission flow writes a
 * free-text `outcome_note` describing the circumstances (admission.service.ts). That is the
 * OPERATIONAL close — it frees the bed and feeds the mortality count. It is not the statutory
 * record: a death certificate needs the cause-of-death CHAIN (immediate → antecedent → underlying,
 * the WHO/Form-4 structure), the manner of death, and whether it is a medico-legal case the police
 * must see. Those are facts, each its own field, not a paragraph someone might phrase differently
 * every time. This record holds them; the disposition and this record agree, each doing its job.
 *
 * ── ONE PER ENCOUNTER ───────────────────────────────────────────────────────
 * A death happens once, in the stay during which the patient was under the hospital's care — a
 * brought-dead casualty is still a registered encounter. So `encounterId` is required and unique:
 * a second death record for the same stay is a mistake, and the unique index refuses it.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { tenantScopePlugin } from "../../core/db/plugins/tenantScope.js";
import { auditPlugin } from "../../core/db/plugins/auditPlugin.js";

/** How the death came about — the box a death certificate and any inquest turn on. */
export const MANNER_OF_DEATH = [
  "natural",
  "accident",
  "suicide",
  "homicide",
  "pending",
  "undetermined",
] as const;
export type MannerOfDeath = (typeof MANNER_OF_DEATH)[number];

export interface DeathRecordDoc {
  _id: Types.ObjectId;
  tenantId: string;
  branchId?: string;

  patientId: Types.ObjectId;
  /** The stay during which the death occurred. Required — a death is always within an encounter. */
  encounterId: Types.ObjectId;

  /** Date and time of death — the time matters, statutorily and clinically. */
  diedAt: Date;
  /** When death was formally pronounced, when that differs from the time of death. */
  pronouncedAt?: Date;

  /** The condition directly leading to death — WHO Part I(a). Required. */
  immediateCause: string;
  /** The condition giving rise to the immediate cause — Part I(b). */
  antecedentCause?: string;
  /** The underlying disease that started the sequence — Part I(c). */
  underlyingCause?: string;
  /** Other significant conditions contributing but not in the causal chain — Part II. */
  contributingConditions?: string;

  manner: MannerOfDeath;
  /** A medico-legal case — police must be informed, body not released without clearance. */
  medicoLegal: boolean;
  postmortemRequired: boolean;

  /** The certifying doctor (userId). Set from the caller's context. */
  certifiedBy?: string;

  /** Who the body was handed to, and their relationship — when it has been released. */
  bodyHandedTo?: string;
  bodyHandedRelationship?: string;
  remarks?: string;

  createdBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const deathRecordSchema = new Schema<DeathRecordDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String },

    patientId: { type: Schema.Types.ObjectId, required: true },
    encounterId: { type: Schema.Types.ObjectId, required: true },

    diedAt: { type: Date, required: true },
    pronouncedAt: { type: Date },

    immediateCause: { type: String, required: true, trim: true, maxlength: 500 },
    antecedentCause: { type: String, trim: true, maxlength: 500 },
    underlyingCause: { type: String, trim: true, maxlength: 500 },
    contributingConditions: { type: String, trim: true, maxlength: 500 },

    manner: { type: String, enum: MANNER_OF_DEATH, required: true, default: "natural" },
    medicoLegal: { type: Boolean, required: true, default: false },
    postmortemRequired: { type: Boolean, required: true, default: false },

    certifiedBy: { type: String },

    bodyHandedTo: { type: String, trim: true, maxlength: 160 },
    bodyHandedRelationship: { type: String, trim: true, maxlength: 60 },
    remarks: { type: String, trim: true, maxlength: 1000 },

    createdBy: { type: String },
  },
  // Indexes owned by migration 0042, never autoIndex — see the patient model.
  { timestamps: true, collection: "deathRecords", autoIndex: false },
);

deathRecordSchema.plugin(tenantScopePlugin);

// PHI — the cause of death is the most sensitive line in the record.
deathRecordSchema.plugin(auditPlugin, { resource: "deathRecord", category: "phi" });

export function getDeathRecordModel(conn: Connection): Model<DeathRecordDoc> {
  return (
    (conn.models.DeathRecord as Model<DeathRecordDoc>) ??
    conn.model<DeathRecordDoc>("DeathRecord", deathRecordSchema)
  );
}
