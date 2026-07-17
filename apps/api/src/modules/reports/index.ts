/**
 * Reports module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5).
 *
 * The scanned/exported documents a diagnostic test produces: uploaded against an order by the
 * technician, read by the ordering doctor. Depends on `orders` (a report answers an order);
 * nothing depends on this, so the graph stays acyclic.
 *
 * NOT a platform module: healthcare vocabulary throughout (PLATFORM_STRATEGY §2).
 */
export { reportRouter } from "./report.routes.js";
export {
  uploadReport,
  listPatientReports,
  getReportFile,
  type ReportMeta,
  type ReportBytes,
} from "./report.service.js";
