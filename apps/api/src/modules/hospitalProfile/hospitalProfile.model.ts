/**
 * Hospital profile (Module B1) — the hospital's OWN official identity.
 *
 * ── ONE DOCUMENT PER HOSPITAL, IN THE HOSPITAL'S OWN DATABASE ────────────────
 * This is the legal/administrative face of the institution — registered name, licence and tax
 * numbers, accreditations, registered address, the person in charge. It is NOT the platform
 * registry (that keeps only what ROUTING needs — slug, domain, plan; owned by the operator console)
 * and it is NOT the marketing site (`site` module — what a stranger reads). A unique index on
 * `tenantId` (migration 0033) makes this a singleton: exactly one profile per hospital.
 *
 * ── A MISSING DOCUMENT IS NOT AN ERROR ──────────────────────────────────────
 * A hospital whose admin has never opened the profile editor simply has an empty profile; every
 * field is optional and the absence of the whole document is a valid, handled state (the service
 * returns an empty profile, the form saves the first one). Nothing downstream depends on it being
 * present — it is reference information an administrator maintains, printed on official documents.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { tenantScopePlugin } from "../../core/db/plugins/tenantScope.js";
import { auditPlugin } from "../../core/db/plugins/auditPlugin.js";

/** How the institution is owned/run — drives nothing in code; printed on official records. */
export const OWNERSHIP_TYPES = [
  "government",
  "private",
  "trust",
  "charitable",
  "corporate",
] as const;
export type OwnershipType = (typeof OWNERSHIP_TYPES)[number];

export interface HospitalProfileDoc {
  _id: Types.ObjectId;
  tenantId: string;

  /** The registered legal entity name (may differ from the brand/display name). */
  legalName?: string;
  /** Hospital/clinical-establishment registration number. */
  registrationNumber?: string;
  /** Tax identifier (GST / PAN / TIN, as the jurisdiction uses). */
  taxId?: string;
  /** Accreditations held — NABH, JCI, ISO, NABL, etc. Free-form strings. */
  accreditations?: string[];
  /** Year the institution was established. */
  establishedYear?: number;
  ownershipType?: OwnershipType;
  /** Beds the institution is licensed for — informational, distinct from the live bed inventory. */
  licensedBeds?: number;

  /** The registered office address (distinct from the marketing contact address). */
  address?: string;
  officialEmail?: string;
  officialPhone?: string;
  website?: string;

  /** The person in charge — medical director / chief / administrator. */
  headName?: string;
  headTitle?: string;

  createdAt: Date;
  updatedAt: Date;
}

const hospitalProfileSchema = new Schema<HospitalProfileDoc>(
  {
    tenantId: { type: String, required: true, index: true },

    legalName: { type: String, trim: true, maxlength: 200 },
    registrationNumber: { type: String, trim: true, maxlength: 80 },
    taxId: { type: String, trim: true, maxlength: 40 },
    accreditations: { type: [String], default: undefined },
    establishedYear: { type: Number },
    ownershipType: { type: String, enum: OWNERSHIP_TYPES },
    licensedBeds: { type: Number },

    address: { type: String, trim: true, maxlength: 500 },
    officialEmail: { type: String, trim: true, maxlength: 160 },
    officialPhone: { type: String, trim: true, maxlength: 40 },
    website: { type: String, trim: true, maxlength: 200 },

    headName: { type: String, trim: true, maxlength: 120 },
    headTitle: { type: String, trim: true, maxlength: 120 },
  },
  // Index (unique tenantId) owned by migration 0033, never autoIndex — see the patient model.
  { timestamps: true, collection: "hospitalProfile", autoIndex: false },
);

hospitalProfileSchema.plugin(tenantScopePlugin);
// Administrative configuration, like `site` branding — `admin` category, and carries no PHI.
hospitalProfileSchema.plugin(auditPlugin, { resource: "hospitalProfile", category: "admin" });

export function getHospitalProfileModel(conn: Connection): Model<HospitalProfileDoc> {
  return (
    (conn.models.HospitalProfile as Model<HospitalProfileDoc>) ??
    conn.model<HospitalProfileDoc>("HospitalProfile", hospitalProfileSchema)
  );
}
