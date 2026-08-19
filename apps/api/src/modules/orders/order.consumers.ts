/**
 * What happens when a result comes back.
 *
 * ── THIS FILE IS THE RETURN JOURNEY ─────────────────────────────────────────
 * "Reports become available automatically to the requesting doctor" is not a screen
 * and not a notification setting. It is this: the moment a result is released, the
 * doctor who ordered it is told, and the patient who has been sitting in
 * `awaiting_results` becomes callable again.
 *
 * The policy — "a released result earns a message to the ordering doctor" — lives
 * HERE, with the module that owns the event, and never inside the notifications
 * module (PLATFORM_STRATEGY Rule P1). Notifications does not know what a lab is.
 */
import { createLogger } from "@medicore/logger";
import { EVENTS } from "../../core/events/eventCatalog.js";
import { onPatientsMerged } from "../../core/events/patientMerge.js";
import type { DomainEvent, ModuleConsumers } from "../../core/events/consumers.js";
import { getContext } from "../../core/context/requestContext.js";
import { notify } from "../notifications/index.js";
import { getPatient } from "../patients/index.js";
import { getById as getUser } from "../users/index.js";
import { getById as getTenant } from "../tenants/index.js";
import { getEncounter, startConsultation } from "../encounters/index.js";
import { isWaitingOnResults, repointPatient } from "./order.repository.js";
import { getOrder } from "./order.service.js";
import { AWAITED_CATEGORIES } from "./order.model.js";

const logger = createLogger({ service: "order-consumers" });

/**
 * A result was released.
 *
 * Two things follow, and they are independent: the doctor is told, and the patient
 * stops waiting. Either can be true without the other — a doctor gets told about a
 * result that came back after the patient went home, and a patient stops waiting
 * because the LAST of four tests landed, not because this one did.
 */
async function onResultReleased(event: DomainEvent): Promise<void> {
  const orderId = String(event.payload.orderId ?? "");
  const order = await getOrder(orderId);
  if (!order) {
    logger.info({ orderId }, "released order no longer resolvable — nothing sent");
    return;
  }

  /**
   * ── NOT EVERY RELEASED ORDER HAS A RESULT TO TELL ANYONE ABOUT ──────────────
   * The pharmacy clears its worklist by walking the same state machine to `released`
   * (`pharmacy.service.ts`), because there is one machine and pharmacy work is order work
   * (ADR-0013 §3). But "released" there means *the patient has their tablets*, not *a
   * report is ready* — and mailing a doctor "your result is available: Prescription — 2
   * items" is a message about nothing, sent to somebody who never asked a question.
   *
   * A channel that sends noise gets ignored, and this is the same channel that carries a
   * critical potassium. So the notification is scoped to the categories that actually
   * answer a question (`AWAITED_CATEGORIES`), while the patient-flow half below runs for
   * everything — it has its own, separate reason to be careful.
   */
  if (AWAITED_CATEGORIES.includes(order.category)) {
    await tellTheOrderingDoctor(order.id, order.orderedBy, order.patientId, order.name, event);
  } else {
    logger.debug(
      { orderId: order.id, category: order.category },
      "released order carries no result — the ordering doctor is not mailed about it",
    );
  }

  await bringThePatientBack(order.encounterId);
}

/** The report reaches the person who asked the question. */
async function tellTheOrderingDoctor(
  orderId: string,
  orderedBy: string,
  patientId: string,
  testName: string,
  event: DomainEvent,
): Promise<void> {
  const [doctor, patient, tenant] = await Promise.all([
    getUser(orderedBy),
    getPatient(patientId),
    getTenant(getContext().tenantId),
  ]);

  if (!doctor) {
    // The doctor has left the hospital since ordering it. The result is not lost —
    // it is on the encounter, and the next clinician to open the chart will see it.
    logger.info({ orderId, orderedBy }, "ordering doctor no longer exists — no message sent");
    return;
  }

  await notify({
    templateKey: "order.result.released",
    recipient: {
      ...(doctor.email ? { address: doctor.email } : {}),
      name: doctor.name,
      type: "user",
      id: orderedBy,
    },
    data: {
      doctorName: doctor.name,
      patientName: patient?.name ?? "your patient",
      uhid: patient?.uhid ?? "",
      testName,
      hospital: tenant?.hospitalName ?? "",
    },
    // One message per order, not per delivery. At-least-once means this consumer WILL
    // run twice, and a doctor told twice about one result starts ignoring the channel.
    dedupeKey: `order.result.released:${orderId}`,
    /** Where it opens (M4) — the released report itself, not the results list. */
    resource: { type: "order", id: orderId },
    eventId: event.eventId,
  });
}

/**
 * The patient has been sitting in the corridor since the doctor sent them for tests.
 * Can they be called back in?
 *
 * ── ONLY WHEN NOTHING ELSE IS OUTSTANDING ───────────────────────────────────
 * A doctor who orders a CBC, an LFT and a chest X-ray sends the patient away ONCE and
 * expects them back ONCE — when all three have landed. Moving the encounter on the
 * first result would call the patient in to a doctor who still has two blanks in front
 * of them, and the patient would be sent back out to wait again. Do that twice and the
 * waiting room stops believing the queue.
 *
 * So the question is not "did a result arrive" but "is anything still owed", and the
 * answer is a COUNT, not a flag — because a flag would have to be maintained by every
 * path that places or cancels an order, and one of them would eventually forget.
 */
async function bringThePatientBack(encounterId: string): Promise<void> {
  const encounter = await getEncounter(encounterId);
  if (!encounter) return;

  /**
   * The patient is only waiting if the encounter says they are. A visit that has been
   * closed, cancelled, or that the patient left — or one where the doctor is already
   * with them — must not be dragged anywhere by a result landing late.
   *
   * This is the same discipline as the appointment reminder: the event is a trigger,
   * and the database is the truth.
   */
  if (encounter.status !== "awaiting_results") return;

  if (await isWaitingOnResults(encounterId)) {
    logger.debug({ encounterId }, "result released, but other orders are still outstanding");
    return;
  }

  await startConsultation(encounterId);
  logger.info(
    { encounterId },
    "all orders settled — patient is back with the doctor (awaiting_results → in_progress)",
  );
}

export const orderConsumers: ModuleConsumers = {
  events: {
    [EVENTS.RESULT_RELEASED]: onResultReleased,
    [EVENTS.PATIENTS_MERGED]: onPatientsMerged("orders", repointPatient),
  },
  tasks: {},
};
