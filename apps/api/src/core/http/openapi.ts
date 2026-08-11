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
import type { ZodTypeAny } from "@medicore/validation";
import { zodToJsonSchema } from "zod-to-json-schema";
import { routeInventory, type RouteInfo } from "./routeInventory.js";

type JsonSchema = Record<string, unknown>;

/**
 * A Zod schema as OpenAPI-flavoured JSON Schema.
 *
 * `target: "openApi3"` because OpenAPI 3.1's dialect differs from raw JSON Schema in ways that
 * break generators (`nullable` vs `type: [x, "null"]`, and `$ref` siblings). Schemas are INLINED
 * rather than lifted into `components`: a Zod schema is an anonymous object by the time it reaches
 * this middleware, so any component name would have to be invented from the operation id — which
 * reads like a real DTO name while being nothing of the sort, and would make two structurally
 * identical bodies look like two different types. Inline is less pretty and does not lie.
 */
function toJsonSchema(schema: ZodTypeAny): JsonSchema {
  const out = zodToJsonSchema(schema, {
    target: "openApi3",
    $refStrategy: "none",
  }) as JsonSchema;
  // `$schema` is meaningless inside an OpenAPI document and makes the file noisier to diff.
  delete out.$schema;
  return out;
}

/** The top-level properties of an object schema — used to type path params individually. */
function jsonSchemaProperties(schema: ZodTypeAny): Record<string, JsonSchema> {
  const converted = toJsonSchema(schema);
  return (converted.properties as Record<string, JsonSchema> | undefined) ?? {};
}

/**
 * A query schema becomes one `in: query` parameter per property, which is what OpenAPI expects —
 * a single object schema would document `?filter={"page":1}` rather than `?page=1`.
 */
function queryParameters(schema: ZodTypeAny): object[] {
  const converted = toJsonSchema(schema);
  const props = (converted.properties as Record<string, JsonSchema> | undefined) ?? {};
  const required = new Set((converted.required as string[] | undefined) ?? []);
  return Object.entries(props).map(([name, propSchema]) => ({
    name,
    in: "query",
    required: required.has(name),
    schema: propSchema,
  }));
}

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
    const opId = operationId(route.method, oapiPath);

    /**
     * The REQUEST shape, read off the `validate()` middleware this route actually runs. Path
     * parameters recovered from the URL are enriched with their validated schema where one
     * exists, so `{id}` documents the 24-hex ObjectId rule instead of a bare string.
     */
    const validation = route.validation ?? {};
    const paramProps = validation.params ? jsonSchemaProperties(validation.params) : {};
    const enrichedParams = params.map((p) => {
      const s = paramProps[(p as { name: string }).name];
      return s ? { ...p, schema: s } : p;
    });
    const queryParams = validation.query ? queryParameters(validation.query) : [];
    const allParams = [...enrichedParams, ...queryParams];

    const operation: Record<string, unknown> = {
      operationId: opId,
      tags: [tag],
      summary: `${route.method} ${oapiPath}`,
      ...(allParams.length ? { parameters: allParams } : {}),
      ...(validation.body
        ? {
            requestBody: {
              required: true,
              content: { "application/json": { schema: toJsonSchema(validation.body) } },
            },
          }
        : {}),
      /**
       * ── WHY THE 200 STILL CARRIES NO SCHEMA ─────────────────────────────────
       * Every success is `{ success: true, data }`, but `data` has no schema to give: the
       * repository DTOs are TypeScript interfaces, and there is not one response Zod schema in
       * the codebase (checked: zero). Emitting `{ success, data: object }` would describe the
       * envelope and say nothing about the payload — a schema that looks like a contract,
       * generates a useless `unknown`, and quietly claims coverage the API does not have.
       *
       * So the envelope is documented in prose and the payload is left undescribed until real
       * response DTOs exist. The contract must describe reality, including the parts of it that
       * are missing.
       */
      responses: {
        "200": { description: "Success — `{ success: true, data }`." },
        ...(Object.keys(validation).length > 0
          ? {
              "400": {
                description: "Validation failed — `HMS-VAL-001`, with `details.fields`.",
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/ApiError" } },
                },
              },
            }
          : {}),
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
