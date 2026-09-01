/**
 * THE CLINICAL SCHEMA REFUSALS, AS A CONTRACT.
 *
 * ── WHY THESE FIVE NEED A CONTRACT TEST AND OTHER ERRORS DO NOT ─────────────
 * `HMS-MAR-002`, `HMS-PHM-004`, `HMS-ORD-001`, `HMS-ADM-003` and `HMS-ENC-001` are the only
 * errors in this system that a CLINICIAN is expected to act on procedurally — chart on paper,
 * hand over on paper, order on paper, allocate on the board, register on paper — while somebody
 * else repairs a database. Three properties have to hold for that to work, and each of them is
 * the kind of thing that rots silently:
 *
 *   1. They are registered in `ERROR_CODES.md`, which the Guidelines make the only legal source
 *      of codes. An unregistered code is one nobody can look up at 3am.
 *   2. They carry `Retry-After`. A 503 without one invites a client to hammer, and the whole
 *      point of the 60s value is that the readiness verdict cannot change faster than that.
 *   3. Their `details` carry SCHEMA facts and never PATIENT facts. `errorHandler` now writes
 *      `details` into the server log for every 5xx, so anything patient-shaped in there would be
 *      PHI in a log file — the exact leak Doc 09 forbids.
 *
 * Read from the source rather than by exercising a database: these are properties of how the
 * refusals are CONSTRUCTED, and an integration test would prove them only for the paths it
 * happened to walk.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const read = (relative: string): string => readFileSync(join(root, relative), "utf8");

/** Every clinical schema refusal, and the guard that raises it. */
const REFUSALS = [
  { code: "HMS-MAR-002", source: "src/modules/mar/mar.service.ts" },
  { code: "HMS-PHM-004", source: "src/modules/pharmacy/pharmacy.service.ts" },
  { code: "HMS-ORD-001", source: "src/modules/orders/order.service.ts" },
  { code: "HMS-ADM-003", source: "src/modules/encounters/encounter.service.ts" },
  { code: "HMS-ENC-001", source: "src/modules/encounters/encounter.service.ts" },
] as const;

const ERROR_CODES = readFileSync(
  join(root, "..", "..", "AI_Workflow", "docs", "ERROR_CODES.md"),
  "utf8",
);

describe("the clinical schema refusals are registered where a human can look them up", () => {
  for (const { code } of REFUSALS) {
    it(`${code} is in ERROR_CODES.md, as a 503`, () => {
      const row = ERROR_CODES.split("\n").find((line) => line.includes(`| ${code} `));
      expect(row, `${code} is thrown but not registered`).toBeDefined();
      expect(row).toMatch(/\|\s*503\s*\|/);
      // It must tell the client it is worth retrying — a 503 marked "no" is a contradiction.
      expect(row).toMatch(/yes \(backoff\)/);
    });
  }

  it("no code is used twice", () => {
    const codes = REFUSALS.map((r) => r.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("every clinical schema refusal carries Retry-After", () => {
  for (const { code, source } of REFUSALS) {
    it(`${code} passes a retry hint to AppError`, () => {
      const text = read(source);
      const at = text.indexOf(`"${code}"`);
      expect(at, `${code} is not thrown in ${source}`).toBeGreaterThan(-1);

      /**
       * The constructor call runs from the code to its closing `);`. `retryAfterSeconds` is the
       * sixth argument, so the presence of a bare `60,` after the `true,` operational flag is what
       * distinguishes a refusal that sets the header from one that forgot.
       */
      const call = text.slice(at, text.indexOf(");", at));
      expect(call, `${code} must pass retryAfterSeconds`).toMatch(
        /\btrue,\s*(\/\/[^\n]*\n\s*)*60,/,
      );
    });
  }

  it("errorHandler is what turns that into the header, so no throw site can forget", () => {
    const handler = read("src/core/http/errorHandler.ts");
    expect(handler).toMatch(/setHeader\("Retry-After"/);
    expect(handler).toMatch(/err\.retryAfterSeconds !== undefined/);
  });
});

/**
 * ── THE PHI CHECK ───────────────────────────────────────────────────────────
 * `errorHandler` writes `details` into the log for every 5xx. These five build `details` from
 * `readiness.missing`, mapping exactly three fields — rule, migration, found — plus an optional
 * `unknown`. Every one of those is a fact about an INDEX. If a future edit adds the patient, the
 * encounter or the drug "so the log is more useful", this is where it stops.
 */
describe("a schema refusal never puts patient data in details", () => {
  const FORBIDDEN = [
    "patientId",
    "patientName",
    "uhid",
    "encounterId",
    "prescriptionId",
    "drugCode",
    "bedCode",
    "name:",
  ];

  for (const { code, source } of REFUSALS) {
    it(`${code} maps only schema facts`, () => {
      const text = read(source);
      const at = text.indexOf(`"${code}"`);
      const call = text.slice(at, text.indexOf("\n  );", at));

      for (const field of FORBIDDEN) {
        expect(call, `${code} must not put ${field} in details`).not.toContain(field);
      }
      // And it must actually carry the two things an operator needs.
      expect(call).toContain("rule");
      expect(call).toContain("migration");
    });
  }

  it("the 5xx log line exists at all, and says what it logged", () => {
    const handler = read("src/core/http/errorHandler.ts");
    expect(handler).toMatch(/err\.httpStatus >= 500/);
    expect(handler).toMatch(/logger\.error\(/);
    // The four fields an operator needs to act without asking a clinician.
    for (const field of ["code", "status", "traceId", "details"]) {
      expect(handler).toContain(`${field}:`);
    }
  });

  /** 4xx must stay quiet: a 404 or a validation failure is the API working, not an incident. */
  it("does not log 4xx AppErrors — that would drown the incident in noise", () => {
    const handler = read("src/core/http/errorHandler.ts");
    expect(handler).not.toMatch(/err\.httpStatus >= 400/);
  });

  /**
   * ── WHY THE LOG LINE IS SAFE AT ALL, ASSERTED RATHER THAN ASSUMED ──────────
   * `errorHandler` writes `details` into the log for EVERY 5xx `AppError`, not only the five
   * named above. That is safe today for one reason and one reason only: those five are the
   * only 5xx `AppError`s in the codebase. Nothing was holding that true.
   *
   * The security audit of 2026-08-17 checked it by hand and found exactly five. A sixth added
   * later — a payment gateway timeout carrying the invoice, an integration error carrying the
   * patient — would start writing PHI into a log file the moment it first threw, silently, with
   * every existing test still green. This is the assertion that turns "we looked once" into a
   * property, and it is why the PHI checks above can be scoped to a known list.
   */
  it("the five are the ONLY 5xx AppErrors — a sixth would log its details unreviewed", () => {
    const modules = join(root, "src", "modules");
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
          const text = readFileSync(full, "utf8");
          for (const match of text.matchAll(
            /new AppError\(\s*(?:\/\/[^\n]*\n\s*)*"([\w-]+)",\s*(\d{3})/g,
          )) {
            const [, code, status] = match;
            if (status && Number(status) >= 500 && !REFUSALS.some((r) => r.code === code)) {
              offenders.push(`${entry.name}: ${String(code)} (${String(status)})`);
            }
          }
        }
      }
    };
    walk(modules);

    expect(
      offenders,
      "a 5xx AppError outside the reviewed set — its `details` will be written to the server " +
        "log verbatim. Either give it a 4xx, or add it to REFUSALS above so the PHI checks cover it.",
    ).toEqual([]);
  });
});
