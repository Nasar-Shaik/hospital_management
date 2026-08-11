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
import type { receiveStock, StockReportRow } from "./medicine.service.js";

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
