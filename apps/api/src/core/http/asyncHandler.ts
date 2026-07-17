/**
 * Express 4 does not forward rejections from async handlers — an `await` that
 * throws becomes an unhandled rejection and the client hangs until it times out.
 * Every async route MUST be wrapped in this, so failures reach the single error
 * middleware (Doc 09 §7) and come back as a proper error envelope.
 *
 * (Express 5 forwards them natively; keeping this wrapper means the upgrade is a
 * deletion, not a rewrite.)
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";

type AsyncRequestHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

export function asyncHandler(handler: AsyncRequestHandler | RequestHandler): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(handler(req, res, next)).catch(next);
  };
}
