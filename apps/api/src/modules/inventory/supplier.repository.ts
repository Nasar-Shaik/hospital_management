/**
 * Supplier repository — the ONLY code that queries `suppliers` (Constitution §6).
 *
 * Tenant-wide: no `scopeFilter()` anywhere in this file, on purpose. A supplier is a company the
 * hospital buys from, not a record that happened at a site — narrowing it to the active branch
 * would make half the list vanish the moment a store keeper picked a site to work in.
 */
import { Types } from "mongoose";
import { getContext, getTenantDb } from "../../core/context/requestContext.js";
import { isDuplicateKey } from "../../core/db/mongoErrors.js";
import { getSupplierModel, type SupplierDoc } from "./supplier.model.js";

export { isDuplicateKey };

/** What leaves the module. Never the raw Mongoose document (Doc 09 §5). */
export interface Supplier {
  id: string;
  code: string;
  name: string;
  phone?: string;
  email?: string;
  taxId?: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function toSupplier(d: SupplierDoc): Supplier {
  return {
    id: d._id.toString(),
    code: d.code,
    name: d.name,
    active: d.active,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    ...(d.phone ? { phone: d.phone } : {}),
    ...(d.email ? { email: d.email } : {}),
    ...(d.taxId ? { taxId: d.taxId } : {}),
  };
}

export interface CreateSupplierInput {
  code: string;
  name: string;
  phone?: string;
  email?: string;
  taxId?: string;
}

export async function create(input: CreateSupplierInput): Promise<Supplier> {
  const ctx = getContext();
  const doc = await getSupplierModel(getTenantDb()).create({
    tenantId: ctx.tenantId,
    code: input.code,
    name: input.name,
    active: true,
    ...(input.phone ? { phone: input.phone } : {}),
    ...(input.email ? { email: input.email } : {}),
    ...(input.taxId ? { taxId: input.taxId } : {}),
  });
  return toSupplier(doc.toObject() as SupplierDoc);
}

export type UpdateSupplierInput = Partial<Omit<CreateSupplierInput, "code">> & { active?: boolean };

export async function update(
  id: string,
  patch: UpdateSupplierInput,
): Promise<Supplier | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getSupplierModel(getTenantDb())
    .findByIdAndUpdate(new Types.ObjectId(id), { $set: patch }, { new: true })
    .lean<SupplierDoc>();
  return doc ? toSupplier(doc) : undefined;
}

export interface ListSuppliersFilter {
  search?: string;
  /** Include retired suppliers. Off by default — the list is who the hospital buys from now. */
  includeInactive?: boolean;
}

export async function list(filter: ListSuppliersFilter = {}): Promise<Supplier[]> {
  const query: Record<string, unknown> = {};
  if (!filter.includeInactive) query.active = true;
  if (filter.search) {
    const rx = new RegExp(escapeRegExp(filter.search), "i");
    query.$or = [{ code: rx }, { name: rx }];
  }
  const docs = await getSupplierModel(getTenantDb())
    .find(query)
    .sort({ name: 1 })
    .lean<SupplierDoc[]>();
  return docs.map(toSupplier);
}

/**
 * One supplier, for stamping its name onto a receipt.
 *
 * Deliberately UNSCOPED, and declared as such in `scopedReads.test.ts`: the collection is
 * tenant-wide (see the header), and `tenantScopePlugin` already forces the tenant match onto this
 * query. Narrowing it to the active branch would mean a store keeper working at one site could
 * not attribute a delivery to a supplier the hospital added at another.
 */
export async function findById(id: string): Promise<Supplier | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getSupplierModel(getTenantDb())
    .findById(new Types.ObjectId(id))
    .lean<SupplierDoc>();
  return doc ? toSupplier(doc) : undefined;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
