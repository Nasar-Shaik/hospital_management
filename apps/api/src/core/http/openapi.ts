/**
 * OpenAPI generation (Module A9 / P0 baseline).
 *
 * ── GENERATED FROM THE SHIPPED APP, NOT HAND-WRITTEN ────────────────────────
 * The spec is built from `routeInventory` — the same introspection the RBAC matrix trusts — so it
 * lists exactly the routes that shipped, each with the security it actually enforces. A hand-kept
 * OpenAPI file drifts the moment someone adds a route and forgets the doc; this one cannot, because
 * there is no second list to forget.
 *
 * ── WHAT THE DOCUMENT COVERS ────────────────────────────────────────────────
 * Every path, method, path and query parameter, security requirement, and — as `x-permission` /
 * `x-feature` extensions — the authorization each route enforces. Request bodies come from the
 * `validate()` middleware a route actually runs; success responses from the `responds()` middleware
 * it actually declares. Both are read off the shipped router stack, so neither can describe a
 * shape the server does not use.
 *
 * Five operations carry no data schema, and say so by media type instead: four downloads and this
 * document itself. That is the whole of the exception list — there is no operation here whose
 * response is simply undescribed.
 */
import type { Application } from "express";
import type { ZodTypeAny } from "@medicore/validation";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  routeInventory,
  type IdempotencyTag,
  type ResponseTag,
  type RouteInfo,
} from "./routeInventory.js";
import { contractRegistry } from "./contract.js";
import { KEY_MAX_LENGTH, KEY_MIN_LENGTH } from "../idempotency/idempotencyStore.js";

type JsonSchema = Record<string, unknown>;

/** Where named response contracts live in the document. */
const COMPONENTS = "components/schemas";

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

/**
 * The `Idempotency-Key` header parameter.
 *
 * `required: false` states the v1 contract exactly: the key is HONOURED, not demanded. Marking it
 * required would be a breaking change to an existing operation, which Doc 04 §5.1 rules out
 * inside a version — and it would be a lie, since the server does execute without it.
 *
 * The length and character rules are the store's own constants rather than a copy, so a generated
 * mobile client cannot be told a bound the server does not enforce.
 */
function idempotencyParameter(tag: IdempotencyTag): object {
  return {
    name: tag.header,
    in: "header",
    required: false,
    schema: {
      type: "string",
      minLength: KEY_MIN_LENGTH,
      maxLength: KEY_MAX_LENGTH,
      pattern: "^[A-Za-z0-9_.:@+-]+$",
    },
    description:
      `${tag.description} Send the same key to retry safely: the first request executes and ` +
      "its response is stored for 24 hours, and every later request with that key returns that " +
      "response verbatim with `Idempotency-Replayed: true`. The same key with a different " +
      "request body is refused (`HMS-REQ-002`), never silently replayed. Keys are scoped to one " +
      "hospital and one user; a UUID per user intent is the intended shape.",
  };
}

/* ── response schemas ───────────────────────────────────────────────────────── */

/**
 * A response schema as JSON Schema, with every REGISTERED contract left as a `$ref`.
 *
 * This is the opposite choice from request bodies, and the difference is that responses have
 * names. A request body is an anonymous Zod object defined at the route, so inlining it is the
 * only honest option; a response contract is registered as `Patient`, so `$ref: Patient` is both
 * shorter and more useful — thirty operations reference one definition instead of repeating it,
 * and a client generator gets a type name rather than thirty structurally identical anonymous
 * shapes.
 */
function toResponseSchema(schema: ZodTypeAny): JsonSchema {
  const out = zodToJsonSchema(schema, {
    definitions: contractRegistry(),
    target: "openApi3",
    basePath: ["#"],
    definitionPath: COMPONENTS as never,
  }) as JsonSchema;
  delete out.$schema;
  // The definitions come back attached to every conversion; they are emitted once, centrally.
  delete out[COMPONENTS];
  return normalise(out);
}

/**
 * Two corrections applied to everything the converter produces for a response.
 *
 * ── 3.1, NOT 3.0 ────────────────────────────────────────────────────────────
 * The `openApi3` target writes `nullable: true`, which is not a keyword in OpenAPI 3.1 — this
 * document declares 3.1, so a strict reader would ignore it and reject the `null` the API really
 * sends for, say, an encounter with no consultation note yet. 3.1 spells it as a union.
 *
 * ── RESPONSES ARE OPEN, REQUESTS ARE CLOSED ─────────────────────────────────
 * Zod's default object mode is `strip`, which the converter reports as `additionalProperties:
 * false` — correct about what the server sends today, wrong about what a client should assume.
 * This contract evolves additively, so adding a response field is expected and allowed; a closed
 * response schema turns every one of those into a validation failure inside any client strict
 * enough to check, including a mobile build that cannot be patched. Requests keep their
 * closedness, where `.strict()` means the server genuinely does reject unknown keys.
 */
function normalise(schema: JsonSchema): JsonSchema {
  if (schema.additionalProperties === false) delete schema.additionalProperties;

  if (schema.nullable === true) {
    const { nullable: _n, allOf, ...rest } = schema;
    const inner = Array.isArray(allOf) && allOf.length === 1 ? (allOf[0] as JsonSchema) : rest;
    for (const key of Object.keys(schema)) delete schema[key];
    schema.oneOf = [inner, { type: "null" }];
  }

  for (const value of Object.values(schema)) {
    if (Array.isArray(value)) {
      for (const item of value) if (isObject(item)) normalise(item);
    } else if (isObject(value)) {
      normalise(value);
    }
  }
  return schema;
}

const isObject = (v: unknown): v is JsonSchema => typeof v === "object" && v !== null;

/**
 * Inlines every `$ref` that does not name a component.
 *
 * ── WHY THE GENERATOR PRODUCES REFS NOBODY CAN FOLLOW ───────────────────────
 * `zod-to-json-schema` de-duplicates structurally identical sub-schemas by pointing the second
 * one at the first, wherever the first happened to land:
 *
 *     VisitReport.byClass.items  →  #/components/schemas/DischargeRegister/properties/…/items
 *     BedBoardWard.counts        →  #/components/schemas/BedBoard/properties/totals
 *
 * Both are legal JSON Pointers and neither is usable OpenAPI. A generator expects `$ref` to name
 * a component; pointed into another component's guts it produces a broken type or nothing at all.
 * Worse, it invents coupling: a visit report would document itself in terms of the discharge
 * register purely because two anonymous `{ key, count }` shapes coincided, so renaming a field on
 * one would silently retype the other.
 *
 * `$refStrategy: "none"` removes these — and also removes the refs to real components, which are
 * the point. So they are resolved here instead: a NAMED contract stays a `$ref`, an anonymous
 * duplicate is written out in full. Repeated because a resolved target can contain one of its own;
 * the cap is a guard against a cycle, which the schemas do not currently contain.
 */
function inlineNonComponentRefs(doc: Record<string, unknown>): void {
  const isComponentRef = (ref: string): boolean => /^#\/components\/schemas\/[^/]+$/.test(ref);

  const resolvePointer = (ref: string): unknown => {
    let node: unknown = doc;
    for (const raw of ref.replace(/^#\//, "").split("/")) {
      const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~");
      if (!isObject(node)) return undefined;
      node = (node as Record<string, unknown>)[segment];
    }
    return node;
  };

  for (let pass = 0; pass < 8; pass += 1) {
    let replaced = 0;

    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if (!isObject(node)) return;

      const ref = node.$ref;
      if (typeof ref === "string" && !isComponentRef(ref)) {
        const target = resolvePointer(ref);
        if (isObject(target)) {
          delete node.$ref;
          Object.assign(node, structuredClone(target));
          replaced += 1;
        }
      }
      for (const value of Object.values(node)) walk(value);
    };

    walk(doc);
    if (replaced === 0) return;
  }
}

/** The registered contracts, converted once, for `components/schemas`. */
function namedContracts(): Record<string, JsonSchema> {
  const registry = contractRegistry();
  const first = Object.values(registry)[0];
  if (!first) return {};
  // One conversion with all of them as definitions, so contracts that reference each other
  // (`Invoice` → `InvoiceLine`) come out cross-referenced rather than duplicated inline.
  const converted = zodToJsonSchema(first, {
    definitions: registry,
    target: "openApi3",
    basePath: ["#"],
    definitionPath: COMPONENTS as never,
  }) as JsonSchema;
  const defs = (converted[COMPONENTS] ?? {}) as Record<string, JsonSchema>;
  return Object.fromEntries(
    Object.keys(defs)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => [name, normalise(defs[name] as JsonSchema)]),
  );
}

/**
 * The success response: the envelope, with the route's own data shape inside it.
 *
 * The envelope is written out per operation rather than lifted into a shared `ApiEnvelope`
 * component, because OpenAPI has no generics — a single shared envelope could only say
 * `data: object`, which is the exact non-answer this milestone exists to avoid. Repeating six
 * lines of wrapper per operation is the price of `data` being a real type.
 */
function successResponse(tag: ResponseTag): JsonSchema {
  /**
   * A non-envelope response: a download, or the spec itself. Documented by MEDIA TYPE, with no
   * data schema — because there is no `data`, not because nobody got round to it.
   */
  if (!tag.schema) {
    const body = tag.mediaSchema ?? { type: "string", format: "binary" };
    return {
      description: tag.description ?? "Success.",
      content: Object.fromEntries(
        (tag.media ?? ["application/octet-stream"]).map((type) => [type, { schema: body }]),
      ),
    };
  }

  const properties: JsonSchema = {
    success: { type: "boolean", const: true },
    data: toResponseSchema(tag.schema),
    ...(tag.meta ? { meta: { $ref: `#/${COMPONENTS}/PageMeta` } } : {}),
  };
  /**
   * An OPTIONAL contract means `data` can be absent from the envelope entirely — `undefined` does
   * not survive `JSON.stringify`, so the key simply is not there. One route genuinely behaves
   * this way, and declaring `data` required would document a body it does not always send.
   */
  const dataGuaranteed = !tag.schema.isOptional();
  return {
    description: tag.description ?? "Success.",
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties,
          required: ["success", ...(dataGuaranteed ? ["data"] : []), ...(tag.meta ? ["meta"] : [])],
        },
      },
    },
  };
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
    const response = route.response;
    const paramProps = validation.params ? jsonSchemaProperties(validation.params) : {};
    const enrichedParams = params.map((p) => {
      const s = paramProps[(p as { name: string }).name];
      return s ? { ...p, schema: s } : p;
    });
    const queryParams = validation.query ? queryParameters(validation.query) : [];
    /**
     * The idempotency header, read off the `idempotent()` middleware this route actually runs —
     * same principle as the body and the response. A header documented on an operation that does
     * not honour it is worse than no documentation: a mobile client would build its offline retry
     * queue on a guarantee the server never made.
     */
    const idempotencyParams = route.idempotency ? [idempotencyParameter(route.idempotency)] : [];
    const allParams = [...enrichedParams, ...queryParams, ...idempotencyParams];

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
       * ── THE SUCCESS RESPONSE ────────────────────────────────────────────────
       * Read off the `responds()` middleware this route actually runs, exactly as the request
       * shape is read off `validate()`. A route that declares nothing still documents its
       * envelope in prose — those are the binary downloads and the spec document itself, which
       * have no JSON payload to describe, and they are listed as exceptions rather than given a
       * fabricated schema.
       */
      responses: {
        ...(response
          ? Object.fromEntries([
              ...response.statuses.map((code) => [String(code), successResponse(response)]),
              // A download that can legitimately answer something other than 200 — an absent
              // logo, say — says so here rather than leaving the caller to discover it.
              ...(response.also ?? []).map((r) => [
                String(r.status),
                { description: r.description },
              ]),
            ])
          : { "200": { description: "Success — `{ success: true, data }`." } }),
        ...(Object.keys(validation).length > 0 || route.idempotency
          ? {
              "400": {
                description: "Validation failed — `HMS-VAL-001`, with `details.fields`.",
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/ApiError" } },
                },
              },
            }
          : {}),
        ...(route.idempotency
          ? {
              "409": {
                description:
                  "`HMS-REQ-002` — this `Idempotency-Key` was used for a DIFFERENT request; " +
                  "`details.original` carries what it did the first time. Or `HMS-REQ-004` — " +
                  "the same request is still in flight; retry shortly to receive its result.",
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

  const document: Record<string, unknown> = {
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
        /**
         * Every named response contract, emitted once and referenced by `$ref` from the
         * operations that send it. Name-sorted, because a spec whose key order depends on module
         * import order produces a diff every time an import moves.
         */
        ...namedContracts(),
        PageMeta: {
          type: "object",
          description: "Present on paginated list responses, alongside `data`.",
          properties: {
            page: { type: "integer", example: 1 },
            limit: { type: "integer", example: 20 },
            total: { type: "integer" },
            hasMore: { type: "boolean" },
          },
          required: ["page", "limit"],
        },
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

  inlineNonComponentRefs(document);
  return document;
}

/** Builds the spec straight from a live Express app. */
export function specFromApp(app: Application, opts: OpenApiOptions = {}): object {
  return buildOpenApiSpec(routeInventory(app), opts);
}
