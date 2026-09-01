/**
 * Report response contract — METADATA only. The file itself is a binary download.
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves } from "../../core/http/contract.js";
import type { ReportMeta } from "./report.repository.js";

export const reportMeta = contract(
  "ReportMeta",
  z.object({
    id: z.string(),
    orderId: z.string(),
    encounterId: z.string(),
    patientId: z.string(),
    episodeId: z.string(),
    category: z.string(),
    testName: z.string(),
    visitDate: z.string(),
    filename: z.string(),
    contentType: z.string(),
    /** Bytes. */
    size: z.number(),
    uploadedBy: z.string(),
    uploadedAt: z.string(),
  }),
);
export type ReportMetaProof = Proves<Matches<typeof reportMeta, ReportMeta>>;
