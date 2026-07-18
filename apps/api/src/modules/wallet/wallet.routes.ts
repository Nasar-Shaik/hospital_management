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
import * as controller from "./wallet.controller.js";
import { depositSchema, refundSchema } from "./wallet.schema.js";

export function walletRouter(): Router {
  const router = Router();

  router.get(
    "/patients/:patientId/wallet",
    authenticate(),
    authorize(PERMISSIONS.WALLET_MANAGE),
    asyncHandler(controller.getWallet),
  );

  router.post(
    "/patients/:patientId/wallet/deposits",
    authenticate(),
    authorize(PERMISSIONS.WALLET_MANAGE),
    validate(depositSchema),
    asyncHandler(controller.deposit),
  );

  router.post(
    "/patients/:patientId/wallet/refunds",
    authenticate(),
    authorize(PERMISSIONS.WALLET_MANAGE),
    validate(refundSchema),
    asyncHandler(controller.refund),
  );

  return router;
}
