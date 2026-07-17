/**
 * Request validation (Doc 04 §2.1 chain, Doc 09 §6).
 *
 * The ONE place a Zod failure becomes an HMS-VAL-001 response, so every endpoint
 * on the platform reports field errors in the same shape. Validated data replaces
 * the raw input, so handlers work with parsed, coerced, defaulted values and
 * never with `req.body as SomeType`.
 */
import type { NextFunction, Request, Response } from "express";
import type { ZodError, ZodTypeAny } from "@medicore/validation";
import { ValidationError } from "../core/errors/appError.js";

type Target = "body" | "query" | "params";

/** `{ field: [messages] }` — the shape ERROR_CODES documents for `details.fields`. */
function fieldErrors(error: ZodError): Record<string, string[]> {
  const fields: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const path = issue.path.join(".") || "_";
    (fields[path] ??= []).push(issue.message);
  }
  return fields;
}

export function validate(schema: ZodTypeAny, target: Target = "body") {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[target]);
    if (!result.success) {
      next(new ValidationError({ fields: fieldErrors(result.error) }));
      return;
    }
    // `req.query`/`req.params` are getter-backed in Express 5; assigning through
    // a cast keeps this working on both 4 and 5.
    (req as unknown as Record<Target, unknown>)[target] = result.data;
    next();
  };
}
