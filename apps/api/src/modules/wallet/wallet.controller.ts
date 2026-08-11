/**
 * Wallet controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler } from "express";
import * as wallet from "./wallet.service.js";
import type { DepositBody, RefundBody } from "./wallet.schema.js";
import { ok } from "../../core/http/respond.js";

/** Balance + recent statement for a patient. */
export const getWallet: RequestHandler = async (req, res) => {
  const { patientId } = req.params as { patientId: string };
  ok(res, await wallet.getWallet(patientId));
};

/** One ledger entry by id — for reprinting an advance (deposit) receipt later. */
export const getEntry: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await wallet.getEntry(id));
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
