/**
 * Pharmacy controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler, Response } from "express";
import type { ApiEnvelope } from "@medicore/types";
import * as pharmacy from "./pharmacy.service.js";
import type { DispenseBody } from "./pharmacy.schema.js";

function ok<T>(res: Response, data: T, status = 200): void {
  const body: ApiEnvelope<T> = { success: true, data };
  res.status(status).json(body);
}

/**
 * Hands the drugs over.
 *
 * Returns **200 with `duplicate: true`** when this `requestId` had already dispensed —
 * not a 409, and not an error. A retry that gets an error will be retried again; a retry
 * that gets the handover it asked for is finished. 201 only when drugs actually moved.
 */
export const dispense: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const body = req.body as DispenseBody;

  const result = await pharmacy.dispenseAndClear({
    prescriptionId: id,
    items: body.items,
    ...(body.requestId ? { requestId: body.requestId } : {}),
    ...(body.creditOverride ? { creditOverride: body.creditOverride } : {}),
  });

  ok(res, result, result.duplicate ? 200 : 201);
};

/** The handover ledger for one prescription — who gave what, when. */
export const listDispenses: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await pharmacy.dispensesFor(id));
};
