/**
 * Document controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler } from "express";
import { AppError } from "../../core/errors/appError.js";
import * as documents from "./document.service.js";
import type { UploadDocumentBody } from "./document.schema.js";
import { ok } from "../../core/http/respond.js";

export const uploadDocument: RequestHandler = async (req, res) => {
  const { patientId } = req.params as { patientId: string };
  const body = req.body as UploadDocumentBody;
  ok(
    res,
    await documents.uploadDocument({
      patientId,
      category: body.category,
      title: body.title,
      ...(body.encounterId ? { encounterId: body.encounterId } : {}),
      filename: body.filename,
      contentType: body.contentType,
      dataBase64: body.dataBase64,
    }),
    201,
  );
};

export const listPatientDocuments: RequestHandler = async (req, res) => {
  const { patientId } = req.params as { patientId: string };
  ok(res, await documents.listPatientDocuments(patientId));
};

/**
 * Streams the file itself. Not wrapped in the `{ success, data }` envelope — it is bytes,
 * `inline` so a PDF or image opens in the browser tab rather than forcing a download.
 */
export const downloadDocument: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const file = await documents.getDocumentFile(id);
  if (!file) throw new AppError("HMS-GEN-404", 404, "Document not found", { id });

  res.setHeader("Content-Type", file.contentType);
  res.setHeader("Content-Disposition", `inline; filename="${file.filename.replace(/["\\]/g, "")}"`);
  res.send(file.data);
};

export const deleteDocument: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  await documents.deleteDocument(id);
  ok(res, { id, deleted: true });
};
