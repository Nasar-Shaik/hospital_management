/**
 * How a signed prescription reaches the pharmacy counter.
 *
 * ── THIS IS THE HAND-OFF, AND IT IS THE WHOLE POINT OF THE FILE ─────────────
 * "The pharmacist sees what the doctor prescribed" is not a screen and not a query
 * somebody remembered to write. It is this: signing publishes an event, the event places
 * a `pharmacy` ORDER, and the pharmacy's worklist is a query over orders — the same
 * query, over the same collection, that the lab's worklist is (ADR-0013 §3). No paper, no
 * phone call, and no "send to pharmacy" button for anyone to forget to press.
 *
 * ── WHY AN ORDER AND NOT JUST THE PRESCRIPTION ──────────────────────────────
 * Because otherwise the pharmacy is the one department in the hospital with a bespoke
 * worklist. PHARMACIST already holds `order:read` and `order:perform` and holds no
 * prescription-specific permission at all — the role was defined on the assumption that
 * pharmacy work is order work, and this file is where that assumption is honoured or
 * quietly abandoned.
 *
 * The division is: the ORDER carries the work (who must do something, is it done), the
 * PRESCRIPTION carries the clinical content (which drug, what dose, by what route). An
 * order cannot express a dose; a prescription cannot express a queue.
 */
import { createLogger } from "@medicore/logger";
import { EVENTS } from "../../core/events/eventCatalog.js";
import { onPatientsMerged } from "../../core/events/patientMerge.js";
import type { DomainEvent, ModuleConsumers } from "../../core/events/consumers.js";
import { cancelOrder, getOrder, placeOrder } from "../orders/index.js";
import * as repo from "./prescription.repository.js";
import { dispensesInHouse } from "./prescription.service.js";

const logger = createLogger({ service: "prescription-consumers" });

/**
 * The order code for "hand these drugs over".
 *
 * ONE order per prescription, not one per drug: the pharmacist deals with the
 * prescription as a single piece of paper, and eight order rows for eight drugs would be
 * eight worklist items to work and clear for one patient standing at one counter.
 *
 * It is deliberately NOT a drug code, and there is deliberately no tariff entry for it —
 * `billing.consumers.ts` skips `pharmacy` orders entirely, because what costs money is
 * the dispense, not the request. See `MEDICATION_DISPENSED`.
 */
const RX_ORDER_CODE = "RX";

/**
 * A prescription was signed → put it on the pharmacy's counter.
 *
 * ── THE POLICY SWITCH THAT MAKES THIS RIGHT FOR A CLINIC ────────────────────
 * `encounterPolicy.pharmacy` (ADR-0013 §5, the fifth switch). A clinic sends patients to
 * the chemist next door: it produces this event, and correctly produces NO order. There
 * is no work for a pharmacy that does not exist, and a worklist item nobody can ever
 * action is worse than no worklist at all — it is a permanent false backlog.
 *
 * This is a POLICY read, not a branch on `organizationType`. Nothing here knows what kind
 * of hospital it is running in, and `organizations.test.ts` greps for exactly that.
 *
 * Idempotent: at-least-once delivery guarantees this runs twice, and `requestId` makes
 * the second run return the order the first one placed rather than raise a second.
 */
async function onPrescriptionSigned(event: DomainEvent): Promise<void> {
  const prescriptionId = String(event.payload.prescriptionId ?? "");
  const encounterId = String(event.payload.encounterId ?? "");
  const prescribedBy = String(event.payload.prescribedBy ?? "");
  const itemCount = Number(event.payload.itemCount ?? 0);

  if (!prescriptionId || !encounterId) {
    logger.warn({ event: event.eventId }, "prescription.signed missing ids — no pharmacy order");
    return;
  }

  if (!(await dispensesInHouse())) {
    logger.info(
      { prescriptionId },
      "external pharmacy — the patient takes the prescription elsewhere; no order raised",
    );
    return;
  }

  const { order, duplicate } = await placeOrder({
    encounterId,
    category: "pharmacy",
    code: RX_ORDER_CODE,
    name: `Prescription — ${String(itemCount)} item${itemCount === 1 ? "" : "s"}`,
    // The pharmacist reads a queue, not a chart. `routine` is honest: a drug that must be
    // given NOW is given on the ward from the emergency box, not fetched from a worklist.
    priority: "routine",
    // One order per prescription, however many times this event is delivered.
    requestId: `rx:${prescriptionId}`,
    // The prescriber, NOT the relay. A consumer has no user of its own, and the pharmacist
    // must be able to see whose authority the drugs are leaving the shelf on.
    ...(prescribedBy ? { orderedBy: prescribedBy } : {}),
    ...(typeof event.branchId === "string" ? { branchId: event.branchId } : {}),
  });

  /**
   * Link the order back to the prescription it carries.
   *
   * Written on every delivery, including the duplicate: if the first delivery placed the
   * order and then died before writing this, the prescription would be signed, the order
   * would exist, and nothing would connect them — the pharmacist would have a worklist
   * item with no drugs on it. Re-writing the same id is a no-op; not writing it is a
   * broken counter.
   */
  await repo.setOrderId(prescriptionId, order.id);

  logger.info(
    { prescriptionId, orderId: order.id, duplicate },
    duplicate
      ? "pharmacy order already existed for this prescription — not raised twice"
      : "prescription is on the pharmacy counter",
  );
}

/**
 * The doctor stopped it → take the work off the counter.
 *
 * ── A CANCELLATION THAT ARRIVES TOO LATE IS NOT AN ERROR ────────────────────
 * The order state machine only permits cancellation before the work starts. If the
 * pharmacist has already begun dispensing, this throws — and it MUST NOT be retried,
 * because it will never succeed and the queue would poison itself on a job that is
 * asking for something that is no longer possible.
 *
 * That is not a lost message. The drugs already handed over are unaffected by design
 * (STATE_MACHINE_CATALOG §6): the prescription is `cancelled`, so the pharmacist cannot
 * dispense any MORE against it (`isDispensable`), and the ones already given are in the
 * patient. The counter is stopped by the prescription's own status; the order row is
 * bookkeeping that has already been overtaken by events.
 */
async function onPrescriptionCancelled(event: DomainEvent): Promise<void> {
  const orderId = String(event.payload.orderId ?? "");
  const prescriptionId = String(event.payload.prescriptionId ?? "");
  if (!orderId) return;

  const order = await getOrder(orderId);
  if (!order) return;

  // Already dead — a redelivery, or the pharmacist cancelled it themselves.
  if (order.status === "cancelled") return;

  if (order.status !== "placed" && order.status !== "accepted") {
    logger.info(
      { prescriptionId, orderId, status: order.status },
      "prescription cancelled after dispensing began — the order stands; the prescription's own status stops any further handover",
    );
    return;
  }

  await cancelOrder(orderId, `prescription cancelled: ${String(event.payload.reason ?? "")}`);
  logger.info(
    { prescriptionId, orderId },
    "pharmacy order withdrawn — the drugs are not to be given",
  );
}

export const prescriptionConsumers: ModuleConsumers = {
  events: {
    [EVENTS.PRESCRIPTION_SIGNED]: onPrescriptionSigned,
    [EVENTS.PRESCRIPTION_CANCELLED]: onPrescriptionCancelled,
    [EVENTS.PATIENTS_MERGED]: onPatientsMerged("prescriptions", repo.repointPatient),
  },
  tasks: {},
};
