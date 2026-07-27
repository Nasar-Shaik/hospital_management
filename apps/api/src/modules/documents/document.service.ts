/**
 * Document service — uploading, listing, downloading and removing a patient's documents (A7).
 *
 * The upload attaches a file to a PATIENT (optionally to one of their encounters). The patient
 * must exist and be in the caller's scope; the file is size- and type-checked at the edge, exactly
 * like a diagnostic report, before a single byte is stored.
 */
import { AppError } from "../../core/errors/appError.js";
import { writeBranchId } from "../../core/context/activeBranch.js";
import { getPatient } from "../patients/index.js";
import * as repo from "./document.repository.js";
import { DOCUMENT_CATEGORIES, type DocumentCategory } from "./document.model.js";

export type { DocumentMeta, DocumentBytes } from "./document.repository.js";
export { DOCUMENT_CATEGORIES, type DocumentCategory } from "./document.model.js";

/** 10 MB. Above a multi-page PDF or a photo, well under Mongo's 16 MB ceiling. */
const MAX_BYTES = 10 * 1024 * 1024;

const ALLOWED_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
]);

export interface UploadDocumentInput {
  patientId: string;
  encounterId?: string;
  category: DocumentCategory;
  title: string;
  filename: string;
  contentType: string;
  /** The file, base64-encoded (the browser reads it as a data URL and sends the payload). */
  dataBase64: string;
}

export async function uploadDocument(input: UploadDocumentInput): Promise<repo.DocumentMeta> {
  const patient = await getPatient(input.patientId);
  if (!patient) {
    throw new AppError("HMS-PAT-001", 404, "Patient not found", { patientId: input.patientId });
  }

  if (!DOCUMENT_CATEGORIES.includes(input.category)) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      category: [`unknown document category "${input.category}"`],
    });
  }
  if (!ALLOWED_TYPES.has(input.contentType)) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      contentType: [`unsupported file type "${input.contentType}" — upload a PDF or an image`],
    });
  }

  const data = Buffer.from(input.dataBase64, "base64");
  if (data.length === 0) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", { file: ["the file is empty"] });
  }
  if (data.length > MAX_BYTES) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      file: [`the file is ${(data.length / 1024 / 1024).toFixed(1)} MB — the limit is 10 MB`],
    });
  }

  const branchId = await writeBranchId();

  return repo.create({
    patientId: patient.id,
    ...(input.encounterId ? { encounterId: input.encounterId } : {}),
    category: input.category,
    title: input.title,
    filename: input.filename,
    contentType: input.contentType,
    size: data.length,
    data,
    ...(branchId ? { branchId } : {}),
  });
}

export const listPatientDocuments = repo.listForPatient;

export async function getDocumentFile(id: string): Promise<repo.DocumentBytes | undefined> {
  return repo.getBytes(id);
}

export async function deleteDocument(id: string): Promise<void> {
  const removed = await repo.remove(id);
  if (!removed) throw new AppError("HMS-GEN-404", 404, "Document not found", { id });
}
