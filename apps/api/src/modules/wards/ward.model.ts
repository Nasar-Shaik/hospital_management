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
 * ── WARD NAMES ARE UNIQUE PER BRANCH (migration 0046) ────────────────────────
 * A ward belongs to ONE SITE, so Hyderabad's ICU and Chennai's ICU are two different wards with
 * the same name — `one_ward_name_per_branch` on `{tenantId, branchId, name}`.
 *
 * Occupancy is keyed the same way and had to move in the same migration. An admission records
 * its bed as TEXT (`bed.ward`, `bed.bedCode` on the encounter), so once two sites may both own an
 * "ICU", a tenant-wide occupancy key would refuse Chennai's ICU/A-12 because Hyderabad's is full.
 * `one_open_stay_per_bed_per_branch` therefore leads with `branchId` too. The two indexes are a
 * pair: change one and the other must follow, or a real patient is turned away by a stale rule.
 *
 * A bed code stays unique within its WARD (`one_bed_code_per_ward` on `wardId`) and needs no
 * branch of its own — a ward already belongs to exactly one.
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
 * A room's CLASS — how a hospital prices and describes the space a bed sits in. A ward groups
 * beds clinically (ICU, maternity); a room groups them commercially (a private single, a
 * four-bed sharing). Drives nothing in code beyond the label and the default room tariff.
 */
export const ROOM_KINDS = [
  "general",
  "sharing",
  "semi_private",
  "private",
  "deluxe",
  "suite",
] as const;
export type RoomKind = (typeof ROOM_KINDS)[number];

/** Same two-state life as a ward: `active` rooms take beds; `inactive` is retired, history intact. */
export const ROOM_STATUSES = ["active", "inactive"] as const;
export type RoomStatus = (typeof ROOM_STATUSES)[number];

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

  /** `General Ward`, `ICU`. Unique per BRANCH — see the header. */
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

/**
 * A ROOM — the optional commercial level between a ward and its beds (ward → room → bed).
 *
 * A bed may sit in a room (`Room 4`, a private single; `Bay B`, a four-bed sharing) or hang
 * directly off the ward (a general ward's open floor of beds). The room carries the room-class
 * TARIFF, so a four-bed sharing is priced once on the room, not four times on its beds. A bed
 * that names a room inherits that price unless it sets its own; the resolution is
 * bed → room → ward, most specific wins. Occupancy is NOT here either — it is derived from
 * encounters exactly as for a ward, so a room never stores who is in it.
 */
export interface RoomDoc {
  _id: Types.ObjectId;
  tenantId: string;
  branchId?: string;

  wardId: Types.ObjectId;
  /** `Room 4`, `Bay B`. Unique within its ward. */
  name: string;
  kind: RoomKind;
  /** The room-class bed-day tariff; a bed in the room bills at this unless it overrides. Optional. */
  tariffCode?: string;
  status: RoomStatus;

  createdAt: Date;
  updatedAt: Date;
}

export interface BedDoc {
  _id: Types.ObjectId;
  tenantId: string;
  branchId?: string;

  wardId: Types.ObjectId;
  /**
   * The room this bed sits in, when the ward is divided into rooms. Absent means the bed hangs
   * directly off the ward (an open general floor). A room's ward always equals the bed's ward —
   * the service enforces it, so the two can never disagree.
   */
  roomId?: Types.ObjectId;
  /** `A-12`. Unique within its ward. */
  code: string;
  /**
   * LEGACY free-text room/bay label, kept for beds catalogued before rooms became first-class.
   * New beds carry `roomId` instead; the board falls back to this label when there is no room.
   */
  room?: string;
  /** Overrides the room/ward tariff for this bed; absent means "bill at the room-or-ward rate". */
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
    branchId: { type: String, required: true },

    name: { type: String, required: true, trim: true, maxlength: 100 },
    kind: { type: String, enum: WARD_KINDS, required: true, default: "general" },
    tariffCode: { type: String, required: true, trim: true, maxlength: 64 },
    status: { type: String, enum: WARD_STATUSES, required: true, default: "active" },
  },
  // Indexes owned by migration 0027, never autoIndex — see the patient model.
  { timestamps: true, collection: "wards", autoIndex: false },
);

const roomSchema = new Schema<RoomDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String, required: true },

    wardId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    kind: { type: String, enum: ROOM_KINDS, required: true, default: "general" },
    tariffCode: { type: String, trim: true, maxlength: 64 },
    status: { type: String, enum: ROOM_STATUSES, required: true, default: "active" },
  },
  { timestamps: true, collection: "rooms", autoIndex: false },
);

const bedSchema = new Schema<BedDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String, required: true },

    wardId: { type: Schema.Types.ObjectId, required: true },
    roomId: { type: Schema.Types.ObjectId },
    code: { type: String, required: true, trim: true, maxlength: 32 },
    room: { type: String, trim: true, maxlength: 32 },
    tariffCode: { type: String, trim: true, maxlength: 64 },
    status: { type: String, enum: BED_STATUSES, required: true, default: "available" },
    blockedReason: { type: String, trim: true, maxlength: 200 },
  },
  { timestamps: true, collection: "beds", autoIndex: false },
);

wardSchema.plugin(tenantScopePlugin);
roomSchema.plugin(tenantScopePlugin);
bedSchema.plugin(tenantScopePlugin);

// Configuration, not PHI — the `admin` category, like `branches`. Adding a ward or blocking a
// bed is an administrative act a compliance officer expects to find in the trail.
wardSchema.plugin(auditPlugin, { resource: "ward", category: "admin" });
roomSchema.plugin(auditPlugin, { resource: "room", category: "admin" });
bedSchema.plugin(auditPlugin, { resource: "bed", category: "admin" });

export function getWardModel(conn: Connection): Model<WardDoc> {
  return (conn.models.Ward as Model<WardDoc>) ?? conn.model<WardDoc>("Ward", wardSchema);
}

export function getRoomModel(conn: Connection): Model<RoomDoc> {
  return (conn.models.Room as Model<RoomDoc>) ?? conn.model<RoomDoc>("Room", roomSchema);
}

export function getBedModel(conn: Connection): Model<BedDoc> {
  return (conn.models.Bed as Model<BedDoc>) ?? conn.model<BedDoc>("Bed", bedSchema);
}
