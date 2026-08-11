/**
 * `Idempotency-Key` — makes a retry safe (Doc 04 §5.1, Doc 03 §5.2, Constitution §7).
 *
 *     router.post(
 *       "/invoices/:id/payments",
 *       authenticate(),
 *       authorize(PERMISSIONS.PAYMENT_COLLECT, FEATURE),
 *       validate(idParamSchema, "params"),
 *       validate(recordPaymentSchema),
 *       responds(invoice, { status: 201 }),
 *       idempotent("Replays the receipt for the payment this key already took."),
 *       asyncHandler(controller.recordPayment),
 *     );
 *
 * ── WHERE IT SITS, AND WHY THAT IS THE ONLY CORRECT PLACE ───────────────────
 * Last in the chain, exactly as Doc 04 §2.1 draws it: `authn → tenant → authz → validate →
 * idempotency`. Every earlier position is a real bug:
 *
 *   before `authenticate` — the key would have no owner, so one hospital's staff could spend
 *                           another's keys, and a replay could hand a receipt to a stranger.
 *   before `authorize`    — a caller with no permission would still consume a key, and could
 *                           park a key on an endpoint to block the person who may use it.
 *   before `validate`     — a malformed body would burn the key, so fixing the typo and
 *                           resubmitting would come back as a 409 conflict instead of working.
 *
 * Placing it after `validate` also means the fingerprint is taken from the PARSED body, which is
 * what makes a retry that reorders its JSON keys, omits a defaulted field, or adds one the schema
 * strips still count as the same request.
 *
 * ── IT IS OPT-IN PER ROUTE, AND THAT IS DELIBERATE ──────────────────────────
 * Not every POST wants this. `POST /encounters/:id/start` is a state transition — sending it
 * twice sets the same state or is refused by the state machine, and there is no second thing to
 * create. Idempotency there costs a write and buys nothing. The rule this codebase applies, and
 * the matrix that records every decision, is in `docs/IDEMPOTENCY.md`.
 *
 * ── HONOURED, NOT DEMANDED ──────────────────────────────────────────────────
 * A request without the header runs exactly as it always has. Making the header mandatory would
 * be a breaking change inside `/v1`, which Doc 04 §5.1 forbids ("additive only; never remove,
 * rename or retype"), and it would silently invalidate the existing billing suite's evidence that
 * the money paths still behave. The per-module `requestId` guards stay underneath either way, so
 * a client that sends nothing is no worse off than before and a client that sends a key is safe.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { createLogger } from "@medicore/logger";
import { getContext } from "../core/context/requestContext.js";
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  ValidationError,
} from "../core/errors/appError.js";
import { asyncHandler } from "../core/http/asyncHandler.js";
import { tagIdempotency, type IdempotencyTag } from "../core/http/routeInventory.js";
import {
  claim,
  complete,
  fingerprint,
  isWellFormedKey,
  release,
  KEY_MAX_LENGTH,
  KEY_MIN_LENGTH,
} from "../core/idempotency/idempotencyStore.js";

const logger = createLogger({ service: "idempotency" });

export const IDEMPOTENCY_HEADER = "Idempotency-Key";

/**
 * Tells the caller this answer came out of the store rather than out of the hospital.
 *
 * Not decoration: a receipt printer that fires on every 201 would print twice for one payment
 * without it, and a mobile client reconciling an offline queue needs to know which of its
 * mutations actually executed on this attempt.
 */
export const REPLAYED_HEADER = "Idempotency-Replayed";

export function idempotent(description: string): RequestHandler {
  const tag: IdempotencyTag = { header: IDEMPOTENCY_HEADER, description };

  const handler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = req.get(IDEMPOTENCY_HEADER)?.trim();
    if (!key) {
      next();
      return;
    }

    if (!isWellFormedKey(key)) {
      /**
       * A 400 rather than "ignore the bad key and carry on". Silently dropping it would mean a
       * client that believes it is protected is not, which is the worst of the three outcomes:
       * worse than refusing, and worse than never having sent one.
       */
      next(
        new ValidationError({
          fields: {
            [IDEMPOTENCY_HEADER]: [
              `must be ${String(KEY_MIN_LENGTH)}–${String(KEY_MAX_LENGTH)} characters of ` +
                `letters, digits, or _ . : @ + -`,
            ],
          },
        }),
      );
      return;
    }

    const ctx = getContext();
    const operation = `${req.method} ${req.baseUrl}${req.route?.path ?? req.path}`;
    const print = fingerprint({
      method: req.method,
      path: req.originalUrl.split("?")[0] ?? req.path,
      query: req.query,
      body: req.body,
      ...(ctx.activeBranchId ? { branchId: ctx.activeBranchId } : {}),
    });

    const result = await claim({ key, fingerprint: print, operation });

    if (result.outcome === "conflict") {
      throw new IdempotencyConflictError({
        key,
        hint: "this key was used for a different request — use a new key for a new operation",
        original: {
          operation: result.record.operation,
          firstSeenAt: result.record.claimedAt,
          ...(result.record.state === "completed"
            ? { status: result.record.responseStatus, response: result.record.response }
            : { status: "still in progress" }),
        },
      });
    }

    if (result.outcome === "in_progress") {
      throw new IdempotencyInProgressError({
        key,
        operation: result.record.operation,
        startedAt: result.record.claimedAt,
        hint: "the first attempt is still running — retry shortly to receive its result",
      });
    }

    if (result.outcome === "replay") {
      res.setHeader(REPLAYED_HEADER, "true");
      res.status(result.status).json(result.body);
      return;
    }

    /**
     * ── CAPTURING THE ANSWER ────────────────────────────────────────────────
     * `res.json` is where every response in this API is produced (`ok()` and the error handler
     * both end there), so wrapping it captures the envelope verbatim — including the status the
     * controller chose. Recording anything reconstructed instead would risk replaying a response
     * subtly unlike the one the first caller received.
     *
     * The store write happens on `finish` rather than inline: `res.json` is synchronous and
     * making the client wait on a bookkeeping write to see its own receipt is the wrong trade.
     * The window this opens is small and safe — a retry arriving inside it finds the claim still
     * `in_progress` and is told so (HMS-REQ-004), which is accurate: the operation ran once.
     *
     * The connection is captured HERE, not read inside the callback. `finish` fires from the
     * socket, outside the request's AsyncLocalStorage, where `getTenantDb()` would throw and the
     * claim would leak.
     */
    const { recordId, connection } = result;
    let captured: unknown;
    const sendJson = res.json.bind(res) as (body: unknown) => Response;
    res.json = ((body: unknown) => {
      captured = body;
      return sendJson(body);
    }) as Response["json"];

    res.on("finish", () => {
      const status = res.statusCode;
      const done =
        status >= 200 && status < 300
          ? complete(connection, recordId, status, captured)
          : release(connection, recordId);
      void done.catch((err: unknown) => {
        // Never fatal: the response has already gone out, and the per-module `requestId` guards
        // still stand underneath. Loud, though — a claim that neither completes nor releases
        // blocks that key until the takeover timeout.
        logger.error({ err, key, operation, status }, "could not settle the idempotency claim");
      });
    });

    next();
  };

  return tagIdempotency(asyncHandler(handler), tag);
}
