/**
 * The success half of the response envelope (Doc 04 §5.1).
 *
 * ── WHY THIS IS ONE FUNCTION AND NOT THIRTY-NINE ────────────────────────────
 * Every controller declared its own `ok()`. They were not quite the same function: four distinct
 * signatures had grown, and one of them took `meta` in the THIRD position where the other thirty-
 * eight took an HTTP status. Nothing caught it, because each copy was locally consistent — the
 * mismatch only existed between files, which is exactly where nothing was looking.
 *
 * That is the real cost of a copied helper: not the duplication, but that the copies diverge in
 * ways no single file can be wrong about. A response envelope is the one shape every client on
 * every platform depends on, so it gets one definition.
 *
 * The errors half already worked this way — `errorHandler.ts` is the only place an error envelope
 * is produced, which is why `{ error: { code, message, details?, traceId } }` never drifted.
 */
import type { Response } from "express";
import type { ApiEnvelope, PageMeta } from "@medicore/types";

/**
 * Sends `{ success: true, data }`, plus `meta` for a paginated list.
 *
 * `status` before `meta` because the overwhelming majority of call sites pass a status (201 on a
 * create) and never a meta — and because it preserves the signature 38 of the 39 copies already
 * had, so migrating them is a deletion rather than a rewrite.
 */
export function ok<T>(res: Response, data: T, status = 200, meta?: PageMeta): void {
  const body: ApiEnvelope<T> = { success: true, data, ...(meta ? { meta } : {}) };
  res.status(status).json(body);
}
