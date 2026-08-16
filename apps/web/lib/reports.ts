/**
 * Presenting a patient's uploaded reports to the doctor.
 *
 * ── ONE ROW PER TEST, NOT PER FILE ──────────────────────────────────────────
 * A report is attached to an ORDER, and an order can legitimately end up with more than one file:
 * a blurred scan re-shot, a corrected page, a second view. The list rendered one row per FILE with
 * the test name on each, so four tests that had been uploaded twice looked exactly like seven
 * different tests — which is how manual testing found it ("the doctor ordered 4, the lab completed
 * 4, why does the doctor see multiple?").
 *
 * Grouping by `orderId` answers that honestly: the doctor sees the four tests they ordered, and the
 * extra files sit UNDER the test they belong to, newest first, still individually openable. Nothing
 * is hidden — a second file may be the corrected one, and deciding which to show would be this
 * browser silently picking a clinical document.
 */
import type { ReportMeta } from "@medicore/api-client";

/** One test, with every file attached to it. */
export interface ReportGroup {
  orderId: string;
  testName: string;
  category: string;
  /** Newest upload first — the correction is usually the one that came second. */
  files: ReportMeta[];
}

/**
 * Reports → one entry per order, preserving the order the server sent them in (newest visit first,
 * then newest upload — `report.repository.ts`). Files with no order to group under keep their own
 * row rather than being merged with anything else.
 */
export function groupReportsByOrder(reports: readonly ReportMeta[]): ReportGroup[] {
  const groups: ReportGroup[] = [];
  const byOrder = new Map<string, ReportGroup>();

  for (const r of reports) {
    let group = byOrder.get(r.orderId);
    if (!group) {
      group = { orderId: r.orderId, testName: r.testName, category: r.category, files: [] };
      byOrder.set(r.orderId, group);
      groups.push(group);
    }
    group.files.push(r);
  }

  for (const group of groups) {
    group.files.sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());
  }

  return groups;
}
