/**
 * Client ↔ contract conformance — makes the hand-written client surface VERIFIABLE.
 *
 *     pnpm --filter @medicore/api client:check
 *
 * ── WHY THIS EXISTS INSTEAD OF A GENERATED CLIENT ───────────────────────────
 * The obvious fix for a hand-maintained client is to generate it. That is not yet honest here,
 * and the reason is worth stating plainly: **the spec has no response schemas.** There is not one
 * response Zod schema in the API (checked), so a generated client would return `unknown`
 * everywhere and be strictly worse than the 145 hand-written interfaces it replaced.
 *
 * The risk being managed is not "the types are hand-written" — it is "nothing checks them". A
 * verified hand-written type is as safe as a generated one; an unverified one is how a client
 * silently stops describing its own API, which is exactly what happened here (eight response types
 * had lost `branchId`, and `setDoctorSchedule` could not reach a feature the server shipped).
 *
 * So this checks what the spec can actually prove:
 *
 *   1. COVERAGE      — every documented operation is reachable from the client.
 *   2. REQUEST SHAPE — every field the spec documents in a request body is offered by the client.
 *   3. BRANCH PARITY — no branch-bearing response type has quietly lost `branchId`.
 *
 * Response *shapes* are deliberately not checked: there is nothing to check them against yet.
 * When response DTOs exist, this file is where that check goes — and at that point generating the
 * surface becomes the better answer and this becomes redundant. It is scaffolding with a
 * documented end.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

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

/* ── report ───────────────────────────────────────────────────────────────── */

const exempted = NOT_CLIENT_FACING.length;
process.stdout.write(
  `client contract: ${String(covered)}/${String(documented)} operations reachable ` +
    `(${String(exempted)} exempt by policy, ${String(uncovered.length)} unreachable)\n`,
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
process.stdout.write("client contract conforms — coverage, request shapes and branch parity\n");
