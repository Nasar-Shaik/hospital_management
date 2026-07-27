/**
 * Department — the hospital's ORGANISATIONAL UNITS and their hierarchy (Modules B2/B3).
 *
 * ── WHAT THIS FIXES ─────────────────────────────────────────────────────────
 * The encounter already carries a `departmentId` (it is one of the queues a patient can be routed
 * into — encounter.model.ts), but until now there was no CATALOGUE of departments: the id pointed
 * at nothing, a report grouped by "department" had only free text to group on, and there was no way
 * to say "Cardiology sits under Medicine". This module is that catalogue — the departments a
 * hospital has, and the parent/child hierarchy between them.
 *
 * ── TENANT-WIDE, NOT BRANCH-SCOPED ──────────────────────────────────────────
 * A department is a SERVICE LINE ("Cardiology", "Radiology"), not a physical place — the same
 * Cardiology exists at every site. So, like `branches`, the catalogue is tenant-wide: a code is
 * unique across the whole hospital and the read is not filtered by `scopeFilter`. The permission
 * says the same thing — `department:manage` is tenant-scoped, with no `branch` row-scope.
 *
 * ── THE HIERARCHY IS A SELF-REFERENCE, GUARDED AGAINST CYCLES ────────────────
 * `parentId` points at another department in the same tenant. A department with no parent is a
 * top-level unit; one with a parent is a sub-department. The service refuses a parent that would
 * make a department its own ancestor — a cycle turns the "walk up to the root" that every tree read
 * does into an infinite loop, so it is rejected at write time, not discovered at read time.
 *
 * ── NO DELETE ───────────────────────────────────────────────────────────────
 * Like `branches`, there is no delete path: encounters and reports reference a department by id, so
 * removing it would orphan history. A department that closes is set `inactive` — it stops appearing
 * in the pickers but its past is still readable.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { tenantScopePlugin } from "../../core/db/plugins/tenantScope.js";
import { auditPlugin } from "../../core/db/plugins/auditPlugin.js";

/**
 * The kind of unit — drives nothing in code; it groups the list and lets a report split
 * "clinical departments" from "support functions".
 */
export const DEPARTMENT_KINDS = [
  "clinical",
  "diagnostic",
  "nursing",
  "pharmacy",
  "support",
  "administrative",
] as const;
export type DepartmentKind = (typeof DEPARTMENT_KINDS)[number];

/** `active` takes new routing; `inactive` is retired but its history is still readable. */
export const DEPARTMENT_STATUSES = ["active", "inactive"] as const;
export type DepartmentStatus = (typeof DEPARTMENT_STATUSES)[number];

export interface DepartmentDoc {
  _id: Types.ObjectId;
  tenantId: string;

  /** `Cardiology`, `Radiology`, `General Medicine`. */
  name: string;
  /** Short code, unique per tenant — the human key on a report and the queue label (`CARD`). */
  code: string;
  kind: DepartmentKind;
  /** The parent unit, when this is a sub-department. Absent means a top-level department. */
  parentId?: Types.ObjectId;
  /** The department head — a staff user id. Descriptive; nothing branches on it. */
  headStaffId?: Types.ObjectId;
  status: DepartmentStatus;
  description?: string;

  createdAt: Date;
  updatedAt: Date;
}

const departmentSchema = new Schema<DepartmentDoc>(
  {
    tenantId: { type: String, required: true, index: true },

    name: { type: String, required: true, trim: true, maxlength: 160 },
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 24 },
    kind: { type: String, enum: DEPARTMENT_KINDS, required: true, default: "clinical" },
    parentId: { type: Schema.Types.ObjectId },
    headStaffId: { type: Schema.Types.ObjectId },
    status: { type: String, enum: DEPARTMENT_STATUSES, required: true, default: "active" },
    description: { type: String, trim: true, maxlength: 500 },
  },
  // Indexes owned by migration 0030, never autoIndex — see the patient model.
  { timestamps: true, collection: "departments", autoIndex: false },
);

departmentSchema.plugin(tenantScopePlugin);

// Configuration, not PHI — the `admin` category, like `branches` and `wards`. Adding or retiring a
// department is an administrative act a compliance officer expects to find in the trail.
departmentSchema.plugin(auditPlugin, { resource: "department", category: "admin" });

export function getDepartmentModel(conn: Connection): Model<DepartmentDoc> {
  return (
    (conn.models.Department as Model<DepartmentDoc>) ??
    conn.model<DepartmentDoc>("Department", departmentSchema)
  );
}
