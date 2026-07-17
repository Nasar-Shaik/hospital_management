/**
 * How the shelf learns that drugs left it.
 *
 * ── STOCK LISTENS, IT IS NOT CALLED ─────────────────────────────────────────
 * The pharmacy publishes `medication.dispensed` when a handover commits — the same event
 * billing consumes to charge for it. This module consumes it to decrement stock. The pharmacy
 * has no idea a stock system exists, exactly as it has no idea billing exists, and that is the
 * point: a fault in the shelf's bookkeeping can never roll back a patient's medicine, because
 * the handover has already committed by the time this runs.
 *
 * ── IDEMPOTENT BY THE LEDGER ────────────────────────────────────────────────
 * Delivery is at-least-once, so this WILL see the same dispense twice. The dispense movement
 * carries a unique `(dispenseId, medicineCode)` key (migration 0019); the second delivery
 * rolls back against it and the balance moves exactly once. See `medicine.service.ts`.
 */
import { createLogger } from "@medicore/logger";
import { EVENTS } from "../../core/events/eventCatalog.js";
import type { DomainEvent, ModuleConsumers } from "../../core/events/consumers.js";
import { recordDispense } from "./medicine.service.js";

const logger = createLogger({ service: "medicine-consumers" });

interface DispensedLinePayload {
  drugCode?: unknown;
  quantity?: unknown;
}

/** Drugs crossed the counter → take them off the shelf. */
async function onMedicationDispensed(event: DomainEvent): Promise<void> {
  const dispenseId = String(event.payload.dispenseId ?? "");
  const rawLines = Array.isArray(event.payload.lines)
    ? (event.payload.lines as DispensedLinePayload[])
    : [];
  if (!dispenseId || rawLines.length === 0) {
    logger.warn({ event: event.eventId }, "medication.dispensed carries no lines — no stock moved");
    return;
  }

  const lines = rawLines
    .map((l) => ({ drugCode: String(l.drugCode ?? ""), quantity: Number(l.quantity ?? 0) }))
    .filter((l) => l.drugCode && l.quantity > 0);

  await recordDispense(
    dispenseId,
    lines,
    typeof event.branchId === "string" ? event.branchId : undefined,
  );
}

export const medicineConsumers: ModuleConsumers = {
  events: {
    [EVENTS.MEDICATION_DISPENSED]: onMedicationDispensed,
  },
  tasks: {},
};
