/**
 * Request-ID middleware — first link in the Doc 04 §2.1 chain.
 * Full OTel tracing lands in P9; the header contract starts now so every
 * error envelope can carry a traceId from day one (Doc 09 §7).
 */
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header("x-request-id");
  req.traceId = incoming && incoming.length <= 128 ? incoming : randomUUID();
  res.setHeader("x-request-id", req.traceId);
  next();
}
