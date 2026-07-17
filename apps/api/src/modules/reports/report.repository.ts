/**
 * Report-file repository — the ONLY code that queries `reportFiles` (Constitution §6).
 *
 * Every list query is PROJECTED to exclude `data`: the bytes are read exactly once, by the
 * download. A patient's report list that dragged every file's binary into memory would fall
 * over on the first person with a year of imaging.
 */
import { Types } from "mongoose";
import { getContext, getTenantDb } from "../../core/context/requestContext.js";
import { repointPatientId, type PatientMergeRef } from "../../core/db/repointPatient.js";
import { getReportFileModel, type ReportFileDoc } from "./report.model.js";
import { scopeFilter } from "../../middleware/authorize.js";

/** Metadata only — never the bytes. What the report list and cards are built from. */
export interface ReportMeta {
  id: string;
  orderId: string;
  encounterId: string;
  patientId: string;
  episodeId: string;
  category: string;
  testName: string;
  visitDate: Date;
  filename: string;
  contentType: string;
  size: number;
  uploadedBy: string;
  uploadedAt: Date;
}

/** The bytes, for a download. */
export interface ReportBytes {
  filename: string;
  contentType: string;
  data: Buffer;
}

function toMeta(doc: Omit<ReportFileDoc, "data">): ReportMeta {
  return {
    id: doc._id.toString(),
    orderId: doc.orderId.toString(),
    encounterId: doc.encounterId.toString(),
    patientId: doc.patientId.toString(),
    episodeId: doc.episodeId.toString(),
    category: doc.category,
    testName: doc.testName,
    visitDate: doc.visitDate,
    filename: doc.filename,
    contentType: doc.contentType,
    size: doc.size,
    uploadedBy: doc.uploadedBy,
    uploadedAt: doc.uploadedAt,
  };
}

export interface CreateReportInput {
  orderId: string;
  encounterId: string;
  patientId: string;
  episodeId: string;
  category: string;
  testName: string;
  visitDate: Date;
  filename: string;
  contentType: string;
  size: number;
  data: Buffer;
  branchId?: string;
}

export async function create(input: CreateReportInput): Promise<ReportMeta> {
  const ctx = getContext();
  const doc = await getReportFileModel(getTenantDb()).create({
    tenantId: ctx.tenantId,
    orderId: new Types.ObjectId(input.orderId),
    encounterId: new Types.ObjectId(input.encounterId),
    patientId: new Types.ObjectId(input.patientId),
    episodeId: new Types.ObjectId(input.episodeId),
    category: input.category,
    testName: input.testName,
    visitDate: input.visitDate,
    filename: input.filename,
    contentType: input.contentType,
    size: input.size,
    data: input.data,
    uploadedBy: ctx.userId ?? "system",
    uploadedAt: new Date(),
    ...(input.branchId ? { branchId: input.branchId } : {}),
  });
  return toMeta(doc.toObject() as ReportFileDoc);
}

/**
 * Every report for a patient, newest visit first — the doctor's cross-visit view. Keyed on
 * the patient, honouring the request's row scope like other clinical reads. Projection drops
 * the bytes.
 */
export async function listForPatient(patientId: string): Promise<ReportMeta[]> {
  const docs = await getReportFileModel(getTenantDb())
    .find({ ...scopeFilter("uploadedBy"), patientId: new Types.ObjectId(patientId) }, { data: 0 })
    .sort({ visitDate: -1, uploadedAt: -1 })
    .lean<Omit<ReportFileDoc, "data">[]>();
  return docs.map(toMeta);
}

/** The bytes for one report — the only read that touches `data`. */
export async function getBytes(id: string): Promise<ReportBytes | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getReportFileModel(getTenantDb())
    .findById(new Types.ObjectId(id))
    .lean<ReportFileDoc>();
  if (!doc) return undefined;
  return { filename: doc.filename, contentType: doc.contentType, data: toBuffer(doc.data) };
}

/**
 * `.lean()` hands a Buffer field back as a BSON `Binary`, not a Node `Buffer` — and
 * `res.send()` on a Binary re-encodes it to base64 text, so a PDF downloads as gibberish.
 * This coerces to a real Buffer whichever shape arrives (found the hard way).
 */
function toBuffer(raw: unknown): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  const binary = raw as { buffer?: Buffer; value?: () => Buffer };
  if (binary.buffer && Buffer.isBuffer(binary.buffer)) return binary.buffer;
  if (typeof binary.value === "function") return binary.value();
  return Buffer.from(raw as Uint8Array);
}

/**
 * Move a merged patient's report files onto the survivor (patient.patients.merged).
 * Idempotent — see repointPatientId.
 */
export async function repointPatient(ref: PatientMergeRef): Promise<number> {
  return repointPatientId(getReportFileModel(getTenantDb()), "patientId", ref, { objectId: true });
}
