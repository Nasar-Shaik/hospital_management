/**
 * Order — THE SPINE THAT CARRIES WORK BETWEEN DEPARTMENTS
 * (ADR-0013 §3, STATE_MACHINE_CATALOG §15).
 *
 * ── ONE OBJECT, NOT SEVEN ───────────────────────────────────────────────────
 * A lab test, a scan, a drug, a procedure, a referral, an admission and a diet are
 * the same thing from the system's point of view: a doctor asked for something, some
 * department has to do it, and the answer has to come back to the person who asked.
 * The lifecycle is identical; only the DESTINATION differs.
 *
 * Seven separate order tables would mean seven state machines to keep in step, seven
 * worklists, and seven chances to forget the one that tells the doctor their result
 * is ready. It would also make a universal work queue (ADR-0014) impossible to build,
 * because there would be nothing common to project FROM.
 *
 * ── ORDERS HANG OFF THE ENCOUNTER, NEVER OFF A NOTE ─────────────────────────
 * `encounterId` is required and immutable. An order is a REQUEST FOR WORK, and
 * documentation is not the thing that requests work: the order must survive a note
 * being amended, and must exist where there is no note at all. A diagnostic centre
 * performing a walk-in scan on an outside prescription has orders and no
 * consultation — and it is one of our six target organization types.
 *
 * ── WHAT MAKES WORK "APPEAR AUTOMATICALLY" IN THE DESTINATION DEPARTMENT ────
 * Nothing in this file. It is the `order.placed` event (see order.service.ts): the
 * lab's worklist is a QUERY over these rows, so an order is in the lab the instant it
 * is committed. There is no hand-off step, and therefore no hand-off step to forget.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { tenantScopePlugin } from "../../core/db/plugins/tenantScope.js";
import { auditPlugin } from "../../core/db/plugins/auditPlugin.js";

/**
 * The destination. This is the ONLY thing that differs between orders, and it is
 * data — not a subclass, not a table, and above all not a code branch.
 */
export const ORDER_CATEGORIES = [
  "lab",
  "radiology",
  "pharmacy",
  "procedure",
  "referral",
  "admission",
  "diet",
] as const;
export type OrderCategory = (typeof ORDER_CATEGORIES)[number];

/**
 * How fast. `stat` means the same thing at the lab bench as it does at the doctor's
 * door, which is exactly why the priority lives on the shared object.
 */
export const ORDER_PRIORITIES = ["routine", "urgent", "stat", "emergency"] as const;
export type OrderPriority = (typeof ORDER_PRIORITIES)[number];

/**
 * The sort key of every worklist in the hospital. DERIVED from `priority` on write —
 * never set by hand, exactly like `encounters.open`.
 *
 * ── WHY A NUMBER AND NOT THE WORD ───────────────────────────────────────────
 * Sorting the words alphabetically gives: emergency, routine, stat, urgent. The
 * `routine` order sorts ABOVE the `stat` one, and a lab that works its list from the
 * top does the routine cholesterol before the emergency troponin. It looks like a
 * sorted list, it is sorted, and it is lethal — which is precisely the kind of bug
 * that survives a code review and gets caught by a coroner.
 */
const PRIORITY_RANK: Record<OrderPriority, number> = {
  emergency: 0,
  stat: 1,
  urgent: 2,
  routine: 3,
};

export function rankOf(priority: OrderPriority): number {
  return PRIORITY_RANK[priority];
}

export const ORDER_STATUSES = [
  "placed",
  "accepted",
  "in_progress",
  "completed",
  "verified",
  "released",
  "cancelled",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * STATE_MACHINE_CATALOG §15, verbatim.
 *
 * ── THE TWO EDGES THAT ARE LOAD-BEARING ─────────────────────────────────────
 * `completed → verified` is a SECOND PAIR OF EYES. The technician who ran the test
 * cannot be the one who certifies it. Collapsing these two states would let an
 * unverified result reach the doctor who acts on it, and people die of that.
 *
 * `verified → released` is separate because a result can be clinically correct and
 * still not ready to be seen — an HIV result is given with counselling, not by a
 * portal notification at 2am. Verification is a clinical act; release is a
 * disclosure, and they are not the same decision.
 *
 * ── THE EDGE THAT IS DELIBERATELY ABSENT ────────────────────────────────────
 * There is NO `in_progress → cancelled`. Once the sample is in the analyser the work
 * has been done and the specimen consumed; letting the order vanish would silently
 * discard a real, billable, already-drawn sample and leave the lab holding a tube for
 * an order that no longer exists. Cancel before it starts, or see it through.
 */
export const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  placed: ["accepted", "cancelled"],
  accepted: ["in_progress", "cancelled"],
  in_progress: ["completed"],
  completed: ["verified"],
  verified: ["released"],

  // Terminal.
  released: [],
  cancelled: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Is this order still owed to somebody?
 *
 * The patient parked in `awaiting_results` cannot be brought back to the doctor until
 * every order raised on their encounter has landed. This predicate is what decides
 * that (see `order.consumers.ts`), so it is not a display concern — it is the
 * condition under which a waiting patient is finally called back in.
 */
const SETTLED: readonly OrderStatus[] = ["released", "cancelled"];
export function isOutstanding(status: OrderStatus): boolean {
  return !SETTLED.includes(status);
}

/**
 * The categories whose completion the ORDERING DOCTOR IS WAITING FOR.
 *
 * ── WHY THIS IS NOT "ALL OF THEM" ───────────────────────────────────────────
 * A patient parked in `awaiting_results` is called back in when nothing is outstanding
 * (`order.consumers.ts`). "Outstanding" cannot mean every category, because the pharmacy
 * is DOWNSTREAM of the consultation ending: the patient collects their drugs on the way
 * out, and if an uncollected prescription counted as outstanding, then the CBC coming back
 * would never bring the patient back to the doctor. They would sit in the corridor until
 * somebody noticed, and the cause — a prescription — would be the last place anyone
 * looked.
 *
 * The same is true of `referral`, `admission` and `diet`: each of them IS an outcome of
 * the consultation, not something the consultation is waiting on. A doctor does not sit
 * with a blank in front of them waiting for a diet order to be actioned.
 *
 * `procedure` IS included. A dressing or a nebulisation is a thing the patient goes away
 * and comes back from, and the doctor may well be waiting to see the result of it. Where
 * a category is genuinely ambiguous, include it: calling the patient in too early sends
 * them back out to wait again, and a waiting room that gets called twice stops believing
 * the queue.
 */
export const AWAITED_CATEGORIES: readonly OrderCategory[] = ["lab", "radiology", "procedure"];

export interface OrderResultValue {
  code: string;
  label: string;
  value: string;
  unit?: string;
  referenceRange?: string;
  /** `low | high | critical_low | critical_high | normal` — the analyser's own flag. */
  flag?: string;
}

export interface OrderHistoryEntry {
  from: OrderStatus;
  to: OrderStatus;
  at: Date;
  by?: string;
  reason?: string;
}

export interface OrderDoc {
  _id: Types.ObjectId;
  tenantId: string;
  branchId?: string;

  /**
   * The visit this was ordered during. REQUIRED — an order with no encounter is work
   * nobody can bill, attribute, or hand back to a doctor.
   */
  encounterId: Types.ObjectId;
  /**
   * Denormalized from the encounter, and worth the duplication.
   *
   * The lab must know whose sample is on the bench without joining through a visit,
   * and the order OUTLIVES the encounter: results come back after the patient has
   * gone home and the encounter has closed. A patientId that had to be fetched
   * through a closed encounter is a patientId the lab will eventually get wrong.
   */
  patientId: Types.ObjectId;
  /** The care story (ADR-0013 §4), so the admission inherits the OP's investigations. */
  episodeId: Types.ObjectId;

  category: OrderCategory;
  /** The catalogue code — `CBC`, `XRAY_CHEST_PA`. Free text until a service master exists. */
  code: string;
  /** What a human calls it. Denormalized so a renamed catalogue never rewrites history. */
  name: string;

  priority: OrderPriority;
  /** Derived from `priority` — see `rankOf`. The sort key every worklist orders by. */
  priorityRank: number;
  status: OrderStatus;

  /** Why the doctor wants it — the clinical question the test is meant to answer. */
  notes?: string;

  /** The doctor who asked. The result comes back to THIS person (RESULT_RELEASED). */
  orderedBy: string;
  orderedAt: Date;

  /** Which department is doing it, when the hospital routes by department. */
  departmentId?: string;

  performedBy?: string;
  completedAt?: Date;
  verifiedBy?: string;
  verifiedAt?: Date;
  releasedAt?: Date;

  result?: {
    summary?: string;
    values?: OrderResultValue[];
    /**
     * A value that can kill the patient today.
     *
     * When this is true the alert is raised SYNCHRONOUSLY, in the call that recorded
     * the result — not through the outbox. See `order.service.ts`.
     */
    critical?: boolean;
  };

  cancelReason?: string;

  /**
   * Client-supplied idempotency key. Optional, unique when present (migration 0013).
   *
   * A doctor double-clicking "Order CBC" must not draw two tubes of blood and raise
   * two bills. A retry after a timeout must not either — and the retry is the case a
   * disabled button cannot help with, because the first request may well have
   * succeeded before the connection dropped.
   */
  requestId?: string;

  history: OrderHistoryEntry[];
  createdAt: Date;
  updatedAt: Date;
}

const orderSchema = new Schema<OrderDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String, required: true },

    encounterId: { type: Schema.Types.ObjectId, required: true },
    patientId: { type: Schema.Types.ObjectId, required: true },
    episodeId: { type: Schema.Types.ObjectId, required: true },

    category: { type: String, enum: ORDER_CATEGORIES, required: true },
    code: { type: String, required: true, trim: true, maxlength: 64 },
    name: { type: String, required: true, trim: true, maxlength: 200 },

    priority: { type: String, enum: ORDER_PRIORITIES, required: true, default: "routine" },
    // Derived, never passed in. See `rankOf` for why the word cannot be the sort key.
    priorityRank: { type: Number, required: true, default: PRIORITY_RANK.routine },
    status: { type: String, enum: ORDER_STATUSES, required: true, default: "placed" },

    notes: { type: String, trim: true, maxlength: 1000 },

    orderedBy: { type: String, required: true },
    orderedAt: { type: Date, required: true },

    departmentId: { type: String },

    performedBy: { type: String },
    completedAt: { type: Date },
    verifiedBy: { type: String },
    verifiedAt: { type: Date },
    releasedAt: { type: Date },

    result: {
      _id: false,
      type: {
        summary: { type: String, trim: true, maxlength: 5000 },
        values: [
          {
            _id: false,
            code: { type: String, required: true },
            label: { type: String, required: true },
            value: { type: String, required: true },
            unit: { type: String },
            referenceRange: { type: String },
            flag: { type: String },
          },
        ],
        critical: { type: Boolean },
      },
      required: false,
    },

    cancelReason: { type: String, trim: true, maxlength: 500 },

    requestId: { type: String },

    history: [
      {
        _id: false,
        from: { type: String, required: true },
        to: { type: String, required: true },
        at: { type: Date, required: true },
        by: { type: String },
        reason: { type: String },
      },
    ],
  },
  { timestamps: true, collection: "orders", autoIndex: false },
);

orderSchema.plugin(tenantScopePlugin);
/**
 * PHI, and among the most sensitive of it. WHAT a doctor ordered is a diagnosis they
 * have not written down yet: an HIV test, a beta-hCG, a psychiatric referral. The
 * order list leaks the suspicion even when the result is negative.
 *
 * `result` is excluded from the audit diff for the same reason the notification body
 * is — the audit log is a record that access happened, not a second copy of the
 * clinical record with weaker access controls in front of it.
 */
orderSchema.plugin(auditPlugin, {
  resource: "order",
  category: "phi",
  ignore: ["result", "history"],
});

export function getOrderModel(conn: Connection): Model<OrderDoc> {
  return (conn.models.Order as Model<OrderDoc>) ?? conn.model<OrderDoc>("Order", orderSchema);
}
