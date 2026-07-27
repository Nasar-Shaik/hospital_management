/**
 * OpenAPI generation (Module A9 / P0 baseline).
 *
 * ── GENERATED FROM THE SHIPPED APP, NOT HAND-WRITTEN ────────────────────────
 * The spec is built from `routeInventory` — the same introspection the RBAC matrix trusts — so it
 * lists exactly the routes that shipped, each with the security it actually enforces. A hand-kept
 * OpenAPI file drifts the moment someone adds a route and forgets the doc; this one cannot, because
 * there is no second list to forget.
 *
 * ── WHAT THIS BASELINE COVERS, AND WHAT IT DOES NOT ─────────────────────────
 * It documents every path, method, path parameter, security requirement, and — as `x-permission` /
 * `x-feature` extensions — the authorization each route enforces. It deliberately does NOT yet
 * describe request/response BODIES: those live as Zod DTOs per module, and wiring each into the
 * spec is the next increment. A route map with accurate security is the useful 80% an integrator
 * needs first; the bodies are the enriching 20% that follows.
 */
import type { Application } from "express";
import { routeInventory, type RouteInfo } from "./routeInventory.js";

interface OpenApiOptions {
  title?: string;
  version?: string;
}

/** The first path segment after the version — `/api/v1/patients/:id` → `patients`. */
function tagOf(path: string): string {
  const m = /^\/api\/(?:platform\/)?v\d+\/([^/]+)/.exec(path);
  if (!m?.[1]) return "misc";
  // A path param as the first segment is rare; fall back to a stable label.
  return m[1].startsWith(":") ? "misc" : m[1];
}

/** Express `:param` → OpenAPI `{param}`, and the parameter objects that path needs. */
function pathAndParams(path: string): { oapiPath: string; params: object[] } {
  const params: object[] = [];
  const oapiPath = path.replace(/:([A-Za-z0-9_]+)/g, (_all, name: string) => {
    params.push({
      name,
      in: "path",
      required: true,
      schema: { type: "string" },
    });
    return `{${name}}`;
  });
  return { oapiPath, params };
}

function operationId(method: string, oapiPath: string): string {
  const slug = oapiPath
    .replace(/^\/api\//, "")
    .replace(/[{}]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${method.toLowerCase()}_${slug}`;
}

/**
 * Builds the OpenAPI 3.1 document from a route inventory. Pure — give it the routes, get the spec;
 * the caller decides where the routes came from (the live app, or a script booting it).
 */
export function buildOpenApiSpec(routes: RouteInfo[], opts: OpenApiOptions = {}): object {
  const paths: Record<string, Record<string, unknown>> = {};
  const tags = new Set<string>();

  // Only the versioned API is a contract for integrators — health checks and the like are noise.
  const documented = routes.filter((r) => /^\/api\/(?:platform\/)?v\d+\//.test(r.path));

  for (const route of documented) {
    const { oapiPath, params } = pathAndParams(route.path);
    const tag = tagOf(route.path);
    tags.add(tag);

    const secured = route.authenticates || route.platformAuth === true;

    const operation: Record<string, unknown> = {
      operationId: operationId(route.method, oapiPath),
      tags: [tag],
      summary: `${route.method} ${oapiPath}`,
      ...(params.length ? { parameters: params } : {}),
      // The `{ success, data }` / `{ error }` envelope is universal; bodies come in a later pass.
      responses: {
        "200": { description: "Success — `{ success: true, data }`." },
        default: {
          description: "Error — `{ error: { code, message, details?, traceId } }`.",
          content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } },
        },
      },
      // Both a session access token and an API key travel as `Authorization: Bearer <token>`.
      security: secured ? [{ bearerAuth: [] }] : [],
      ...(route.permission ? { "x-permission": route.permission } : {}),
      ...(route.feature ? { "x-feature": route.feature } : {}),
      ...(route.platformAuth ? { "x-operator": true } : {}),
      ...(route.platformRoles?.length ? { "x-operator-roles": route.platformRoles } : {}),
    };

    paths[oapiPath] ??= {};
    paths[oapiPath][route.method.toLowerCase()] = operation;
  }

  return {
    openapi: "3.1.0",
    info: {
      title: opts.title ?? "MediCore HMS API",
      version: opts.version ?? "1.0.0",
      description:
        "The MediCore HMS tenant API. Every path is resolved against the hospital in the request " +
        "host (the hostname IS the tenant). Authenticated routes accept a session access token or " +
        "an API key as `Authorization: Bearer <token>`. The `x-permission` and `x-feature` " +
        "extensions state the authorization each route enforces.",
    },
    servers: [
      { url: "/", description: "The hospital's own host (e.g. https://apollo.example.com)" },
    ],
    tags: [...tags].sort().map((name) => ({ name })),
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "A session access token OR an API key (`mk_…`).",
        },
      },
      schemas: {
        ApiError: {
          type: "object",
          properties: {
            error: {
              type: "object",
              properties: {
                code: { type: "string", example: "HMS-AUTH-005" },
                message: { type: "string" },
                details: { type: "object", additionalProperties: true },
                traceId: { type: "string" },
              },
              required: ["code", "message"],
            },
          },
          required: ["error"],
        },
      },
    },
    paths,
  };
}

/** Builds the spec straight from a live Express app. */
export function specFromApp(app: Application, opts: OpenApiOptions = {}): object {
  return buildOpenApiSpec(routeInventory(app), opts);
}
