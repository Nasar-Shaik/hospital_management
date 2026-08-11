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
 *                       with the same optionality and the same type, at every depth; and the
 *                       client claims no field the server does not send.
 *   5. METHOD RETURNS  — each method's declared type is the contract its endpoint actually sends.
 *
 * Checks 4 and 5 are what make the hand-written surface trustworthy, and each found defects on the
 * day it was switched on. Check 4: 37 divergences across 121 shared types — `Encounter.history`,
 * `Invoice.version`, `Dispense.creditOverride` and thirty more the server had always sent and no
 * caller could read. Deepening it past the top level then found `Invoice.payments[].by` and
 * `.requestId`, invisible while both sides were merely "an array". Check 5 found four methods
 * typed as something their endpoint has never sent — including `createOperator`, where the ONE
 * value that matters is a temporary password the server cannot reissue.
 *
 * That is the argument for keeping the client hand-written but VERIFIED: none of these were
 * noticed by anybody in months of use, and all of them were found in one pass the moment
 * something could compare the two.
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
/**
 * Reads the path literal starting at `/api/`, scanned rather than regexed.
 *
 * A regex cannot do this: the client writes `` `/api/v1/patients${qs ? `?${qs}` : ""}` `` —
 * a template hole containing another template — so any `[^`]+` match stops in the middle of the
 * expression and yields a path that matches nothing. The distinction that matters is what the
 * hole IS: after a `/` it is a path parameter (`/patients/${id}` → `/patients/{p}`); anywhere
 * else it is a query string being appended, and the path ends there.
 */
function readPathFrom(text: string, from: number): string {
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
}

function clientCalls(): Set<string> {
  const calls = new Set<string>();
  const readPath = readPathFrom;

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
  WalletView: "Wallet",
  StockChange: "StockMoveResult",
  LicenseView: "HospitalLicense",
};

interface ClientField {
  optional: boolean;
  /** The declared type, kept as a node so nested shapes can be walked, not string-matched. */
  node?: ts.TypeNode;
}

const clientSource = ts.createSourceFile(CLIENT, client, ts.ScriptTarget.ESNext, true);
const interfaces = new Map<string, Map<string, ClientField>>();
const bases = new Map<string, string[]>();
/** Interfaces extending something this parser cannot expand (`Partial<Record<…>>`). */
const openInterfaces = new Set<string>();
const typeAliases = new Map<string, ts.TypeNode>();

const collect = (node: ts.Node): void => {
  if (ts.isInterfaceDeclaration(node)) {
    const fields = new Map<string, ClientField>();
    for (const member of node.members) {
      if (ts.isPropertySignature(member) && member.name && ts.isIdentifier(member.name)) {
        fields.set(member.name.text, {
          optional: member.questionToken !== undefined,
          ...(member.type ? { node: member.type } : {}),
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
    typeAliases.set(node.name.text, node.type);
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

const schemas = (spec.components as Json | undefined)?.schemas as Record<string, Json> | undefined;

/**
 * ── HOW DEEP THIS GOES, AND WHERE IT STOPS ──────────────────────────────────
 * The first version compared only the top level and only the broad category — string vs number vs
 * boolean vs array. That caught a field going missing, which was the failure that had actually
 * happened, and was blind to everything INSIDE one: `Invoice.payments` typed `{ amount: number }[]`
 * passed because both sides were arrays, while the server had been sending `by` and `requestId` on
 * every entry for months.
 *
 * So it now walks the shape: nested objects, array items, `Record<>` values, nullability, and enum
 * membership. What it deliberately does NOT do is become a type checker. It resolves names to
 * interfaces and aliases and compares structure; it does not evaluate conditional types, generics
 * beyond `Array`/`Record`, or intersections. Anything it cannot resolve is SKIPPED rather than
 * guessed at — a checker that invents failures gets switched off, and then it checks nothing.
 */

/** Unwraps parentheses. */
function unwrap(node: ts.TypeNode): ts.TypeNode {
  return ts.isParenthesizedTypeNode(node) ? unwrap(node.type) : node;
}

/** Splits a union into its non-null members, and whether `null` was among them. */
function unionParts(node: ts.TypeNode): { members: ts.TypeNode[]; nullable: boolean } {
  const inner = unwrap(node);
  if (!ts.isUnionTypeNode(inner)) return { members: [inner], nullable: false };
  const members: ts.TypeNode[] = [];
  let nullable = false;
  for (const member of inner.types.map(unwrap)) {
    const isNull =
      member.kind === ts.SyntaxKind.NullKeyword ||
      (ts.isLiteralTypeNode(member) && member.literal.kind === ts.SyntaxKind.NullKeyword);
    if (isNull) nullable = true;
    else if (member.kind !== ts.SyntaxKind.UndefinedKeyword) members.push(member);
  }
  return { members, nullable };
}

const nodeText = (node: ts.Node): string =>
  clientSource.text.slice(node.getStart(clientSource), node.getEnd()).replace(/\s+/g, " ");

/** The string literals a union is made of — `"a" | "b"`. Undefined when it is not that shape. */
function literalMembers(members: ts.TypeNode[]): string[] | undefined {
  const out: string[] = [];
  for (const member of members) {
    if (ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)) {
      out.push(member.literal.text);
    } else {
      return undefined;
    }
  }
  return out.length > 0 ? out : undefined;
}

/** Follows a named type alias to the node that defines it. */
function resolveAlias(name: string, seen = new Set<string>()): ts.TypeNode | undefined {
  if (seen.has(name)) return undefined;
  seen.add(name);
  const alias = typeAliases.get(name);
  if (!alias) return undefined;
  const inner = unwrap(alias);
  if (ts.isTypeReferenceNode(inner) && ts.isIdentifier(inner.typeName)) {
    return resolveAlias(inner.typeName.text, seen) ?? inner;
  }
  return alias;
}

/** Unwraps `oneOf: [X, null]` into X plus a nullable flag. */
function nonNull(schema: Json): { schema: Json; nullable: boolean } {
  const oneOf = schema.oneOf as Json[] | undefined;
  if (!oneOf) return { schema, nullable: false };
  const nulls = oneOf.filter((s) => s.type === "null");
  const rest = oneOf.filter((s) => s.type !== "null");
  if (nulls.length === 0 || rest.length !== 1) return { schema, nullable: false };
  return { schema: rest[0] as Json, nullable: true };
}

const KEYWORDS: Partial<Record<ts.SyntaxKind, string>> = {
  [ts.SyntaxKind.StringKeyword]: "string",
  [ts.SyntaxKind.NumberKeyword]: "number",
  [ts.SyntaxKind.BooleanKeyword]: "boolean",
};

/**
 * Compares one published schema against the client type meant to model it. `where` is a dotted
 * path (`Invoice.payments[].amount`) so a failure names the field, not the type it lives in.
 */
function compareType(schema: Json, node: ts.TypeNode, where: string, depth = 0): void {
  if (depth > 6) return;

  const { schema: bare, nullable: schemaNullable } = nonNull(schema);
  const { members, nullable: clientNullable } = unionParts(node);

  if (schemaNullable && !clientNullable) {
    failures.push(
      `response shape: ${where} — the server can send null, the client type cannot hold it ` +
        `(${nodeText(node)})`,
    );
    return;
  }
  if (!schemaNullable && clientNullable) {
    failures.push(
      `response shape: ${where} — the client allows null, the server never sends it, so the ` +
        `check for it is dead code`,
    );
    return;
  }
  if (members.length === 0) return;

  const literals = literalMembers(members);
  const single = members.length === 1 ? (members[0] as ts.TypeNode) : undefined;

  /* enums: the client must accept every value the server can send, and no more */
  const enumValues = bare.enum as string[] | undefined;
  if (enumValues) {
    if (literals) {
      const missing = enumValues.filter((v) => !literals.includes(v));
      if (missing.length > 0) {
        failures.push(
          `response shape: ${where} — the client's union is NARROWER than the server's: it does ` +
            `not accept ${missing.map((m) => `"${m}"`).join(", ")}`,
        );
      }
      const extra = literals.filter((v) => !enumValues.includes(v));
      if (extra.length > 0) {
        failures.push(
          `response shape: ${where} — the client accepts ${extra.map((m) => `"${m}"`).join(", ")}, ` +
            `which the server never sends`,
        );
      }
      return;
    }
    if (single && ts.isTypeReferenceNode(single) && ts.isIdentifier(single.typeName)) {
      const resolved = resolveAlias(single.typeName.text);
      if (resolved) compareType(bare, resolved, where, depth + 1);
    }
    // A bare `string` is WIDER than the enum — not wrong, only vague.
    return;
  }

  if (!single) return;
  const client = unwrap(single);

  /* a named contract */
  if (typeof bare.$ref === "string") {
    const refName = bare.$ref.split("/").pop() ?? "";
    const expected = CLIENT_NAMES[refName] ?? refName;
    if (ts.isTypeReferenceNode(client) && ts.isIdentifier(client.typeName)) {
      const actual = client.typeName.text;
      if (actual === expected) return;
      if (fieldsOf(actual)) compareObject(schemas?.[refName] ?? {}, actual, where, depth + 1);
      else {
        const resolved = resolveAlias(actual);
        if (resolved) compareType(bare, resolved, where, depth + 1);
      }
      return;
    }
    if (ts.isTypeLiteralNode(client)) {
      compareLiteral(schemas?.[refName] ?? {}, client, where, depth + 1);
    }
    return;
  }

  /* arrays */
  if (bare.type === "array") {
    const items = (bare.items ?? {}) as Json;
    if (ts.isArrayTypeNode(client)) {
      compareType(items, client.elementType, `${where}[]`, depth + 1);
      return;
    }
    if (
      ts.isTypeReferenceNode(client) &&
      ts.isIdentifier(client.typeName) &&
      client.typeName.text === "Array" &&
      client.typeArguments?.[0]
    ) {
      compareType(items, client.typeArguments[0], `${where}[]`, depth + 1);
      return;
    }
    failures.push(
      `response shape: ${where} — the server sends an array, the client declares ` +
        `${nodeText(client)}`,
    );
    return;
  }

  /* objects, and `Record<string, X>` maps */
  if (bare.type === "object" || bare.properties) {
    const additional = bare.additionalProperties;
    if (additional && typeof additional === "object") {
      if (
        ts.isTypeReferenceNode(client) &&
        ts.isIdentifier(client.typeName) &&
        client.typeName.text === "Record" &&
        client.typeArguments?.[1]
      ) {
        compareType(additional as Json, client.typeArguments[1], `${where}[key]`, depth + 1);
      }
      return;
    }
    if (!bare.properties) return; // free-form object — nothing to compare against
    if (ts.isTypeLiteralNode(client)) {
      compareLiteral(bare, client, where, depth + 1);
      return;
    }
    if (ts.isTypeReferenceNode(client) && ts.isIdentifier(client.typeName)) {
      const name = client.typeName.text;
      if (fieldsOf(name)) compareObject(bare, name, where, depth + 1);
      else {
        const resolved = resolveAlias(name);
        if (resolved) compareType(bare, resolved, where, depth + 1);
      }
    }
    return;
  }

  /* primitives */
  const expected = bare.type === "integer" ? "number" : (bare.type as string | undefined);
  if (!expected) return;
  const actual = KEYWORDS[client.kind];
  if (!actual) {
    if (ts.isTypeReferenceNode(client) && ts.isIdentifier(client.typeName)) {
      const resolved = resolveAlias(client.typeName.text);
      if (resolved) compareType(bare, resolved, where, depth + 1);
    }
    return;
  }
  if (actual !== expected) {
    failures.push(
      `response shape: ${where} — the server sends ${expected}, the client declares ${actual}`,
    );
  }
}

/** Presence, optionality, then the type — the same three questions at every depth. */
function checkProperties(
  props: Record<string, Json>,
  required: Set<string>,
  where: string,
  depth: number,
  lookup: (field: string) => { optional: boolean; node?: ts.TypeNode } | undefined,
  open = false,
): void {
  for (const [field, sub] of Object.entries(props)) {
    const at = `${where}.${field}`;
    const declared = lookup(field);
    if (!declared) {
      if (!open) {
        failures.push(
          `response shape: ${at} — the server sends it, the client does not declare it, so no ` +
            `caller can read it`,
        );
      }
      continue;
    }
    if (required.has(field) === declared.optional) {
      failures.push(
        `response shape: ${at} — the server ${required.has(field) ? "always sends" : "may omit"} ` +
          `it, the client says ${declared.optional ? "optional" : "required"}`,
      );
    }
    if (declared.node) compareType(sub, declared.node, at, depth + 1);
  }
}

/** Compares an object schema against an inline `{ … }` type literal. */
function compareLiteral(
  schema: Json,
  node: ts.TypeLiteralNode,
  where: string,
  depth: number,
): void {
  const props = (schema.properties ?? {}) as Record<string, Json>;
  const required = new Set((schema.required as string[] | undefined) ?? []);
  const declared = new Map<string, ts.PropertySignature>();
  for (const member of node.members) {
    if (ts.isPropertySignature(member) && member.name && ts.isIdentifier(member.name)) {
      declared.set(member.name.text, member);
    }
  }
  checkProperties(props, required, where, depth, (field) => {
    const member = declared.get(field);
    if (!member) return undefined;
    return {
      optional: member.questionToken !== undefined,
      ...(member.type ? { node: member.type } : {}),
    };
  });
  for (const field of declared.keys()) {
    if (!(field in props)) {
      failures.push(
        `response shape: ${where}.${field} — the client declares it and the server never sends it`,
      );
    }
  }
}

/** Compares an object schema against a named client interface. */
function compareObject(schema: Json, clientName: string, where: string, depth: number): void {
  const fields = fieldsOf(clientName);
  if (!fields) return;
  const props = (schema.properties ?? {}) as Record<string, Json>;
  const required = new Set((schema.required as string[] | undefined) ?? []);

  checkProperties(
    props,
    required,
    where,
    depth,
    (field) => {
      const declared = fields.get(field);
      if (!declared) return undefined;
      return { optional: declared.optional, ...(declared.node ? { node: declared.node } : {}) };
    },
    isOpen(clientName),
  );

  for (const field of fields.keys()) {
    if (!(field in props)) {
      failures.push(
        `response shape: ${where}.${field} — the client declares it and the server never ` +
          `sends it, so it is always undefined`,
      );
    }
  }
}

let compared = 0;
const noClientType: string[] = [];

for (const [name, schema] of Object.entries(schemas ?? {})) {
  if (name === "ApiError" || name === "PageMeta") continue;
  const clientName = CLIENT_NAMES[name] ?? name;
  if (!fieldsOf(clientName)) {
    if (!typeAliases.has(clientName)) noClientType.push(name);
    continue;
  }
  compared += 1;
  compareObject(schema, clientName, clientName, 0);
}

/* 5 · METHOD RETURN TYPES ───────────────────────────────────────────────────
 *
 * The shape checks above prove that `Appointment` is right. They cannot notice that a method
 * returns `Promise<Appointment>` for an endpoint that sends something else entirely — and three
 * did, each losing something a caller needed:
 *
 *   rescheduleAppointment  → typed `Appointment`, sends `{ cancelled, booked }`
 *   createOperator         → typed `PlatformOperator`, sends the ONE-TIME password
 *   setRolePermissions     → typed `Role`, sends the codes it just stored
 *
 * So the generic on `request<T>` is compared with the component the operation actually returns.
 * Two shapes of call, as with coverage: `request<T>(METHOD, path)` states its type, and
 * `paged<T>(path)` is a GET whose `T` is the ITEM type of a list.
 */
const RETURN_EXEMPT: { match: RegExp; why: string }[] = [
  // A caller that discards a small acknowledgement is making a choice, not a mistake. Each of
  // these sends `{ ok: true }`-shaped confirmation and nothing a screen needs.
  { match: /^POST \/api\/platform\/v1\/auth\/change-password$/, why: "ack only" },
  { match: /^POST \/api\/v1\/auth\/mfa\/disable$/, why: "ack only" },
  { match: /^DELETE \/api\/v1\/roles\/\{p\}$/, why: "ack only" },
  { match: /^DELETE \/api\/v1\/doctors\/schedule\/\{p\}$/, why: "ack only" },
];

/** The interface a client type alias ultimately names, if any. */
function aliasOf(name: string): string | undefined {
  const alias = typeAliases.get(name);
  if (!alias) return undefined;
  const inner = unwrap(alias);
  if (ts.isTypeReferenceNode(inner) && ts.isIdentifier(inner.typeName)) {
    return aliasOf(inner.typeName.text) ?? inner.typeName.text;
  }
  return undefined;
}

/**
 * Whether an inline type literal covers the same field names as a published component.
 *
 * Deliberately name-level rather than a full comparison: the point is only to recognise that
 * `{ removed: boolean }` IS the `RemovedAck` shape, so a small acknowledgement written at the
 * method is not reported as a wrong type. The field-by-field checks above are where shapes are
 * actually verified.
 */
function structurallyMatches(declaredType: string, componentName: string): boolean {
  const component = schemas?.[componentName];
  const props = Object.keys((component?.properties ?? {}) as Json);
  if (props.length === 0 || !declaredType.trim().startsWith("{")) return false;
  return props.every((field) => new RegExp(`\\b${field}\\s*\\??:`).test(declaredType));
}

/** The component an operation's `data` resolves to, and whether it is a list. */
function responseComponent(op: Json): { name: string; list: boolean } | undefined {
  for (const [code, raw] of Object.entries((op.responses ?? {}) as Record<string, Json>)) {
    if (!code.startsWith("2")) continue;
    const envelope = (
      ((raw.content as Json | undefined)?.["application/json"] as Json | undefined)?.schema as
        Json | undefined
    )?.properties as Json | undefined;
    const data = envelope?.data as Json | undefined;
    if (!data) continue;
    const { schema: bare } = nonNull(data);
    if (typeof bare.$ref === "string") {
      return { name: bare.$ref.split("/").pop() ?? "", list: false };
    }
    if (bare.type === "array") {
      const items = (bare.items ?? {}) as Json;
      if (typeof items.$ref === "string") {
        return { name: items.$ref.split("/").pop() ?? "", list: true };
      }
    }
  }
  return undefined;
}

/** `(METHOD path)` → the type argument the client declares for it. */
function declaredReturns(): Map<string, { type: string; paged: boolean }> {
  const out = new Map<string, { type: string; paged: boolean }>();
  const pattern = /\.(request|paged)<([^<>]*)>\(\s*(?:"(GET|POST|PUT|PATCH|DELETE)",\s*)?[`"]/g;
  for (const m of client.matchAll(pattern)) {
    const paged = m[1] === "paged";
    const method = paged ? "GET" : (m[3] ?? "");
    if (!method) continue;
    const path = readPathFrom(client, m.index + m[0].length);
    if (path.startsWith("/api/")) {
      out.set(`${method} ${path}`, { type: (m[2] ?? "").trim(), paged });
    }
  }
  return out;
}

const returns = declaredReturns();
let returnsChecked = 0;

for (const [path, ops] of Object.entries(spec.paths as Record<string, Json>)) {
  for (const [method, rawOp] of Object.entries(ops)) {
    if (!METHODS.includes(method)) continue;
    const label = `${method.toUpperCase()} ${path}`;
    if (RETURN_EXEMPT.some((e) => e.match.test(`${method.toUpperCase()} ${normalise(path)}`))) {
      continue;
    }
    const expected = responseComponent(rawOp as Json);
    const declared = returns.get(`${method.toUpperCase()} ${normalise(path)}`);
    if (!expected || !declared) continue;
    returnsChecked += 1;

    // `paged<T>` unwraps a list, so its `T` is already the item type.
    const wantsList = expected.list && !declared.paged;
    const declaredList = declared.type.endsWith("[]");
    const declaredName = declared.type
      .replace(/\[\]$/, "")
      .replace(/\s*\|\s*null\s*$/, "")
      .trim();
    const wantName = CLIENT_NAMES[expected.name] ?? expected.name;

    /**
     * A name is not the only right answer. `TariffItem` is an alias of `ServiceItem`, and
     * `{ message: string }` written inline is a perfectly good `ForgotPasswordAck` — so a
     * mismatch on the name is only reported when the shape does not match either. Insisting on
     * the published name would be enforcing a naming convention, which is not what this is for.
     */
    const equivalent =
      declaredName === wantName ||
      aliasOf(declaredName) === wantName ||
      structurallyMatches(declared.type, expected.name);

    if (!equivalent) {
      failures.push(
        `method return: ${label} sends \`${expected.name}\`, the client method declares ` +
          `\`${declared.type}\` — a caller reading the result gets undefined`,
      );
    } else if (wantsList !== declaredList) {
      failures.push(
        `method return: ${label} sends ${wantsList ? "a list" : "a single"} \`${expected.name}\`, ` +
          `the client declares \`${declared.type}\``,
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
    `                 ${String(compared)} response contracts compared field by field, ` +
    `${String(returnsChecked)} method return types\n`,
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
