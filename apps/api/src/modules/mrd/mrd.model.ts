/**
 * Medical Records Department (Module MRD / support.mrd) — clinical CODING and the registers it feeds.
 *
 * Two collections, one job: put an ICD-10 code on a visit's diagnosis so the hospital can answer
 * the statutory question "how many cases of dengue this month?" — which a free-text diagnosis on the
 * consultation note cannot. `icdCodes` is the code master (the picker); `encounterCodings` is the
 * coded record for one visit. The coding is SEPARATE from the signed consultation note on purpose:
 * the note is the doctor's clinical account, frozen; the coding is a records act that may be revised
 * (a coder corrects a code after discharge) without ever rewriting the clinical note.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { tenantScopePlugin } from "../../core/db/plugins/tenantScope.js";
import { auditPlugin } from "../../core/db/plugins/auditPlugin.js";

/* ── ICD-10 code master ─────────────────────────────────────────────────────── */

export interface IcdCodeDoc {
  _id: Types.ObjectId;
  tenantId: string;

  /** The ICD-10 code — `J18.9`, `A90`. Unique per tenant. */
  code: string;
  title: string;
  /** The ICD chapter/block it belongs to — a coarse grouping for the register. Free text. */
  chapter?: string;
  active: boolean;

  createdBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const icdCodeSchema = new Schema<IcdCodeDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 16 },
    title: { type: String, required: true, trim: true, maxlength: 300 },
    chapter: { type: String, trim: true, maxlength: 120 },
    active: { type: Boolean, required: true, default: true },
    createdBy: { type: String },
  },
  // Indexes owned by migration 0044, never autoIndex.
  { timestamps: true, collection: "icdCodes", autoIndex: false },
);

icdCodeSchema.plugin(tenantScopePlugin);
// The code master is reference data, not PHI — `admin`, like the tariff and the lab catalogue.
icdCodeSchema.plugin(auditPlugin, { resource: "icdCode", category: "admin" });

/* ── encounter coding ───────────────────────────────────────────────────────── */

/** One coded diagnosis on a visit. `primary` marks the main condition — every register counts it. */
export interface CodedDiagnosis {
  code: string;
  title: string;
  primary: boolean;
}

export interface EncounterCodingDoc {
  _id: Types.ObjectId;
  tenantId: string;
  branchId?: string;

  encounterId: Types.ObjectId;
  patientId: Types.ObjectId;
  episodeId: Types.ObjectId;

  codes: CodedDiagnosis[];

  codedBy?: string;
  codedAt: Date;

  createdAt: Date;
  updatedAt: Date;
}

const codedDiagnosisSchema = new Schema<CodedDiagnosis>(
  {
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 16 },
    title: { type: String, required: true, trim: true, maxlength: 300 },
    primary: { type: Boolean, required: true, default: false },
  },
  { _id: false },
);

const encounterCodingSchema = new Schema<EncounterCodingDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String },

    encounterId: { type: Schema.Types.ObjectId, required: true },
    patientId: { type: Schema.Types.ObjectId, required: true },
    episodeId: { type: Schema.Types.ObjectId, required: true },

    codes: { type: [codedDiagnosisSchema], default: undefined },

    codedBy: { type: String },
    codedAt: { type: Date, required: true },
  },
  { timestamps: true, collection: "encounterCodings", autoIndex: false },
);

encounterCodingSchema.plugin(tenantScopePlugin);
// PHI — a coded diagnosis IS the diagnosis. Audited as patient health information.
encounterCodingSchema.plugin(auditPlugin, { resource: "encounterCoding", category: "phi" });

export function getIcdCodeModel(conn: Connection): Model<IcdCodeDoc> {
  return (
    (conn.models.IcdCode as Model<IcdCodeDoc>) ?? conn.model<IcdCodeDoc>("IcdCode", icdCodeSchema)
  );
}

export function getEncounterCodingModel(conn: Connection): Model<EncounterCodingDoc> {
  return (
    (conn.models.EncounterCoding as Model<EncounterCodingDoc>) ??
    conn.model<EncounterCodingDoc>("EncounterCoding", encounterCodingSchema)
  );
}
