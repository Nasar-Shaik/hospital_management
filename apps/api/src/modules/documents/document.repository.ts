/**
 * Document repository — the ONLY code that queries `documents` (Constitution §6).
 *
 * Every list query is PROJECTED to exclude `data`: the bytes are read exactly once, by the
 * download. A patient's document list that dragged every file's binary into memory would fall
 * over on the first person with a folder of scans.
 */
import { Types } from "mongoose";
import { getContext, getTenantDb } from "../../core/context/requestContext.js";
import { repointPatientId, type PatientMergeRef } from "../../core/db/repointPatient.js";
import { scopeFilter } from "../../middleware/authorize.js";
import { getDocumentModel, type DocumentDoc, type DocumentCategory } from "./document.model.js";

/** Metadata only — never the bytes. What the Documents tab is built from. */
export interface DocumentMeta {
  id: string;
  patientId: string;
  encounterId?: string;
  category: DocumentCategory;
  title: string;
  filename: string;
  contentType: string;
  size: number;
  uploadedBy: string;
  uploadedAt: Date;
}

/** The bytes, for a download. */
export interface DocumentBytes {
  filename: string;
  contentType: string;
  data: Buffer;
}

function toMeta(doc: Omit<DocumentDoc, "data">): DocumentMeta {
  return {
    id: doc._id.toString(),
    patientId: doc.patientId.toString(),
    ...(doc.encounterId ? { encounterId: doc.encounterId.toString() } : {}),
    category: doc.category,
    title: doc.title,
    filename: doc.filename,
    contentType: doc.contentType,
    size: doc.size,
    uploadedBy: doc.uploadedBy,
    uploadedAt: doc.uploadedAt,
  };
}

export interface CreateDocumentInput {
  patientId: string;
  encounterId?: string;
  category: DocumentCategory;
  title: string;
  filename: string;
  contentType: string;
  size: number;
  data: Buffer;
  branchId?: string;
}

export async function create(input: CreateDocumentInput): Promise<DocumentMeta> {
  const ctx = getContext();
  const doc = await getDocumentModel(getTenantDb()).create({
    tenantId: ctx.tenantId,
    patientId: new Types.ObjectId(input.patientId),
    ...(input.encounterId ? { encounterId: new Types.ObjectId(input.encounterId) } : {}),
    category: input.category,
    title: input.title,
    filename: input.filename,
    contentType: input.contentType,
    size: input.size,
    data: input.data,
    uploadedBy: ctx.userId ?? "system",
    uploadedAt: new Date(),
    ...(input.branchId ? { branchId: input.branchId } : {}),
  });
  return toMeta(doc.toObject() as DocumentDoc);
}

/** Every document for a patient, newest first. Keyed on the patient, honouring the row scope. */
export async function listForPatient(patientId: string): Promise<DocumentMeta[]> {
  const docs = await getDocumentModel(getTenantDb())
    .find({ ...scopeFilter("uploadedBy"), patientId: new Types.ObjectId(patientId) }, { data: 0 })
    .sort({ uploadedAt: -1 })
    .lean<Omit<DocumentDoc, "data">[]>();
  return docs.map(toMeta);
}

/** One document's metadata — the delete path reads this to confirm it exists in scope. */
export async function findMeta(id: string): Promise<DocumentMeta | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getDocumentModel(getTenantDb())
    .findOne({ _id: new Types.ObjectId(id), ...scopeFilter("uploadedBy") }, { data: 0 })
    .lean<Omit<DocumentDoc, "data">>();
  return doc ? toMeta(doc) : undefined;
}

/** The bytes for one document — the only read that touches `data`. */
export async function getBytes(id: string): Promise<DocumentBytes | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getDocumentModel(getTenantDb())
    .findOne({ _id: new Types.ObjectId(id), ...scopeFilter("uploadedBy") })
    .lean<DocumentDoc>();
  if (!doc) return undefined;
  return { filename: doc.filename, contentType: doc.contentType, data: toBuffer(doc.data) };
}

/** Removes a document (audited via the plugin's delete hook). Returns whether one was removed. */
export async function remove(id: string): Promise<boolean> {
  if (!Types.ObjectId.isValid(id)) return false;
  const doc = await getDocumentModel(getTenantDb()).findOneAndDelete({
    _id: new Types.ObjectId(id),
    ...scopeFilter("uploadedBy"),
  });
  return doc !== null;
}

/**
 * `.lean()` hands a Buffer field back as a BSON `Binary`, not a Node `Buffer` — and `res.send()`
 * on a Binary re-encodes it to base64 text, so a PDF downloads as gibberish. Coerce to a real
 * Buffer whichever shape arrives (the same fix reportFiles needed).
 */
function toBuffer(raw: unknown): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  const binary = raw as { buffer?: Buffer; value?: () => Buffer };
  if (binary.buffer && Buffer.isBuffer(binary.buffer)) return binary.buffer;
  if (typeof binary.value === "function") return binary.value();
  return Buffer.from(raw as Uint8Array);
}

/** Move a merged patient's documents onto the survivor (patient.patients.merged). Idempotent. */
export async function repointPatient(ref: PatientMergeRef): Promise<number> {
  return repointPatientId(getDocumentModel(getTenantDb()), "patientId", ref, { objectId: true });
}
