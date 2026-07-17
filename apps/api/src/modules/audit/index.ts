/**
 * Audit module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5).
 *
 * This module READS the trail. It does not write it: the write path is
 * `core/audit` (the plugin and `recordAudit`), because audit must be
 * infrastructure that no module can opt out of rather than a service other
 * modules choose to call. See `core/audit/audit.model.ts` for why.
 *
 * So there is deliberately no `recordAudit` export here. A module that wants to
 * be audited applies the plugin to its schema; a module with an event that is not
 * a document mutation (a login, a denial) calls `core/audit/auditWriter` directly.
 *
 * Platform module (PLATFORM_STRATEGY §2) — no healthcare vocabulary.
 */
export { auditRouter } from "./audit.routes.js";

export {
  listAudit,
  exportTrail,
  checkIntegrity,
  type AuditEntryView,
  type AuditFilter,
  type AuditPage,
} from "./audit.service.js";
