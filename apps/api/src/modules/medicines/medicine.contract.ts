/**
 * Medicine and stock response contracts.
 *
 * The medicine master is TENANT-SCOPED and stock movements are BRANCH-SCOPED (ADR-0015): the drug
 * catalogue is one hospital-wide list, but what is physically on a shelf belongs to a site.
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves, type Returns } from "../../core/http/contract.js";
import { MEDICINE_FORMS, STOCK_MOVEMENT_KINDS } from "./medicine.model.js";
import type { Medicine, StockMovement } from "./medicine.repository.js";
import type {
  Availability as AvailabilityDto,
  BatchOnShelf,
  receiveStock,
  StockReportRow,
} from "./medicine.service.js";

const medicineFields = {
  id: z.string(),
  code: z.string(),
  name: z.string(),
  manufacturer: z.string().optional(),
  generic: z.string().optional(),
  form: z.enum(MEDICINE_FORMS),
  strength: z.string().optional(),
  unitsPerSheet: z.number().optional(),
  sheetsPerPack: z.number().optional(),
  stockUnits: z.number(),
  reorderLevel: z.number(),
  active: z.boolean(),
  branchId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
};

export const medicine = contract("Medicine", z.object(medicineFields));
export type MedicineProof = Proves<Matches<typeof medicine, Medicine>>;

/** The medicine with the shelf verdict the reorder screen sorts on. */
export const stockReportRow = contract(
  "StockReportRow",
  z.object({ ...medicineFields, status: z.enum(["ok", "low", "out", "reconcile"]) }),
);
export type StockReportRowProof = Proves<Matches<typeof stockReportRow, StockReportRow>>;

export const stockMovement = contract(
  "StockMovement",
  z.object({
    id: z.string(),
    medicineId: z.string(),
    medicineCode: z.string(),
    kind: z.enum(STOCK_MOVEMENT_KINDS),
    /** Signed: receipts are positive, issues negative. */
    delta: z.number(),
    balanceAfter: z.number(),
    batchNo: z.string().optional(),
    expiry: z.string().optional(),
    reason: z.string().optional(),
    dispenseId: z.string().optional(),
    createdBy: z.string(),
    createdAt: z.string(),
  }),
);
export type StockMovementProof = Proves<Matches<typeof stockMovement, StockMovement>>;

/** A stock change answers with both the new balance and the ledger row that produced it. */
export const stockChange = contract("StockChange", z.object({ medicine, movement: stockMovement }));
export type StockChangeProof = Proves<Matches<typeof stockChange, Returns<typeof receiveStock>>>;

/** One lot on the shelf, as the pharmacist sees it — expired ones included and labelled. */
export const medicineBatch = contract(
  "MedicineBatch",
  z.object({
    id: z.string(),
    batchNo: z.string(),
    expiry: z.string(),
    remaining: z.number(),
    state: z.enum(["expired", "near_expiry", "ok"]),
  }),
);
export type MedicineBatchProof = Proves<Matches<typeof medicineBatch, BatchOnShelf>>;

/**
 * What the pharmacy could hand over today, for the prescribing screen.
 *
 * Deliberately NOT the medicine record: a prescriber is asking "can my patient get this here?",
 * not reading inventory. No cost, no reorder level, no ledger — the smallest honest answer.
 */
export const medicineAvailability = contract(
  "MedicineAvailability",
  z.object({
    code: z.string(),
    units: z.number(),
    nearestExpiry: z.string().optional(),
    /** False when the figure is the master's running total rather than counted lots. */
    batched: z.boolean(),
  }),
);
export type MedicineAvailabilityProof = Proves<
  Matches<typeof medicineAvailability, AvailabilityDto>
>;
