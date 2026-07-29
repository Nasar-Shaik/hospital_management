/**
 * Lab test catalogue repository — the ONLY code that queries `labTests` (Constitution §6).
 * Tenant-wide config, read branch-aware like every master.
 */
import { Types } from "mongoose";
import { getContext, getTenantDb } from "../../core/context/requestContext.js";
import { writeBranchId } from "../../core/context/activeBranch.js";
import { scopeFilter } from "../../middleware/authorize.js";
import { isDuplicateKey } from "../../core/db/mongoErrors.js";
import { getLabTestModel, type LabTestDoc, type Analyte } from "./labTest.model.js";

export { isDuplicateKey };
export type { Analyte };

export interface LabTest {
  id: string;
  code: string;
  name: string;
  specimenType?: string;
  analytes: Analyte[];
  active: boolean;
  branchId?: string;
}

function toTest(doc: LabTestDoc): LabTest {
  return {
    id: doc._id.toString(),
    code: doc.code,
    name: doc.name,
    ...(doc.specimenType ? { specimenType: doc.specimenType } : {}),
    analytes: doc.analytes ?? [],
    active: doc.active,
    ...(doc.branchId ? { branchId: doc.branchId } : {}),
  };
}

export interface CreateLabTestInput {
  code: string;
  name: string;
  specimenType?: string;
  analytes?: Analyte[];
}

export async function createTest(input: CreateLabTestInput): Promise<LabTest> {
  const ctx = getContext();
  const branchId = await writeBranchId();
  const doc = await getLabTestModel(getTenantDb()).create({
    tenantId: ctx.tenantId,
    code: input.code.toUpperCase(),
    name: input.name,
    ...(input.specimenType ? { specimenType: input.specimenType } : {}),
    ...(input.analytes && input.analytes.length ? { analytes: input.analytes } : {}),
    active: true,
    ...(ctx.userId ? { createdBy: ctx.userId } : {}),
    ...(branchId ? { branchId } : {}),
  });
  return toTest(doc.toObject() as LabTestDoc);
}

export async function listTests(includeInactive: boolean): Promise<LabTest[]> {
  const q: Record<string, unknown> = { ...scopeFilter() };
  if (!includeInactive) q.active = true;
  const docs = await getLabTestModel(getTenantDb()).find(q).sort({ name: 1 }).lean<LabTestDoc[]>();
  return docs.map(toTest);
}

/** One test by its catalogue code — what ordering and result entry look up. */
export async function findByCode(code: string): Promise<LabTest | undefined> {
  const doc = await getLabTestModel(getTenantDb())
    .findOne({ code: code.toUpperCase(), ...scopeFilter() })
    .lean<LabTestDoc>();
  return doc ? toTest(doc) : undefined;
}

export async function findById(id: string): Promise<LabTest | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getLabTestModel(getTenantDb())
    .findOne({ _id: new Types.ObjectId(id), ...scopeFilter() })
    .lean<LabTestDoc>();
  return doc ? toTest(doc) : undefined;
}

export interface UpdateLabTestInput {
  name?: string;
  specimenType?: string;
  analytes?: Analyte[];
  active?: boolean;
}

export async function updateTest(
  id: string,
  patch: UpdateLabTestInput,
): Promise<LabTest | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getLabTestModel(getTenantDb())
    .findOneAndUpdate(
      { _id: new Types.ObjectId(id), ...scopeFilter() },
      { $set: patch },
      { new: true },
    )
    .lean<LabTestDoc>();
  return doc ? toTest(doc) : undefined;
}
