/**
 * Audit query DTOs (Doc 09 §5/§6).
 */
import { z } from "@medicore/validation";
import { AUDIT_CATEGORIES, AUDIT_OUTCOMES } from "../../core/audit/audit.model.js";

export const listAuditSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    // Capped at 100 like every other list on the platform (Doc 09 §4).
    limit: z.coerce.number().int().min(1).max(100).default(25),
    category: z.enum(AUDIT_CATEGORIES).optional(),
    action: z.string().max(80).optional(),
    actorId: z.string().max(64).optional(),
    resource: z.string().max(64).optional(),
    resourceId: z.string().max(64).optional(),
    outcome: z.enum(AUDIT_OUTCOMES).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .strict();

export const exportAuditSchema = listAuditSchema.omit({ page: true, limit: true });
