/**
 * Orders and their results — what may be shown, and what must be shouted about.
 *
 * ── A RESULT IS NOT VISIBLE UNTIL IT IS RELEASED ────────────────────────────
 * `completed` means the machine produced a number. `verified` means a second person checked it.
 * `released` means it may reach the person who will act on it (STATE_MACHINE_CATALOG §15). The web
 * app enforces exactly this, and it is the whole reason the ladder has three rungs — a phone that
 * rendered `result` the moment the field appeared would leak an unverified potassium onto a ward
 * round and quietly delete the second pair of eyes.
 *
 * ── "CRITICAL" IS THE SERVER'S WORD, NEVER THIS FILE'S ──────────────────────
 * `order.result.critical` is set when the result was recorded, and per-value `flag` strings come
 * from the lab. Nothing here compares a number to a range: a client-side panic rule would be a
 * second clinical opinion that no pathologist signed off, and it would disagree with the alert the
 * server already raised synchronously to the ordering doctor.
 */
import type { Order, OrderCategory, OrderPriority, OrderStatus } from "@medicore/api-client";
import type { ClinicalTone } from "./encounters";

const STATUS_LABEL: Record<OrderStatus, string> = {
  placed: "Ordered",
  accepted: "Accepted",
  in_progress: "In progress",
  completed: "Awaiting verification",
  verified: "Awaiting release",
  released: "Result ready",
  cancelled: "Cancelled",
};

/**
 * `completed` and `verified` deliberately read as what the DOCTOR is waiting for rather than as
 * what the lab has done. "Completed" on a doctor's screen means "there is a number for me", and
 * there is not one yet — that wording is how somebody stops chasing a result that has not landed.
 */
export function orderStatusLabel(status: OrderStatus): string {
  return STATUS_LABEL[status];
}

export function orderStatusTone(status: OrderStatus): ClinicalTone {
  if (status === "released") return "done";
  if (status === "cancelled") return "neutral";
  return "waiting";
}

const CATEGORY_LABEL: Record<OrderCategory, string> = {
  lab: "Laboratory",
  radiology: "Imaging",
  pharmacy: "Pharmacy",
  procedure: "Procedure",
  referral: "Referral",
  admission: "Admission",
  diet: "Diet",
};

export function orderCategoryLabel(category: OrderCategory): string {
  return CATEGORY_LABEL[category];
}

const PRIORITY_LABEL: Record<OrderPriority, string> = {
  routine: "Routine",
  urgent: "Urgent",
  stat: "STAT",
  emergency: "Emergency",
};

export function orderPriorityLabel(priority: OrderPriority): string {
  return PRIORITY_LABEL[priority];
}

export function orderPriorityTone(priority: OrderPriority): ClinicalTone {
  if (priority === "stat" || priority === "emergency") return "critical";
  if (priority === "urgent") return "warning";
  return "neutral";
}

/** True once the result may be read by a clinician. The single gate; every screen asks it. */
export function isResultReadable(order: Pick<Order, "status" | "result">): boolean {
  return order.status === "released" && order.result !== undefined;
}

/**
 * True when the SERVER marked this result critical AND it has been released.
 *
 * Both halves matter. A critical flag on an unreleased order is a result the verifying pathologist
 * has not signed off, and putting a red banner on it would push a clinician to act on a number
 * nobody has confirmed — while also making it impossible to tell, at a glance, which reds are real.
 */
export function isCriticalResult(order: Pick<Order, "status" | "result">): boolean {
  return isResultReadable(order) && order.result?.critical === true;
}

/**
 * Still outstanding — asked for, nothing back yet.
 *
 * `released` and `cancelled` are the only endings. Everything between is work the doctor is waiting
 * on, which is what an "outstanding" count on a home screen has to mean for it to be worth glancing
 * at. This is the same shape as the API's own `outstanding=true` filter, kept here for counting a
 * page that has already been fetched.
 */
export function isOutstanding(order: Pick<Order, "status">): boolean {
  return order.status !== "released" && order.status !== "cancelled";
}

/**
 * Is this individual value one the lab flagged?
 *
 * The web app tests `flag?.startsWith("critical")`, so the wire carries strings like
 * `critical_high`. Matched the same way, and case-insensitively, because a `flag` is a free string
 * on the contract (`flag?: string`) rather than an enum — a lab that sends `CRITICAL_LOW` must not
 * lose its highlight over an uppercase letter.
 */
export function isCriticalValue(flag: string | undefined): boolean {
  return flag !== undefined && flag.toLowerCase().startsWith("critical");
}

export function valueTone(flag: string | undefined): ClinicalTone {
  if (isCriticalValue(flag)) return "critical";
  return flag && flag.toLowerCase() !== "normal" ? "warning" : "neutral";
}

export interface ResultSummary {
  outstanding: number;
  /** Released results the server marked critical — the only number worth a badge. */
  critical: number;
}

export function summariseResults(orders: readonly Order[]): ResultSummary {
  let outstanding = 0;
  let critical = 0;
  for (const order of orders) {
    if (isOutstanding(order)) outstanding += 1;
    if (isCriticalResult(order)) critical += 1;
  }
  return { outstanding, critical };
}

/**
 * The order a results list is read in: critical first, then everything still outstanding, then the
 * rest — and newest first inside each band.
 *
 * A strictly chronological list buries a panic value from this morning under six routine results
 * that came back since. That is the failure this ordering exists to prevent, and it is why the
 * bands are not a filter the user has to discover.
 */
export function sortForReview(orders: readonly Order[]): Order[] {
  const band = (order: Order): number =>
    isCriticalResult(order) ? 0 : isOutstanding(order) ? 1 : 2;
  return [...orders].sort((a, b) => {
    const byBand = band(a) - band(b);
    if (byBand !== 0) return byBand;
    return b.orderedAt.localeCompare(a.orderedAt);
  });
}
