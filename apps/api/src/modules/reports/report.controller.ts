/**
 * Report controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler, Response } from "express";
import type { ApiEnvelope } from "@medicore/types";
import { AppError } from "../../core/errors/appError.js";
import * as reports from "./report.service.js";
import type { UploadReportBody } from "./report.schema.js";

function ok<T>(res: Response, data: T, status = 200): void {
  const body: ApiEnvelope<T> = { success: true, data };
  res.status(status).json(body);
}

export const uploadReport: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const body = req.body as UploadReportBody;
  ok(
    res,
    await reports.uploadReport({
      orderId: id,
      filename: body.filename,
      contentType: body.contentType,
      dataBase64: body.dataBase64,
    }),
    201,
  );
};

export const listPatientReports: RequestHandler = async (req, res) => {
  const { patientId } = req.params as { patientId: string };
  ok(res, await reports.listPatientReports(patientId));
};

/**
 * Streams the file itself. Not wrapped in the `{ success, data }` envelope — it is bytes,
 * `inline` so a PDF or image opens in the browser tab rather than forcing a download.
 */
export const downloadReport: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const file = await reports.getReportFile(id);
  if (!file) throw new AppError("HMS-GEN-404", 404, "Report not found", { id });

  res.setHeader("Content-Type", file.contentType);
  res.setHeader("Content-Disposition", `inline; filename="${file.filename.replace(/["\\]/g, "")}"`);
  res.send(file.data);
};
