/**
 * MRD repository — the ONLY code that queries `icdCodes` and `encounterCodings` (Constitution §6).
 */
import { Types } from "mongoose";
import { getContext, getTenantDb } from "../../core/context/requestContext.js";
import { writeBranchId } from "../../core/context/activeBranch.js";
import { scopeFilter } from "../../middleware/authorize.js";
import { isDuplicateKey } from "../../core/db/mongoErrors.js";
import {
  getIcdCodeModel,
  getEncounterCodingModel,
  type IcdCodeDoc,
  type EncounterCodingDoc,
  type CodedDiagnosis,
} from "./mrd.model.js";
import { repointPatientId, type PatientMergeRef } from "../../core/db/repointPatient.js";

export { isDuplicateKey };
export type { CodedDiagnosis };

/* ── ICD-10 master ──────────────────────────────────────────────────────────── */

export interface IcdCode {
  id: string;
  code: string;
  title: string;
  chapter?: string;
  active: boolean;
}

function toIcd(d: IcdCodeDoc): IcdCode {
  return {
    id: d._id.toString(),
    code: d.code,
    title: d.title,
    active: d.active,
    ...(d.chapter ? { chapter: d.chapter } : {}),
  };
}

export interface CreateIcdInput {
  code: string;
  title: string;
  chapter?: string;
}

export async function createIcd(input: CreateIcdInput): Promise<IcdCode> {
  const ctx = getContext();
  const doc = await getIcdCodeModel(getTenantDb()).create({
    tenantId: ctx.tenantId,
    code: input.code.toUpperCase(),
    title: input.title,
    ...(input.chapter ? { chapter: input.chapter } : {}),
    active: true,
    ...(ctx.userId ? { createdBy: ctx.userId } : {}),
  });
  return toIcd(doc.toObject() as IcdCodeDoc);
}

export async function listIcd(
  search: string | undefined,
  includeInactive: boolean,
): Promise<IcdCode[]> {
  const q: Record<string, unknown> = {};
  if (!includeInactive) q.active = true;
  if (search?.trim()) {
    const rx = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    q.$or = [{ code: rx }, { title: rx }];
  }
  const docs = await getIcdCodeModel(getTenantDb())
    .find(q)
    .sort({ code: 1 })
    .limit(200)
    .lean<IcdCodeDoc[]>();
  return docs.map(toIcd);
}

/**
 * One ACTIVE code from the master, by its code. The lookup behind "is this a real ICD code?" —
 * used by the problem list, which stores a code only when the master recognises it. Inactive
 * codes are deliberately not returned: a retired code is not a code a new record may be filed
 * under, and `listIcd` already hides them from the picker for the same reason.
 *
 * The master is tenant reference data, not PHI and not branch-owned, so there is no
 * `scopeFilter()` here — none of the ICD reads has one.
 */
export async function findActiveIcdByCode(code: string): Promise<IcdCode | undefined> {
  const doc = await getIcdCodeModel(getTenantDb())
    .findOne({ code: code.toUpperCase().trim(), active: true })
    .lean<IcdCodeDoc>();
  return doc ? toIcd(doc) : undefined;
}

export async function updateIcd(
  id: string,
  patch: { title?: string; chapter?: string; active?: boolean },
): Promise<IcdCode | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getIcdCodeModel(getTenantDb())
    .findOneAndUpdate({ _id: new Types.ObjectId(id) }, { $set: patch }, { new: true })
    .lean<IcdCodeDoc>();
  return doc ? toIcd(doc) : undefined;
}

/* ── encounter coding ───────────────────────────────────────────────────────── */

export interface EncounterCoding {
  encounterId: string;
  patientId: string;
  codes: CodedDiagnosis[];
  codedBy?: string;
  codedAt: string;
}

function toCoding(d: EncounterCodingDoc): EncounterCoding {
  return {
    encounterId: d.encounterId.toString(),
    patientId: d.patientId.toString(),
    codes: d.codes ?? [],
    codedAt: d.codedAt.toISOString(),
    ...(d.codedBy ? { codedBy: d.codedBy } : {}),
  };
}

export async function getCoding(encounterId: string): Promise<EncounterCoding | undefined> {
  if (!Types.ObjectId.isValid(encounterId)) return undefined;
  const doc = await getEncounterCodingModel(getTenantDb())
    .findOne({ encounterId: new Types.ObjectId(encounterId), ...scopeFilter() })
    .lean<EncounterCodingDoc>();
  return doc ? toCoding(doc) : undefined;
}

export interface UpsertCodingInput {
  encounterId: string;
  patientId: string;
  episodeId: string;
  codes: CodedDiagnosis[];
  branchId?: string;
}

/** One coding per encounter — upserted, so re-coding a visit revises the record rather than piling up. */
export async function upsertCoding(input: UpsertCodingInput): Promise<EncounterCoding> {
  const ctx = getContext();
  const branchId = await writeBranchId(input.branchId);
  const doc = await getEncounterCodingModel(getTenantDb())
    .findOneAndUpdate(
      { encounterId: new Types.ObjectId(input.encounterId), tenantId: ctx.tenantId },
      {
        $set: {
          codes: input.codes,
          codedAt: new Date(),
          ...(ctx.userId ? { codedBy: ctx.userId } : {}),
        },
        $setOnInsert: {
          tenantId: ctx.tenantId,
          patientId: new Types.ObjectId(input.patientId),
          episodeId: new Types.ObjectId(input.episodeId),
          ...(branchId ? { branchId } : {}),
        },
      },
      { new: true, upsert: true },
    )
    .lean<EncounterCodingDoc>();
  return toCoding(doc);
}

/* ── disease register ───────────────────────────────────────────────────────── */

export interface DiseaseRegisterRow {
  code: string;
  title: string;
  cases: number;
}

/**
 * How many visits carried each diagnosis in a period — the notifiable-disease / morbidity register.
 * Counts the PRIMARY coded diagnosis of each coding whose `codedAt` falls in the window; tenant-
 * scoped by the aggregate hook. One row per code, commonest first.
 */
export async function diseaseRegister(from: Date, to: Date): Promise<DiseaseRegisterRow[]> {
  const rows = await getEncounterCodingModel(getTenantDb()).aggregate<{
    _id: { code: string; title: string };
    cases: number;
  }>([
    { $match: { codedAt: { $gte: from, $lt: to } } },
    { $unwind: "$codes" },
    { $match: { "codes.primary": true } },
    {
      $group: {
        _id: { code: "$codes.code", title: "$codes.title" },
        cases: { $sum: 1 },
      },
    },
    { $sort: { cases: -1, "_id.code": 1 } },
  ]);
  return rows.map((r) => ({ code: r._id.code, title: r._id.title, cases: r.cases }));
}

/**
 * Coded diagnoses follow the person. A coding row IS the diagnosis (it is audited as PHI for that
 * reason), and the disease register counts these — so a merge that left them behind would both
 * hide a condition from the survivor's chart and under-count it in the hospital's returns.
 *
 * The ICD master is deliberately not touched: it is reference data and holds no patient.
 */
export async function repointPatient(ref: PatientMergeRef): Promise<number> {
  return repointPatientId(getEncounterCodingModel(getTenantDb()), "patientId", ref, {
    objectId: true,
  });
}
