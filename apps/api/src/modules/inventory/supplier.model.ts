/**
 * The supplier master — who the hospital buys from.
 *
 * ── THE SMALLEST THING THAT MAKES A RECEIPT ANSWERABLE ──────────────────────
 * The pharmacy has recorded stock arriving since migration 0052 and has never been able to say
 * where it came from: `POST /medicines/:id/receive` takes a quantity, a batch and an expiry, and
 * nothing else. So the product could answer "what is on the shelf" and could not answer "who did
 * we buy it from, on which invoice, for how much" — which is the other half of every stock
 * conversation a hospital actually has.
 *
 * This is that half, and it is deliberately a NAME AND A CONTACT, nothing more. There are no
 * purchase orders, no rate contracts, no approval chains, no payment terms, no performance
 * scoring, and no accounts-payable balance. A supplier here is a party a delivery can be
 * attributed to. Everything else is procurement software, which we are explicitly not building.
 *
 * ── TENANT-WIDE, LIKE EVERY OTHER MASTER ────────────────────────────────────
 * A hospital buys from one supplier for all its sites; the DELIVERY is what happens at a site,
 * and that is the movement, which is branch-stamped. Splitting the supplier list per branch would
 * make the same company two records that no report could add together.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { tenantScopePlugin } from "../../core/db/plugins/tenantScope.js";
import { auditPlugin } from "../../core/db/plugins/auditPlugin.js";

export interface SupplierDoc {
  _id: Types.ObjectId;
  tenantId: string;

  /** Short code the store keeper types. Unique per tenant, uppercased like every other master. */
  code: string;
  name: string;
  phone?: string;
  email?: string;
  /**
   * The tax registration the invoice carries — GSTIN in India, VAT/TIN elsewhere. Free text and
   * unvalidated on purpose: it is printed and reconciled by a person, and a regex that is right
   * for one country is wrong for the next.
   */
  taxId?: string;

  /** A supplier the hospital has stopped using stays for its history and leaves the picker. */
  active: boolean;

  createdAt: Date;
  updatedAt: Date;
}

const supplierSchema = new Schema<SupplierDoc>(
  {
    tenantId: { type: String, required: true, index: true },

    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 32 },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    phone: { type: String, trim: true, maxlength: 32 },
    email: { type: String, trim: true, lowercase: true, maxlength: 200 },
    taxId: { type: String, trim: true, maxlength: 64 },

    active: { type: Boolean, required: true, default: true },
  },
  { timestamps: true, collection: "suppliers", autoIndex: false },
);

supplierSchema.plugin(tenantScopePlugin);
/** `admin` — a master, not a transaction. Who was added, renamed or retired, and by whom. */
supplierSchema.plugin(auditPlugin, { resource: "supplier", category: "admin" });

export function getSupplierModel(conn: Connection): Model<SupplierDoc> {
  return (
    (conn.models.Supplier as Model<SupplierDoc>) ??
    conn.model<SupplierDoc>("Supplier", supplierSchema)
  );
}
