/**
 * Order service (ADR-0013 §3, STATE_MACHINE_CATALOG §15).
 *
 * ── WHAT THIS MODULE IS FOR ─────────────────────────────────────────────────
 * "Doctor orders appear automatically in the destination department; reports become
 * available automatically to the requesting doctor."
 *
 * That sentence is the whole product requirement, and it is NOT a queue feature and
 * NOT a screen. It is a lifecycle:
 *
 *   place   → the order commits, and the lab's worklist is a QUERY over these rows,
 *             so the work is in the lab the instant it exists. No hand-off step, and
 *             therefore no hand-off step for anyone to forget.
 *   release → the result reaches the doctor who asked for it, and the patient parked
 *             in `awaiting_results` becomes actionable again.
 *
 * The hospital's paper equivalent of this file is a person walking a chit down a
 * corridor, and everything that goes wrong in an OPD goes wrong on that walk.
 */
import { createLogger } from "@medicore/logger";
import { AppError } from "../../core/errors/appError.js";
import { getContext, getTenantDb } from "../../core/context/requestContext.js";
import { writeBranchId } from "../../core/context/activeBranch.js";
import { withTransaction } from "../../core/db/transaction.js";
import { tenantSchemaReadiness } from "../../core/db/schemaReadiness.js";
import type { ClinicalCapability } from "../../core/db/clinicalInvariants.js";
import { publish } from "../../core/events/outbox.js";
import { EVENTS } from "../../core/events/eventCatalog.js";
import {
  getEncounter,
  isOpen,
  recordOrderPlaced,
  recordOrderCancelled,
} from "../encounters/index.js";
import { getPatient, namesByIds } from "../patients/index.js";
import { notify } from "../notifications/index.js";
import { isFeatureEnabled } from "../entitlements/index.js";
import { getById as getUser } from "../users/index.js";
import { getById as getTenant } from "../tenants/index.js";
import * as repo from "./order.repository.js";
import { verifyAuthorityFor } from "./order.authority.js";
import { featureForCategory } from "./order.entitlement.js";
import {
  canTransition,
  type OrderCategory,
  type OrderPriority,
  type OrderResultValue,
  type OrderStatus,
} from "./order.model.js";

const logger = createLogger({ service: "orders" });

export type { Order } from "./order.repository.js";

export interface PlaceOrderInput {
  encounterId: string;
  category: OrderCategory;
  code: string;
  name: string;
  priority?: OrderPriority;
  notes?: string;
  departmentId?: string;
  requestId?: string;
  branchId?: string;
  /**
   * Who asked for this. Defaults to the authenticated caller, which is what every HTTP
   * request wants and the only thing an HTTP request can get.
   *
   * ── THIS IS SERVICE-ONLY, AND IT MUST STAY THAT WAY ─────────────────────────
   * `placeOrderSchema` does not declare this field, and `validate()` replaces `req.body`
   * with Zod's output — which strips undeclared keys. So a client cannot set it, and the
   * "the orderer is the authenticated caller, never the body" rule still holds for every
   * route. If anyone ever adds `orderedBy` to that schema, they hand any doctor the
   * ability to order tests in a colleague's name and receive none of the results.
   *
   * The one legitimate caller is a CONSUMER, which has no user of its own: the pharmacy
   * order raised from `prescription.signed` belongs to the doctor who signed it, and
   * without this it would decay to "system" — losing the prescriber on the very object
   * the pharmacist uses to check who authorised the drugs.
   */
  orderedBy?: string;
}

export interface PlaceOrderResult {
  order: repo.Order;
  /** True when this `requestId` had already placed the order — a retry, not a new one. */
  duplicate: boolean;
}

export interface CompleteOrderInput {
  summary?: string;
  values?: OrderResultValue[];
  /** A value that can kill the patient today. Raises the alert SYNCHRONOUSLY. */
  critical?: boolean;
}

function invalidTransition(from: OrderStatus, to: OrderStatus): AppError {
  return new AppError("HMS-STATE-001", 422, "Invalid state transition", {
    from,
    to,
    allowed: "see STATE_MACHINE_CATALOG §15",
  });
}

/**
 * The capabilities placing an order rests on. ONE — and the omission is the point.
 *
 * ── WHY NOT `idempotent-replay` TOO, AS MAR AND DISPENSING BOTH REQUIRE ─────
 * Two locks stand between a retry and a second order: the `Idempotency-Key` claim (index 0048)
 * and `one_order_per_request_id` (index 0013). MAR and dispensing each have a class of
 * LEGITIMATE write that carries no module identifier — a PRN dose has no `scheduledFor`, a
 * partial handover has no `requestId` — so for those writes the header claim is the only lock and
 * its index must be sound. Ordering has no such class: `orderRequests` (mobile) and the web
 * OrderPad both put the same string in the header AND in `requestId`, and the one non-HTTP caller
 * sets `requestId: "rx:<prescriptionId>"` explicitly.
 *
 * So losing 0048 alone leaves every order write still arbitrated by 0013, and refusing to order
 * because of it would block a hospital that is demonstrably still safe. Losing 0013 is different,
 * and worse than it looks — see below.
 */
const ORDER_REQUIRES: readonly ClinicalCapability[] = ["ordering"];

/**
 * ── THE ARBITER MUST EXIST BEFORE WE RELY ON IT ─────────────────────────────
 * `placeOrder` performs NO read-before-write. It goes straight into the transaction and inserts,
 * and the `catch` below only consults `findByRequestId` AFTER the database has said E11000. The
 * index is therefore the sole race arbiter, exactly as `order.repository.ts` states. Without it
 * the insert simply succeeds twice: a second tube of blood from a real arm, a second exposure for
 * an X-ray, and a second bill — measured, not assumed (two rows, no error).
 *
 * ── AND THE CONSUMER PATH HAS NOTHING ELSE AT ALL ───────────────────────────
 * `prescription.signed` raises the pharmacy order through this same function, with a `requestId`
 * and NO HTTP request — so no `Idempotency-Key` middleware exists on that path to fall back on.
 * Delivery is at-least-once by design and the handler's own comment says it will run twice. With
 * 0013 gone, every redelivery puts another identical row on the pharmacy counter, and
 * `setOrderId` repoints the prescription at the newest one, orphaning the rest as work that can
 * never be completed.
 *
 * ── AND IT CANNOT BE UNDONE BY REBUILDING ───────────────────────────────────
 * Once two rows share a `requestId`, recreating the index is refused (E11000 — measured). The
 * repair is a destructive delete, which Constitution §3.9 does not permit casually. Refusing is
 * recoverable in the minutes it takes to run the migration; drift is not.
 *
 * Placed before the encounter read purely so the refusal is the FIRST thing the caller hears; the
 * read itself is harmless and its position is not a safety claim.
 */
async function assertOrderingIsSafe(): Promise<void> {
  const ctx = getContext();
  const readiness = await tenantSchemaReadiness(ctx.tenantId, getTenantDb(), ORDER_REQUIRES);
  if (readiness.safe) return;

  throw new AppError(
    "HMS-ORD-001",
    503,
    "Ordering is unavailable on this system — order on paper and escalate",
    {
      // Named, not counted: whoever is paged needs the rule and the migration, not a number.
      missing: readiness.missing.map((m) => ({
        rule: m.invariant.rule,
        migration: m.invariant.migration,
        found: m.found,
      })),
      ...(readiness.unknown ? { unknown: readiness.unknown } : {}),
    },
    true,
    // A minute: the readiness verdict is re-checked on that cadence anyway, so retrying sooner
    // cannot produce a different answer.
    60,
  );
}

/**
 * Did this hospital buy this KIND of work?
 *
 * ── PLACING ONLY, FOR THE SAME REASON THE READINESS GUARD IS ────────────────
 * Guarded here and nowhere in the state machine, exactly like `assertOrderingIsSafe` above and for
 * the same clinical reason, stated there: a transition updates a row that already exists. If a
 * hospital's RIS entitlement lapses on the day a patient is halfway through a CT, blocking
 * `complete` strands a scan that has already been performed — the dose is delivered, the image
 * exists, and the only thing refusing achieves is that the doctor never sees it. An expired
 * subscription is a commercial problem and must never be allowed to become a clinical one.
 *
 * Reads are not guarded either, and it is the same argument once more: a record already created
 * must stay readable. A hospital that stops paying for imaging does not thereby lose the right to
 * see last year's chest X-ray, and a product that hid it would be destroying a medical record
 * over an invoice.
 *
 * So the entitlement stops NEW work starting — the one point at which refusing costs nobody
 * anything.
 */
async function assertCategoryIsSold(category: OrderCategory): Promise<void> {
  const feature = featureForCategory(category);
  if (!feature) return;

  const ctx = getContext();
  if (await isFeatureEnabled(ctx.tenantId, feature)) return;

  // HMS-PLAN-002 — the same code and shape `authorize({ feature })` raises, so a client that
  // already knows how to say "not in your edition" needs no second case. Mobile reads exactly this
  // code to hide a module rather than report a fault (`queue.tsx`).
  throw new AppError("HMS-PLAN-002", 403, "Feature not in your edition", {
    feature,
    category,
    hint: `ordering ${category} needs the ${feature} module`,
  });
}

/**
 * A doctor asks for something.
 *
 * ── AN ORDER REQUIRES AN OPEN ENCOUNTER ─────────────────────────────────────
 * Not merely an encounter that exists — one the patient is still ON. Ordering a test
 * against a closed visit produces work nobody is expecting, for a patient who has
 * gone home, billed to a visit that has already been settled. If a doctor genuinely
 * needs a further test, the patient has come back, and coming back is a new
 * encounter in the same episode — which is exactly what an Episode of Care is for.
 */
export async function placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
  /**
   * Only PLACING is guarded. The state machine below (accept → start → complete → verify →
   * release, and cancel) updates a row that already exists and rests on nothing this invariant
   * provides — so a drifted tenant can still finish the work already on its benches, which is
   * exactly what you want while somebody runs the migration. Blocking those would strand samples
   * mid-analysis for a rule that has no bearing on them.
   */
  await assertOrderingIsSafe();
  await assertCategoryIsSold(input.category);

  const encounter = await getEncounter(input.encounterId);
  if (!encounter) {
    throw new AppError("HMS-GEN-404", 404, "Encounter not found", {
      encounterId: input.encounterId,
    });
  }
  if (!isOpen(encounter.status)) {
    throw new AppError("HMS-STATE-001", 422, "Cannot order against a closed visit", {
      encounterId: encounter.id,
      status: encounter.status,
      hint: "the patient has left — a further test means a new encounter in the same episode",
    });
  }

  const priority: OrderPriority = input.priority ?? "routine";

  /**
   * The branch, by the same rule as `patientId` below: an order happens where its encounter
   * is. A caller MAY name one explicitly, but only one they can actually reach —
   * `writeBranchId` refuses anything outside their allowed set (HMS-AUTH-005). Before that
   * check existed, `input.branchId ?? encounter.branchId` let a branch-confined user file an
   * order into a site they cannot see.
   */
  const branchId = input.branchId ? await writeBranchId(input.branchId) : encounter.branchId;

  try {
    return await withTransaction(async (session) => {
      const order = await repo.create(
        {
          encounterId: encounter.id,
          // Taken from the ENCOUNTER, never from the request body. A caller that could
          // name the patient could attach a test to somebody else's chart.
          patientId: encounter.patientId,
          episodeId: encounter.episodeId,
          category: input.category,
          code: input.code,
          name: input.name,
          priority,
          ...(input.notes ? { notes: input.notes } : {}),
          ...(input.departmentId ? { departmentId: input.departmentId } : {}),
          ...(input.requestId ? { requestId: input.requestId } : {}),
          ...(input.orderedBy ? { orderedBy: input.orderedBy } : {}),
          ...(branchId ? { branchId } : {}),
        },
        session,
      );

      /**
       * Count this test on the visit, in the SAME transaction as the order. This is what lets
       * "send for tests" refuse an empty investigations visit the instant after the order is
       * placed — an event consumer would not have caught up yet. Only genuinely new orders reach
       * here; a duplicate `requestId` throws below and never counts twice.
       */
      await recordOrderPlaced(encounter.id, session);

      /**
       * THIS is the hand-off. Published in the SAME transaction as the order, so the
       * lab cannot be told about work that was never committed, and work cannot be
       * committed that the lab is never told about.
       */
      await publish(
        {
          name: EVENTS.ORDER_PLACED,
          payload: {
            orderId: order.id,
            encounterId: order.encounterId,
            patientId: order.patientId,
            episodeId: order.episodeId,
            category: order.category,
            code: order.code,
            name: order.name,
            priority: order.priority,
            orderedBy: order.orderedBy,
            ...(order.departmentId ? { departmentId: order.departmentId } : {}),
          },
          ...(order.branchId ? { branchId: order.branchId } : {}),
        },
        session,
      );

      return { order, duplicate: false };
    });
  } catch (err) {
    if (!repo.isDuplicateKey(err) || !input.requestId) throw err;

    /**
     * The same `requestId` has been used before: a double-click, or a retry after a
     * timeout on a request that had in fact succeeded. Hand back the order that
     * exists.
     *
     * The alternative — a second order — draws a second tube of blood from a real
     * arm and raises a second bill for it. The index is the arbiter rather than a
     * prior read, because the retry and the original can be in flight together.
     */
    const existing = await repo.findByRequestId(input.requestId);
    if (!existing) throw err;

    logger.info(
      { orderId: existing.id, requestId: input.requestId },
      "order already placed with this requestId — returning it rather than ordering twice",
    );
    return { order: existing, duplicate: true };
  }
}

/** The single door through which an order changes state. */
async function transition(
  id: string,
  to: OrderStatus,
  opts: { reason?: string; alsoSet?: Record<string, unknown> } = {},
): Promise<repo.Order> {
  const ctx = getContext();

  return withTransaction(async (session) => {
    const current = await repo.findById(id);
    if (!current) throw new AppError("HMS-GEN-404", 404, "Order not found", { id });
    if (!canTransition(current.status, to)) throw invalidTransition(current.status, to);

    const updated = await repo.setStatus(
      id,
      to,
      {
        from: current.status,
        to,
        at: new Date(),
        ...(ctx.userId ? { by: ctx.userId } : {}),
        ...(opts.reason ? { reason: opts.reason } : {}),
      },
      session,
      opts.alsoSet ?? {},
    );
    if (!updated) throw new AppError("HMS-GEN-404", 404, "Order not found", { id });

    if (to === "cancelled") {
      // The test is no longer live — take it off the visit's count, in the same transaction as the
      // cancellation, so "send for tests" reflects it immediately (and a visit whose every order was
      // cancelled is correctly blocked again).
      await recordOrderCancelled(updated.encounterId, session);

      await publish(
        {
          name: EVENTS.ORDER_CANCELLED,
          payload: {
            orderId: updated.id,
            encounterId: updated.encounterId,
            patientId: updated.patientId,
            category: updated.category,
            ...(opts.reason ? { reason: opts.reason } : {}),
          },
          ...(updated.branchId ? { branchId: updated.branchId } : {}),
        },
        session,
      );
    }

    /**
     * Published in the SAME transaction as the result it describes — so there can
     * never be a critical value in the database with no record that it was flagged,
     * nor a flag for a result that rolled back.
     *
     * The ALERT itself does not travel this path; it has already been sent inline by
     * the time anyone consumes this (see `raiseCriticalAlert`). This event is the
     * audit trail and the fan-out.
     */
    if (to === "completed" && updated.result?.critical) {
      await publish(
        {
          name: EVENTS.CRITICAL_RESULT_FLAGGED,
          payload: {
            orderId: updated.id,
            encounterId: updated.encounterId,
            patientId: updated.patientId,
            category: updated.category,
            code: updated.code,
            name: updated.name,
            orderedBy: updated.orderedBy,
          },
          ...(updated.branchId ? { branchId: updated.branchId } : {}),
        },
        session,
      );
    }

    if (to === "released") {
      /**
       * The return half of the spine. Consumed by `order.consumers.ts`, which tells
       * the ordering doctor and — if nothing else is outstanding — brings the patient
       * out of `awaiting_results`.
       */
      await publish(
        {
          name: EVENTS.RESULT_RELEASED,
          payload: {
            orderId: updated.id,
            encounterId: updated.encounterId,
            patientId: updated.patientId,
            category: updated.category,
            code: updated.code,
            name: updated.name,
            orderedBy: updated.orderedBy,
            ...(updated.result?.critical ? { critical: true } : {}),
          },
          ...(updated.branchId ? { branchId: updated.branchId } : {}),
        },
        session,
      );
    }

    return updated;
  });
}

/** The department picks the work up. */
export const acceptOrder = (id: string): Promise<repo.Order> => transition(id, "accepted");

/** The technician starts it — the sample is on the bench. */
export const startOrder = (id: string): Promise<repo.Order> =>
  transition(id, "in_progress", {
    alsoSet: { ...(getContext().userId ? { performedBy: getContext().userId } : {}) },
  });

/**
 * The work is done and the result is recorded.
 *
 * ── THE CRITICAL VALUE IS ALERTED HERE, NOT AT RELEASE ──────────────────────
 * A potassium of 7.2 stops the heart. It does not wait for a pathologist to come back
 * from lunch and sign the report, and neither does the alert: the warning is raised
 * the moment the number exists, BEFORE verification and long before release.
 *
 * That is not a shortcut around the second pair of eyes — the result still cannot be
 * RELEASED unverified. It is the recognition that "this number is being reviewed" and
 * "somebody must be told right now" are different clocks, and only one of them is the
 * patient's.
 */
export async function completeOrder(id: string, input: CompleteOrderInput): Promise<repo.Order> {
  const ctx = getContext();

  const order = await transition(id, "completed", {
    alsoSet: {
      completedAt: new Date(),
      ...(ctx.userId ? { performedBy: ctx.userId } : {}),
      result: {
        ...(input.summary ? { summary: input.summary } : {}),
        ...(input.values ? { values: input.values } : {}),
        ...(input.critical ? { critical: true } : {}),
      },
    },
  });

  if (input.critical) await raiseCriticalAlert(order);

  return order;
}

/**
 * A number that can kill the patient today.
 *
 * ── WHY THIS IS NOT AN EVENT ────────────────────────────────────────────────
 * Every other message in this system goes through the outbox, and rightly: durable,
 * retried, survives a crash. But durable and FAST are different promises. The relay
 * polls; the queue has a backlog; a consumer is retrying someone else's email. Any of
 * that is fine for a welcome message and unconscionable for a potassium of 7.2.
 *
 * So the alert is sent INLINE, in the request that recorded the result, and the
 * clinician is told before the API call returns. `CRITICAL_RESULT_FLAGGED` is still
 * published afterwards — but as the AUDIT TRAIL and the fan-out, not as the warning.
 *
 * ── AND WHY A FAILURE HERE DOES NOT ROLL BACK THE RESULT ────────────────────
 * If the alert cannot be delivered, the result must still be saved. Throwing would
 * discard a correctly-measured critical value because we could not tell anyone about
 * it — which leaves the number nowhere at all, and the patient with neither the alert
 * nor the record. We log loudly, and the event remains as the durable path.
 */
async function raiseCriticalAlert(order: repo.Order): Promise<void> {
  const ctx = getContext();

  try {
    const [doctor, patient, tenant] = await Promise.all([
      getUser(order.orderedBy),
      getPatient(order.patientId),
      getTenant(ctx.tenantId),
    ]);

    const outcome = await notify({
      templateKey: "order.critical",
      recipient: {
        ...(doctor?.email ? { address: doctor.email } : {}),
        ...(doctor?.name ? { name: doctor.name } : {}),
        type: "user",
        id: order.orderedBy,
      },
      data: {
        doctorName: doctor?.name ?? "Doctor",
        patientName: patient?.name ?? "the patient",
        uhid: patient?.uhid ?? "",
        testName: order.name,
        result: order.result?.summary ?? summarise(order.result?.values),
        hospital: tenant?.hospitalName ?? "",
      },
      // One alert per order, however many times anything retries.
      dedupeKey: `order.critical:${order.id}`,
      /**
       * WHERE the alert opens (M4). "A critical result" is not a destination; order 64b7… is —
       * and the doctor who is being asked to act in the next few minutes should arrive at the
       * value, not at a list to search. The kind is a string because the notifications module is
       * not allowed to know what an order is (Rule P1); each client maps it to its own screen.
       */
      resource: { type: "order", id: order.id },
      ...(order.branchId ? { branchId: order.branchId } : {}),
    });

    /**
     * ── `notify` REPORTS FAILURE; IT DOES NOT THROW IT ──────────────────────
     * A missing template, an unreachable doctor, a suppressed channel — every one of
     * those comes back as an OUTCOME, not an exception. An earlier version of this
     * function had a bare `try/catch` around the call and logged "alert raised
     * synchronously" on the happy path, which meant a critical potassium whose
     * template did not exist was recorded in the log as SUCCESSFULLY ALERTED.
     *
     * That is worse than not logging at all. A silent failure you know about is an
     * incident; a silent failure that files a success report is a post-mortem in
     * which nobody can work out why the doctor says they were never told.
     *
     * `duplicate` is a success: the alert was already sent for this order.
     */
    if (outcome !== "sent" && outcome !== "duplicate") {
      logger.error(
        { orderId: order.id, patientId: order.patientId, orderedBy: order.orderedBy, outcome },
        "CRITICAL result alert WAS NOT DELIVERED — the result is saved; escalate by phone NOW",
      );
      return;
    }

    logger.warn(
      { orderId: order.id, patientId: order.patientId, orderedBy: order.orderedBy, outcome },
      "CRITICAL result — alert raised synchronously",
    );
  } catch (err) {
    /**
     * Loudly, and then carry on.
     *
     * Throwing here would roll back a correctly-measured critical value because we
     * could not announce it — leaving the number nowhere at all, and the patient with
     * neither the alert NOR the record. The result is the more important of the two,
     * and `CRITICAL_RESULT_FLAGGED` (already committed with it) remains as the
     * durable path.
     */
    logger.error(
      { err, orderId: order.id, tenantId: ctx.tenantId },
      "CRITICAL result alert FAILED TO SEND — the result is saved; escalate by phone",
    );
  }
}

function summarise(values?: OrderResultValue[]): string {
  if (!values?.length) return "see report";
  return values
    .map((v) => `${v.label}: ${v.value}${v.unit ? ` ${v.unit}` : ""}`)
    .slice(0, 5)
    .join(", ");
}

/**
 * A second pair of eyes signs the result off.
 *
 * ── THE CATEGORY AUTHORITY CHECK ────────────────────────────────────────────
 * `order:verify` alone is not enough. A pathologist holds it, and so does a
 * radiologist — and neither of them can read the other's work. The extra permission
 * required is the one that says they are competent in THIS category
 * (`order.authority.ts`). A signature from someone who cannot read the result is not
 * a check; it is a formality with a name attached.
 */
export async function verifyOrder(id: string): Promise<repo.Order> {
  const ctx = getContext();

  const order = await repo.findById(id);
  if (!order) throw new AppError("HMS-GEN-404", 404, "Order not found", { id });

  const required = verifyAuthorityFor(order.category);
  if (required && !(ctx.permissions ?? []).includes(required.code)) {
    throw new AppError("HMS-AUTH-005", 403, "Insufficient permission", {
      category: order.category,
      required: required.code,
      hint: `verifying a ${order.category} result requires ${required.code} — a specialist in that category`,
    });
  }

  return transition(id, "verified", {
    alsoSet: {
      verifiedAt: new Date(),
      ...(ctx.userId ? { verifiedBy: ctx.userId } : {}),
    },
  });
}

/**
 * The result becomes visible to the doctor who ordered it.
 *
 * Separate from `verify` because a result can be clinically correct and still not
 * ready to be seen: an HIV result is given with counselling, not by a portal
 * notification at 2am. Verification is a clinical act; release is a disclosure.
 */
export const releaseOrder = (id: string): Promise<repo.Order> =>
  transition(id, "released", { alsoSet: { releasedAt: new Date() } });

/** Called off. Only before the work starts — see TRANSITIONS. */
export const cancelOrder = (id: string, reason: string): Promise<repo.Order> =>
  transition(id, "cancelled", { reason, alsoSet: { cancelReason: reason } });

export const getOrder = (id: string): Promise<repo.Order | undefined> => repo.findById(id);
/** A worklist row: the order, plus who it is for. */
export interface OrderRow extends repo.Order {
  /** `Unknown patient` when the record cannot be read — never silently blank. */
  patientName: string;
  /** Empty only when the patient record itself carries none. */
  uhid: string;
}

/**
 * A page of orders, each carrying its patient's identity.
 *
 * ── WHY IDENTITY IS RESOLVED HERE AND NOT BY THE CALLER ─────────────────────
 * The web worklist used to fetch "the first 100 patients in the hospital" and look each order's
 * patient up in that array. Two silent truncations sat on top of each other: an order past the
 * 100th row never appeared, and an order whose patient was not among the first 100 patients
 * rendered as "—". Both failed toward *less* work being visible, which on a lab queue means a
 * sample nobody runs, and neither said anything was missing.
 *
 * `InpatientRow` already carries its name for the same reason, and says so: "a client must never
 * reconstruct it from a patient list." This is that rule applied to the second list that was
 * doing it. One extra query per page, however long the page.
 */
export async function listOrders(
  filter: repo.ListOrdersFilter,
): Promise<{ items: OrderRow[]; total: number }> {
  const { items, total } = await repo.list(filter);
  if (items.length === 0) return { items: [], total };

  const named = await namesByIds([...new Set(items.map((o) => o.patientId))]);
  const byId = new Map(named.map((p) => [p.id, p]));

  return {
    items: items.map((o) => {
      const p = byId.get(o.patientId);
      return { ...o, patientName: p?.name ?? "Unknown patient", uhid: p?.uhid ?? "" };
    }),
    total,
  };
}

export const isWaitingOnResults = repo.isWaitingOnResults;

/** The diagnostics register for a period — used by the reporting module. */
export const diagnosticsReport = repo.diagnosticsReport;
