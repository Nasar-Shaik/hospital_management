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
import { withTransaction } from "../../core/db/transaction.js";
import * as repo from "./medicine.repository.js";
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
  const result = await withTransaction((session) =>
    repo.move(
      id,
      {
        kind: "receipt",
        delta: input.quantity,
        ...(input.batchNo ? { batchNo: input.batchNo } : {}),
        ...(input.expiry ? { expiry: input.expiry } : {}),
        ...(input.branchId ? { branchId: input.branchId } : {}),
      },
      session,
    ),
  );
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
  const result = await withTransaction((session) =>
    repo.move(
      id,
      {
        kind: "adjustment",
        delta: input.delta,
        reason: input.reason,
        ...(input.branchId ? { branchId: input.branchId } : {}),
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
      await withTransaction((session) =>
        repo.move(
          medicine.id,
          {
            kind: "dispense",
            delta: -quantity,
            dispenseId,
            ...(branchId ? { branchId } : {}),
          },
          session,
        ),
      );
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
