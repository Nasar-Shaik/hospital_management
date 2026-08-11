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
import { tagValidation } from "../core/http/routeInventory.js";

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

/**
 * ── THE SCHEMA IS TAGGED ONTO THE MIDDLEWARE, AND THAT IS THE CONTRACT ──────
 * `tagValidation` stamps the Zod schema onto the returned handler, exactly as the auth factories
 * stamp the permission they enforce. The OpenAPI builder then reads it back off Express's own
 * router stack, so the documented request shape IS the shape that runs — there is no second list
 * to keep in step and no way to document a body the server does not actually validate.
 *
 * This is what closes the gap the contract audit found: 287 `validate()` calls existed and the
 * spec described none of them, because the spec was built from routes alone.
 */
export function validate(schema: ZodTypeAny, target: Target = "body") {
  const handler = (req: Request, _res: Response, next: NextFunction): void => {
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
  return tagValidation(handler, { schema, target });
}
