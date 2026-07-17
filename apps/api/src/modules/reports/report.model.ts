/**
 * Report files — the scanned or exported documents a diagnostic test produces.
 *
 * ── WHY THE FILE LIVES IN THE TENANT DATABASE ───────────────────────────────
 * A blood report or an X-ray image is PHI, and it belongs to exactly one hospital. Storing it
 * as capped binary in the hospital's OWN database gives tenant isolation for free — the same
 * property every other collection gets from `tenantScopePlugin` — with no second system to
 * secure, back up or reason about. A 16 MB Mongo document ceiling caps a single report; the
 * service refuses anything over 10 MB, which is comfortably above a multi-page PDF or a
 * compressed image and well under the ceiling.
 *
 * At a scale where a hospital stores terabytes of imaging, this moves to object storage
 * (MinIO is already in the stack) behind the SAME repository interface — the model changes,
 * the callers do not. That is recorded as debt; it is deliberately not built now, because a
 * half-integrated object store is more moving parts than a hospital demo needs.
 *
 * ── VISIBLE TO THE DOCTOR IMMEDIATELY, BY DESIGN ────────────────────────────
 * Unlike a structured RESULT (which passes through verify → release, because an unverified
 * value a doctor acts on can kill someone), an uploaded report is a document the technician
 * scanned in — there is no separate approval step, and the ordering doctor sees it as soon as
 * it lands. It carries who uploaded it and when, so provenance is never in doubt.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { tenantScopePlugin } from "../../core/db/plugins/tenantScope.js";
import { auditPlugin } from "../../core/db/plugins/auditPlugin.js";

export interface ReportFileDoc {
  _id: Types.ObjectId;
  tenantId: string;
  branchId?: string;

  /** The order this report answers. */
  orderId: Types.ObjectId;
  encounterId: Types.ObjectId;
  patientId: Types.ObjectId;
  episodeId: Types.ObjectId;

  /** `lab` | `radiology` | `procedure` — how the doctor's report list is grouped. */
  category: string;
  /** The test name, denormalized so the list reads without a join to the order. */
  testName: string;
  /** The visit's date, denormalized from the encounter so reports group by appointment. */
  visitDate: Date;

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

const reportFileSchema = new Schema<ReportFileDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String },

    orderId: { type: Schema.Types.ObjectId, required: true },
    encounterId: { type: Schema.Types.ObjectId, required: true },
    patientId: { type: Schema.Types.ObjectId, required: true },
    episodeId: { type: Schema.Types.ObjectId, required: true },

    category: { type: String, required: true },
    testName: { type: String, required: true, trim: true, maxlength: 200 },
    visitDate: { type: Date, required: true },

    filename: { type: String, required: true, trim: true, maxlength: 260 },
    contentType: { type: String, required: true, maxlength: 100 },
    size: { type: Number, required: true },
    data: { type: Buffer, required: true },

    uploadedBy: { type: String, required: true },
    uploadedAt: { type: Date, required: true },
  },
  { timestamps: true, collection: "reportFiles", autoIndex: false },
);

reportFileSchema.plugin(tenantScopePlugin);

/**
 * PHI. `data`, `filename` and `testName` are excluded from the audit diff — a report's
 * bytes and a test name (which is a diagnosis) must not become a second copy of the chart in
 * the audit log. The audit records THAT a report was added, by whom.
 */
reportFileSchema.plugin(auditPlugin, {
  resource: "reportFile",
  category: "phi",
  ignore: ["data", "filename", "testName"],
});

export function getReportFileModel(conn: Connection): Model<ReportFileDoc> {
  return (
    (conn.models.ReportFile as Model<ReportFileDoc>) ??
    conn.model<ReportFileDoc>("ReportFile", reportFileSchema)
  );
}
