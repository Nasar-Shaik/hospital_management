/**
 * Report DTOs. `.strict()` — an unexpected field is a 400.
 */
import { z } from "@medicore/validation";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "invalid id");

export const uploadReportSchema = z
  .object({
    filename: z.string().min(1).max(260),
    contentType: z.string().min(1).max(100),
    /**
     * The file as base64. Capped generously here so an oversized upload is rejected by the
     * body parser / this bound before the service decodes it; the service enforces the real
     * 10 MB limit on the DECODED bytes (base64 inflates by ~4/3).
     */
    dataBase64: z.string().min(1).max(15_000_000),
  })
  .strict();

export const orderIdParamSchema = z.object({ id: objectId }).strict();
export const patientIdParamSchema = z.object({ patientId: objectId }).strict();
export const reportIdParamSchema = z.object({ id: objectId }).strict();

export type UploadReportBody = z.infer<typeof uploadReportSchema>;
