/**
 * Wards module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5, Module B4).
 *
 * Owns the bed INVENTORY: the wards a hospital has and the beds in them. A leaf master, like
 * `branches` — it depends on nothing operational. `encounters` reads `getBed` to validate and
 * price a bed at admission; `admissions` reads `listWards`/`listBeds` to build the free-bed
 * board. Nothing here reads back into those modules, so the graph stays acyclic: occupancy is
 * NEVER stored on a bed (that lives on the encounter), so this module never needs to know who
 * is admitted.
 */
export { wardRouter } from "./ward.routes.js";

export {
  listWards,
  listBeds,
  getWard,
  getBed,
  createWard,
  updateWard,
  createBed,
  updateBed,
  type Ward,
  type Bed,
} from "./ward.service.js";

export {
  WARD_KINDS,
  WARD_STATUSES,
  BED_STATUSES,
  type WardKind,
  type WardStatus,
  type BedStatus,
} from "./ward.model.js";
