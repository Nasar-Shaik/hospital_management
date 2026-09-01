/**
 * Problem list response contract.
 *
 * `code` is optional and `title` is not — the shape states the rule the model argues for: every
 * problem is readable at the bedside, and only some of them are coded.
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves } from "../../core/http/contract.js";
import { PROBLEM_STATUSES } from "./problem.model.js";
import type { Problem } from "./problem.repository.js";

export const problem = contract(
  "Problem",
  z.object({
    id: z.string(),
    patientId: z.string(),
    /** An ICD-10 code from this hospital's master, when the problem is coded. */
    code: z.string().optional(),
    title: z.string(),
    status: z.enum(PROBLEM_STATUSES),
    onsetDate: z.string().optional(),
    /** The visit whose diagnosis this was promoted from. Absent when added directly. */
    sourceEncounterId: z.string().optional(),
    notedBy: z.string(),
    notedAt: z.string(),
    resolvedBy: z.string().optional(),
    resolvedAt: z.string().optional(),
    resolvedReason: z.string().optional(),
    /** TENANT-WIDE like an allergy (ADR-0015): provenance only, never a filter. */
    branchId: z.string().optional(),
  }),
);
export type ProblemProof = Proves<Matches<typeof problem, Problem>>;
