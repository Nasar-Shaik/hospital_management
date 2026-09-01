/**
 * Department repository — the ONLY code that queries `departments` (Constitution §6).
 *
 * Reads are tenant-wide: `tenantScopePlugin` forces `tenantId`, and a tenant sees all of its own
 * departments. This collection is NOT branch-scoped by `scopeFilter` — a service line spans every
 * site, and the routing pickers must list every department (see the module header).
 */
import { Types } from "mongoose";
import { getContext, getTenantDb } from "../../core/context/requestContext.js";
import { isDuplicateKey } from "../../core/db/mongoErrors.js";
import {
  getDepartmentModel,
  type DepartmentDoc,
  type DepartmentKind,
  type DepartmentStatus,
} from "./department.model.js";

export { isDuplicateKey };

/** What leaves the module. Never the raw Mongoose document (Doc 09 §5). */
export interface Department {
  id: string;
  name: string;
  code: string;
  kind: DepartmentKind;
  status: DepartmentStatus;
  parentId?: string;
  headStaffId?: string;
  description?: string;
  /** Denormalized from the parent for the tree view — never a stored field. */
  parentName?: string;
}

function toDepartment(doc: DepartmentDoc, parent?: DepartmentDoc): Department {
  return {
    id: doc._id.toString(),
    name: doc.name,
    code: doc.code,
    kind: doc.kind,
    status: doc.status,
    ...(doc.parentId ? { parentId: doc.parentId.toString() } : {}),
    ...(doc.headStaffId ? { headStaffId: doc.headStaffId.toString() } : {}),
    ...(doc.description ? { description: doc.description } : {}),
    ...(parent ? { parentName: parent.name } : {}),
  };
}

export interface CreateDepartmentInput {
  name: string;
  code: string;
  kind: DepartmentKind;
  parentId?: string;
  headStaffId?: string;
  description?: string;
}

export async function create(input: CreateDepartmentInput): Promise<Department> {
  const ctx = getContext();
  const doc = await getDepartmentModel(getTenantDb()).create({
    tenantId: ctx.tenantId,
    name: input.name,
    code: input.code.toUpperCase(),
    kind: input.kind,
    ...(input.parentId ? { parentId: new Types.ObjectId(input.parentId) } : {}),
    ...(input.headStaffId ? { headStaffId: new Types.ObjectId(input.headStaffId) } : {}),
    ...(input.description ? { description: input.description } : {}),
  });
  return toDepartment(doc.toObject() as DepartmentDoc);
}

/**
 * Every department, each carrying its parent's name so the tree view reads without a second round
 * trip. One query, joined in memory — a hospital has dozens of departments, not millions. Sorted
 * by code, which is the stable human key the admin scans.
 */
export async function list(): Promise<Department[]> {
  const docs = await getDepartmentModel(getTenantDb())
    .find({})
    .sort({ code: 1 })
    .lean<DepartmentDoc[]>();
  const byId = new Map(docs.map((d) => [d._id.toString(), d]));
  return docs.map((d) => toDepartment(d, d.parentId ? byId.get(d.parentId.toString()) : undefined));
}

export async function findById(id: string): Promise<Department | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getDepartmentModel(getTenantDb())
    .findById(new Types.ObjectId(id))
    .lean<DepartmentDoc>();
  if (!doc) return undefined;
  const parent = doc.parentId
    ? ((await getDepartmentModel(getTenantDb()).findById(doc.parentId).lean<DepartmentDoc>()) ??
      undefined)
    : undefined;
  return toDepartment(doc, parent);
}

/** The raw parentId chain check needs the bare doc — no join. */
export async function findDocById(id: string): Promise<DepartmentDoc | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getDepartmentModel(getTenantDb())
    .findById(new Types.ObjectId(id))
    .lean<DepartmentDoc>();
  return doc ?? undefined;
}

export interface UpdateDepartmentInput {
  name?: string;
  kind?: DepartmentKind;
  status?: DepartmentStatus;
  parentId?: string | null;
  headStaffId?: string | null;
  description?: string;
}

export async function update(
  id: string,
  patch: UpdateDepartmentInput,
): Promise<Department | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;

  // `null` explicitly detaches a parent/head; `undefined` leaves it untouched. The `$unset`
  // removes the field entirely so a detached department reads as top-level, not as "parent: null".
  const set: Record<string, unknown> = {};
  const unset: Record<string, unknown> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.kind !== undefined) set.kind = patch.kind;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.parentId === null) unset.parentId = "";
  else if (patch.parentId !== undefined) set.parentId = new Types.ObjectId(patch.parentId);
  if (patch.headStaffId === null) unset.headStaffId = "";
  else if (patch.headStaffId !== undefined) set.headStaffId = new Types.ObjectId(patch.headStaffId);

  const doc = await getDepartmentModel(getTenantDb())
    .findByIdAndUpdate(
      new Types.ObjectId(id),
      {
        ...(Object.keys(set).length ? { $set: set } : {}),
        ...(Object.keys(unset).length ? { $unset: unset } : {}),
      },
      { new: true },
    )
    .lean<DepartmentDoc>();
  if (!doc) return undefined;
  const parent = doc.parentId
    ? ((await getDepartmentModel(getTenantDb()).findById(doc.parentId).lean<DepartmentDoc>()) ??
      undefined)
    : undefined;
  return toDepartment(doc, parent);
}
