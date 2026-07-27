/**
 * Ward & Bed — the hospital's bed INVENTORY (Module B4, PROJECT_MEMORY §5).
 *
 * ── WHAT THIS FIXES ─────────────────────────────────────────────────────────
 * Until now a bed was three free-text strings typed at admission (`ward`, `bedCode`,
 * `tariffCode` on the IP encounter). The database already refused two open stays in the same
 * ward+bed (`one_open_stay_per_bed`, migration 0020), so it could tell you a bed was TAKEN —
 * but there was no CATALOGUE of beds, so it could never tell you which beds are FREE, and a
 * typo ("Genral Ward") silently created a bed nobody could find again. This module is that
 * catalogue: the wards a hospital has and the beds in them, so admission becomes "pick a free
 * bed" instead of "type the name and hope".
 *
 * ── OCCUPANCY IS NOT STORED HERE, AND THAT IS DELIBERATE ─────────────────────
 * A bed does NOT carry "occupied": the IP encounter IS the admission (ADR-0013 §1), so the one
 * true answer to "who is in this bed?" lives on `encounters`. Storing it a second time on the
 * bed would be a dual write to two collections that cannot commit together — the exact class
 * of bug the outbox and the derived work-queue (ADR-0014) exist to avoid. The bed's own
 * `status` records only what the ENCOUNTER cannot: whether a bed is out of service. Whether a
 * bed is free is DERIVED by the bed board (admissions module) from the open IP encounters.
 *
 * ── WHY WARD NAMES ARE UNIQUE PER TENANT, NOT PER BRANCH ─────────────────────
 * `one_open_stay_per_bed` keys occupancy on `{tenantId, bed.ward, bed.bedCode}` — no branch.
 * So the catalogue matches it: a ward name is unique across the whole hospital and a bed code
 * is unique within its ward, which makes `(ward name, bed code)` a tenant-wide key that lines
 * up exactly with how occupancy is already enforced. `branchId` is recorded so the board can
 * group beds by site, but it is descriptive — it does not widen the uniqueness.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { tenantScopePlugin } from "../../core/db/plugins/tenantScope.js";
import { auditPlugin } from "../../core/db/plugins/auditPlugin.js";

/** The kind of ward — drives nothing in code; it groups the board and hints the default tariff. */
export const WARD_KINDS = [
  "general",
  "semi_private",
  "private",
  "icu",
  "nicu",
  "picu",
  "hdu",
  "maternity",
  "emergency",
  "isolation",
  "daycare",
] as const;
export type WardKind = (typeof WARD_KINDS)[number];

/** `active` takes new admissions; `inactive` is retired but its history is still readable. */
export const WARD_STATUSES = ["active", "inactive"] as const;
export type WardStatus = (typeof WARD_STATUSES)[number];

/**
 * A bed's OWN status — the part occupancy cannot answer.
 * - `available` — in service; free-or-occupied is derived from encounters, not from here.
 * - `blocked`   — out of service (cleaning, maintenance, reserved). Not admittable, and the
 *                 board shows WHY (`blockedReason`).
 */
export const BED_STATUSES = ["available", "blocked"] as const;
export type BedStatus = (typeof BED_STATUSES)[number];

export interface WardDoc {
  _id: Types.ObjectId;
  tenantId: string;
  branchId?: string;

  /** `General Ward`, `ICU`. Unique per tenant — see the header. */
  name: string;
  kind: WardKind;
  /**
   * The default bed-day tariff for beds in this ward (`BED_GEN`, `BED_ICU`). A bed may override
   * it. NOT derived from the name: "ICU" is not a price, and renaming a ward must never silently
   * re-price the beds in it — the same rule the admit screen has always followed.
   */
  tariffCode: string;
  status: WardStatus;

  createdAt: Date;
  updatedAt: Date;
}

export interface BedDoc {
  _id: Types.ObjectId;
  tenantId: string;
  branchId?: string;

  wardId: Types.ObjectId;
  /** `A-12`. Unique within its ward. */
  code: string;
  /** Optional room/bay label, purely for the human reading the board (`Room 4`, `Bay B`). */
  room?: string;
  /** Overrides the ward's tariff for this bed; absent means "bill at the ward's rate". */
  tariffCode?: string;
  status: BedStatus;
  /** Why the bed is out of service — shown on the board. Set only when `status` is `blocked`. */
  blockedReason?: string;

  createdAt: Date;
  updatedAt: Date;
}

const wardSchema = new Schema<WardDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String },

    name: { type: String, required: true, trim: true, maxlength: 100 },
    kind: { type: String, enum: WARD_KINDS, required: true, default: "general" },
    tariffCode: { type: String, required: true, trim: true, maxlength: 64 },
    status: { type: String, enum: WARD_STATUSES, required: true, default: "active" },
  },
  // Indexes owned by migration 0027, never autoIndex — see the patient model.
  { timestamps: true, collection: "wards", autoIndex: false },
);

const bedSchema = new Schema<BedDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String },

    wardId: { type: Schema.Types.ObjectId, required: true },
    code: { type: String, required: true, trim: true, maxlength: 32 },
    room: { type: String, trim: true, maxlength: 32 },
    tariffCode: { type: String, trim: true, maxlength: 64 },
    status: { type: String, enum: BED_STATUSES, required: true, default: "available" },
    blockedReason: { type: String, trim: true, maxlength: 200 },
  },
  { timestamps: true, collection: "beds", autoIndex: false },
);

wardSchema.plugin(tenantScopePlugin);
bedSchema.plugin(tenantScopePlugin);

// Configuration, not PHI — the `admin` category, like `branches`. Adding a ward or blocking a
// bed is an administrative act a compliance officer expects to find in the trail.
wardSchema.plugin(auditPlugin, { resource: "ward", category: "admin" });
bedSchema.plugin(auditPlugin, { resource: "bed", category: "admin" });

export function getWardModel(conn: Connection): Model<WardDoc> {
  return (conn.models.Ward as Model<WardDoc>) ?? conn.model<WardDoc>("Ward", wardSchema);
}

export function getBedModel(conn: Connection): Model<BedDoc> {
  return (conn.models.Bed as Model<BedDoc>) ?? conn.model<BedDoc>("Bed", bedSchema);
}
