/**
 * API contract compatibility — makes additive-only evolution ENFORCEABLE.
 *
 *     pnpm --filter @medicore/api contract:check     # fail on a breaking change
 *     pnpm --filter @medicore/api contract:accept    # adopt the current spec as the baseline
 *
 * ── WHY A BASELINE FILE AND NOT A DIFF AGAINST HEAD ─────────────────────────
 * The drift gate already guarantees the committed spec matches the code, so comparing the working
 * tree against `HEAD` would compare a file with itself and pass forever. What needs guarding is
 * something else: the contract as it was last APPROVED. `openapi.baseline.json` is that approval,
 * and moving it is a deliberate, reviewable commit — which is exactly the property Doc 04 §5.1
 * asks for when it says a break ships as `/v2` with a 12-month sunset. A break should be
 * impossible to make by accident and easy to make on purpose.
 *
 * ── WHAT COUNTS AS BREAKING, AND WHY ────────────────────────────────────────
 * The asymmetry matters. For a REQUEST the client is the writer and the server the reader; for a
 * RESPONSE it is the other way round. So the same edit breaks in opposite directions:
 *
 *   request  · a new REQUIRED field   — old clients do not send it, and now fail validation
 *   request  · a REMOVED field        — old clients still send it, and `.strict()` schemas
 *                                       (`additionalProperties: false`) reject unknown keys
 *   response · a REMOVED field        — old clients read it and get `undefined`
 *   either   · a CHANGED type         — the value stops parsing
 *   either   · a NARROWED enum        — a value that used to be legal is refused
 *   path/op  · REMOVED                — the call 404s
 *   status   · REMOVED                — a documented outcome silently disappears
 *
 * The mobile case is why this is not academic: an app build in the field cannot be patched, so a
 * required field added today breaks phones for as long as they stay installed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

type Json = Record<string, unknown>;

const here = dirname(fileURLToPath(import.meta.url));
const CURRENT = resolve(here, "../../openapi.json");
const BASELINE = resolve(here, "../../openapi.baseline.json");

const METHODS = ["get", "post", "put", "patch", "delete"];

interface Break {
  where: string;
  what: string;
}

const asObj = (v: unknown): Json | undefined =>
  typeof v === "object" && v !== null ? (v as Json) : undefined;

/** The JSON Schema of an operation's request body, if it documents one. */
function requestSchema(op: Json): Json | undefined {
  const content = asObj(asObj(op.requestBody)?.content);
  return asObj(asObj(content?.["application/json"])?.schema);
}

/** The JSON Schema of a success response, if it documents one. */
function responseSchema(op: Json, code: string): Json | undefined {
  const content = asObj(asObj(asObj(op.responses)?.[code])?.content);
  return asObj(asObj(content?.["application/json"])?.schema);
}

/**
 * Compares two object schemas. `direction` decides which way an added/removed field breaks —
 * see the header; getting this backwards would make the check confidently wrong.
 */
function compareSchemas(
  where: string,
  before: Json | undefined,
  after: Json | undefined,
  direction: "request" | "response",
  out: Break[],
): void {
  if (!before) return;
  if (!after) {
    out.push({ where, what: `the ${direction} schema was removed` });
    return;
  }

  const beforeProps = asObj(before.properties) ?? {};
  const afterProps = asObj(after.properties) ?? {};
  const beforeReq = new Set((before.required as string[] | undefined) ?? []);
  const afterReq = new Set((after.required as string[] | undefined) ?? []);

  for (const [name, rawBefore] of Object.entries(beforeProps)) {
    const b = asObj(rawBefore);
    const a = asObj(afterProps[name]);
    if (!a) {
      // A removed request field breaks callers only when unknown keys are refused — which is the
      // house style (`.strict()`), but check rather than assume.
      const strict = after.additionalProperties === false;
      if (direction === "response" || strict) {
        out.push({ where: `${where}.${name}`, what: `${direction} field removed` });
      }
      continue;
    }
    if (
      b?.type !== undefined &&
      a.type !== undefined &&
      JSON.stringify(b.type) !== JSON.stringify(a.type)
    ) {
      out.push({
        where: `${where}.${name}`,
        what: `type changed: ${JSON.stringify(b.type)} → ${JSON.stringify(a.type)}`,
      });
    }
    const bEnum = b?.enum as unknown[] | undefined;
    const aEnum = a.enum as unknown[] | undefined;
    if (bEnum && aEnum) {
      const lost = bEnum.filter((v) => !aEnum.includes(v));
      if (lost.length > 0) {
        out.push({
          where: `${where}.${name}`,
          what: `enum narrowed, lost ${JSON.stringify(lost)}`,
        });
      }
    } else if (bEnum && !aEnum) {
      // Widening to a free string is additive for a reader and harmless for a writer.
    }
    compareSchemas(`${where}.${name}`, b, a, direction, out);
  }

  if (direction === "request") {
    for (const name of afterReq) {
      if (!beforeReq.has(name)) {
        out.push({ where: `${where}.${name}`, what: "became a REQUIRED request field" });
      }
    }
  } else {
    for (const name of beforeReq) {
      if (!afterReq.has(name)) {
        out.push({ where: `${where}.${name}`, what: "response field is no longer guaranteed" });
      }
    }
  }
}

function compare(baseline: Json, current: Json): Break[] {
  const out: Break[] = [];
  const basePaths = asObj(baseline.paths) ?? {};
  const currPaths = asObj(current.paths) ?? {};

  for (const [path, rawOps] of Object.entries(basePaths)) {
    const baseOps = asObj(rawOps) ?? {};
    const currOps = asObj(currPaths[path]);
    if (!currOps) {
      out.push({ where: path, what: "path removed" });
      continue;
    }
    for (const method of Object.keys(baseOps)) {
      if (!METHODS.includes(method)) continue;
      const b = asObj(baseOps[method]);
      const a = asObj(currOps[method]);
      if (!b) continue;
      if (!a) {
        out.push({ where: `${method.toUpperCase()} ${path}`, what: "operation removed" });
        continue;
      }
      const op = `${method.toUpperCase()} ${path}`;
      compareSchemas(`${op} body`, requestSchema(b), requestSchema(a), "request", out);

      // Query and path parameters are part of the request contract too.
      const params = (list: unknown): Map<string, Json> =>
        new Map(
          ((list as Json[] | undefined) ?? []).map((p) => [`${String(p.in)}:${String(p.name)}`, p]),
        );
      const bp = params(b.parameters);
      const ap = params(a.parameters);
      for (const [key, param] of bp) {
        const now = ap.get(key);
        if (!now) {
          out.push({ where: `${op} ${key}`, what: "parameter removed" });
          continue;
        }
        if (now.required === true && param.required !== true) {
          out.push({ where: `${op} ${key}`, what: "parameter became required" });
        }
        compareSchemas(`${op} ${key}`, asObj(param.schema), asObj(now.schema), "request", out);
      }

      /**
       * ── AUTHORIZATION IS PART OF THE CONTRACT ──────────────────────────────
       * A change here breaks a caller as surely as a removed field, and more confusingly: the
       * request is unchanged, the response is a 401 or a 403, and the client author has no reason
       * to look at a schema diff. For a mobile build in the field it means a screen that worked
       * yesterday now shows "insufficient permission" to a user whose role has not changed.
       *
       * Three moves are breaking, and all three are easy to make by accident while tidying:
       *
       *   public → authenticated   an anonymous caller (a booking widget, a status page) is cut off
       *   permission added         every token issued before today lacks it
       *   permission/feature swapped  the same, plus a hospital that bought the old feature
       *
       * The reverse of each is additive and passes: relaxing a rule never breaks a caller who was
       * already satisfying the stricter one.
       */
      const wasSecured = ((b.security as unknown[] | undefined) ?? []).length > 0;
      const nowSecured = ((a.security as unknown[] | undefined) ?? []).length > 0;
      if (nowSecured && !wasSecured) {
        out.push({ where: op, what: "a public operation now requires authentication" });
      }

      for (const key of ["x-permission", "x-feature"] as const) {
        const before = b[key] as string | undefined;
        const after = a[key] as string | undefined;
        if (before === after) continue;
        if (before === undefined) {
          out.push({ where: op, what: `now requires ${key.slice(2)} "${String(after)}"` });
        } else if (after !== undefined) {
          out.push({
            where: op,
            what: `${key.slice(2)} changed: "${before}" → "${after}"`,
          });
        }
        // `after === undefined` — the requirement was DROPPED. Additive; a caller who could
        // already reach the operation still can.
      }

      for (const code of Object.keys(asObj(b.responses) ?? {})) {
        if (!(code in (asObj(a.responses) ?? {}))) {
          out.push({ where: op, what: `documented response ${code} removed` });
          continue;
        }
        compareSchemas(
          `${op} ${code}`,
          responseSchema(b, code),
          responseSchema(a, code),
          "response",
          out,
        );
      }
    }
  }
  return out;
}

/* ── run ──────────────────────────────────────────────────────────────────── */

const current = JSON.parse(readFileSync(CURRENT, "utf8")) as Json;

if (process.argv.includes("--accept")) {
  writeFileSync(BASELINE, readFileSync(CURRENT, "utf8"));
  process.stdout.write("contract baseline updated — commit it with the reason for the break\n");
  process.exit(0);
}

let baseline: Json;
try {
  baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as Json;
} catch {
  writeFileSync(BASELINE, readFileSync(CURRENT, "utf8"));
  process.stdout.write("no baseline yet — seeded from the current contract\n");
  process.exit(0);
}

const breaks = compare(baseline, current);
const opCount = Object.values(asObj(current.paths) ?? {}).reduce<number>(
  (n, ops) => n + Object.keys(asObj(ops) ?? {}).filter((m) => METHODS.includes(m)).length,
  0,
);

if (breaks.length === 0) {
  process.stdout.write(
    `contract compatible with the baseline — ${String(opCount)} operations, additive only\n`,
  );
  process.exit(0);
}

process.stderr.write(
  `\n  BREAKING API CHANGE — ${String(breaks.length)} incompatibility(ies) with the approved contract.\n\n`,
);
for (const b of breaks) process.stderr.write(`    ${b.where}\n      ${b.what}\n`);
process.stderr.write(
  "\n  This project evolves additively (Doc 04 §5.1): within /v1 nothing is removed, renamed or\n" +
    "  retyped, because an app build in the field cannot be patched to keep up.\n\n" +
    "  If the break is genuinely intended — a /v2, or a contract nobody has shipped against yet —\n" +
    "  record it deliberately:\n\n" +
    "    pnpm --filter @medicore/api contract:accept\n\n" +
    "  and commit the new baseline with the reason. Accepting it by accident is the thing this\n" +
    "  refuses to allow; accepting it on purpose is one command.\n",
);
process.exit(1);
