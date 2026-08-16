/**
 * Single global error middleware (Doc 09 §7): maps AppError → envelope,
 * hides internals on unexpected errors, always includes traceId.
 */
import type { NextFunction, Request, Response } from "express";
import type { Logger } from "@medicore/logger";
import type { ApiEnvelope } from "@medicore/types";
import { AppError } from "../errors/appError.js";
import { tryGetContext } from "../context/requestContext.js";

export function notFoundHandler(req: Request, res: Response): void {
  const body: ApiEnvelope<never> = {
    success: false,
    error: { code: "HMS-GEN-404", message: "Route not found", traceId: req.traceId },
  };
  res.status(404).json(body);
}

export function errorHandler(logger: Logger) {
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    if (err instanceof AppError) {
      const body: ApiEnvelope<never> = {
        success: false,
        error: { code: err.code, message: err.message, details: err.details, traceId: req.traceId },
      };
      // RFC 9110 §10.2.3. Set here rather than at each throw site so a refusal cannot carry the
      // advice in its body and forget it in the headers.
      if (err.retryAfterSeconds !== undefined) {
        res.setHeader("Retry-After", String(err.retryAfterSeconds));
      }

      /**
       * ── A 5xx REFUSAL MUST LEAVE A TRACE ON THE SERVER, NOT ONLY ON A SCREEN ──
       * `AppError` returned without a word in the log, which is right for the 4xx crowd — a 404 or
       * a failed validation is the API working, and logging every one of them is noise.
       *
       * It is wrong for 5xx. The clinical schema refusals (HMS-MAR-002, HMS-PHM-004, HMS-ORD-001,
       * HMS-ADM-003, HMS-ENC-001) put the missing rule and its migration in `details` and sent the
       * only copy to the person holding the phone. An operator watching a spike of 503s could see
       * the tenant, the path and the status from the request log — and had to ask a nurse to read
       * their screen to find out WHICH index was gone.
       *
       * `details` is safe to log for these by construction: it carries rule names, migration ids
       * and index shapes, never patient data. That is a property of the 5xx codes we raise, so it
       * is asserted by `errorContract.test.ts` rather than assumed here.
       */
      if (err.httpStatus >= 500) {
        const tenant = tryGetContext()?.tenantSlug;
        logger.error(
          {
            code: err.code,
            status: err.httpStatus,
            path: req.path,
            traceId: req.traceId,
            // Same source and same field name the request log uses, so the two lines join.
            ...(tenant ? { tenant } : {}),
            ...(err.retryAfterSeconds !== undefined
              ? { retryAfterSeconds: err.retryAfterSeconds }
              : {}),
            details: err.details,
          },
          "request refused with a 5xx — an operator needs this without asking a clinician",
        );
      }

      res.status(err.httpStatus).json(body);
      return;
    }
    // Unexpected: log full, return generic (no internals leak — Doc 09 §7).
    logger.error({ err, traceId: req.traceId, path: req.path }, "unhandled error");
    const body: ApiEnvelope<never> = {
      success: false,
      error: { code: "HMS-GEN-500", message: "Something went wrong", traceId: req.traceId },
    };
    res.status(500).json(body);
  };
}
