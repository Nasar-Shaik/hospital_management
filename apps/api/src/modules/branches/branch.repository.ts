/**
 * Branch repository — the ONLY code that queries `branches` (Constitution §6).
 *
 * Reads are tenant-wide: `tenantScopePlugin` forces `tenantId`, and a tenant sees all of its own
 * branches. This collection is NOT branch-scoped by `scopeFilter` — a branch cannot be filtered by
 * itself, and the switcher must list every branch the caller could work in.
 */
import { Types } from "mongoose";
import { getContext, getTenantDb } from "../../core/context/requestContext.js";
import { isDuplicateKey } from "../../core/db/mongoErrors.js";
import { getBranchModel, type BranchDoc, type BranchStatus } from "./branch.model.js";

export { isDuplicateKey };

/** What leaves the module. Never the raw Mongoose document (Doc 09 §5). */
export interface Branch {
  id: string;
  name: string;
  code: string;
  status: BranchStatus;
  isMain: boolean;
  address?: string;
  contactPhone?: string;
  contactEmail?: string;
  timezone?: string;
  gstin?: string;
}

function toBranch(doc: BranchDoc): Branch {
  return {
    id: doc._id.toString(),
    name: doc.name,
    code: doc.code,
    status: doc.status,
    isMain: doc.isMain,
    ...(doc.address ? { address: doc.address } : {}),
    ...(doc.contactPhone ? { contactPhone: doc.contactPhone } : {}),
    ...(doc.contactEmail ? { contactEmail: doc.contactEmail } : {}),
    ...(doc.timezone ? { timezone: doc.timezone } : {}),
    ...(doc.gstin ? { gstin: doc.gstin } : {}),
  };
}

export interface CreateBranchInput {
  name: string;
  code: string;
  isMain?: boolean;
  address?: string;
  contactPhone?: string;
  contactEmail?: string;
  timezone?: string;
  gstin?: string;
}

export async function create(input: CreateBranchInput): Promise<Branch> {
  const ctx = getContext();
  const doc = await getBranchModel(getTenantDb()).create({
    tenantId: ctx.tenantId,
    name: input.name,
    code: input.code.toUpperCase(),
    isMain: input.isMain ?? false,
    ...(input.address ? { address: input.address } : {}),
    ...(input.contactPhone ? { contactPhone: input.contactPhone } : {}),
    ...(input.contactEmail ? { contactEmail: input.contactEmail } : {}),
    ...(input.timezone ? { timezone: input.timezone } : {}),
    ...(input.gstin ? { gstin: input.gstin } : {}),
  });
  return toBranch(doc.toObject() as BranchDoc);
}

/** All branches, main first then alphabetical — the admin list and the switcher's raw material. */
export async function list(): Promise<Branch[]> {
  const docs = await getBranchModel(getTenantDb())
    .find({})
    .sort({ isMain: -1, name: 1 })
    .lean<BranchDoc[]>();
  return docs.map(toBranch);
}

/** The branches with the given ids — for resolving a user's allowed set to real rows. */
export async function listByIds(ids: string[]): Promise<Branch[]> {
  const objectIds = ids
    .filter((id) => Types.ObjectId.isValid(id))
    .map((id) => new Types.ObjectId(id));
  if (objectIds.length === 0) return [];
  const docs = await getBranchModel(getTenantDb())
    .find({ _id: { $in: objectIds } })
    .sort({ isMain: -1, name: 1 })
    .lean<BranchDoc[]>();
  return docs.map(toBranch);
}

export async function findById(id: string): Promise<Branch | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getBranchModel(getTenantDb())
    .findById(new Types.ObjectId(id))
    .lean<BranchDoc>();
  return doc ? toBranch(doc) : undefined;
}

/** How many branches this tenant already has — the cap check reads this. */
export async function count(): Promise<number> {
  return getBranchModel(getTenantDb()).countDocuments({});
}

export interface UpdateBranchInput {
  name?: string;
  status?: BranchStatus;
  address?: string;
  contactPhone?: string;
  contactEmail?: string;
  timezone?: string;
  gstin?: string;
}

export async function update(id: string, patch: UpdateBranchInput): Promise<Branch | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getBranchModel(getTenantDb())
    .findByIdAndUpdate(new Types.ObjectId(id), { $set: patch }, { new: true })
    .lean<BranchDoc>();
  return doc ? toBranch(doc) : undefined;
}
