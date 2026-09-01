/**
 * Wallet routes — the patient's advance balance.
 *
 * All three are gated on `wallet:manage`, held by CASHIER and FRONT_OFFICE (see
 * @medicore/permissions): taking an advance and handing one back is the cash counter's job.
 * Paths hang off `/patients/:patientId/wallet` because a wallet belongs to a patient — the
 * patient router owns the rest of that prefix; these subpaths are ours.
 */
import { Router } from "express";
import { PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import { responds } from "../../middleware/responds.js";
import { idempotent } from "../../middleware/idempotent.js";
import * as controller from "./wallet.controller.js";
import { walletEntry, walletView } from "./wallet.contract.js";
import { depositSchema, refundSchema } from "./wallet.schema.js";

export function walletRouter(): Router {
  const router = Router();

  router.get(
    "/patients/:patientId/wallet",
    authenticate(),
    authorize(PERMISSIONS.WALLET_MANAGE),
    responds(walletView),
    asyncHandler(controller.getWallet),
  );

  // One ledger entry by id — reprinting an advance receipt. Sits outside the patient prefix
  // because a receipt link carries only the entry id.
  router.get(
    "/wallet/entries/:id",
    authenticate(),
    authorize(PERMISSIONS.WALLET_MANAGE),
    responds(walletEntry),
    asyncHandler(controller.getEntry),
  );

  router.post(
    "/patients/:patientId/wallet/deposits",
    authenticate(),
    authorize(PERMISSIONS.WALLET_MANAGE),
    validate(depositSchema),
    responds(walletView, { status: 201 }),
    idempotent("Replays the advance this key already collected."),
    asyncHandler(controller.deposit),
  );

  router.post(
    "/patients/:patientId/wallet/refunds",
    authenticate(),
    authorize(PERMISSIONS.WALLET_MANAGE),
    validate(refundSchema),
    responds(walletView, { status: 201 }),
    idempotent("Replays the advance refund this key already paid out."),
    asyncHandler(controller.refund),
  );

  return router;
}
