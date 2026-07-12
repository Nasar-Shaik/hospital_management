/**
 * Single global error middleware (Doc 09 §7): maps AppError → envelope,
 * hides internals on unexpected errors, always includes traceId.
 */
import type { NextFunction, Request, Response } from "express";
import type { Logger } from "@medicore/logger";
import type { ApiEnvelope } from "@medicore/types";
import { AppError } from "../errors/appError.js";

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
