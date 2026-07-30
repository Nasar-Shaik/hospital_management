/**
 * Mortuary DTOs (Doc 09 §5/§6). `.strict()` — an unexpected field is a 400.
 */
import { z } from "@medicore/validation";
import { MORTUARY_STATUSES } from "./mortuary.model.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "invalid id");

export const receiveBodySchema = z
  .object({
    encounterId: objectId,
    tagNumber: z.string().trim().min(1).max(40),
    storageUnit: z.string().trim().max(60).optional(),
    remarks: z.string().trim().max(1000).optional(),
  })
  .strict();

export const releaseBodySchema = z
  .object({
    releasedTo: z.string().trim().min(1).max(160),
    releasedRelationship: z.string().trim().min(1).max(60),
    clearanceRef: z.string().trim().max(120).optional(),
    remarks: z.string().trim().max(1000).optional(),
  })
  .strict();

export const listQuerySchema = z.object({ status: z.enum(MORTUARY_STATUSES).optional() }).strict();

export const idParamSchema = z.object({ id: objectId }).strict();
export const encounterParamSchema = z.object({ encounterId: objectId }).strict();

export type ReceiveBodyBody = z.infer<typeof receiveBodySchema>;
export type ReleaseBodyBody = z.infer<typeof releaseBodySchema>;
export type ListQuery = z.infer<typeof listQuerySchema>;
