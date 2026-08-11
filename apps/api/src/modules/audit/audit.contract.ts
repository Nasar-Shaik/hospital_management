/**
 * Audit response contracts — the trail, and the proof it has not been edited.
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves } from "../../core/http/contract.js";
import { AUDIT_CATEGORIES, AUDIT_OUTCOMES } from "../../core/audit/audit.model.js";
import type { AuditEntryView } from "./audit.repository.js";
import type { VerifyResult } from "../../core/audit/auditChain.js";

export const auditEntry = contract(
  "AuditEntry",
  z.object({
    id: z.string(),
    /** Monotonic per tenant — the ordering the hash chain is built over. */
    seq: z.number(),
    at: z.string(),
    actorId: z.string().optional(),
    actorEmail: z.string().optional(),
    actorRoles: z.array(z.string()).optional(),
    action: z.string(),
    category: z.enum(AUDIT_CATEGORIES),
    resource: z.string(),
    resourceId: z.string().optional(),
    outcome: z.enum(AUDIT_OUTCOMES),
    before: z.record(z.unknown()).optional(),
    after: z.record(z.unknown()).optional(),
    meta: z.record(z.unknown()).optional(),
    ip: z.string().optional(),
    traceId: z.string().optional(),
  }),
);
export type AuditEntryProof = Proves<Matches<typeof auditEntry, AuditEntryView>>;

export const chainProblem = contract(
  "AuditChainProblem",
  z.object({
    anchorIndex: z.number(),
    kind: z.enum([
      "content-tampered",
      "root-mismatch",
      "broken-link",
      "missing-entry",
      "late-insert",
    ]),
    detail: z.string(),
  }),
);

/** The integrity verdict. `ok: false` with an empty `problems` array is not a thing. */
export const auditIntegrity = contract(
  "AuditIntegrity",
  z.object({
    ok: z.boolean(),
    anchors: z.number(),
    entriesVerified: z.number(),
    problems: z.array(chainProblem),
  }),
);
export type AuditIntegrityProof = Proves<Matches<typeof auditIntegrity, VerifyResult>>;
