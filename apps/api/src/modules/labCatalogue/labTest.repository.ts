/**
 * Lab test catalogue repository — the ONLY code that queries `labTests` (Constitution §6).
 *
 * ── THE CATALOGUE IS TENANT-WIDE, SO ITS READS ARE NOT BRANCH-FILTERED ──────
 * This file used to write `branchId` on create and apply `scopeFilter()` on all four reads, and
 * the two halves contradicted each other AND the schema. Migration 0041 makes the code unique per
 * TENANT (`one_lab_test_code_per_tenant`), so a hospital has exactly one CBC — but a branch-filtered
 * read means the site that did not define it cannot see it, and the unique index means that site
 * cannot define its own either. It gets 409 "That test code already exists" for a test the list in
 * front of it says does not.
 *
 * Worse, it is invisible in the ordinary case: the web app always has a branch selected, so
 * `scopeFilter()` returns `{ branchId: <active> }`, and a catalogue seeded for the hospital carries
 * no such key. Every test vanishes and the result grid silently falls back to blank.
 *
 * `billing.repository.ts` carries this note verbatim over `packages`, having already been bitten by
 * it: "The failure was silent and total in the direction that looks like data loss." Same class,
 * same master-data shape, same fix — and the tariff (`serviceItems`) never filtered by branch at
 * all, which is the behaviour both of the others have now been corrected to.
 *
 * Physical tenant isolation is untouched: `getTenantDb()` is the wall, and it is a different
 * database per hospital. Branch was never the wall here, and pretending it was hid the catalogue.
 */
import { Types } from "mongoose";
import { getContext, getTenantDb } from "../../core/context/requestContext.js";
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
  // No `branchId`: the code is unique per TENANT, so the definition is the hospital's. See header.
  const doc = await getLabTestModel(getTenantDb()).create({
    tenantId: ctx.tenantId,
    code: input.code.toUpperCase(),
    name: input.name,
    ...(input.specimenType ? { specimenType: input.specimenType } : {}),
    ...(input.analytes && input.analytes.length ? { analytes: input.analytes } : {}),
    active: true,
    ...(ctx.userId ? { createdBy: ctx.userId } : {}),
  });
  return toTest(doc.toObject() as LabTestDoc);
}

export async function listTests(includeInactive: boolean): Promise<LabTest[]> {
  const q: Record<string, unknown> = {};
  if (!includeInactive) q.active = true;
  const docs = await getLabTestModel(getTenantDb()).find(q).sort({ name: 1 }).lean<LabTestDoc[]>();
  return docs.map(toTest);
}

/** One test by its catalogue code — what ordering and result entry look up. */
export async function findByCode(code: string): Promise<LabTest | undefined> {
  const doc = await getLabTestModel(getTenantDb())
    .findOne({ code: code.toUpperCase() })
    .lean<LabTestDoc>();
  return doc ? toTest(doc) : undefined;
}

export async function findById(id: string): Promise<LabTest | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getLabTestModel(getTenantDb())
    .findOne({ _id: new Types.ObjectId(id) })
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
    .findOneAndUpdate({ _id: new Types.ObjectId(id) }, { $set: patch }, { new: true })
    .lean<LabTestDoc>();
  return doc ? toTest(doc) : undefined;
}
