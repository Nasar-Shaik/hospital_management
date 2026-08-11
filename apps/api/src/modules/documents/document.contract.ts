/**
 * Document response contract — METADATA only. The bytes are fetched from the file route.
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves } from "../../core/http/contract.js";
import { DOCUMENT_CATEGORIES } from "./document.model.js";
import type { DocumentMeta } from "./document.repository.js";

export const documentMeta = contract(
  "DocumentMeta",
  z.object({
    id: z.string(),
    patientId: z.string(),
    encounterId: z.string().optional(),
    category: z.enum(DOCUMENT_CATEGORIES),
    title: z.string(),
    filename: z.string(),
    contentType: z.string(),
    /** Bytes. */
    size: z.number(),
    uploadedBy: z.string(),
    uploadedAt: z.string(),
  }),
);
export type DocumentMetaProof = Proves<Matches<typeof documentMeta, DocumentMeta>>;

export const documentDeletedAck = contract(
  "DocumentDeletedAck",
  z.object({ id: z.string(), deleted: z.literal(true) }),
);
