/**
 * Client ↔ contract conformance — makes the hand-written client surface VERIFIABLE.
 *
 *     pnpm --filter @medicore/api client:check
 *
 * ── WHY THIS EXISTS INSTEAD OF A GENERATED CLIENT ───────────────────────────
 * The obvious fix for a hand-maintained client is to generate it, and the spec can now support
 * that — 165 named response contracts, every one proved against the DTO its service returns.
 *
 * It is still not the change to make in this milestone. The risk being managed was never "the
 * types are hand-written", it was "nothing checks them": a verified hand-written type is as safe
 * as a generated one, and the client also carries real runtime behaviour — silent refresh, tenant
 * host resolution, active-branch and licence headers, injected fetch — that a generator would
 * have to reproduce rather than replace. Verification buys the safety now; generation can be
 * decided on its own merits later, against a contract that is finally complete enough to make it
 * a real option.
 *
 * So this checks what the spec can actually prove:
 *
 *   1. COVERAGE       — every documented operation is reachable from the client.
 *   2. REQUEST SHAPE  — every field the spec documents in a request body is offered by the client.
 *   3. BRANCH PARITY  — no branch-bearing response type has quietly lost `branchId`.
 *   4. RESPONSE SHAPE — every field the spec says the server SENDS is declared by the client type,
 *                       with the same optionality, and the client claims no field the server does
 *                       not send.
 *
 * Check 4 is new, and it is the one that closes the gap. The previous note here said response
 * shapes could not be checked because there was nothing to check them against; there is now —
 * 165 named response contracts, each proved against the DTO the service returns. Turning it on
 * found 37 divergences on 121 shared types: `Encounter.history`, `Order.createdAt`,
 * `Invoice.version`, `Dispense.creditOverride` and thirty more that the server has always sent
 * and no client could read, plus `getRole` typed as `Role` so the role editor could not see the
 * permissions it exists to edit.
 *
 * That is the whole argument for keeping the client hand-written but VERIFIED rather than
 * generated: none of those were noticed by anybody in months of use, and all of them were found
 * in one pass the moment something could compare the two.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const SPEC = resolve(here, "../../openapi.json");
const CLIENT = resolve(here, "../../../../packages/api-client/src/index.ts");
const METHODS = ["get", "post", "put", "patch", "delete"];

/**
 * Operations a typed client is not expected to expose, each with the reason. This list is the
 * only place a gap is allowed to be invisible, so it names WHY rather than just what.
 */
const NOT_CLIENT_FACING: { match: RegExp; why: string }[] = [
  { match: /^GET \/api\/v1\/openapi\.json$/, why: "the contract document itself" },
  { match: /^GET \/api\/v1\/documents\/\{id\}\/file$/, why: "binary download, fetched by URL" },
  { match: /^GET \/api\/v1\/audit\/export$/, why: "CSV download, fetched by URL" },
  { match: /^GET \/api\/v1\/reports\/\{id\}\/file$/, why: "binary download, fetched by URL" },
  { match: /^GET \/api\/v1\/site\/logo$/, why: "image, rendered from its URL by an <img>" },
];

type Json = Record<string, unknown>;
const spec = JSON.parse(readFileSync(SPEC, "utf8")) as Json;
const client = readFileSync(CLIENT, "utf8");

/**
 * Every `(METHOD, path)` the client actually calls, normalised to the spec's shape.
 *
 * Two call shapes, because the client has two: `request<T>("GET", path)` states its method, and
 * `paged<T>(path)` is implicitly a GET (it exists to unwrap `meta`). Matching only the first —
 * as the audit's estimate did — reports every list endpoint as unreachable, which is how that
 * estimate reached "~40 missing" for methods that were sitting right there.
 */
function clientCalls(): Set<string> {
  const calls = new Set<string>();

  /**
   * Reads the path literal starting at `/api/`, scanned rather than regexed.
   *
   * A regex cannot do this: the client writes `` `/api/v1/patients${qs ? `?${qs}` : ""}` `` —
   * a template hole containing another template — so any `[^`]+` match stops in the middle of the
   * expression and yields a path that matches nothing. The distinction that matters is what the
   * hole IS: after a `/` it is a path parameter (`/patients/${id}` → `/patients/{p}`); anywhere
   * else it is a query string being appended, and the path ends there.
   */
  const readPath = (text: string, from: number): string => {
    let out = "";
    let i = from;
    while (i < text.length) {
      const ch = text[i] ?? "";
      if (ch === "`" || ch === '"' || ch === "?") break;
      if (ch === "$" && text[i + 1] === "{") {
        if (!out.endsWith("/")) break; // a query-string append — the path is done
        out += "{p}";
        let depth = 0;
        i += 1;
        for (; i < text.length; i++) {
          if (text[i] === "{") depth += 1;
          else if (text[i] === "}") {
            depth -= 1;
            if (depth === 0) break;
          }
        }
        i += 1;
        continue;
      }
      out += ch;
      i += 1;
    }
    return out.replace(/\/$/, "");
  };

  const add = (method: string, path: string): void => {
    if (path.startsWith("/api/")) calls.add(`${method} ${path}`);
  };

  for (const m of client.matchAll(/"(GET|POST|PUT|PATCH|DELETE)",\s*[`"]/g)) {
    add(m[1] ?? "", readPath(client, m.index + m[0].length));
  }
  // `paged<T>(path)` is implicitly a GET — it exists to unwrap `meta` from a list response.
  for (const m of client.matchAll(/\.paged<[^>]*>\(\s*[`"]/g)) {
    add("GET", readPath(client, m.index + m[0].length));
  }
  return calls;
}

const normalise = (path: string): string => path.replace(/\{[^}]*\}/g, "{p}").replace(/\/$/, "");

const failures: string[] = [];
const calls = clientCalls();
let documented = 0;
let covered = 0;
const uncovered: string[] = [];

for (const [path, rawOps] of Object.entries(spec.paths as Record<string, Json>)) {
  for (const [method, rawOp] of Object.entries(rawOps)) {
    if (!METHODS.includes(method)) continue;
    const op = rawOp as Json;
    const label = `${method.toUpperCase()} ${path}`;
    documented += 1;

    /* 1 · COVERAGE */
    const exempt = NOT_CLIENT_FACING.find((e) => e.match.test(label));
    if (calls.has(`${method.toUpperCase()} ${normalise(path)}`)) covered += 1;
    else if (!exempt) uncovered.push(label);

    /* 2 · REQUEST SHAPE — every documented body field must be offered somewhere in the client. */
    const schema = (
      (
        ((op.requestBody as Json | undefined)?.content as Json | undefined)?.[
          "application/json"
        ] as Json | undefined
      )?.schema as Json | undefined
    )?.properties as Record<string, Json> | undefined;
    if (schema && calls.has(`${method.toUpperCase()} ${normalise(path)}`)) {
      for (const field of Object.keys(schema)) {
        // A coarse but honest check: the field name must appear in the client source at all.
        // It cannot prove the field is on the RIGHT method, but it does catch a whole field
        // going missing — which is the failure that actually happened.
        if (!new RegExp(`\\b${field}\\b`).test(client)) {
          failures.push(`${label}: request field "${field}" is not offered by the client`);
        }
      }
    }
  }
}

/* 3 · BRANCH PARITY — the regression that Phase 2 of this milestone had to fix by hand. */
const BRANCH_BEARING = [
  "Allergy",
  "Appointment",
  "Bed",
  "Dispense",
  "DoctorAvailability",
  "DoctorLeave",
  "DoctorSchedule",
  "Encounter",
  "Medicine",
  "Order",
  "Patient",
  "Prescription",
  "Room",
  "Ward",
  "WardNote",
];
for (const name of BRANCH_BEARING) {
  const m = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(client);
  if (!m) {
    failures.push(`branch parity: client has no \`${name}\` interface to check`);
    continue;
  }
  if (!/\bbranchId\b/.test(m[1] ?? "")) {
    failures.push(
      `branch parity: ${name}.branchId is missing — the server sends it (ADR-0015), so a caller ` +
        `cannot tell which site the record belongs to`,
    );
  }
}

/* 4 · RESPONSE SHAPE ────────────────────────────────────────────────────────
 *
 * Compares each named response contract against the client interface that models it. Parsed with
 * the TypeScript AST rather than a regex: optionality, inherited fields and the difference
 * between a declared field and one that merely appears somewhere in the file all matter here, and
 * a regex gets every one of them wrong.
 */

/**
 * Contracts the client models under a different name, each because the name is already taken by
 * something else or reads better locally. Listed rather than inferred — a rename should be a
 * decision somebody made, not a match the checker guessed at.
 */
const CLIENT_NAMES: Record<string, string> = {
  // `Bed` on the client is the bed an ADMITTED PATIENT occupies (ward + code); the ward
  // inventory's bed is a different record with a different key.
  Bed: "InventoryBed",
  Notification: "NotificationRecord",
  Package: "CarePackage",
  PlatformUser: "PlatformOperator",
  PlatformAuditEntry: "OperatorAuditEntry",
  HospitalSummary: "Hospital",
  AssessedVitals: "VitalsReading",
  BillPreview: "Bill",
};

interface ClientField {
  optional: boolean;
  type: string;
}

const clientSource = ts.createSourceFile(CLIENT, client, ts.ScriptTarget.ESNext, true);
const interfaces = new Map<string, Map<string, ClientField>>();
const bases = new Map<string, string[]>();
/** Interfaces extending something this parser cannot expand (`Partial<Record<…>>`). */
const openInterfaces = new Set<string>();
const typeAliases = new Set<string>();

const collect = (node: ts.Node): void => {
  if (ts.isInterfaceDeclaration(node)) {
    const fields = new Map<string, ClientField>();
    for (const member of node.members) {
      if (ts.isPropertySignature(member) && member.name && ts.isIdentifier(member.name)) {
        fields.set(member.name.text, {
          optional: member.questionToken !== undefined,
          type: member.type
            ? clientSource.text.slice(member.type.getStart(clientSource), member.type.getEnd())
            : "?",
        });
      }
    }
    interfaces.set(node.name.text, fields);
    const extended = (node.heritageClauses ?? [])
      .flatMap((h) => h.types)
      .map((t) => clientSource.text.slice(t.getStart(clientSource), t.getEnd()).trim());
    if (extended.length > 0) bases.set(node.name.text, extended);
    // `extends Partial<Record<VitalField, number>>` contributes a whole family of optional
    // fields that cannot be read off the name. The interface is treated as OPEN: what it does
    // declare is still checked, but a field it does not declare is not called missing.
    if (extended.some((e) => !/^[A-Za-z0-9_]+$/.test(e))) openInterfaces.add(node.name.text);
  } else if (ts.isTypeAliasDeclaration(node)) {
    typeAliases.add(node.name.text);
  }
  ts.forEachChild(node, collect);
};
collect(clientSource);

/** An interface's own fields plus everything it extends. */
function fieldsOf(name: string, seen = new Set<string>()): Map<string, ClientField> | undefined {
  if (seen.has(name)) return undefined;
  seen.add(name);
  const own = interfaces.get(name);
  if (!own) return undefined;
  const all = new Map(own);
  for (const base of bases.get(name) ?? []) {
    if (!/^[A-Za-z0-9_]+$/.test(base)) continue;
    for (const [k, v] of fieldsOf(base, seen) ?? []) if (!all.has(k)) all.set(k, v);
  }
  return all;
}

function isOpen(name: string, seen = new Set<string>()): boolean {
  if (seen.has(name)) return false;
  seen.add(name);
  if (openInterfaces.has(name)) return true;
  return (bases.get(name) ?? []).some((b) => /^[A-Za-z0-9_]+$/.test(b) && isOpen(b, seen));
}

/** The JSON Schema type, named the way a TypeScript reader would recognise it. */
function schemaType(schema: Json | undefined): string {
  if (!schema) return "?";
  if (typeof schema.$ref === "string") return schema.$ref.split("/").pop() ?? "?";
  if (Array.isArray(schema.oneOf)) return (schema.oneOf as Json[]).map(schemaType).join(" | ");
  if (schema.type === "array") return `${schemaType(schema.items as Json)}[]`;
  if (Array.isArray(schema.enum)) return "enum";
  return String(schema.type ?? "?");
}

/**
 * A deliberately COARSE type comparison: it separates string from number from boolean from array,
 * and stops there. A precise one would have to model every enum union and nested object literal
 * the client writes, and would fail on differences nobody can act on. The failures that matter —
 * a field missing entirely, a field the server never sends, a required field typed optional — are
 * all caught by presence and optionality, which are exact.
 */
function typesAgree(specType: string, clientType: string): boolean {
  const t = clientType
    .replace(/\s*\|\s*(null|undefined)/g, "")
    .replace(/^Readonly<(.*)>$/, "$1")
    .trim();
  if (specType.endsWith("[]")) return t.endsWith("[]") || t.startsWith("Record<");
  switch (specType) {
    case "number":
    case "integer":
      return t === "number";
    case "boolean":
      return t === "boolean" || t === "true" || t === "false";
    case "string":
    case "enum":
      return t !== "number" && t !== "boolean" && !t.endsWith("[]");
    default:
      return true;
  }
}

const schemas = (spec.components as Json | undefined)?.schemas as Record<string, Json> | undefined;
let compared = 0;
const noClientType: string[] = [];

for (const [name, schema] of Object.entries(schemas ?? {})) {
  if (name === "ApiError" || name === "PageMeta") continue;
  const clientName = CLIENT_NAMES[name] ?? name;
  const fields = fieldsOf(clientName);
  if (!fields) {
    if (!typeAliases.has(clientName)) noClientType.push(name);
    continue;
  }
  compared += 1;

  const props = (schema.properties ?? {}) as Record<string, Json>;
  const required = new Set((schema.required as string[] | undefined) ?? []);
  const open = isOpen(clientName);

  for (const [field, sub] of Object.entries(props)) {
    const declared = fields.get(field);
    if (!declared) {
      if (!open) {
        failures.push(
          `response shape: ${clientName}.${field} — the server sends it, the client does not ` +
            `declare it, so no caller can read it`,
        );
      }
      continue;
    }
    if (required.has(field) === declared.optional) {
      failures.push(
        `response shape: ${clientName}.${field} — the server ${required.has(field) ? "always sends" : "may omit"} it, ` +
          `the client says ${declared.optional ? "optional" : "required"}`,
      );
    }
    const specType = schemaType(sub);
    if (!typesAgree(specType, declared.type)) {
      failures.push(
        `response shape: ${clientName}.${field} — the server sends ${specType}, ` +
          `the client declares ${declared.type}`,
      );
    }
  }

  for (const field of fields.keys()) {
    if (!(field in props)) {
      failures.push(
        `response shape: ${clientName}.${field} — the client declares it and the server never ` +
          `sends it, so it is always undefined`,
      );
    }
  }
}

/**
 * A response contract with no client type at all.
 *
 * Only enforced for REAL RESOURCES — a top-level response with four or more fields. The rest are
 * acknowledgements (`{ removed: true }`) and nested pieces the client writes inline at the method,
 * which is the right shape for them; demanding a named interface for every one would be noise
 * with no reader.
 */
const topLevel = new Set<string>();
const collectRefs = (schema: Json | undefined): void => {
  if (!schema) return;
  if (typeof schema.$ref === "string") topLevel.add(schema.$ref.split("/").pop() ?? "");
  if (schema.type === "array") collectRefs(schema.items as Json);
  if (Array.isArray(schema.oneOf)) for (const s of schema.oneOf as Json[]) collectRefs(s);
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    collectRefs(schema.additionalProperties as Json);
  }
};
for (const ops of Object.values(spec.paths as Record<string, Json>)) {
  for (const [method, op] of Object.entries(ops)) {
    if (!METHODS.includes(method)) continue;
    for (const [code, response] of Object.entries((op as Json).responses ?? {})) {
      if (!code.startsWith("2")) continue;
      const body = (response as Json).content as Json | undefined;
      const envelope = (body?.["application/json"] as Json | undefined)?.schema as Json | undefined;
      collectRefs((envelope?.properties as Json | undefined)?.data as Json | undefined);
    }
  }
}
for (const name of noClientType) {
  const schema = schemas?.[name];
  const size = Object.keys((schema?.properties ?? {}) as Json).length;
  if (topLevel.has(name) && size >= 4) {
    failures.push(
      `response shape: the API returns \`${name}\` (${String(size)} fields) and the client has no ` +
        `type for it — add one, or map it in CLIENT_NAMES if it is modelled under another name`,
    );
  }
}

/* ── report ───────────────────────────────────────────────────────────────── */

const exempted = NOT_CLIENT_FACING.length;
process.stdout.write(
  `client contract: ${String(covered)}/${String(documented)} operations reachable ` +
    `(${String(exempted)} exempt by policy, ${String(uncovered.length)} unreachable)\n` +
    `                 ${String(compared)} response contracts compared field by field\n`,
);

if (uncovered.length > 0) {
  process.stderr.write(
    `\n  ${String(uncovered.length)} documented operation(s) have no typed client method:\n\n`,
  );
  for (const op of uncovered) process.stderr.write(`    ${op}\n`);
  process.stderr.write(
    "\n  Every public operation should be reachable from the typed client, or listed in\n" +
      "  NOT_CLIENT_FACING with the reason. A shipped endpoint no client can call is either\n" +
      "  dead code or a gap a consumer will work around with a raw fetch.\n",
  );
}

if (failures.length > 0) {
  process.stderr.write(`\n  ${String(failures.length)} contract conformance failure(s):\n\n`);
  for (const f of failures) process.stderr.write(`    ${f}\n`);
}

if (uncovered.length > 0 || failures.length > 0) process.exit(1);
process.stdout.write(
  "client contract conforms — coverage, request shapes, response shapes and branch parity\n",
);
