/**
 * THE PERMISSION LEDGER — every capability is either enforced or declared unbuilt.
 *
 * ── THE DEFECT CLASS THIS CLOSES ────────────────────────────────────────────
 * `nursing:manage` was granted to NURSE, had a complete backend route, and had NO client caller
 * for two milestones. A nurse could not write a note; the roles page said she could. Nobody found
 * it by reading the catalogue, because a permission that gates nothing looks exactly like a
 * permission whose module is not built yet — and 75 of the 160 codes here genuinely are the
 * latter. `lab:collect` is one; it belongs to the LIS module (M6) and is correctly idle.
 *
 * The two cases are indistinguishable by counting routes, so the difference is DECLARED on the
 * permission (`lifecycle` in `@medicore/permissions`) and checked here against the SHIPPED app.
 * The rule is one sentence: **no `lifecycle` means it must be enforced right now.**
 *
 * ── WHY THIS IS NOT "EVERY PERMISSION MUST GATE A ROUTE" ────────────────────
 * That test would be wrong in both directions and would be silenced within a week.
 *
 *   It would FAIL on real authorization it cannot see. `radiology:sign` gates no route and is
 *   absolutely live: `orders/order.authority.ts` requires it ON TOP of `order:verify` so a
 *   pathologist cannot certify a CT scan. `pharmacy:credit-override` is checked inside
 *   `pharmacy.service.ts`, and it CANNOT gate the route — the pharmacist calling `dispense` is
 *   not the person authorising the credit. Both are declared `service`, and the claim is
 *   verified below rather than believed.
 *
 *   It would also PASS things it should not, if the answer to a red build were "add it to the
 *   allow-list". So there is no allow-list: an exception is a typed object requiring a module and
 *   a reason, `superseded` must name the code that replaced it, and — the part that keeps the
 *   ledger honest over time — a `future` permission that ACQUIRES a route fails too. The
 *   declaration cannot rot in the safe direction.
 *
 * A unit test on purpose: `routeInventory` reads the Express app in memory, so this needs no
 * database and runs in the fast suite, where a wrong answer is seen in seconds.
 */
import { describe, expect, it } from "vitest";
import { createLogger } from "@medicore/logger";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALL_PERMISSIONS,
  ALL_PERMISSION_CODES,
  DEFAULT_ROLES,
  PERMISSIONS,
  type PermissionDefinition,
} from "@medicore/permissions";
import { createApp } from "./app.js";
import { routeInventory } from "./core/http/routeInventory.js";

const app = createApp(createLogger({ service: "permission-lifecycle-test" }));

/** Every permission the SHIPPED app enforces through `authorize()`, and where. */
const routesByPermission = new Map<string, string[]>();
for (const route of routeInventory(app)) {
  if (!route.permission) continue;
  const at = `${route.method.toUpperCase()} ${route.path}`;
  routesByPermission.set(route.permission, [
    ...(routesByPermission.get(route.permission) ?? []),
    at,
  ]);
}

const routed = (code: string): boolean => routesByPermission.has(code);
const describeOf = (p: PermissionDefinition): string =>
  `${p.code}${p.lifecycle ? ` [${p.lifecycle.status}]` : " [active]"}`;

/**
 * The API source, minus routers and tests — where a `service` permission must actually appear.
 *
 * Routers are excluded deliberately: finding the code in a `.routes.ts` would mean it IS routed,
 * which `routesByPermission` already answers. Tests are excluded because a permission mentioned
 * only by a test that asserts nothing enforces it would satisfy the check while proving nothing.
 */
const apiSource = ((): string => {
  const root = fileURLToPath(new URL(".", import.meta.url));
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path, out);
      else if (/\.ts$/.test(entry) && !/\.test\.ts$/.test(entry) && !/\.routes\.ts$/.test(entry)) {
        out.push(path);
      }
    }
    return out;
  };
  return walk(root)
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
})();

/* ── 1. the rule ───────────────────────────────────────────────────────────── */

describe("every permission is enforced, or says why not", () => {
  /**
   * ── THE ONE THAT WOULD HAVE CAUGHT F-2 ────────────────────────────────────
   * An undeclared permission that reaches nothing is either a feature nobody can use or a code
   * nobody should hold. Both are worth a red build, and the failure names the two honest fixes so
   * nobody reaches for a third.
   */
  it("has no silent orphans — an undeclared permission must gate a route", () => {
    const orphans = ALL_PERMISSIONS.filter((p) => !p.lifecycle && !routed(p.code)).map(
      (p) => p.code,
    );

    expect(
      orphans,
      "These permissions claim to be live and gate nothing. Either wire the route that was " +
        "forgotten (this is how `nursing:manage` hid for two milestones), or declare the " +
        "permission `future`/`superseded` in @medicore/permissions with a module and a reason.",
    ).toEqual([]);
  });

  /**
   * The declaration cannot rot in the safe direction. When the LIS module lands and wires
   * `lab:collect`, this fails and the note saying "not implemented" has to go with it — rather
   * than sitting in the catalogue for a year describing a feature that now exists.
   */
  it("has no stale declarations — a future/superseded permission must NOT gate a route", () => {
    const live = ALL_PERMISSIONS.filter(
      (p) =>
        (p.lifecycle?.status === "future" || p.lifecycle?.status === "superseded") &&
        routed(p.code),
    ).map((p) => `${p.code} → ${(routesByPermission.get(p.code) ?? []).join(", ")}`);

    expect(
      live,
      "These are declared unbuilt and now gate a route. The capability shipped — delete the " +
        "`lifecycle` argument so the permission is checked as active from here on.",
    ).toEqual([]);
  });
});

/* ── 2. an exception must carry its evidence ───────────────────────────────── */

describe("a declaration is a claim, and the claim is checked", () => {
  const declared = ALL_PERMISSIONS.filter((p) => p.lifecycle);

  /**
   * ── THE ANTI-ALLOWLIST RULE ───────────────────────────────────────────────
   * The cheapest way to make this gate green is to declare everything `future` with an empty
   * reason. The types stop the empty case; this stops the useless one. A reason another engineer
   * cannot act on is not a reason, it is a silencer.
   */
  it("names a module and gives a usable reason", () => {
    const thin = declared
      .filter(
        (p) => p.lifecycle!.module.trim().length < 2 || p.lifecycle!.reason.trim().length < 20,
      )
      .map(describeOf);

    expect(thin, "A declaration needs an owning module and a reason somebody can act on.").toEqual(
      [],
    );
  });

  /** `superseded` has to say WHAT replaced it, and the replacement has to be a real permission. */
  it("makes every `superseded` name a real, live replacement", () => {
    const broken: string[] = [];
    for (const p of declared.filter((x) => x.lifecycle!.status === "superseded")) {
      const named = [...p.lifecycle!.reason.matchAll(/`([a-z-]+:[a-z:-]+)`/g)].map(
        (m) => m[1] ?? "",
      );
      if (named.length === 0) {
        broken.push(`${p.code}: names no replacement`);
        continue;
      }
      for (const code of named) {
        if (!ALL_PERMISSION_CODES.includes(code))
          broken.push(`${p.code}: \`${code}\` is not a permission`);
        else if (!routed(code)) broken.push(`${p.code}: \`${code}\` gates nothing either`);
      }
    }

    expect(
      broken,
      "A superseded permission must point at the permission that actually took over the capability.",
    ).toEqual([]);
  });

  /**
   * ── THE CLAIM MOST WORTH VERIFYING ────────────────────────────────────────
   * `service` says "this IS enforced, just not by a router". Taken on trust it becomes the hole
   * the whole gate exists to close — the one status that lets a permission gate nothing and pass.
   * So the code must genuinely appear in non-router API source, and the reason must name the file.
   */
  it("proves every `service` permission is really checked outside a router", () => {
    /**
     * Both spellings count, and BOTH are needed. Guidelines Never-rule 7 says a route must
     * reference `PERMISSIONS.X.code` and never a literal — `order.authority.ts` obeys it and maps
     * categories to `PERMISSIONS.RADIOLOGY_SIGN`, so a literal-only scan finds nothing and calls
     * live authorization an orphan. That is exactly the false positive that gets a gate deleted;
     * my first version had it.
     */
    const keyOf = new Map(Object.entries(PERMISSIONS).map(([key, def]) => [def.code, key]));
    const mentioned = (code: string): boolean => {
      const key = keyOf.get(code);
      return (
        apiSource.includes(`"${code}"`) ||
        apiSource.includes(`'${code}'`) ||
        (key !== undefined && apiSource.includes(`PERMISSIONS.${key}`))
      );
    };

    const unproven: string[] = [];
    for (const p of declared.filter((x) => x.lifecycle!.status === "service")) {
      if (routed(p.code)) {
        unproven.push(`${p.code}: gates a route — it is plain active, drop the declaration`);
      }
      if (!mentioned(p.code)) {
        unproven.push(`${p.code}: no check found in non-router API source`);
      }
      if (!/[a-zA-Z0-9_.-]+\.ts/.test(p.lifecycle!.reason)) {
        unproven.push(`${p.code}: the reason must name the file that performs the check`);
      }
    }

    expect(unproven, "A `service` declaration must be verifiable, not a promise.").toEqual([]);
  });
});

/* ── 3. what a hospital is shown it can do ─────────────────────────────────── */

describe("the roles a hospital is seeded with", () => {
  /**
   * Every code on a seeded role must exist. A typo here grants nothing and is invisible until
   * somebody asks why a button never appeared.
   */
  it("grant only permissions that exist in the catalogue", () => {
    const unknown = DEFAULT_ROLES.flatMap((role) =>
      role.permissions
        .filter((code) => !ALL_PERMISSION_CODES.includes(code))
        .map((code) => `${role.code} → ${code}`),
    );

    expect(unknown, "A seeded role grants a permission that is not in the catalogue.").toEqual([]);
  });

  /**
   * ── NOT A FAILURE, A LEDGER ───────────────────────────────────────────────
   * Roles legitimately carry `future` codes: DOCTOR holds `lab:order` and NURSE holds
   * `lab:collect` so that the day those modules land, nobody has to re-grant them across every
   * hospital's database. What is NOT acceptable is that number growing without anybody noticing,
   * so it is pinned. A change here is a prompt to check the report, not automatically a bug.
   */
  it("carry a known number of not-yet-live codes, so growth is deliberate", () => {
    const idle = new Set(
      DEFAULT_ROLES.flatMap((role) =>
        role.permissions.filter((code) => {
          const permission = ALL_PERMISSIONS.find((p) => p.code === code);
          return permission?.lifecycle && permission.lifecycle.status !== "service";
        }),
      ),
    );

    expect(
      idle.size,
      `Distinct not-yet-live permissions held by seeded roles: ${[...idle].sort().join(", ")}`,
    ).toBe(68);
  });
});

/* ── 4. the shape of the catalogue, for the report ─────────────────────────── */

describe("the catalogue as a whole", () => {
  it("is fully accounted for: every permission is active, declared, or both is impossible", () => {
    const active = ALL_PERMISSIONS.filter((p) => !p.lifecycle);
    const declared = ALL_PERMISSIONS.filter((p) => p.lifecycle);

    expect(active.length + declared.length).toBe(ALL_PERMISSIONS.length);
    // Every active permission is routed — the same claim as §1, stated as a total so the numbers
    // in the audit report cannot drift from the code without this failing.
    expect(active.every((p) => routed(p.code))).toBe(true);
    expect(ALL_PERMISSIONS.length).toBeGreaterThan(0);
  });
});
