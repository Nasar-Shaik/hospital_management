/**
 * Pharmacy service — handing the drugs over.
 *
 * ── THIS MODULE IS AN ORCHESTRATOR ──────────────────────────────────────────
 * It owns exactly one collection (`dispenses`) and coordinates three modules that must
 * not know about each other:
 *
 *     prescriptions → what was authorised, and how much of it is left
 *     orders        → the pharmacy's worklist entry, cleared when the handover is done
 *     billing       → told (never called) that drugs left the counter
 *
 * Same shape as `staff.service.ts`: the use case lives one level up, in a module that may
 * depend on all three while nothing depends on it. `prescriptions` must not import
 * `pharmacy` — the arrow points this way, and the graph stays acyclic.
 *
 * ── WHAT THIS MODULE DELIBERATELY DOES NOT DO ───────────────────────────────
 * Stock. STATE_MACHINE_CATALOG §6 says dispensing "decrements batch stock
 * transactionally", and it does not, because there are no batches: no inventory, no
 * expiry dates, no purchase orders. `pharmacy:stock` exists as a permission and nothing
 * writes it.
 *
 * That is a REAL GAP and it is written down as such (PROJECT_MEMORY): this module records
 * what was handed over and bills for it, and it will let you dispense a drug the shelf
 * does not have. It is honest about being a counter without a warehouse. What it must
 * never do is pretend otherwise — a stock number that is only sometimes decremented is
 * worse than no stock number, because people believe it.
 */
import { createLogger } from "@medicore/logger";
import { AppError } from "../../core/errors/appError.js";
import { getContext } from "../../core/context/requestContext.js";
import { withTransaction } from "../../core/db/transaction.js";
import { publish } from "../../core/events/outbox.js";
import { EVENTS } from "../../core/events/eventCatalog.js";
import {
  acceptOrder,
  completeOrder,
  getOrder,
  releaseOrder,
  startOrder,
  verifyOrder,
} from "../orders/index.js";
import {
  addDispensedQty,
  getPrescription,
  isDispensable,
  setPrescriptionStatus,
  type Prescription,
  type PrescriptionStatus,
} from "../prescriptions/index.js";
import { assessDrugCredit } from "../billing/index.js";
import * as repo from "./dispense.repository.js";
import type { DispenseLine } from "./dispense.model.js";

const logger = createLogger({ service: "pharmacy" });

export type { Dispense } from "./dispense.repository.js";

export interface DispenseItemInput {
  /** The POSITION on the prescription — the same drug can legitimately appear twice. */
  lineIndex: number;
  /** How many units to hand over NOW. Not the prescribed total. */
  quantity: number;
}

export interface DispenseInput {
  prescriptionId: string;
  items: DispenseItemInput[];
  requestId?: string;
  /**
   * Present when the caller is knowingly dispensing OVER an admitted patient's advance —
   * the "authorise on credit" acknowledgement. Only honoured from a caller holding
   * `pharmacy:credit-override`; without it an over-budget dispense is refused (HMS-PHM-003).
   */
  creditOverride?: { reason: string };
}

export interface DispenseResult {
  dispense: repo.Dispense;
  prescription: Prescription;
  /** True when this `requestId` had already been handed over — a retry, not a second lot. */
  duplicate: boolean;
}

/**
 * Hands drugs over against a signed prescription.
 *
 * ── THE FOUR THINGS THAT MUST BE TRUE TOGETHER OR NOT AT ALL ────────────────
 * the quantities go up · the ledger row exists · the status matches the quantities ·
 * billing has been told. All four are inside one transaction, because any one of them
 * alone is a lie: quantities without a ledger row is a total nobody can audit, a ledger
 * row without the event is drugs the patient is never charged for, and a status that
 * disagrees with its own quantities is the bug that ends with a pharmacist arguing with a
 * screen while a queue builds behind the patient.
 */
export async function dispense(input: DispenseInput): Promise<DispenseResult> {
  const ctx = getContext();

  /**
   * Read through the ORDINARY scoped path — there is no bypass here.
   *
   * A pharmacist dispenses prescriptions somebody ELSE wrote, so this only works because
   * `prescription:*` is `branch`-scoped rather than `own` (see @medicore/permissions).
   * Their authority to hand the drugs over comes from `pharmacy:dispense` plus a real
   * signature on a real prescription — exactly as it does on paper, where the pharmacist's
   * right comes from the chit and not from having written it. A pharmacist restricted to
   * one branch is correctly unable to dispense another branch's prescriptions.
   */
  const rx = await getPrescription(input.prescriptionId);
  if (!rx) {
    throw new AppError("HMS-GEN-404", 404, "Prescription not found", {
      id: input.prescriptionId,
    });
  }

  /**
   * ── ONLY A SIGNED PRESCRIPTION AUTHORISES ANYTHING ──────────────────────────
   * A draft is a doctor thinking out loud. A cancelled one is a doctor who has changed
   * their mind — possibly because of an allergy, an interaction, or a result that came
   * back an hour ago. Dispensing against either is handing out drugs on an authority that
   * does not exist, and it is the single worst thing this module could do.
   */
  if (!isDispensable(rx.status)) {
    throw new AppError("HMS-STATE-001", 422, "This prescription cannot be dispensed against", {
      id: rx.id,
      status: rx.status,
      hint:
        rx.status === "draft"
          ? "it has not been signed — a draft authorises nothing"
          : "it is no longer in force (cancelled, discarded, or already fully dispensed)",
    });
  }

  /**
   * A retry, checked BEFORE any work. The unique index is still the real arbiter (two
   * clicks can be in flight at once and this read would miss), but catching the common
   * case here means the usual retry never touches the quantities at all.
   */
  if (input.requestId) {
    const existing = await repo.findByRequestId(input.requestId);
    if (existing) {
      logger.info(
        { dispenseId: existing.id, requestId: input.requestId },
        "already dispensed with this requestId — returning it rather than handing over twice",
      );
      return { dispense: existing, prescription: rx, duplicate: true };
    }
  }

  // Resolve every line BEFORE touching anything: a request naming one good drug and one
  // bad index must hand over neither, not the first one and then an error.
  const lines: DispenseLine[] = input.items.map((item) => {
    const line = rx.lines[item.lineIndex];
    if (!line) {
      throw new AppError("HMS-VAL-001", 400, "Validation failed", {
        items: [`no line ${String(item.lineIndex)} on this prescription`],
      });
    }
    return {
      lineIndex: item.lineIndex,
      drugCode: line.drugCode,
      drugName: line.drugName,
      quantity: item.quantity,
    };
  });

  /**
   * ── OVER-BUDGET CHECKPOINT (admitted patients only) ─────────────────────────
   * If handing these drugs over would push an ADMITTED patient's advance below zero, a
   * clinician must authorise the credit (`pharmacy:credit-override`). This is a recorded
   * sign-off, NOT a denial of medicine — and it FAILS OPEN: if the assessment itself errors
   * (tariff, wallet, encounter read), the dispense proceeds unblocked, because a money
   * problem must never hold a patient's drugs (this module's founding rule).
   */
  let creditOverride: repo.CreateDispenseInput["creditOverride"];
  let assessment: Awaited<ReturnType<typeof assessDrugCredit>> | undefined;
  try {
    assessment = await assessDrugCredit({
      patientId: rx.patientId,
      encounterId: rx.encounterId,
      lines: lines.map((l) => ({ drugCode: l.drugCode, quantity: l.quantity })),
    });
  } catch (err) {
    logger.warn(
      { err, prescriptionId: rx.id },
      "credit assessment failed — dispensing without the advance-budget check (fail open)",
    );
  }

  if (assessment?.overBudget) {
    if (!input.creditOverride) {
      throw new AppError("HMS-PHM-003", 402, "Dispense would exceed the patient's advance", {
        cost: assessment.cost,
        balance: assessment.balance,
        shortfall: assessment.shortfall,
        hint: "a doctor must authorise dispensing on credit",
      });
    }
    // The acknowledgement only counts from someone with the authority to commit the credit.
    if (!ctx.permissions?.includes("pharmacy:credit-override")) {
      throw new AppError("HMS-AUTH-005", 403, "Not authorised to dispense on credit", {
        hint: "over-budget dispensing needs a doctor's or administrator's sign-off (pharmacy:credit-override)",
      });
    }
    creditOverride = {
      by: ctx.userId ?? "system",
      reason: input.creditOverride.reason,
      shortfall: assessment.shortfall,
      at: new Date(),
    };
  }

  try {
    return await withTransaction(async (session) => {
      /**
       * ── THE OVER-DISPENSE GUARD IS THE DATABASE, NOT AN `if` ──────────────────
       * `addDispensedQty` refuses in the QUERY when the new total would exceed what was
       * prescribed. A read-then-check here would let two pharmacists both see "2 left",
       * both pass, and both hand over 2 — and the patient walks out with 12 tablets of a
       * drug they were prescribed 10 of, with a ledger that says it never happened.
       */
      let updated: Prescription | undefined;

      for (const line of lines) {
        updated = await addDispensedQty(rx.id, line.lineIndex, line.quantity, session);
        if (!updated) {
          const prescribed = rx.lines[line.lineIndex];
          throw new AppError("HMS-STATE-001", 422, "More than was prescribed", {
            drug: line.drugName,
            requested: line.quantity,
            prescribed: prescribed?.quantity ?? 0,
            alreadyDispensed: prescribed?.dispensedQty ?? 0,
            hint: "the patient can only be given what the doctor prescribed — amend the prescription to give more",
          });
        }
      }
      if (!updated) {
        throw new AppError("HMS-VAL-001", 400, "Validation failed", {
          items: ["a dispense must hand over at least one drug"],
        });
      }

      const dispenseRow = await repo.create(
        {
          prescriptionId: rx.id,
          encounterId: rx.encounterId,
          patientId: rx.patientId,
          episodeId: rx.episodeId,
          lines,
          ...(rx.orderId ? { orderId: rx.orderId } : {}),
          ...(input.requestId ? { requestId: input.requestId } : {}),
          ...(rx.branchId ? { branchId: rx.branchId } : {}),
          ...(creditOverride ? { creditOverride } : {}),
        },
        session,
      );

      /**
       * The status is DERIVED from the quantities we just wrote — never chosen by the
       * caller, and never inferred from "was this the last item I clicked". A status that
       * is computed from the numbers it claims to summarise cannot drift away from them.
       */
      const next = statusFor(updated);
      const settled =
        next === updated.status
          ? updated
          : ((await setPrescriptionStatus(
              rx.id,
              updated.status,
              next,
              {
                from: updated.status,
                to: next,
                at: new Date(),
                ...(ctx.userId ? { by: ctx.userId } : {}),
              },
              session,
            )) ?? updated);

      /**
       * ── BILLING IS TOLD, NOT CALLED ─────────────────────────────────────────
       * Published in the SAME transaction as the handover, so there can never be drugs on
       * the ledger that nobody was charged for, nor a charge for drugs that rolled back.
       * `billing.consumers.ts` decides what it costs; this module does not know that money
       * exists, and a broken tariff can never stop a patient getting their medicine.
       */
      await publish(
        {
          name: EVENTS.MEDICATION_DISPENSED,
          payload: {
            dispenseId: dispenseRow.id,
            prescriptionId: rx.id,
            encounterId: rx.encounterId,
            patientId: rx.patientId,
            episodeId: rx.episodeId,
            // What was handed over in THIS lot. The charge is per dispense, per drug, at
            // the quantity that actually crossed the counter.
            lines: lines.map((l) => ({
              drugCode: l.drugCode,
              drugName: l.drugName,
              quantity: l.quantity,
            })),
            fullyDispensed: next === "dispensed",
          },
          ...(rx.branchId ? { branchId: rx.branchId } : {}),
        },
        session,
      );

      return { dispense: dispenseRow, prescription: settled, duplicate: false };
    });
  } catch (err) {
    if (!repo.isDuplicateKey(err) || !input.requestId) throw err;

    // The retry and the original raced, and the index arbitrated. Hand back the one that
    // won rather than telling the pharmacist their click failed — it did not.
    const existing = await repo.findByRequestId(input.requestId);
    if (!existing) throw err;

    const current = (await getPrescription(input.prescriptionId)) ?? rx;
    return { dispense: existing, prescription: current, duplicate: true };
  }
}

/**
 * What the prescription's status IS, given what has actually been handed over.
 *
 * Nobody sets these by hand — see `prescription.model.ts`. A line that has had nothing
 * dispensed and a line that has had some are both "not finished"; only when every line is
 * complete is the prescription.
 */
function statusFor(rx: Prescription): PrescriptionStatus {
  const complete = rx.lines.every((l) => l.dispensedQty >= l.quantity);
  if (complete) return "dispensed";

  const started = rx.lines.some((l) => l.dispensedQty > 0);
  return started ? "partially_dispensed" : rx.status;
}

/**
 * Moves the pharmacy's worklist entry along, AFTER the drugs are safely recorded.
 *
 * ── WHY THIS IS OUTSIDE THE TRANSACTION, AND WHY A FAILURE HERE IS SURVIVABLE ─
 * The order module opens its own transactions and `withTransaction` is not re-entrant, so
 * these cannot join the handover's transaction. That is tolerable precisely BECAUSE the
 * order is not the source of truth here: what the patient may still be given is decided by
 * the prescription's quantities, which are already committed. If this fails, a worklist
 * entry is stale — irritating, visible, and fixable by clicking again. Nobody gets the
 * wrong drugs.
 *
 * ── WHY THE PHARMACIST VERIFIES AND RELEASES THEIR OWN ORDER ────────────────
 * For a lab result, `completed → verified` is a SECOND PAIR OF EYES and collapsing it
 * would kill somebody. For a handover, the second pair of eyes has ALREADY happened, and
 * it happened in the right order: the doctor prescribed, and the pharmacist — a different
 * person, professionally obliged to question it — checked the prescription before the
 * drugs left the shelf. Making them then "verify" their own handover would be a signature
 * on their own work, which is the exact thing verification exists not to be.
 *
 * So the ceremony is skipped, and it is skipped honestly: `verifyAuthorityFor("pharmacy")`
 * returns nothing (`order.authority.ts`), which says in code that no category-specialist
 * signature is required here. What clears the pharmacy's worklist is the drugs being in
 * the patient's hand.
 */
async function clearTheWorklist(orderId: string, fullyDispensed: boolean): Promise<void> {
  const order = await getOrder(orderId);
  if (!order) return;

  let status = order.status;

  if (status === "placed") {
    ({ status } = await acceptOrder(orderId));
  }
  if (status === "accepted") {
    ({ status } = await startOrder(orderId));
  }
  if (!fullyDispensed) return;

  if (status === "in_progress") {
    ({ status } = await completeOrder(orderId, { summary: "Dispensed to the patient" }));
  }
  if (status === "completed") {
    ({ status } = await verifyOrder(orderId));
  }
  if (status === "verified") {
    await releaseOrder(orderId);
  }
}

/**
 * Dispense, then clear the counter.
 *
 * The worklist update is deliberately best-effort: the drugs and the money are already
 * committed, and throwing here would report a failure for something that succeeded — the
 * pharmacist would hand over a second lot to "fix" it.
 */
export async function dispenseAndClear(input: DispenseInput): Promise<DispenseResult> {
  const result = await dispense(input);

  if (result.dispense.orderId && !result.duplicate) {
    try {
      await clearTheWorklist(result.dispense.orderId, result.prescription.status === "dispensed");
    } catch (err) {
      logger.error(
        { err, orderId: result.dispense.orderId, dispenseId: result.dispense.id },
        "drugs were dispensed and recorded, but the pharmacy worklist entry did not move — the handover STANDS; the entry is stale",
      );
    }
  }

  return result;
}

export const dispensesFor = repo.listForPrescription;
