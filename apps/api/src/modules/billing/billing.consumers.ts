/**
 * What gets charged, and when.
 *
 * ── WHY BILLING LISTENS INSTEAD OF BEING CALLED ─────────────────────────────
 * `encounters` and `orders` must not know that money exists. If `startEncounter` called
 * `postCharge`, then billing would be upstream of every clinical module, a bug in the
 * tariff could fail a registration, and the dependency graph would have a cycle in it
 * the day billing needed to read an encounter (it does — see `billing.service.ts`).
 *
 * So the arrow points the other way: the clinical modules announce what HAPPENED, and
 * billing decides what that costs. This is what the outbox was built for, and it means
 * a hospital that turns billing off entirely still runs a clinic.
 *
 * The pricing POLICY — "arriving earns a consultation fee, a placed order earns the
 * cost of the test" — lives HERE, with the module that owns money, not scattered
 * through the modules that own care.
 */
import { createLogger } from "@medicore/logger";
import { EVENTS } from "../../core/events/eventCatalog.js";
import type { DomainEvent, ModuleConsumers } from "../../core/events/consumers.js";
import { postCharge, reverseChargesFor } from "./billing.service.js";
import type { ChargeCategory } from "./billing.model.js";

const logger = createLogger({ service: "billing-consumers" });

/** The tariff code for a consultation. Seeded by `seed/tariff.ts`. */
const CONSULTATION_CODE = "CONSULT_GEN";

/**
 * A patient arrived → the consultation fee.
 *
 * Charged on arrival rather than when the doctor calls them in, because that is when a
 * prepaid hospital actually takes the money — at the desk, before the patient sits
 * down. A government hospital posts the same charge at ₹0 (see `postCharge`).
 *
 * Idempotent on the encounter: a redelivered event must not charge a second
 * consultation fee.
 */
async function onEncounterStarted(event: DomainEvent): Promise<void> {
  const encounterId = String(event.payload.encounterId ?? "");
  const patientId = String(event.payload.patientId ?? "");
  const episodeId = String(event.payload.episodeId ?? "");
  if (!encounterId || !patientId || !episodeId) {
    logger.warn({ event: event.eventId }, "encounter.started missing ids — not charged");
    return;
  }

  await postCharge({
    encounterId,
    patientId,
    episodeId,
    code: CONSULTATION_CODE,
    category: "consultation",
    source: "encounter",
    // The encounter IS the cause. One consultation fee per visit, enforced by the
    // unique index on (sourceId, code).
    sourceId: encounterId,
    ...(typeof event.branchId === "string" ? { branchId: event.branchId } : {}),
  });
}

/** Maps an order's category onto a charge category. Lab and radiology bill differently. */
function chargeCategoryFor(orderCategory: string): ChargeCategory {
  switch (orderCategory) {
    case "lab":
      return "lab";
    case "radiology":
      return "radiology";
    case "pharmacy":
      return "pharmacy";
    case "procedure":
      return "procedure";
    default:
      return "other";
  }
}

/**
 * A test was ordered → the cost of the test.
 *
 * Charged at PLACEMENT, not at release. The hospital has committed the reagent and the
 * technician's time the moment the order reaches the bench; a patient who leaves before
 * collecting the report has still consumed it. Cancelling before the work starts
 * reverses it (`onOrderCancelled`), which is exactly the window the order state machine
 * allows a cancellation in.
 */
async function onOrderPlaced(event: DomainEvent): Promise<void> {
  const orderId = String(event.payload.orderId ?? "");
  const encounterId = String(event.payload.encounterId ?? "");
  const patientId = String(event.payload.patientId ?? "");
  const episodeId = String(event.payload.episodeId ?? "");
  const code = String(event.payload.code ?? "");
  if (!orderId || !encounterId || !code) {
    logger.warn({ event: event.eventId }, "order.placed missing ids — not charged");
    return;
  }

  await postCharge({
    encounterId,
    patientId,
    episodeId,
    code,
    description: String(event.payload.name ?? code),
    category: chargeCategoryFor(String(event.payload.category ?? "")),
    source: "order",
    sourceId: orderId,
    ...(typeof event.branchId === "string" ? { branchId: event.branchId } : {}),
  });
}

/**
 * An order was cancelled → un-bill it.
 *
 * The order state machine only permits cancellation BEFORE the work starts
 * (`placed`/`accepted` → `cancelled`), so nothing has been consumed and the patient
 * must not pay. A charge that survives its cancelled order is the single most common
 * complaint at a hospital billing counter, and it is always the software's fault.
 *
 * Reversal is a void flag, never a delete — money that vanishes cannot be audited.
 * Idempotent: voiding an already-voided charge changes nothing, and at-least-once
 * delivery guarantees this runs twice.
 */
async function onOrderCancelled(event: DomainEvent): Promise<void> {
  const orderId = String(event.payload.orderId ?? "");
  if (!orderId) return;

  const voided = await reverseChargesFor(
    orderId,
    `order cancelled: ${String(event.payload.reason ?? "no reason given")}`,
  );

  if (voided > 0) logger.info({ orderId, voided }, "charges reversed for a cancelled order");
}

export const billingConsumers: ModuleConsumers = {
  events: {
    [EVENTS.ENCOUNTER_STARTED]: onEncounterStarted,
    [EVENTS.ORDER_PLACED]: onOrderPlaced,
    [EVENTS.ORDER_CANCELLED]: onOrderCancelled,
  },
  tasks: {},
};
