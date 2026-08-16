/**
 * Turning a department's order queue into the thing a technician actually works from.
 *
 * ── THE UNIT OF WORK IS A PATIENT, NOT A TEST ───────────────────────────────
 * The worklist was one flat list of every outstanding order in the department. That is not how
 * the bench works: one person walks up, one draw is taken, and four tests come off it. A flat
 * list scattered those four rows among everybody else's, so the same patient was re-found four
 * times — reported in manual testing as "I got all orders at a time, which is confusing".
 *
 * ── THE TRIAGE RULE IS NOT RE-IMPLEMENTED HERE ──────────────────────────────
 * The server sorts by `priorityRank` then `orderedAt` and that is the only place that rule lives.
 * Grouping therefore preserves FIRST-APPEARANCE order, which already means "the patient whose
 * most urgent order is oldest". Re-sorting groups here would be a second copy of a triage
 * decision, in a browser, that drifts the first time either side changes.
 *
 * Kept out of the page component because a Next.js page module may only export a default — and
 * because grouping is the part worth testing without a browser.
 */
import type { OrderRow, OrderPriority } from "@medicore/api-client";

/** One person's work in the current tab: what the queue lists, and what selecting one opens. */
export interface PatientGroup {
  patientId: string;
  patientName: string;
  uhid: string;
  orders: OrderRow[];
  /** The most urgent priority anywhere in the group — the badge the queue row wears. */
  topPriority: OrderPriority;
  /** The EARLIEST order in the group: how long this person has actually been waiting. */
  waitingSince: string;
}

/**
 * Mirrors the server's `priorityRank`. Unknown priorities sort last rather than throwing — a
 * priority this build has not heard of is a reason to show the row, not to hide it.
 */
const PRIORITY_RANK: Record<string, number> = { emergency: 0, stat: 1, urgent: 2, routine: 3 };

export function groupByPatient(orders: readonly OrderRow[]): PatientGroup[] {
  const groups: PatientGroup[] = [];
  const byId = new Map<string, PatientGroup>();

  for (const o of orders) {
    let group = byId.get(o.patientId);
    if (!group) {
      group = {
        patientId: o.patientId,
        patientName: o.patientName,
        uhid: o.uhid,
        orders: [],
        topPriority: o.priority,
        waitingSince: o.orderedAt,
      };
      byId.set(o.patientId, group);
      groups.push(group);
    }
    group.orders.push(o);
    if ((PRIORITY_RANK[o.priority] ?? 9) < (PRIORITY_RANK[group.topPriority] ?? 9)) {
      group.topPriority = o.priority;
    }
    if (new Date(o.orderedAt) < new Date(group.waitingSince)) group.waitingSince = o.orderedAt;
  }

  return groups;
}

/**
 * "25 min" / "3 h" / "2 d" — how long the oldest thing in a group has been sitting.
 *
 * Coarse on purpose. A technician needs "this one has been waiting since this morning", not a
 * live-ticking clock: a value that changes every second in a list of forty rows is noise, and an
 * exact age implies a precision the sample's actual collection time does not have.
 */
export function waited(iso: string, now: number = Date.now()): string {
  const mins = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (mins < 60) return `${String(mins)} min`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${String(hours)} h`;
  return `${String(Math.round(hours / 24))} d`;
}
