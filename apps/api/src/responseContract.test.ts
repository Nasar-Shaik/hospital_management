/**
 * The response contract, checked end to end across the three places it has to agree.
 *
 *     Zod contract  ──►  OpenAPI component  ──►  api-client interface
 *
 * The release gate already enforces all three globally (`openapi:check`, `client:check`). These
 * tests exist anyway, and the difference is worth stating: a gate script tells you the whole
 * surface is consistent, a test tells you WHICH link broke and for which resource. When
 * `Prescription` loses a field, "client contract failed" and "Prescription: the Zod contract and
 * the published component disagree on `history`" are very different messages to be handed.
 *
 * The seven resources named here are the ones a mobile build would touch first, so they are the
 * ones whose breakage must be unmissable.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { z } from "@medicore/validation";
import { createLogger } from "@medicore/logger";
import { createApp } from "./app.js";
import { specFromApp } from "./core/http/openapi.js";
import { contractRegistry } from "./core/http/contract.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLIENT = resolve(here, "../../../packages/api-client/src/index.ts");

/**
 * Building the app is what POPULATES the registry: a contract is registered when its module is
 * imported, and its module is imported because a router references it. Reading the registry
 * without building the app would see whatever happened to be loaded — which is exactly the kind
 * of accidental coupling this file is meant to catch.
 */
const spec = specFromApp(createApp(createLogger({ service: "contract-test" }))) as {
  components: {
    schemas: Record<string, { properties?: Record<string, unknown>; required?: string[] }>;
  };
};
const registry = contractRegistry();
const clientSource = readFileSync(CLIENT, "utf8");

/** The resources a client depends on most — and the ones a mobile build will reach for first. */
const RESOURCES = [
  "Patient",
  "Appointment",
  "DoctorSchedule",
  "Encounter",
  "Invoice",
  "Prescription",
  "Branch",
] as const;

/** Every field an object contract declares, and whether it is required. */
function zodFields(name: string): { fields: string[]; required: string[] } {
  const schema = registry[name];
  if (!(schema instanceof z.ZodObject)) throw new Error(`${name} is not an object contract`);
  const shape = schema.shape as Record<string, z.ZodTypeAny>;
  return {
    fields: Object.keys(shape).sort(),
    required: Object.entries(shape)
      .filter(([, value]) => !value.isOptional())
      .map(([key]) => key)
      .sort(),
  };
}

function componentFields(name: string): { fields: string[]; required: string[] } {
  const component = spec.components.schemas[name];
  if (!component) throw new Error(`${name} is not published in components/schemas`);
  return {
    fields: Object.keys(component.properties ?? {}).sort(),
    required: [...(component.required ?? [])].sort(),
  };
}

/** The client interface's own declared fields, with inherited ones folded in. */
function clientFields(name: string): string[] {
  const declaration = new RegExp(
    `export interface ${name}(?: extends ([A-Za-z0-9_]+))? \\{([\\s\\S]*?)\\n\\}`,
  ).exec(clientSource);
  if (!declaration) throw new Error(`the api-client has no \`${name}\` interface`);
  const own = [...(declaration[2] ?? "").matchAll(/^\s{2}([A-Za-z0-9_]+)\??:/gm)].map(
    (m) => m[1] as string,
  );
  const base = declaration[1];
  return [...new Set([...own, ...(base ? clientFields(base) : [])])].sort();
}

describe("the response contract agrees with itself", () => {
  describe.each(RESOURCES)("%s", (name) => {
    it("the Zod contract and the published OpenAPI component describe the same shape", () => {
      const zod = zodFields(name);
      const component = componentFields(name);
      expect(component.fields).toEqual(zod.fields);
      expect(component.required).toEqual(zod.required);
    });

    it("the api-client declares every field the OpenAPI component says the server sends", () => {
      const published = componentFields(name).fields;
      const declared = clientFields(name);
      // The client may not invent fields either — a type that promises something the server never
      // sends is a `undefined` waiting to reach a screen.
      expect(declared).toEqual(published);
    });
  });
});

/**
 * ── THE ONE FIELD WITH ITS OWN TEST ─────────────────────────────────────────
 * `branchId` is optional on nine response types, which makes it precisely the field a checker can
 * lose without anything looking wrong — and losing it is not cosmetic. A caller that cannot tell
 * which site a record belongs to cannot show a branch column, cannot filter, and cannot notice
 * that it is looking at another hospital's ward. It went missing from eight client types once
 * already; this is the test that would have caught it.
 */
describe("branch-aware resources carry branchId the whole way through", () => {
  const BRANCH_AWARE = [
    "Appointment",
    "DoctorSchedule",
    "Encounter",
    "Order",
    "Patient",
    "Prescription",
    "Ward",
    "WardNote",
  ] as const;

  it.each(BRANCH_AWARE)("%s declares branchId in the contract, the spec and the client", (name) => {
    expect(zodFields(name).fields).toContain("branchId");
    expect(componentFields(name).fields).toContain("branchId");
    // `Bed` is the one rename: on the client, `Bed` is the bed a patient occupies and the ward
    // inventory's bed is `InventoryBed`. Kept in step with CLIENT_NAMES in checkClientContract.
    expect(clientFields(name)).toContain("branchId");
  });
});

describe("what the contract deliberately does NOT claim", () => {
  it("documents the five non-JSON responses by media type rather than inventing a schema", () => {
    const paths = (spec as unknown as { paths: Record<string, Record<string, unknown>> }).paths;
    const nonJson = [
      ["/api/v1/audit/export", "text/csv"],
      ["/api/v1/documents/{id}/file", "application/pdf"],
      ["/api/v1/reports/{id}/file", "application/pdf"],
      ["/api/v1/site/logo", "image/*"],
      ["/api/v1/openapi.json", "application/json"],
    ] as const;

    for (const [path, mediaType] of nonJson) {
      const operation = paths[path]?.get as {
        responses: Record<string, { content?: Record<string, unknown>; description: string }>;
      };
      const ok = operation.responses["200"];
      expect(Object.keys(ok?.content ?? {})).toContain(mediaType);
      // A description, not a bare undocumented 200 — a reader can tell "returns a PDF" from
      // "nobody got round to this one".
      expect(ok?.description.length).toBeGreaterThan(20);
    }
  });
});
