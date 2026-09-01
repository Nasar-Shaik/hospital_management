/**
 * Documents module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5, Module A7).
 *
 * Owns a patient's non-report files: ID proofs, consents, insurance cards, referral letters,
 * outside records. Depends on `patients` (to check the patient exists in scope); nothing depends
 * on it. Storage is bytes-in-the-tenant-DB, the same discipline as `reportFiles` — the sibling it
 * deliberately does NOT share a collection with (different lifecycle: documents can be deleted).
 */
export { documentRouter } from "./document.routes.js";

export {
  uploadDocument,
  listPatientDocuments,
  getDocumentFile,
  deleteDocument,
  DOCUMENT_CATEGORIES,
  type DocumentCategory,
  type DocumentMeta,
  type DocumentBytes,
} from "./document.service.js";

/** Re-points documents onto the survivor on merge. Registered in eventConsumer.ts. */
export { documentConsumers } from "./document.consumers.js";
