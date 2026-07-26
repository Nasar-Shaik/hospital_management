/**
 * Branch — a physical location of a tenant (Domain Glossary: "a physical location of a tenant";
 * ADR-0015).
 *
 * A tenant is one hospital ORGANISATION; a branch is one of its sites (Apollo Hyderabad, Apollo
 * Chennai). Branches are NOT tenants: they live inside the tenant's own database, share its patient
 * identity space (one UHID across every branch) and its staff directory. What they own is the
 * OPERATIONAL record — every encounter, order, bill and admission carries the `branchId` of the site
 * it happened at (see `writeBranchId`).
 *
 * ── EVERY TENANT HAS AT LEAST ONE ─────────────────────────────────────────────
 * Provisioning creates a `Main Branch` (`isMain: true`), and the migration backfills one for tenants
 * that predate branches. There is deliberately no delete path: an operational history is stamped
 * with `branchId`, so removing the branch would orphan years of records. A branch that closes is set
 * `inactive` — it stops appearing in the switcher but its past is still readable.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { tenantScopePlugin } from "../../core/db/plugins/tenantScope.js";
import { auditPlugin } from "../../core/db/plugins/auditPlugin.js";

/** `active` shows in the switcher and may take new records; `inactive` is retired but readable. */
export const BRANCH_STATUSES = ["active", "inactive"] as const;
export type BranchStatus = (typeof BRANCH_STATUSES)[number];

export interface BranchDoc {
  _id: Types.ObjectId;
  tenantId: string;

  name: string;
  /** Short code, unique per tenant — the human key on a report ("HYD", "CHN"). */
  code: string;
  status: BranchStatus;
  /**
   * The tenant's original site. Exactly one branch is `isMain` — provisioning's, and the one the
   * backfill creates. It cannot be deactivated (a hospital always has a home site) and it is the
   * default active branch for a user who has not chosen one.
   */
  isMain: boolean;

  address?: string;
  contactPhone?: string;
  contactEmail?: string;
  /** IANA zone (e.g. `Asia/Kolkata`). A branch may sit in a different zone from its tenant. */
  timezone?: string;
  /**
   * The branch's GST registration. A hospital's branches are frequently separate GSTINs / places of
   * business, which is WHY invoice series run per branch (ADR-0015). Descriptive here; the tax
   * engine reads it, nothing branches on it.
   */
  gstin?: string;

  createdAt: Date;
  updatedAt: Date;
}

const branchSchema = new Schema<BranchDoc>(
  {
    tenantId: { type: String, required: true, index: true },

    name: { type: String, required: true, trim: true, maxlength: 160 },
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 24 },
    status: { type: String, enum: BRANCH_STATUSES, required: true, default: "active" },
    isMain: { type: Boolean, required: true, default: false },

    address: { type: String, trim: true, maxlength: 500 },
    contactPhone: { type: String, trim: true, maxlength: 40 },
    contactEmail: { type: String, trim: true, maxlength: 160, lowercase: true },
    timezone: { type: String, trim: true, maxlength: 64 },
    gstin: { type: String, trim: true, maxlength: 32, uppercase: true },
  },
  // Indexes owned by migration 0026, never autoIndex — see the patient model.
  { timestamps: true, collection: "branches", autoIndex: false },
);

branchSchema.plugin(tenantScopePlugin);

// Configuration, not PHI — the `admin` category, which the audit catalogue names "branches" for
// explicitly. Creating or renaming a site is an administrative act every compliance officer expects
// to find in the trail.
branchSchema.plugin(auditPlugin, { resource: "branch", category: "admin" });

export function getBranchModel(conn: Connection): Model<BranchDoc> {
  return (conn.models.Branch as Model<BranchDoc>) ?? conn.model<BranchDoc>("Branch", branchSchema);
}
