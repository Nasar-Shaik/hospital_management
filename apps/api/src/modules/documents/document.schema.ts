/**
 * Document DTOs (Doc 09 §5/§6). `.strict()` — an unexpected field is a 400.
 */
import { z } from "@medicore/validation";
import { DOCUMENT_CATEGORIES } from "./document.model.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "invalid id");

export const uploadDocumentSchema = z
  .object({
    category: z.enum(DOCUMENT_CATEGORIES),
    title: z.string().trim().min(1).max(200),
    /** Optional visit this document belongs to. Absent for record-level documents. */
    encounterId: objectId.optional(),
    filename: z.string().trim().min(1).max(260),
    contentType: z.string().trim().min(1).max(100),
    /** The file, base64-encoded. Size is checked in the service, not here. */
    dataBase64: z.string().min(1),
  })
  .strict();

export const patientIdParamSchema = z.object({ patientId: objectId }).strict();
export const documentIdParamSchema = z.object({ id: objectId }).strict();

export type UploadDocumentBody = z.infer<typeof uploadDocumentSchema>;
