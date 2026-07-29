/**
 * Lab catalogue module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5, Module D6).
 *
 * Owns the laboratory's test master. A leaf: ordering and result entry READ it (by code), but it
 * reads nothing operational and stores no PHI, so the graph stays acyclic.
 */
export { labCatalogueRouter } from "./labTest.routes.js";

export {
  listTests,
  getTestByCode,
  createTest,
  updateTest,
  type LabTest,
  type Analyte,
} from "./labTest.service.js";
