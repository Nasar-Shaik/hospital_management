/**
 * Patient documents (Module A7) — the scans and files a patient's record accumulates that are
 * NOT a diagnostic report: an ID proof, a signed consent, an insurance card, a referral letter,
 * an outside hospital's summary.
 *
 * ── WHY THIS IS SEPARATE FROM `reportFiles` ─────────────────────────────────
 * A report file answers an ORDER — it inherits the order's patient, episode and test, and it is
 * clinical PHI a doctor acts on. A document answers the PATIENT — it is attached to the person
 * (optionally to one visit), it is administrative as often as clinical, and it can be DELETED
 * (an ID scanned onto the wrong patient must be removable, unlike a signed clinical record which
 * is immutable). Same storage discipline, different lifecycle — so a sibling collection rather
 * than a column on an existing one.
 *
 * ── STORAGE: BYTES IN THE TENANT DB (same rationale as reportFiles) ─────────
 * The bytes live as capped binary in the hospital's OWN database: tenant isolation for free from
 * `tenantScopePlugin`, no second system to secure or back up. The service refuses anything over
 * 10 MB, comfortably above a multi-page PDF or a photo and well under Mongo's 16 MB ceiling. At a
 * scale where documents run to terabytes this moves to object storage (MinIO is in the stack)
 * behind the SAME repository interface — recorded as debt, deliberately not built now.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { tenantScopePlugin } from "../../core/db/plugins/tenantScope.js";
import { auditPlugin } from "../../core/db/plugins/auditPlugin.js";

/** How the document is filed — drives the grouping and the icon on the patient's Documents tab. */
export const DOCUMENT_CATEGORIES = [
  "id_proof",
  "consent",
  "insurance",
  "referral",
  "discharge",
  "clinical_image",
  "external_record",
  "other",
] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

export interface DocumentDoc {
  _id: Types.ObjectId;
  tenantId: string;
  branchId?: string;

  patientId: Types.ObjectId;
  /** The visit this document belongs to, when it is visit-specific. Absent for record-level docs. */
  encounterId?: Types.ObjectId;

  category: DocumentCategory;
  /** A human label — "Aadhaar card", "Surgery consent", "Referral from Dr Rao". */
  title: string;

  filename: string;
  contentType: string;
  size: number;
  /** The bytes. Excluded from every list query — only the download reads it. */
  data: Buffer;

  uploadedBy: string;
  uploadedAt: Date;

  createdAt: Date;
  updatedAt: Date;
}

const documentSchema = new Schema<DocumentDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String },

    patientId: { type: Schema.Types.ObjectId, required: true },
    encounterId: { type: Schema.Types.ObjectId },

    category: { type: String, enum: DOCUMENT_CATEGORIES, required: true, default: "other" },
    title: { type: String, required: true, trim: true, maxlength: 200 },

    filename: { type: String, required: true, trim: true, maxlength: 260 },
    contentType: { type: String, required: true, maxlength: 100 },
    size: { type: Number, required: true },
    data: { type: Buffer, required: true },

    uploadedBy: { type: String, required: true },
    uploadedAt: { type: Date, required: true },
  },
  { timestamps: true, collection: "documents", autoIndex: false },
);

documentSchema.plugin(tenantScopePlugin);

/**
 * PHI. `data`, `filename` and `title` are excluded from the audit diff — a document's bytes and
 * even its title ("HIV test consent") can disclose a diagnosis, and must not become a second copy
 * of the chart in the audit log. The audit records THAT a document was added or removed, by whom.
 */
documentSchema.plugin(auditPlugin, {
  resource: "document",
  category: "phi",
  ignore: ["data", "filename", "title"],
});

export function getDocumentModel(conn: Connection): Model<DocumentDoc> {
  return (
    (conn.models.Document as Model<DocumentDoc>) ??
    conn.model<DocumentDoc>("Document", documentSchema)
  );
}
