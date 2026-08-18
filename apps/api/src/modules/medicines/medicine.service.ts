/**
 * Medicine master + stock service.
 *
 * ── STOCK IS DECREMENTED BY LISTENING, NOT BY BEING CALLED ──────────────────
 * The pharmacy module never calls this one. When drugs cross the counter it publishes
 * `medication.dispensed`, and `medicine.consumers.ts` turns that into a stock movement here —
 * the same arrow billing uses to charge for the same event. This keeps the guarantee the
 * pharmacy service insists on: a broken stock system can never stop a patient getting their
 * medicine, because the handover has already committed by the time this runs.
 *
 * ── THE LEDGER IS IDEMPOTENT, BECAUSE EVENTS ARE DELIVERED AT LEAST ONCE ─────
 * Every stock move is atomic (a `$inc` and the movement row in one transaction). A dispense
 * move additionally carries `(dispenseId, medicineCode)`, unique in the database (migration
 * 0019): a redelivered `medication.dispensed` hits that index, the transaction rolls back the
 * `$inc`, and the balance is decremented exactly once however many times the event arrives.
 */
import { createLogger } from "@medicore/logger";
import { AppError } from "../../core/errors/appError.js";
import { writeBranchId } from "../../core/context/activeBranch.js";
import { withTransaction } from "../../core/db/transaction.js";
import * as repo from "./medicine.repository.js";
import type { ClientSession } from "mongoose";
import * as batches from "./batch.repository.js";
import { batchState, type BatchState } from "./batch.model.js";
import type { Medicine, StockMovement } from "./medicine.repository.js";

const logger = createLogger({ service: "medicine-service" });

export type { Medicine, StockMovement, StockRegisterRow } from "./medicine.repository.js";
export type { MedicineForm, StockMovementKind } from "./medicine.model.js";
export { MEDICINE_FORMS, STOCK_MOVEMENT_KINDS } from "./medicine.model.js";

export const listMedicines = repo.list;
export const getMedicine = repo.findById;
export const listMovements = repo.listMovements;
/** The stock register for a period — see the repository. Used by the reporting module. */
export const stockRegister = repo.stockRegister;

export async function createMedicine(input: repo.CreateMedicineInput): Promise<Medicine> {
  try {
    return await repo.create(input);
  } catch (err) {
    if (repo.isDuplicateKey(err)) {
      throw new AppError("HMS-VAL-001", 409, "That medicine code is already in the master", {
        code: input.code,
        hint: "codes are unique per hospital — pick another, or edit the existing medicine",
      });
    }
    throw err;
  }
}

export async function updateMedicine(
  id: string,
  patch: repo.UpdateMedicineInput,
): Promise<Medicine> {
  const updated = await repo.update(id, patch);
  if (!updated) throw new AppError("HMS-GEN-404", 404, "Medicine not found", { id });
  return updated;
}

export interface ReceiveStockInput {
  /** Base units received. Must be positive — a receipt adds. */
  quantity: number;
  batchNo?: string;
  expiry?: Date;
  branchId?: string;
}

/** Books stock IN against a medicine — the pharmacist receiving a delivery. */
export async function receiveStock(
  id: string,
  input: ReceiveStockInput,
): Promise<{ medicine: Medicine; movement: StockMovement }> {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw new AppError("HMS-VAL-001", 400, "Received quantity must be a positive whole number", {
      quantity: input.quantity,
    });
  }
  /**
   * ── WHY THIS IS RESOLVED HERE AND NOT TAKEN FROM THE CALLER ─────────────────
   * `branchId` was an optional argument that the controller never passed, so EVERY receipt and
   * adjustment made over HTTP was written branchless — the pharmacy audit of 2026-08-11 found 31
   * such rows and no code path that could have produced anything else. A ledger that cannot say
   * which pharmacy the stock arrived at is not a stock ledger, and the field's mere presence made
   * it look solved. It now comes from the active branch, through the one choke point (ADR-0015),
   * which also validates a caller-supplied value instead of trusting it.
   */
  const branchId = await writeBranchId(input.branchId);

  /**
   * ── A BATCH NEEDS BOTH HALVES, OR IT IS NOT A BATCH ─────────────────────────
   * A lot number with no expiry cannot be refused when it lapses; an expiry with no lot number
   * cannot be recalled. Either alone is a field that looks like stock control and is not, which
   * is precisely the state this milestone found: both were captured on the movement and neither
   * was ever read. Ask for the pair or take neither.
   */
  if (Boolean(input.batchNo) !== Boolean(input.expiry)) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      batchNo: [
        "give a batch number AND an expiry date, or neither — one without the other cannot be " +
          "expired out or recalled",
      ],
    });
  }

  /**
   * Expired on arrival. Refused rather than booked in and flagged: stock that may never be
   * dispensed is not stock, and accepting it would put a number on the shelf that every later
   * screen has to remember to subtract.
   */
  if (input.expiry && input.expiry.getTime() <= Date.now()) {
    throw new AppError("HMS-STATE-001", 422, "That stock has already expired", {
      expiry: input.expiry,
      hint: "check the date on the box — expired stock cannot be received",
    });
  }

  const result = await withTransaction(async (session) => {
    const moved = await repo.move(
      id,
      {
        kind: "receipt",
        delta: input.quantity,
        ...(input.batchNo ? { batchNo: input.batchNo } : {}),
        ...(input.expiry ? { expiry: input.expiry } : {}),
        ...(branchId ? { branchId } : {}),
      },
      session,
    );
    if (!moved) return undefined;

    /**
     * The lot itself, in the same transaction as the movement that explains it. A batch without
     * its ledger row is stock nobody can audit; a ledger row without its batch is the state this
     * replaces. Stock received WITHOUT a batch number stays on the master's running total alone
     * — honest, and exactly how every existing hospital's balance already sits.
     */
    if (input.batchNo && input.expiry) {
      await batches.receiveBatch(
        {
          medicineId: moved.medicine.id,
          medicineCode: moved.medicine.code,
          batchNo: input.batchNo,
          expiry: input.expiry,
          quantity: input.quantity,
          ...(branchId ? { branchId } : {}),
        },
        session,
      );
    }
    return moved;
  });

  if (!result) throw new AppError("HMS-GEN-404", 404, "Medicine not found", { id });
  return result;
}

export interface AdjustStockInput {
  /** Signed base units — negative for breakage, positive for a stock-take correction up. */
  delta: number;
  reason: string;
  branchId?: string;
}

/** A manual correction — breakage, expiry write-off, a stock-take that found the truth. */
export async function adjustStock(
  id: string,
  input: AdjustStockInput,
): Promise<{ medicine: Medicine; movement: StockMovement }> {
  if (!Number.isInteger(input.delta) || input.delta === 0) {
    throw new AppError("HMS-VAL-001", 400, "An adjustment must be a non-zero whole number", {
      delta: input.delta,
    });
  }
  // Same as `receiveStock`: the site the correction was made at, from the context, not the body.
  const branchId = await writeBranchId(input.branchId);
  const result = await withTransaction((session) =>
    repo.move(
      id,
      {
        kind: "adjustment",
        delta: input.delta,
        reason: input.reason,
        ...(branchId ? { branchId } : {}),
      },
      session,
    ),
  );
  if (!result) throw new AppError("HMS-GEN-404", 404, "Medicine not found", { id });
  return result;
}

export interface DispensedLine {
  drugCode: string;
  quantity: number;
}

/**
 * Decrements stock for a dispense — called ONLY by the event consumer, never a controller.
 *
 * Lines are summed per code first: a prescription can carry the same drug twice (a QID dose
 * and an SOS dose), and stock cares only about the total that left the shelf, not the reason.
 * A code the master does not know is skipped, not an error — the master is the set of drugs
 * this hospital tracks stock for, and dispensing an untracked drug is a legitimate thing that
 * simply produces no movement. A redelivery is absorbed by the unique dispense key.
 */
/**
 * Takes `quantity` off this drug's lots, earliest expiry first.
 *
 * Returns what it managed to take, which may be less than asked for or nothing at all — an
 * unbatched pharmacy (every hospital's existing balance) allocates nothing and is not an error.
 *
 * Each take is a conditional update, so two pharmacists racing for the same last lot do not both
 * get it: one wins, the other's take returns nothing and the loop simply moves to the next lot.
 */
async function allocateFefo(
  medicineCode: string,
  quantity: number,
  session: ClientSession,
): Promise<{ batchNo: string; taken: number }[]> {
  const now = new Date();
  const taken: { batchNo: string; taken: number }[] = [];
  let outstanding = quantity;

  for (const batch of await batches.allocatableFor(medicineCode, now, session)) {
    if (outstanding <= 0) break;
    const want = Math.min(outstanding, batch.remaining);
    const got = await batches.takeFromBatch(batch.id, want, now, session);
    // Somebody else took it between the list and the take. Their claim stands; try the next lot.
    if (!got) continue;
    taken.push({ batchNo: batch.batchNo, taken: want });
    outstanding -= want;
  }

  return taken;
}

export async function recordDispense(
  dispenseId: string,
  lines: DispensedLine[],
  branchId?: string,
): Promise<void> {
  const byCode = new Map<string, number>();
  for (const line of lines) {
    if (!line.drugCode || !Number.isFinite(line.quantity) || line.quantity <= 0) continue;
    byCode.set(line.drugCode, (byCode.get(line.drugCode) ?? 0) + line.quantity);
  }

  for (const [code, quantity] of byCode) {
    const medicine = await repo.findByCode(code);
    if (!medicine) continue; // not tracked — no stock number to move

    try {
      await withTransaction(async (session) => {
        /**
         * ── FEFO, AND THE SHORTFALL IS NOT AN ERROR ─────────────────────────
         * Take from the earliest-expiring lot that is still in date, then the next, until the
         * quantity is met or the batched stock runs out. Expired lots are excluded by the query
         * itself (`allocatableFor`), so there is no path here that hands over expired stock and
         * no `if` anybody can forget.
         *
         * What happens when the batches cannot cover it is the decision that matters. This
         * module's founding rule is that a bookkeeping problem must never hold a patient's
         * medicine — `pharmacy.service.ts` says so, and the fail-open credit assessment beside it
         * follows the same rule. The pharmacist is standing at the counter with the box in their
         * hand; the drugs have ALREADY crossed it by the time this consumer runs. Refusing here
         * would not un-give them, it would only lose the record.
         *
         * So the shortfall is recorded rather than refused: the master's running total absorbs
         * it, goes negative if it must, and `statusOf` reports that as `reconcile` — which is
         * exactly what it has always meant, "more went out than was ever booked in". A pharmacy
         * whose shelf and records disagree needs to be told, not silently corrected.
         */
        const allocations = await allocateFefo(medicine.code, quantity, session);

        await repo.move(
          medicine.id,
          {
            kind: "dispense",
            delta: -quantity,
            dispenseId,
            ...(allocations.length > 0
              ? { batchNo: allocations.map((a) => a.batchNo).join(", ") }
              : {}),
            ...(branchId ? { branchId } : {}),
          },
          session,
        );
      });
    } catch (err) {
      if (repo.isDuplicateKey(err)) {
        // This dispense already moved this medicine — a redelivered event. Exactly once holds.
        logger.debug(
          { dispenseId, code },
          "stock already decremented for this dispense — skipping",
        );
        continue;
      }
      throw err;
    }
  }
}

/* ── The shelf, as a pharmacist and a prescriber each need to see it ────────── */

export interface BatchOnShelf {
  id: string;
  batchNo: string;
  expiry: Date;
  remaining: number;
  /** `expired` | `near_expiry` | `ok` — computed, never stored, so it cannot go stale. */
  state: BatchState;
}

/**
 * Every lot of one drug, expired ones INCLUDED and labelled.
 *
 * The pharmacist is the one person who must see expired stock: somebody has to pull it off the
 * shelf and write it off, and a screen that hides it guarantees it stays there. Contrast
 * `availability` below, which is the prescriber's question and excludes it.
 */
export async function shelfFor(
  medicineCode: string,
  now: Date = new Date(),
): Promise<BatchOnShelf[]> {
  const rows = await batches.listForMedicine(medicineCode);
  return rows.map((b) => ({
    id: b.id,
    batchNo: b.batchNo,
    expiry: b.expiry,
    remaining: b.remaining,
    state: batchState(b.expiry, now),
  }));
}

export interface Availability {
  code: string;
  /** Base units that could actually be handed over today. Expired lots are not counted. */
  units: number;
  /** Absent when the drug has no batched stock at all — see `batched`. */
  nearestExpiry?: Date;
  /**
   * False when this hospital tracks no batches for the drug and the figure comes from the
   * master's running total instead. The distinction is the difference between "we have 40, and
   * the oldest goes off in March" and "our books say 40" — and a prescriber deserves to know
   * which one they are being told.
   */
  batched: boolean;
}

/**
 * What the pharmacy could give a patient today, for the prescribing screen.
 *
 * ── AVAILABILITY IS INFORMATION, NOT PERMISSION ─────────────────────────────
 * Nothing consumes this to refuse anything, and nothing ever should. A doctor prescribes what
 * the patient needs; if the hospital pharmacy is out, the patient buys it outside and the
 * prescription is what they take to the shop. A stock check that could block prescribing would
 * turn an inventory problem into a clinical one.
 *
 * Falls back to the master's running total for any drug with no batches, which is every drug in
 * every hospital that has not started recording them — otherwise switching this on would report
 * a fully stocked pharmacy as empty.
 */
export async function availability(
  codes: string[],
  now: Date = new Date(),
): Promise<Availability[]> {
  const wanted = [...new Set(codes.filter(Boolean))];
  if (wanted.length === 0) return [];

  const [batched, masters] = await Promise.all([
    batches.onHandByCode(wanted, now),
    repo.listByCodes(wanted),
  ]);
  const byCode = new Map(masters.map((m) => [m.code, m]));

  return wanted.map((code) => {
    const lots = batched.get(code);
    if (lots) {
      return {
        code,
        units: lots.units,
        batched: true,
        ...(lots.nearestExpiry ? { nearestExpiry: lots.nearestExpiry } : {}),
      };
    }
    // No lots: the running total is the only answer there is. Negative means the shelf and the
    // books disagree (`reconcile`), and a prescriber is told zero rather than a minus number.
    const master = byCode.get(code);
    return { code, units: Math.max(0, master?.stockUnits ?? 0), batched: false };
  });
}

/** A medicine's position, as the stock report reads it. */
export type StockStatus = "ok" | "low" | "out" | "reconcile";

export interface StockReportRow extends Medicine {
  status: StockStatus;
}

function statusOf(m: Medicine): StockStatus {
  if (m.stockUnits < 0) return "reconcile"; // more went out than was ever booked in
  if (m.stockUnits === 0) return "out";
  if (m.reorderLevel > 0 && m.stockUnits <= m.reorderLevel) return "low";
  return "ok";
}

/**
 * The stock report — every stocked medicine with a plain-language position. Ordered by how
 * much it needs attention (reconcile, then out, then low, then ok) so the pharmacist reads
 * the problems first.
 */
export async function stockReport(filter: repo.ListFilter = {}): Promise<StockReportRow[]> {
  const medicines = await repo.list(filter);
  const rank: Record<StockStatus, number> = { reconcile: 0, out: 1, low: 2, ok: 3 };
  return medicines
    .map((m) => ({ ...m, status: statusOf(m) }))
    .sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));
}
