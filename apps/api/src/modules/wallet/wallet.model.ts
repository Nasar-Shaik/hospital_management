/**
 * Patient wallet — a stored-value advance the hospital holds on a patient's behalf.
 *
 * ── WHY A WALLET AT ALL ─────────────────────────────────────────────────────
 * The desk takes money BEFORE the care is costed: an OP advance at reception, and — the
 * case this was built for — an ADMISSION advance when a doctor decides to admit. That
 * money is not a payment against any one bill yet; it is credit the patient holds, and
 * every treatment cost is settled against it as the visit runs. Refunded on discharge if
 * anything is left. The invoice machinery answers "what does this visit cost?"; the wallet
 * answers "what has this patient already put down?", and the two meet when a bill is
 * settled `method: "wallet"`.
 *
 * ── MONEY IS AN INTEGER NUMBER OF PAISE. NEVER A FLOAT ──────────────────────
 * Same law as billing (`billing.model.ts`): ₹150.50 is 15050, everywhere, and only the UI
 * divides by 100. A wallet that cannot reconcile to the rupee is worse than no wallet.
 *
 * ── TWO COLLECTIONS, ONE TRUTH ──────────────────────────────────────────────
 *   walletAccounts — the AUTHORITATIVE running balance, one document per patient. Mutated
 *                    only by atomic `$inc`, and a debit is a CONDITIONAL update that the
 *                    database refuses when the balance would go negative. The guard is the
 *                    query, never a read-then-write, because two counters can race.
 *   walletEntries  — the immutable LEDGER: one row per movement, carrying the balance it
 *                    left behind (`balanceAfter`). Money that changes hands and leaves no
 *                    row cannot be audited, so the row and the balance move together, in one
 *                    transaction (`withTransaction`).
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { tenantScopePlugin } from "../../core/db/plugins/tenantScope.js";
import { auditPlugin } from "../../core/db/plugins/auditPlugin.js";

/* ── The account (authoritative balance) ───────────────────────────────────── */

export interface WalletAccountDoc {
  _id: Types.ObjectId;
  tenantId: string;
  patientId: Types.ObjectId;
  /** Paise. Never negative — a conditional update is what keeps it so. */
  balance: number;
  createdAt: Date;
  updatedAt: Date;
}

const walletAccountSchema = new Schema<WalletAccountDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    // One wallet per patient. The unique index (migration 0023) is what makes the upsert
    // on first deposit safe against two clerks depositing at the same instant.
    patientId: { type: Schema.Types.ObjectId, required: true },
    balance: { type: Number, required: true, default: 0, min: 0 },
  },
  { timestamps: true, collection: "walletAccounts", autoIndex: false },
);

walletAccountSchema.plugin(tenantScopePlugin);
// The balance is the patient's money in the hospital's hands. Changing it silently is how a
// hospital loses an audit — `financial`, and audited.
walletAccountSchema.plugin(auditPlugin, { resource: "walletAccount", category: "financial" });

/* ── The ledger ────────────────────────────────────────────────────────────── */

/**
 * What a movement IS. `deposit`/`refund` are the desk; `debit` is a bill settled from the
 * wallet; `reversal` unwinds a debit whose settlement rolled back. Direction is implied by
 * the type — `amount` is always POSITIVE, and the type says which way it moved.
 */
export const WALLET_ENTRY_TYPES = ["deposit", "debit", "refund", "reversal"] as const;
export type WalletEntryType = (typeof WALLET_ENTRY_TYPES)[number];

export interface WalletEntryDoc {
  _id: Types.ObjectId;
  tenantId: string;
  branchId?: string;

  patientId: Types.ObjectId;

  type: WalletEntryType;
  /** Paise. Always positive; `type` carries the sign. */
  amount: number;
  /** Paise. The balance this movement LEFT BEHIND — the ledger reads without re-summing. */
  balanceAfter: number;

  /** How the money came in (`cash`, `card`, `upi`…) for a deposit/refund. */
  method?: string;
  reference?: string;
  /** Free text — "Admission advance", "OP advance", "Refund on discharge". */
  reason?: string;

  /** The bill a `debit` settled, when there is one. */
  invoiceId?: Types.ObjectId;
  /** The visit the movement belongs to, when it is visit-scoped. */
  encounterId?: Types.ObjectId;

  by?: string;
  at: Date;

  createdAt: Date;
  updatedAt: Date;
}

const walletEntrySchema = new Schema<WalletEntryDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String },

    patientId: { type: Schema.Types.ObjectId, required: true },

    type: { type: String, enum: WALLET_ENTRY_TYPES, required: true },
    amount: { type: Number, required: true, min: 1 },
    balanceAfter: { type: Number, required: true, min: 0 },

    method: { type: String, trim: true, maxlength: 40 },
    reference: { type: String, trim: true, maxlength: 120 },
    reason: { type: String, trim: true, maxlength: 200 },

    invoiceId: { type: Schema.Types.ObjectId },
    encounterId: { type: Schema.Types.ObjectId },

    by: { type: String },
    at: { type: Date, required: true },
  },
  { timestamps: true, collection: "walletEntries", autoIndex: false },
);

walletEntrySchema.plugin(tenantScopePlugin);
// A movement of the patient's money — `financial`, and audited like the charge ledger.
walletEntrySchema.plugin(auditPlugin, { resource: "walletEntry", category: "financial" });

export function getWalletAccountModel(conn: Connection): Model<WalletAccountDoc> {
  return (
    (conn.models.WalletAccount as Model<WalletAccountDoc>) ??
    conn.model<WalletAccountDoc>("WalletAccount", walletAccountSchema)
  );
}

export function getWalletEntryModel(conn: Connection): Model<WalletEntryDoc> {
  return (
    (conn.models.WalletEntry as Model<WalletEntryDoc>) ??
    conn.model<WalletEntryDoc>("WalletEntry", walletEntrySchema)
  );
}
