/**
 * Wallet controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler, Response } from "express";
import type { ApiEnvelope } from "@medicore/types";
import * as wallet from "./wallet.service.js";
import type { DepositBody, RefundBody } from "./wallet.schema.js";

function ok<T>(res: Response, data: T, status = 200): void {
  const body: ApiEnvelope<T> = { success: true, data };
  res.status(status).json(body);
}

/** Balance + recent statement for a patient. */
export const getWallet: RequestHandler = async (req, res) => {
  const { patientId } = req.params as { patientId: string };
  ok(res, await wallet.getWallet(patientId));
};

/** The desk takes an advance (OP advance, admission advance). */
export const deposit: RequestHandler = async (req, res) => {
  const { patientId } = req.params as { patientId: string };
  const body = req.body as DepositBody;
  ok(
    res,
    await wallet.deposit(patientId, {
      amount: body.amount,
      method: body.method,
      ...(body.reference ? { reference: body.reference } : {}),
      ...(body.reason ? { reason: body.reason } : {}),
      ...(body.encounterId ? { encounterId: body.encounterId } : {}),
    }),
    201,
  );
};

/** Money handed back to the patient — leftover advance on discharge. */
export const refund: RequestHandler = async (req, res) => {
  const { patientId } = req.params as { patientId: string };
  const body = req.body as RefundBody;
  ok(
    res,
    await wallet.refund(patientId, {
      amount: body.amount,
      method: body.method,
      ...(body.reference ? { reference: body.reference } : {}),
      ...(body.reason ? { reason: body.reason } : {}),
    }),
    201,
  );
};
