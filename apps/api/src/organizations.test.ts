/**
 * ORGANIZATION PRESETS — release-gating (ADR-0013 §6).
 *
 * Two things are defended here, and the second one is the reason this file exists.
 *
 *   1. A government hospital is FREE TO THE PATIENT and STILL BILLS. `zero_tariff`
 *      is a tariff, not an off-switch: every charge is posted at ₹0, because the
 *      hospital must report drug consumption and per-patient cost even when nobody
 *      pays. A zero-rupee invoice is a record; a missing invoice is a hole.
 *
 *   2. NOBODY BRANCHES ON `organizationType`. This is enforced mechanically, by
 *      reading the source, because a rule that lives only in an ADR is a rule that
 *      gets broken by the next person in a hurry — and the breakage is invisible
 *      until a customer cannot be sold to.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ORGANIZATION_PRESETS,
  ORGANIZATION_TYPES,
  resolveEncounterPolicy,
} from "@medicore/permissions";

describe("a government hospital is free to the patient — and still bills", () => {
  it("presets to a zero tariff, walk-in entry, and department routing", () => {
    const policy = resolveEncounterPolicy("government_hospital");

    expect(policy.billingMode).toBe("zero_tariff");
    // The patient walks in. There is no appointment to check in to, so the token is
    // issued at the registration counter and they are routed to an OP room.
    expect(policy.entry).toBe("walk_in");
    expect(policy.tokenIssuedAt).toBe("registration");
    expect(policy.routing).toBe("department");
  });

  it("`zero_tariff` is a TARIFF, not an off-switch — billing is never disabled by type", () => {
    // There is deliberately no `billingMode: "none"` and no `billingEnabled: false`.
    // If either existed, someone would reach for it for a government hospital and
    // silently throw away the consumption data the hospital is legally obliged to
    // report — data that cannot be reconstructed after the fact.
    const modes = Object.values(ORGANIZATION_PRESETS).map((p) => p.encounterPolicy.billingMode);

    expect(modes).not.toContain("none");
    expect(modes).not.toContain("disabled");
    for (const mode of modes) {
      expect(["prepaid", "postpaid", "zero_tariff"]).toContain(mode);
    }
  });

  it("a government hospital that opens a PAID private ward needs no code change", () => {
    // The scenario that makes a type branch not merely ugly but WRONG: government
    // hospitals really do run paying private wards. Under `if (type === government)`
    // this customer is unsellable. Under a policy, they are one override.
    const paidWard = resolveEncounterPolicy("government_hospital", { billingMode: "postpaid" });

    expect(paidWard.billingMode).toBe("postpaid");
    // …and everything else about how they run a clinic is untouched.
    expect(paidWard.routing).toBe("department");
    expect(paidWard.tokenIssuedAt).toBe("registration");
  });

  it("every organization type resolves to a complete policy", () => {
    for (const type of ORGANIZATION_TYPES) {
      const policy = resolveEncounterPolicy(type);
      expect(policy.entry).toBeTruthy();
      expect(policy.tokenIssuedAt).toBeTruthy();
      expect(policy.routing).toBeTruthy();
      expect(policy.billingMode).toBeTruthy();
      expect(policy.pharmacy).toBeTruthy();
    }
  });

  it("an unknown or absent type falls back to a working policy, never to undefined", () => {
    // A tenant provisioned before `organizationType` existed must still resolve.
    const policy = resolveEncounterPolicy(undefined);
    expect(policy.billingMode).toBe("prepaid");
  });
});

/**
 * ── THE MECHANICAL GUARD ─────────────────────────────────────────────────────
 *
 * `if (organizationType === "government_hospital")` is forbidden (ADR-0013 §6).
 * The Constitution demands 25 organization types from one codebase; a type branch
 * is a 26th axis that CI cannot enforce and no test can cover, and it widens with
 * every customer.
 *
 * So CI enforces it by reading the source. This is the same instinct as the route
 * audit: a rule that is only written down is a rule that is only sometimes true.
 */
describe("nothing in the codebase branches on organizationType", () => {
  const SRC = join(import.meta.dirname);

  function sourceFiles(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        found.push(...sourceFiles(path));
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        found.push(path);
      }
    }
    return found;
  }

  /**
   * Comments are stripped first, and the reason is instructive: the first run of
   * this guard failed on the very doc comments that EXPLAIN the rule — they quote
   * the forbidden pattern in order to forbid it. A guard that cannot tell code from
   * prose would make the rule unexplainable, and an unexplained rule is one that
   * gets deleted by whoever trips over it next.
   */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }

  it("no comparison of organizationType against a literal type", () => {
    // Matches `organizationType === "…"`, `orgType !== '…'`, `case "government_hospital":`
    const forbidden =
      /(organizationType|orgType)\s*[!=]==?\s*["'`]|case\s+["'`](government_hospital|private_hospital|clinic|diagnostic_centre|medical_college)["'`]/;

    const files = sourceFiles(SRC);
    // Vacuity guard: if the walk finds nothing, the test proves nothing.
    expect(files.length).toBeGreaterThan(50);

    const offenders = files.filter((file) =>
      forbidden.test(stripComments(readFileSync(file, "utf8"))),
    );

    expect(
      offenders,
      "Branching on organizationType is forbidden (ADR-0013 §6). Ask the POLICY instead: " +
        '`policyOf(tenant).billingMode === "zero_tariff"`, never ' +
        '`tenant.organizationType === "government_hospital"`. A government hospital may run a ' +
        "paid private ward, so the branch is not even true — and it would make that customer unsellable.",
    ).toEqual([]);
  });
});
