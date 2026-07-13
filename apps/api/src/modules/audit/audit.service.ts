/**
 * Audit read service (Doc 09 §9).
 *
 * Reading the trail is itself an auditable act — see `recordAudit` at the bottom
 * of `exportTrail`. Anyone who can export "every access to this patient's chart"
 * is holding a compliance instrument, and the question "who has been reading the
 * audit log" is one a security officer is entitled to ask.
 */
import { verifyAuditChain, type VerifyResult } from "../../core/audit/auditChain.js";
import { recordAudit } from "../../core/audit/auditWriter.js";
import * as repo from "./audit.repository.js";
import type { AuditEntryView, AuditFilter, AuditPage } from "./audit.repository.js";

/** A single export must not be able to pull a hospital's entire history into memory. */
const EXPORT_CAP = 10_000;

export async function listAudit(filter: AuditFilter): Promise<AuditPage> {
  return repo.list(filter);
}

export interface ExportResult {
  csv: string;
  rows: number;
  truncated: boolean;
}

export async function exportTrail(
  filter: Omit<AuditFilter, "page" | "limit">,
): Promise<ExportResult> {
  const entries = await repo.listForExport(filter, EXPORT_CAP + 1);
  const truncated = entries.length > EXPORT_CAP;
  const rows = truncated ? entries.slice(0, EXPORT_CAP) : entries;

  await recordAudit({
    action: "audit.exported",
    category: "security",
    resource: "audit",
    meta: { rows: rows.length, truncated, filter: filter as Record<string, unknown> },
  });

  return { csv: toCsv(rows), rows: rows.length, truncated };
}

const COLUMNS = [
  "seq",
  "at",
  "actorEmail",
  "action",
  "category",
  "resource",
  "resourceId",
  "outcome",
  "ip",
  "changes",
] as const;

/**
 * A field starting with `=`, `+`, `-` or `@` is executed as a formula when the
 * CSV is opened in Excel — which is exactly how a compliance export gets opened.
 * Prefixing with an apostrophe neutralizes it without altering the value a human
 * reads. (CSV injection, OWASP.)
 */
function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? "" : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

function toCsv(entries: AuditEntryView[]): string {
  const header = COLUMNS.join(",");
  const lines = entries.map((entry) => {
    const changes = entry.meta?.fields ? (entry.meta.fields as string[]).join(" ") : "";
    return [
      csvCell(entry.seq),
      csvCell(entry.at.toISOString()),
      csvCell(entry.actorEmail ?? entry.actorId ?? "system"),
      csvCell(entry.action),
      csvCell(entry.category),
      csvCell(entry.resource),
      csvCell(entry.resourceId),
      csvCell(entry.outcome),
      csvCell(entry.ip),
      csvCell(changes),
    ].join(",");
  });
  return [header, ...lines].join("\n");
}

/**
 * "Has this trail been tampered with?" — recomputes the whole hash chain.
 *
 * Exposed to hospital admins on purpose. A tamper-evident log whose verification
 * only we can run asks the customer to take our word for it, which is the one
 * thing tamper evidence exists to avoid.
 */
export async function checkIntegrity(): Promise<VerifyResult> {
  return verifyAuditChain();
}

export type { AuditEntryView, AuditFilter, AuditPage };
