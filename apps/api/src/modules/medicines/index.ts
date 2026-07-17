/**
 * The pharmacy's medicine master and stock ledger — the module's public face (Constitution §5).
 *
 * Everything another module may touch is re-exported here; nothing reaches past this file into
 * `medicine.repository.ts` or the models. The stock decrement is NOT exposed as a function to
 * call — it happens by consuming `medication.dispensed` (see `medicineConsumers`), so the
 * pharmacy never imports this module at all.
 */
export { medicineRouter } from "./medicine.routes.js";
export { medicineConsumers } from "./medicine.consumers.js";
export {
  listMedicines,
  getMedicine,
  createMedicine,
  updateMedicine,
  receiveStock,
  adjustStock,
  listMovements,
  stockReport,
  MEDICINE_FORMS,
  STOCK_MOVEMENT_KINDS,
} from "./medicine.service.js";
export type {
  Medicine,
  StockMovement,
  MedicineForm,
  StockMovementKind,
  StockStatus,
  StockReportRow,
} from "./medicine.service.js";
