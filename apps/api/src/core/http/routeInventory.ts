/**
 * Route inventory — makes the API's authorization surface INTROSPECTABLE.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * The three-layer `authorize` chain (ADR-0010) is only as good as its weakest
 * route, and the weakest route is always the one somebody forgot to protect. That
 * failure is invisible by construction: a route with no `authorize()` does not
 * throw, does not warn, and does not look different in a diff — it just quietly
 * answers everybody. Reviewing for it by eye works right up until the day it
 * doesn't, and in this product that day involves patient records.
 *
 * So the middleware TAGS itself with what it enforces, and this module reads the
 * tags back off Express's own router stack. The result is a list of every route
 * that actually shipped, with the permission and feature flag each one actually
 * requires — not what a developer believes it requires, and not what a doc says.
 *
 * The RBAC matrix suite then asserts two things against it:
 *
 *   1. Every route under /api/v1 is either explicitly PUBLIC or carries both
 *      `authenticate()` and `authorize(...)`. A new unprotected route fails CI.
 *   2. Every protected route appears in the matrix with an expected outcome per
 *      role. Adding a route without deciding who may call it fails CI.
 *
 * That is the difference between testing authorization and testing the
 * authorization we *remembered to test*. It is why the suite is release-gating.
 */
import type { Application, RequestHandler } from "express";
import type { ZodTypeAny } from "@medicore/validation";

/** The tag the auth middleware factories stamp onto themselves. */
export interface AuthTag {
  /** Behind `authenticate()` — a tenant user's access token. */
  authenticates?: boolean;
  /** The permission code this route requires (layer 2). */
  permission?: string;
  /** The feature flag the hospital must have bought (layer 1). */
  feature?: string;
  /**
   * Behind `authenticatePlatform()` — an OPERATOR token, which is a different
   * population entirely (master DB, no `tid`, cannot authorize inside a hospital).
   *
   * Tagged separately rather than reusing `authenticates`, because conflating them
   * is exactly the mistake that would matter: the two token types are mutually
   * rejecting, and a report that showed both as "authenticated" would hide a route
   * mounted on the wrong side of the tenancy boundary.
   */
  platformAuth?: boolean;
  /** Operator roles permitted (SUPER_ADMIN / SUPPORT). Empty = any operator. */
  platformRoles?: string[];
}

const TAG = Symbol.for("medicore.authTag");
const VALIDATION_TAG = Symbol.for("medicore.validationTag");
const RESPONSE_TAG = Symbol.for("medicore.responseTag");

/** Stamps a middleware with what it enforces. Called by the middleware factories. */
export function tagMiddleware<T extends RequestHandler>(handler: T, tag: AuthTag): T {
  (handler as unknown as Record<symbol, AuthTag>)[TAG] = tag;
  return handler;
}

function readTag(handler: unknown): AuthTag | undefined {
  return (handler as Record<symbol, AuthTag> | undefined)?.[TAG];
}

/**
 * The request shape a route actually validates (`validate()` stamps this).
 *
 * Deliberately a SEPARATE symbol from the auth tag: they answer different questions and are
 * merged differently. A route carries at most one auth tag, but up to three validations (body,
 * params, query), so merging them into one bag would silently drop two of the three.
 */
export interface ValidationTag {
  schema: ZodTypeAny;
  target: "body" | "query" | "params";
}

export function tagValidation<T extends RequestHandler>(handler: T, tag: ValidationTag): T {
  (handler as unknown as Record<symbol, ValidationTag>)[VALIDATION_TAG] = tag;
  return handler;
}

function readValidation(handler: unknown): ValidationTag | undefined {
  return (handler as Record<symbol, ValidationTag> | undefined)?.[VALIDATION_TAG];
}

/**
 * The success payload a route actually sends (`responds()` stamps this).
 *
 * A third symbol for the same reason as the second: this answers "what comes back", which is a
 * different question from "what may go in" and from "who may ask". Merging the three bags would
 * mean a route could only ever declare one of them.
 */
export interface ResponseTag {
  /** The shape of `data` inside the envelope — NOT the envelope itself. */
  schema: ZodTypeAny;
  /** Every success status this route can send. Two entries where a create can also resume. */
  statuses: number[];
  /** True when the route also sends `meta` (a paginated list). */
  meta: boolean;
  description?: string;
}

export function tagResponse<T extends RequestHandler>(handler: T, tag: ResponseTag): T {
  (handler as unknown as Record<symbol, ResponseTag>)[RESPONSE_TAG] = tag;
  return handler;
}

function readResponse(handler: unknown): ResponseTag | undefined {
  return (handler as Record<symbol, ResponseTag> | undefined)?.[RESPONSE_TAG];
}

export interface RouteInfo {
  method: string;
  /** The full mounted path, e.g. `/api/v1/patients/:id`. */
  path: string;
  authenticates: boolean;
  permission?: string;
  feature?: string;
  platformAuth?: boolean;
  platformRoles?: string[];
  /** The Zod schemas this route validates against, by target. Feeds the OpenAPI request shapes. */
  validation?: Partial<Record<ValidationTag["target"], ZodTypeAny>>;
  /** The success payload this route declares. Feeds the OpenAPI response schemas. */
  response?: ResponseTag;
}

/**
 * Walks Express's router stack and reports every registered route.
 *
 * This reads the SHIPPED app — the same object `createApp` hands to the server —
 * so it cannot drift from reality the way a hand-maintained list would. If a route
 * is reachable in production, it is in here.
 */
export function routeInventory(app: Application): RouteInfo[] {
  const routes: RouteInfo[] = [];

  interface Layer {
    name?: string;
    route?: {
      path: string;
      methods: Record<string, boolean>;
      stack: { handle?: unknown; name?: string }[];
    };
    handle?: { stack?: Layer[] };
    regexp?: RegExp;
  }

  /**
   * Express stores a mounted router's prefix as a REGEX, not a string, so the
   * prefix has to be recovered from `layer.regexp.source`. Ugly, and there is no
   * public API for it — but the alternative is maintaining a parallel list of
   * routes by hand, which is exactly the thing that goes stale and lets an
   * unprotected route through.
   */
  const prefixOf = (layer: Layer): string => {
    const source = layer.regexp?.source;
    if (!source || source === "^\\/?(?=\\/|$)") return "";
    return source
      .replace(/^\^/, "")
      .replace(/\\\/\?\(\?=\\\/\|\$\)$/, "")
      .replace(/\$$/, "")
      .replace(/\\\//g, "/");
  };

  const walk = (stack: Layer[], prefix: string): void => {
    for (const layer of stack) {
      if (layer.route) {
        const tag: AuthTag = {};
        const validation: Partial<Record<ValidationTag["target"], ZodTypeAny>> = {};
        let response: ResponseTag | undefined;
        for (const entry of layer.route.stack) {
          Object.assign(tag, readTag(entry.handle) ?? {});
          const v = readValidation(entry.handle);
          // Last one wins per target, matching Express: the final middleware to parse a
          // target is the one whose shape the handler actually receives.
          if (v) validation[v.target] = v.schema;
          response ??= readResponse(entry.handle);
        }
        const hasValidation = Object.keys(validation).length > 0;

        for (const method of Object.keys(layer.route.methods)) {
          routes.push({
            method: method.toUpperCase(),
            path: prefix + layer.route.path,
            authenticates: tag.authenticates === true,
            ...(tag.permission ? { permission: tag.permission } : {}),
            ...(tag.feature ? { feature: tag.feature } : {}),
            ...(tag.platformAuth ? { platformAuth: true } : {}),
            ...(tag.platformRoles ? { platformRoles: tag.platformRoles } : {}),
            ...(hasValidation ? { validation } : {}),
            ...(response ? { response } : {}),
          });
        }
      } else if (layer.handle?.stack) {
        walk(layer.handle.stack, prefix + prefixOf(layer));
      }
    }
  };

  const root = (app as unknown as { _router?: { stack: Layer[] } })._router;
  if (!root) throw new Error("could not read the Express router stack — cannot audit routes");

  walk(root.stack, "");
  return routes;
}
