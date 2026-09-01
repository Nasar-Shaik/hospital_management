/**
 * Mortuary register (Module support.mortuary) — the hospital's custody record for a DECEASED body,
 * from the moment it is received into the mortuary to the moment it is released.
 *
 * ── WHY THIS IS NOT THE DEATH RECORD ────────────────────────────────────────
 * The death record (medico-legal, Module C3) is the STATUTORY account of the death — the cause
 * chain a certificate is written from. This is the PHYSICAL custody log: which body is in which
 * drawer, under what tag, and to whom it was handed. They answer different questions and are written
 * by different people (the doctor certifies the death; ward/mortuary staff hold the body). This
 * module DERIVES the patient and the medico-legal flag from the death record — a body cannot enter
 * the mortuary until the death it represents has been recorded — but never writes back to it.
 *
 * ── ONE ENTRY PER ENCOUNTER ─────────────────────────────────────────────────
 * A body is the body of one death, which happened in one stay. `encounterId` is required and unique:
 * registering the same body twice is a mistake, and the unique index (migration 0045) refuses it.
 *
 * ── THE MEDICO-LEGAL HOLD ───────────────────────────────────────────────────
 * When the death is a medico-legal case the police must clear the body before it leaves. We snapshot
 * `medicoLegal` at receipt and the service refuses release without a clearance reference — the
 * hospital cannot hand over a body the law is still holding.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { tenantScopePlugin } from "../../core/db/plugins/tenantScope.js";
import { auditPlugin } from "../../core/db/plugins/auditPlugin.js";

/** Where the body is in its custody: still stored, or handed over. */
export const MORTUARY_STATUSES = ["in_storage", "released"] as const;
export type MortuaryStatus = (typeof MORTUARY_STATUSES)[number];

export interface MortuaryEntryDoc {
  _id: Types.ObjectId;
  tenantId: string;
  branchId?: string;

  patientId: Types.ObjectId;
  /** The stay the death occurred in — required, unique. Ties the body to its statutory record. */
  encounterId: Types.ObjectId;
  /** The death record this body belongs to, when one is linked. */
  deathRecordId?: Types.ObjectId;

  /** The deceased's name, snapshotted so the occupancy board needs no patient lookup. */
  deceasedName: string;

  receivedAt: Date;
  receivedBy?: string;
  /** The body tag number — the physical label tied to the body. */
  tagNumber: string;
  /** The drawer / freezer / chamber the body is stored in. Free text. */
  storageUnit?: string;

  /** Snapshot of the death record's medico-legal flag — governs whether release needs clearance. */
  medicoLegal: boolean;

  status: MortuaryStatus;

  releasedAt?: Date;
  releasedBy?: string;
  /** Who the body was released to, and their relationship to the deceased. */
  releasedTo?: string;
  releasedRelationship?: string;
  /** The police / magistrate clearance reference — required to release a medico-legal body. */
  clearanceRef?: string;

  remarks?: string;

  createdBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const mortuaryEntrySchema = new Schema<MortuaryEntryDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String },

    patientId: { type: Schema.Types.ObjectId, required: true },
    encounterId: { type: Schema.Types.ObjectId, required: true },
    deathRecordId: { type: Schema.Types.ObjectId },

    deceasedName: { type: String, required: true, trim: true, maxlength: 160 },

    receivedAt: { type: Date, required: true },
    receivedBy: { type: String },
    tagNumber: { type: String, required: true, trim: true, maxlength: 40 },
    storageUnit: { type: String, trim: true, maxlength: 60 },

    medicoLegal: { type: Boolean, required: true, default: false },

    status: { type: String, enum: MORTUARY_STATUSES, required: true, default: "in_storage" },

    releasedAt: { type: Date },
    releasedBy: { type: String },
    releasedTo: { type: String, trim: true, maxlength: 160 },
    releasedRelationship: { type: String, trim: true, maxlength: 60 },
    clearanceRef: { type: String, trim: true, maxlength: 120 },

    remarks: { type: String, trim: true, maxlength: 1000 },

    createdBy: { type: String },
  },
  // Indexes owned by migration 0045, never autoIndex.
  { timestamps: true, collection: "mortuaryRegister", autoIndex: false },
);

mortuaryEntrySchema.plugin(tenantScopePlugin);

// PHI — the record names a deceased patient and their custody. Audited as patient information.
mortuaryEntrySchema.plugin(auditPlugin, { resource: "mortuaryEntry", category: "phi" });

export function getMortuaryEntryModel(conn: Connection): Model<MortuaryEntryDoc> {
  return (
    (conn.models.MortuaryEntry as Model<MortuaryEntryDoc>) ??
    conn.model<MortuaryEntryDoc>("MortuaryEntry", mortuaryEntrySchema)
  );
}
