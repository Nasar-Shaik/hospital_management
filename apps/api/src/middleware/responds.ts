/**
 * Declares the success payload a route sends (Doc 04 §5.1).
 *
 *     router.get(
 *       "/patients",
 *       authenticate(),
 *       authorize(PERMISSIONS.PATIENT_READ),
 *       validate(listPatientsQuerySchema, "query"),
 *       responds(patient.array(), { meta: true }),
 *       asyncHandler(controller.listPatients),
 *     );
 *
 * ── WHY IT SITS IN THE CHAIN RATHER THAN ON THE CONTROLLER ──────────────────
 * Same reason `validate()` and `authorize()` do: the route file is where a reviewer looks to
 * answer "what does this endpoint do", and a declaration that lives anywhere else is a
 * declaration somebody will forget to change. Reading it back off Express's own router stack also
 * means the spec describes routes that SHIPPED — a contract schema attached to a controller
 * nobody mounted would document an endpoint that does not exist.
 *
 * ── AND WHY IT IS NOT A NO-OP ───────────────────────────────────────────────
 * Outside production it verifies the claim. `ok()` parses the JSON it is about to send against
 * this schema and throws if it does not match, which turns the whole integration suite into a
 * contract conformance test: 1,409 tests already exercise these endpoints with real data, and
 * every one of them now also asserts the response is the shape the spec promises.
 *
 * That is the difference between a documented contract and a true one. `Proves<>` shows the schema
 * matches the DTO's TYPE; this shows the running server actually produces it — which catches the
 * things types cannot, like a controller sending `{ order }` where the contract says `Order`.
 *
 * It is off in production: a hospital's response should not fail because a schema is wrong, and
 * the check has already run thousands of times before a build ships.
 */
import type { NextFunction, Request, Response } from "express";
import type { ZodTypeAny } from "@medicore/validation";
import { tagResponse, type ResponseTag } from "../core/http/routeInventory.js";

export interface RespondsOptions {
  /** Success statuses this route can send. Default `200`; `[200, 201]` where a create can resume. */
  status?: number | number[];
  /** True when the route sends `meta` alongside `data` — a paginated list. */
  meta?: boolean;
  description?: string;
}

/** Where `ok()` finds the schema for the route it is answering. */
export const CONTRACT_LOCAL = "responseContract";

export function responds(schema: ZodTypeAny, opts: RespondsOptions = {}) {
  const statuses = Array.isArray(opts.status) ? opts.status : [opts.status ?? 200];
  const tag: ResponseTag = {
    schema,
    statuses,
    meta: opts.meta ?? false,
    ...(opts.description ? { description: opts.description } : {}),
  };

  const handler = (_req: Request, res: Response, next: NextFunction): void => {
    (res.locals as Record<string, unknown>)[CONTRACT_LOCAL] = tag;
    next();
  };
  return tagResponse(handler, tag);
}
