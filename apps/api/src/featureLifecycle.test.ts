/**
 * THE FLAG LEDGER — every entitlement is enforced, or declares why it is not.
 *
 * ── THE DEFECT CLASS, AND WHY IT NEEDS ITS OWN GATE ─────────────────────────
 * `permissionLifecycle.test.ts` closes the same hole one layer down: a permission that gates
 * nothing is a feature nobody has. A FLAG that gates nothing is the mirror image — a feature
 * EVERYBODY has — and it is the more expensive of the two, because the thing it fails to
 * withhold is the thing with a price on it.
 *
 * Both live examples were found by reading, not by failing:
 *
 *   `module.finance.packages` sat in three editions and gated no code. Care packages are sold as
 *   a Day Care / Hospital Plus differentiator; every PLAN_HOSPITAL and PLAN_CLINIC tenant had
 *   them, because the package routes carried the same `module.ops.opd` as the rest of billing.
 *
 *   `portal.patient` sat in CLINIC_FLAGS — which every edition extends — with no portal anywhere
 *   in the product, and appeared on every hospital's subscription page under "Included in this
 *   plan".
 *
 * Nothing about either was visible in a diff. `module.clinical.ris` and
 * `module.clinical.emergency` were the same defect and were each found, separately, by a human
 * re-reading the catalogue months later. Three finds by audit is the signal that the audit should
 * be a test.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 * A flag with no entry in `FEATURE_LIFECYCLE` must be read by shipped code — a route's `feature`
 * tag, or a non-router check like `orders/order.entitlement.ts`. A flag WITH an entry must be
 * read by none, so a declaration cannot rot once the module lands.
 *
 * A unit test on purpose, like its sibling: `routeInventory` reads the Express app in memory, so
 * a wrong answer here is seen in seconds rather than after a database spins up.
 */
import { describe, expect, it } from "vitest";
import { createLogger } from "@medicore/logger";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EDITIONS,
  FEATURE_FLAGS,
  FEATURE_LIFECYCLE,
  type FeatureFlag,
} from "@medicore/permissions";
import { createApp } from "./app.js";
import { routeInventory } from "./core/http/routeInventory.js";

const app = createApp(createLogger({ service: "feature-lifecycle-test" }));

const ALL_FLAGS = Object.values(FEATURE_FLAGS) as FeatureFlag[];
const KEY_OF = new Map(Object.entries(FEATURE_FLAGS).map(([key, flag]) => [flag as string, key]));

/** Every flag the SHIPPED app enforces at a route, and where. */
const routesByFeature = new Map<string, string[]>();
for (const route of routeInventory(app)) {
  if (!route.feature) continue;
  routesByFeature.set(route.feature, [
    ...(routesByFeature.get(route.feature) ?? []),
    `${route.method.toUpperCase()} ${route.path}`,
  ]);
}

/**
 * The API source minus routers and tests — where a flag checked OUTSIDE a route must appear.
 *
 * Routers are excluded because finding a flag in a `.routes.ts` would only re-answer what
 * `routesByFeature` already answers, from the app itself rather than from a string. Tests are
 * excluded because a flag named only by a test proves nothing about what ships: `rbac.int.test.ts`
 * mentions `module.clinical.dialysis` precisely to assert that nobody can switch it on.
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

/**
 * Checked outside a router — `orders/order.entitlement.ts` is the live case: the Order is
 * polymorphic, so `module.clinical.ris` is looked up where the CATEGORY is known rather than
 * gating all seven order kinds at the route.
 *
 * Both spellings count, for the same reason the permission ledger takes both: the guidelines
 * require `FEATURE_FLAGS.X` over a literal, so a literal-only scan would call the one correctly
 * written check an orphan.
 */
function checkedInService(flag: FeatureFlag): boolean {
  const key = KEY_OF.get(flag);
  return (
    apiSource.includes(`"${flag}"`) ||
    apiSource.includes(`'${flag}'`) ||
    (key !== undefined && apiSource.includes(`FEATURE_FLAGS.${key}`))
  );
}

const enforced = (flag: FeatureFlag): boolean =>
  routesByFeature.has(flag) || checkedInService(flag);
const declaration = (flag: FeatureFlag) => FEATURE_LIFECYCLE[flag];

/* ── 1. the rule ───────────────────────────────────────────────────────────── */

describe("every feature flag gates something, or says why not", () => {
  /**
   * ── THE ONE THAT WOULD HAVE CAUGHT `module.finance.packages` ──────────────
   * An undeclared flag that gates nothing is a capability every edition holds regardless of what
   * it paid. The failure names the two honest fixes, because there is a third that looks easier:
   * quietly declaring it `bundled`, which is how a real gate becomes a comment.
   */
  it("has no silent orphans — an undeclared flag must be read by shipped code", () => {
    const orphans = ALL_FLAGS.filter((flag) => !declaration(flag) && !enforced(flag));

    expect(
      orphans,
      "These flags are sold and gate nothing, so every hospital has the capability whatever it " +
        "bought. Either gate the routes that were forgotten (this is how `module.finance.packages` " +
        "gave PLAN_HOSPITAL a Hospital-Plus differentiator for free), or declare the flag in " +
        "`FEATURE_LIFECYCLE` with an owning module and a reason.",
    ).toEqual([]);
  });

  /**
   * The declaration cannot rot in the safe direction. When dialysis lands and its routes carry
   * the flag, this fails and the note saying "not built" has to go with it — rather than sitting
   * in the catalogue for a year describing a module that now exists.
   */
  it("has no stale declarations — a declared flag must gate nothing", () => {
    const live = ALL_FLAGS.filter((flag) => declaration(flag) && enforced(flag)).map(
      (flag) =>
        `${flag} → ${(routesByFeature.get(flag) ?? ["checked in non-router source"]).join(", ")}`,
    );

    expect(
      live,
      "These are declared as gating nothing and now gate something. The module shipped — delete " +
        "the `FEATURE_LIFECYCLE` entry so the flag is checked as live from here on.",
    ).toEqual([]);
  });

  it("declares nothing it has not defined", () => {
    const unknown = Object.keys(FEATURE_LIFECYCLE).filter(
      (flag) => !ALL_FLAGS.includes(flag as FeatureFlag),
    );
    expect(unknown, "A declaration names a flag that is not in FEATURE_FLAGS.").toEqual([]);
  });
});

/* ── 2. a declaration is a claim ───────────────────────────────────────────── */

describe("a declaration carries its evidence", () => {
  /**
   * The cheapest way to make this gate green is to declare everything with an empty reason. The
   * types stop the empty case; this stops the useless one.
   */
  it("names an owning module and gives a usable reason", () => {
    const thin = ALL_FLAGS.filter((flag) => {
      const d = declaration(flag);
      return d && (d.module.trim().length < 2 || d.reason.trim().length < 20);
    });

    expect(thin, "A declaration needs an owning module and a reason somebody can act on.").toEqual(
      [],
    );
  });

  /**
   * ── THE CLAIMS MOST WORTH DISTRUSTING ─────────────────────────────────────
   * `bundled` and `gated` both say "this capability is built and deliberately has no gate of its
   * own". They are what a MISSING gate would say about itself — `module.finance.packages` could
   * have been written as either and passed — so neither is taken on its word.
   *
   * `bundled` is confined to what it actually means: a capability every edition has. A flag only
   * some editions carry is being sold as a differentiator, and a differentiator with no gate is
   * the bug. This check is what stopped `module.finance.ipBilling` being filed here on the way
   * past; it is `gated` by `module.ops.ipd`, which is a different and verifiable claim.
   */
  it("allows `bundled` only where every edition really has the capability", () => {
    const wrong: string[] = [];
    for (const flag of ALL_FLAGS) {
      if (declaration(flag)?.status !== "bundled") continue;
      const without = Object.values(EDITIONS)
        .filter((e) => !(e.flags as readonly FeatureFlag[]).includes(flag))
        .map((e) => e.code);
      if (without.length > 0) wrong.push(`${flag}: not in ${without.join(", ")}`);
    }

    expect(
      wrong,
      "`bundled` means the capability ships to every edition, so the flag is a price-list line " +
        "rather than a switch. These editions do not carry it — which makes it a differentiator " +
        "that gates nothing. Gate it, declare it `gated` by the flag that does, or add it to the " +
        "editions that are already getting it.",
    ).toEqual([]);
  });

  /**
   * `gated` names the flag that actually withholds the capability, and all three parts of that
   * sentence are checked: the named flag has to exist, has to be live itself (a gate behind a
   * gate that gates nothing is no gate), and has to be held by every edition that sells this one
   * — otherwise the edition lists a module its own plan makes unreachable, which is the same lie
   * as an unbuilt flag wearing a different label.
   */
  it("proves every `gated` flag names a live gate that its editions actually hold", () => {
    const unproven: string[] = [];
    for (const flag of ALL_FLAGS) {
      const d = declaration(flag);
      if (d?.status !== "gated") continue;

      const by = d.gatedBy;
      if (!by) {
        unproven.push(`${flag}: names no gating flag`);
        continue;
      }
      if (!ALL_FLAGS.includes(by)) unproven.push(`${flag}: \`${by}\` is not a flag`);
      else if (!enforced(by)) unproven.push(`${flag}: \`${by}\` gates nothing either`);

      const orphanEditions = Object.values(EDITIONS)
        .filter((e) => {
          const flags = e.flags as readonly FeatureFlag[];
          return flags.includes(flag) && !flags.includes(by);
        })
        .map((e) => e.code);
      if (orphanEditions.length > 0) {
        unproven.push(`${flag}: sold without \`${by}\` in ${orphanEditions.join(", ")}`);
      }
    }

    expect(unproven, "A `gated` declaration must be verifiable, not a promise.").toEqual([]);
  });
});

/* ── 3. what a hospital is told it bought ──────────────────────────────────── */

describe("the editions a hospital can buy", () => {
  /**
   * ── THE ONE THAT WOULD HAVE CAUGHT `portal.patient` ───────────────────────
   * Editions are not internal: `/subscription` lists an edition's flags to the hospital under
   * "Included in this plan". A flag every edition shares is therefore a promise made to EVERY
   * customer, including the single-doctor clinic on the cheapest plan — and the patient portal
   * was one of four such promises while no portal existed in any edition.
   *
   * Premium editions may list a module we are still building; that is a contract someone signs
   * deliberately, and §3's pinned count keeps it deliberate. The base bundle may not: nobody
   * signs for it, everybody receives it.
   */
  it("promises nothing unbuilt to every customer", () => {
    const editions = Object.values(EDITIONS);
    const inEvery = (editions[0]?.flags ?? []).filter((flag) =>
      editions.every((e) => (e.flags as readonly FeatureFlag[]).includes(flag)),
    );
    const unbuilt = inEvery.filter((flag) => declaration(flag)?.status === "unbuilt");

    expect(
      unbuilt,
      "Every edition sells these and none of them exists. A flag in the base bundle is shown to " +
        "every hospital on its subscription page as a module it has — remove it from the " +
        "editions until the module ships.",
    ).toEqual([]);
  });

  /**
   * ── NOT A FAILURE, A LEDGER ───────────────────────────────────────────────
   * A premium edition legitimately lists a module under construction — Enterprise sells
   * inter-branch transfer, Hospital Plus sells the blood bank — and pulling those out would
   * misdescribe what the sales conversation is actually about. What is NOT acceptable is that
   * number growing without anybody noticing, so it is pinned exactly like the permission
   * ledger's idle count. It should FALL when a module ships.
   */
  it("sells a known number of unbuilt modules, so growth is deliberate", () => {
    const sold = new Set(
      Object.values(EDITIONS).flatMap((e) =>
        (e.flags as readonly FeatureFlag[]).filter(
          (flag) => declaration(flag)?.status === "unbuilt",
        ),
      ),
    );

    /**
     * 12 → 11 when `portal.patient` left the editions (2026-08-20). The remaining eleven are all
     * in Clinic Plus and above, each one a department on the roadmap.
     */
    expect(sold.size, `Unbuilt modules listed in an edition: ${[...sold].sort().join(", ")}`).toBe(
      11,
    );
  });
});

/* ── 4. the shape of the catalogue, for the report ─────────────────────────── */

describe("the flag catalogue as a whole", () => {
  it("is fully accounted for: every flag is live or declared, never both and never neither", () => {
    const live = ALL_FLAGS.filter((flag) => !declaration(flag));
    const declared = ALL_FLAGS.filter((flag) => declaration(flag));

    expect(live.length + declared.length).toBe(ALL_FLAGS.length);
    expect(live.every((flag) => enforced(flag))).toBe(true);
    expect(declared.every((flag) => !enforced(flag))).toBe(true);
  });
});
