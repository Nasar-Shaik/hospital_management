/**
 * Report service — uploading a diagnostic report and reading a patient's reports.
 *
 * The upload attaches a file to an ORDER: the order already knows the patient, the episode,
 * the department and the test name, so the technician supplies only the file. That is also
 * what makes the report land on the right doctor's patient — it inherits the order's context
 * rather than trusting the uploader to name it.
 */
import { AppError } from "../../core/errors/appError.js";
import { getOrder } from "../orders/index.js";
import * as repo from "./report.repository.js";

export type { ReportMeta, ReportBytes } from "./report.repository.js";

/** 10 MB. Above a multi-page PDF or a compressed image, well under Mongo's 16 MB ceiling. */
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * The most orders one worklist lookup may ask about. The lab page fetches a single patient's
 * orders, so a handful; the cap is what stops the same route being used to walk the collection.
 * Matches the ceiling `orderPaymentStatus` puts on the same screen's payment lookup.
 */
const MAX_ORDERS_PER_LOOKUP = 100;

const ALLOWED_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
]);

export interface UploadReportInput {
  orderId: string;
  filename: string;
  contentType: string;
  /** The file, base64-encoded (the browser reads it as a data URL and sends the payload). */
  dataBase64: string;
}

export async function uploadReport(input: UploadReportInput): Promise<repo.ReportMeta> {
  const order = await getOrder(input.orderId);
  if (!order) throw new AppError("HMS-GEN-404", 404, "Order not found", { orderId: input.orderId });

  if (!ALLOWED_TYPES.has(input.contentType)) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      contentType: [`unsupported file type "${input.contentType}" — upload a PDF or an image`],
    });
  }

  const data = Buffer.from(input.dataBase64, "base64");
  if (data.length === 0) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", { file: ["the file is empty"] });
  }
  if (data.length > MAX_BYTES) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      file: [`the file is ${(data.length / 1024 / 1024).toFixed(1)} MB — the limit is 10 MB`],
    });
  }

  return repo.create({
    orderId: order.id,
    encounterId: order.encounterId,
    patientId: order.patientId,
    episodeId: order.episodeId,
    category: order.category,
    testName: order.name,
    // The order's own timestamp — the report belongs to the visit the test was ordered in.
    visitDate: order.orderedAt,
    filename: input.filename,
    contentType: input.contentType,
    size: data.length,
    data,
    ...(order.branchId ? { branchId: order.branchId } : {}),
  });
}

/**
 * The reports attached to a set of orders — the lab worklist's read, reachable with `order:read`.
 * Capped so a caller cannot turn one request into a scan of the collection.
 */
export async function reportsForOrders(orderIds: string[]): Promise<repo.ReportMeta[]> {
  return repo.listForOrders(orderIds.slice(0, MAX_ORDERS_PER_LOOKUP));
}

export async function listPatientReports(patientId: string): Promise<repo.ReportMeta[]> {
  return repo.listForPatient(patientId);
}

export async function getReportFile(id: string): Promise<repo.ReportBytes | undefined> {
  return repo.getBytes(id);
}
