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
import { calendarDaysStarted } from "../../core/time/day.js";
import { branchZone } from "../branches/index.js";
import { EVENTS } from "../../core/events/eventCatalog.js";
import { onPatientsMerged } from "../../core/events/patientMerge.js";
import type { DomainEvent, ModuleConsumers } from "../../core/events/consumers.js";
import { consultationFollowUp, postCharge, reverseChargesFor } from "./billing.service.js";
import { repointPatient } from "./billing.repository.js";
import type { ChargeCategory } from "./billing.model.js";
// A pricing INPUT: the doctor's own consultation fee. Read through the users module's public
// face, so billing prices per-doctor without any clinical module knowing money exists.
import { getById as getUserById } from "../users/index.js";

const logger = createLogger({ service: "billing-consumers" });

/** The tariff code for a consultation. Seeded by `seed/tariff.ts`. */
const CONSULTATION_CODE = "CONSULT_GEN";

/**
 * The surcharge for a paid fast-track (express) OP visit. A SEPARATE line from the consultation
 * itself, so the bill and the collections report show the express upgrade for what it is rather
 * than hiding it inside a larger consult fee. Zero-tariff still flattens it to ₹0 in `postCharge`.
 */
const EXPRESS_CODE = "CONSULT_EXPRESS";

/**
 * When the event says it happened, falling back to now if the stamp is unusable.
 *
 * The follow-up window is judged against THIS, not `new Date()`: at-least-once delivery means a
 * retry hours later must reach the same verdict as the first attempt, or a visit could be charged
 * on one delivery and waived on the next.
 */
function eventTime(event: DomainEvent): Date {
  const at = new Date(event.occurredAt);
  return Number.isNaN(at.getTime()) ? new Date() : at;
}

/** `12 Jul 2026` — the date a waiver quotes back on the bill, so the patient can check it. */
function formatDay(date: Date): string {
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/**
 * A patient arrived → the consultation fee.
 *
 * Charged on arrival rather than when the doctor calls them in, because that is when a
 * prepaid hospital actually takes the money — at the desk, before the patient sits
 * down. A government hospital posts the same charge at ₹0 (see `postCharge`).
 *
 * ── PER-DOCTOR PRICING, WITHOUT A CODE PER DOCTOR ───────────────────────────
 * The line stays `CONSULT_GEN` — one consultation code the invoice and reports already
 * understand — but its PRICE can come from the doctor. When the doctor carries a
 * `consultationFee` on their staff profile, that overrides the tariff for this visit; when
 * they do not, the hospital's flat consultation tariff applies unchanged. Reading the fee
 * here (rather than baking it into the event) keeps the pricing decision in the module that
 * owns money, and `getById` is a public read on the users module — no clinical module learns
 * that a consultation has a price. The zero-tariff policy still flattens it to ₹0 in
 * `postCharge`, because free care is a billing MODE, not a doctor's choice.
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

  const doctorId = typeof event.payload.doctorId === "string" ? event.payload.doctorId : undefined;
  const fee = doctorId ? await doctorConsultationFee(doctorId) : undefined;

  /**
   * ── FREE FOLLOW-UP WITHIN THE TARIFF'S VALIDITY ("OP validity") ─────────────
   * A patient revisiting the SAME doctor inside the window their last PAID consultation bought
   * is not charged again. The visit is still registered, still charged, and still invoiced — at
   * ₹0, with the reason and the origin window written into the line.
   *
   * Posting a ₹0 line rather than posting nothing is the load-bearing choice. It keeps the
   * consultation on the bill (so the record shows the patient was seen and what it was worth),
   * it keeps `one_charge_per_cause` idempotency intact, and — because reception's pay gate
   * already reads a ₹0 consultation as `free` — the follow-up patient walks straight to the
   * doctor's queue with no cash-counter detour and no new gate logic anywhere.
   *
   * `event.occurredAt` (not `new Date()`) anchors the window so a redelivered event judges the
   * same instant and cannot flip a visit from charged to free hours later.
   */
  const waiver =
    doctorId !== undefined
      ? await consultationFollowUp({
          patientId,
          doctorId,
          code: CONSULTATION_CODE,
          at: eventTime(event),
        }).catch((err: unknown) => {
          // Never let a pricing lookup fail a registration — charge the ordinary fee instead.
          logger.warn({ encounterId, err }, "follow-up check failed — charging the normal fee");
          return undefined;
        })
      : undefined;

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
    ...(doctorId ? { doctorId } : {}),
    ...(waiver
      ? {
          unitPrice: 0,
          description: `Consultation — free follow-up (within ${String(waiver.days)} days of ${formatDay(waiver.since)})`,
        }
      : // The doctor's own rate when they set one; otherwise postCharge falls back to the tariff.
        fee !== undefined
        ? { unitPrice: fee }
        : {}),
    ...(typeof event.branchId === "string" ? { branchId: event.branchId } : {}),
  });

  if (waiver) {
    logger.info(
      { encounterId, doctorId, originChargeId: waiver.originChargeId, days: waiver.days },
      "consultation waived — revisit inside the follow-up window",
    );
  }

  /**
   * A paid fast-track visit earns an express surcharge, on its own line. Same idempotency as the
   * consultation — the code differs, so `(sourceId=encounterId, code=CONSULT_EXPRESS)` is a second
   * unique key on the same encounter and a redelivered event never charges it twice. A missing
   * `CONSULT_EXPRESS` tariff posts at ₹0 with a warning rather than blocking the visit (postCharge).
   */
  if (event.payload.express === true) {
    await postCharge({
      encounterId,
      patientId,
      episodeId,
      code: EXPRESS_CODE,
      category: "consultation",
      source: "encounter",
      sourceId: encounterId,
      ...(typeof event.branchId === "string" ? { branchId: event.branchId } : {}),
    });
  }
}

/**
 * The doctor's own consultation fee, or undefined to fall back to the tariff.
 *
 * A missing doctor, or a doctor who never set a fee, is not an error — it is the ordinary
 * "use the hospital rate" case, so this swallows a lookup miss into undefined rather than
 * failing a registration over a pricing read.
 */
async function doctorConsultationFee(doctorId: string): Promise<number | undefined> {
  try {
    const doctor = await getUserById(doctorId);
    const fee = doctor?.profile?.consultationFee;
    return typeof fee === "number" && fee >= 0 ? fee : undefined;
  } catch (err) {
    logger.warn({ doctorId, err }, "could not read doctor consultation fee — using the tariff");
    return undefined;
  }
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

  /**
   * ── A PRESCRIPTION IS A REQUEST; ONLY A DISPENSE IS A CONSUMPTION ───────────
   * Pharmacy orders are the one category NOT charged at placement, and the exception is
   * not a special case — it is the rule applied honestly. Placing a lab order commits the
   * reagent; signing a prescription commits nothing. The drugs are still on the shelf.
   *
   * Charging here would bill the patient the moment the doctor signed, which is wrong in
   * three ordinary situations: they never walk to the counter, the pharmacy has only six
   * of the ten tablets, or they take the prescription to a chemist down the road and buy
   * it from somebody else entirely. In all three the hospital has supplied nothing.
   *
   * So the drug is charged by `onMedicationDispensed`, for the quantity that actually
   * crossed the counter. This early return is load-bearing: the `RX` order carries no
   * drug code and has no tariff entry, so without it every signed prescription would post
   * a silent ₹0 charge (`postCharge` prices an unknown code at zero) — a line item on a
   * private hospital's bill, for nothing, at the wrong time.
   */
  if (event.payload.category === "pharmacy") {
    logger.debug(
      { orderId },
      "pharmacy order — not charged at placement; the drugs are charged when they are dispensed",
    );
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

/** One handed-over drug, as `medication.dispensed` carries it. */
interface DispensedLine {
  drugCode: string;
  drugName: string;
  quantity: number;
}

function toDispensedLines(raw: unknown): DispensedLine[] {
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const line = entry as Record<string, unknown>;

    const drugCode = String(line.drugCode ?? "");
    const quantity = Number(line.quantity ?? 0);
    // A line with no code cannot be priced, and a line with no quantity is not a
    // handover. Skipping is right: the drugs are already with the patient, and throwing
    // would retry this event forever over a payload that will never improve.
    if (!drugCode || !Number.isFinite(quantity) || quantity <= 0) return [];

    return [{ drugCode, drugName: String(line.drugName ?? drugCode), quantity }];
  });
}

/**
 * Drugs left the counter → charge for what was actually handed over.
 *
 * ── THE CHARGE IS KEYED ON THE DISPENSE, NEVER ON THE PRESCRIPTION ──────────
 * `one_charge_per_cause` (migration 0014) is unique on `(sourceId, code)`. A prescription
 * dispensed in two visits — six tablets today, four on Thursday, which is every pharmacy
 * that has ever run out of anything — produces two chargeable events for the SAME drug
 * code. Keyed on the prescription, the index would accept the first and silently swallow
 * the second: the patient receives ten tablets, pays for six, and no error is reported
 * anywhere. Keyed on the dispense, each handover is its own cause and each is billed once,
 * however many times the event is redelivered.
 *
 * A government hospital posts all of this at ₹0 with `listPrice` intact, through the same
 * single line in `postCharge` — free to the patient, and still costed for the state.
 */
async function onMedicationDispensed(event: DomainEvent): Promise<void> {
  const dispenseId = String(event.payload.dispenseId ?? "");
  const encounterId = String(event.payload.encounterId ?? "");
  const patientId = String(event.payload.patientId ?? "");
  const episodeId = String(event.payload.episodeId ?? "");
  const lines = toDispensedLines(event.payload.lines);

  if (!dispenseId || !encounterId || lines.length === 0) {
    logger.warn(
      { event: event.eventId, dispenseId },
      "medication.dispensed carries no billable lines — nothing charged",
    );
    return;
  }

  for (const line of lines) {
    await postCharge({
      encounterId,
      patientId,
      episodeId,
      code: line.drugCode,
      description: line.drugName,
      category: "pharmacy",
      // What crossed the counter — NOT what was prescribed. The gap between those two is
      // the patient who was given six of their ten tablets.
      quantity: line.quantity,
      source: "pharmacy",
      // THE DISPENSE is the cause. See above for why this must not be the prescription.
      sourceId: dispenseId,
      ...(typeof event.branchId === "string" ? { branchId: event.branchId } : {}),
    });
  }

  logger.info({ dispenseId, lines: lines.length }, "dispensed drugs charged to the visit");
}

/**
 * The bed, billed by the day.
 *
 * ── ONE CHARGE PER NIGHT, KEYED ON THE NIGHT ────────────────────────────────
 * `one_charge_per_cause` (migration 0014) is unique on `(sourceId, code)`. Keyed on the
 * encounter, a five-day stay in `BED_GEN` could post exactly ONE bed-day: the first would
 * succeed and the other four would be silently swallowed as duplicates. The hospital would
 * bill ₹1,500 for a week in a ward and never see an error — the same trap that keying the
 * drug charge on the prescription would have set, and it is here for the same reason.
 *
 * So the CAUSE is the night: `<encounterId>:night:3`. Each night is its own row, billed
 * exactly once however many times this runs.
 *
 * ── WHICH MAKES THIS FUNCTION SAFE TO CALL AT ANY TIME, REPEATEDLY ──────────
 * It posts every night from admission to `until` and lets the index reject the ones
 * already there. So admission calls it (night 1 exists immediately — the family asking for
 * an interim bill on day three must not be told the stay is free), discharge calls it (the
 * rest land), and the nightly job this hospital does not have yet can call it too, with no
 * new code and no reconciliation step. Re-running it is a no-op, which is the only
 * property that makes an at-least-once queue survivable.
 */
async function chargeBedDays(input: {
  encounterId: string;
  patientId: string;
  episodeId: string;
  tariffCode: string;
  admittedAt: Date;
  until: Date;
  branchId?: string;
}): Promise<void> {
  /**
   * ── THE NIGHT IS THE SITE'S NIGHT, NOT THE HEAD OFFICE'S (D3) ─────────────
   * "One calendar day started" only means anything against a particular calendar, and this used
   * `env.DEFAULT_TIMEZONE` while already holding the `branchId` it uses for the charge itself. A
   * ward in another zone therefore had its midnights imported from head office: a twelve-hour
   * evening stay that crosses the ward's midnight but not the default's was billed one night
   * instead of two, on every such admission, always in the direction of undercharging.
   *
   * `calendarDaysStarted` itself was never wrong — it counts day KEYS, so a 23-hour DST day
   * cannot round a stay down. It was being handed the wrong calendar.
   *
   * Nothing moves for a site whose zone IS the hospital default, which is every single-site
   * hospital: `branchZone` returns the same string and the arithmetic is identical.
   */
  const nights = calendarDaysStarted(
    input.admittedAt,
    input.until,
    await branchZone(input.branchId),
  );

  for (let night = 1; night <= nights; night++) {
    await postCharge({
      encounterId: input.encounterId,
      patientId: input.patientId,
      episodeId: input.episodeId,
      code: input.tariffCode,
      category: "bed",
      quantity: 1,
      source: "bed",
      // THE NIGHT is the cause. Never the encounter — see above.
      sourceId: `${input.encounterId}:night:${String(night)}`,
      ...(input.branchId ? { branchId: input.branchId } : {}),
    });
  }

  logger.info(
    { encounterId: input.encounterId, nights, code: input.tariffCode },
    "bed-days charged up to date (already-posted nights are skipped by the index)",
  );
}

/** Parses the ids and the bed off an admission/discharge event. */
function bedContextOf(event: DomainEvent):
  | {
      encounterId: string;
      patientId: string;
      episodeId: string;
      tariffCode: string;
      admittedAt: Date;
      branchId?: string;
    }
  | undefined {
  const encounterId = String(event.payload.encounterId ?? "");
  const patientId = String(event.payload.patientId ?? "");
  const episodeId = String(event.payload.episodeId ?? "");
  const tariffCode = String(event.payload.tariffCode ?? "");
  const admittedAtRaw = String(event.payload.admittedAt ?? "");

  if (!encounterId || !patientId || !tariffCode || !admittedAtRaw) return undefined;

  const admittedAt = new Date(admittedAtRaw);
  if (Number.isNaN(admittedAt.getTime())) return undefined;

  return {
    encounterId,
    patientId,
    episodeId,
    tariffCode,
    admittedAt,
    ...(typeof event.branchId === "string" ? { branchId: event.branchId } : {}),
  };
}

/** A patient took a bed → charge the first night, now. */
async function onPatientAdmitted(event: DomainEvent): Promise<void> {
  const ctx = bedContextOf(event);
  if (!ctx) {
    logger.warn({ event: event.eventId }, "patient.admitted missing bed context — not charged");
    return;
  }

  await chargeBedDays({ ...ctx, until: ctx.admittedAt });
}

/**
 * The patient went home → charge every night not yet charged.
 *
 * `dischargedAt` is the clock's other end, and it comes from the event rather than from
 * `new Date()`: a redelivery an hour later must bill the same stay, not a longer one.
 */
async function onPatientDischarged(event: DomainEvent): Promise<void> {
  const ctx = bedContextOf(event);
  if (!ctx) {
    logger.warn({ event: event.eventId }, "patient.discharged missing bed context — not charged");
    return;
  }

  const dischargedAt = new Date(String(event.payload.dischargedAt ?? ""));
  if (Number.isNaN(dischargedAt.getTime())) {
    logger.warn({ event: event.eventId }, "patient.discharged has no valid dischargedAt");
    return;
  }

  await chargeBedDays({ ...ctx, until: dischargedAt });
}

export const billingConsumers: ModuleConsumers = {
  events: {
    [EVENTS.ENCOUNTER_STARTED]: onEncounterStarted,
    [EVENTS.ORDER_PLACED]: onOrderPlaced,
    [EVENTS.ORDER_CANCELLED]: onOrderCancelled,
    [EVENTS.MEDICATION_DISPENSED]: onMedicationDispensed,
    [EVENTS.PATIENT_ADMITTED]: onPatientAdmitted,
    [EVENTS.PATIENT_DISCHARGED]: onPatientDischarged,
    [EVENTS.PATIENTS_MERGED]: onPatientsMerged("billing", repointPatient),
  },
  tasks: {},
};
