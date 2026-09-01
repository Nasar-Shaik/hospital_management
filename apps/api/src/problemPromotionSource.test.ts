/**
 * A PROBLEM IS AUTHORED BY A CLINICIAN, FROM A CONSULTATION — AND FROM NOWHERE ELSE.
 *
 * ── THE RULE, AND WHY IT NEEDS A GUARD RATHER THAN A COMMENT ────────────────
 * This product holds three representations of a diagnosis and they are not interchangeable:
 *
 *   consultation.diagnoses[]   the clinician's account of ONE visit
 *   encounterCoding.codes[]    how that visit was CLASSIFIED for the register — a records act,
 *                              revisable by a coder after discharge, deliberately separate from
 *                              the note (mrd.model.ts says so in its header)
 *   problems                   what is true of the PATIENT, longitudinally
 *
 * A promotion path from the MRD coding panel would look like an obvious convenience — the ICD
 * code is already picked there — and would quietly make the records department the author of a
 * standing clinical statement about a patient. A coder correcting `J18.0` to `J18.9` three weeks
 * after discharge must not be able to create, rename or revive a condition on someone's chart.
 *
 * The decision is recorded in `problem.service.ts` and `problem.routes.ts`. This is what makes it
 * enforceable: a comment cannot fail, and the convenience is tempting enough that somebody will
 * eventually reach for it.
 *
 * ── WHY THE SPEC AND THE SOURCE, NOT AN INTEGRATION TEST ────────────────────
 * An integration test proves the routes it walks. The failure being guarded against is a NEW
 * route nobody thought to walk, so the assertion is over the whole shipped surface: every
 * operation that produces a `Problem`, and every import edge into the module that owns it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SPEC = JSON.parse(readFileSync(join(__dirname, "..", "openapi.json"), "utf8")) as Record<
  string,
  unknown
>;

/** The only three operations allowed to hand back a `Problem`. */
const SANCTIONED = [
  "GET /api/v1/patients/{patientId}/problems",
  "POST /api/v1/patients/{patientId}/problems",
  "POST /api/v1/encounters/{id}/problems/promote",
  "POST /api/v1/problems/{id}/resolve",
];

/** Every `METHOD path` in the spec whose success response carries the `Problem` schema. */
function operationsProducingAProblem(): string[] {
  const out: string[] = [];
  const paths = SPEC.paths as Record<string, Record<string, unknown>>;
  for (const [path, ops] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(ops)) {
      const responses = (op as { responses?: unknown }).responses;
      if (JSON.stringify(responses ?? {}).includes('"#/components/schemas/Problem"')) {
        out.push(`${method.toUpperCase()} ${path}`);
      }
    }
  }
  return out.sort();
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("a problem list entry can only be authored from the clinician's consultation", () => {
  it("names the whole surface that produces a Problem, and it is the sanctioned four", () => {
    /**
     * Falsified by adding, say, `POST /mrd/codings/{id}/promote` returning `problem`: the new
     * operation appears here and this goes red with its path in the message.
     */
    expect(operationsProducingAProblem()).toEqual(SANCTIONED.sort());
  });

  it("has exactly one promotion route, and it hangs off the encounter's consultation", () => {
    const promotions = operationsProducingAProblem().filter((op) => op.includes("promote"));
    expect(promotions).toEqual(["POST /api/v1/encounters/{id}/problems/promote"]);
  });

  it("exposes no promotion under an MRD or coding path", () => {
    const fromRecords = operationsProducingAProblem().filter(
      (op) => op.includes("/mrd/") || op.includes("coding"),
    );
    expect(
      fromRecords,
      "the records department must not author a longitudinal clinical statement — see " +
        "problem.service.ts. If this is a deliberate product change, change it there first.",
    ).toEqual([]);
  });

  /**
   * The dependency runs `problems → mrd` (the code master) and never back. If `mrd` reached into
   * `problems` it would either be authoring one or reading one to act on it, and both are the
   * same mistake wearing different clothes. `pnpm boundaries` would catch the CYCLE; it would not
   * catch a one-way edge, which is what this covers.
   */
  it("keeps the MRD module out of the problems module entirely", () => {
    const offenders = filesUnder(join(__dirname, "modules", "mrd")).filter((f) =>
      readFileSync(f, "utf8").includes("modules/problems"),
    );
    expect(offenders).toEqual([]);

    const reverse = filesUnder(join(__dirname, "modules", "mrd")).filter((f) =>
      /from\s+"\.\.\/problems/.test(readFileSync(f, "utf8")),
    );
    expect(reverse).toEqual([]);
  });
});
