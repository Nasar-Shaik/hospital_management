/**
 * THE NODE VERSION IS DECLARED IN THREE PLACES AND THEY MUST AGREE.
 *
 * ── THE TWO BUILDS THIS COST ────────────────────────────────────────────────
 * The first EAS build this project ever ran failed in `pnpm install`, in 22 seconds. So did the
 * second, in 1 second. Both for the same reason, and neither said so anywhere a person would look:
 *
 *   `.npmrc`      sets `engine-strict=true`, which turns an unsatisfied `engines.node` from a
 *                 warning into a refusal to install ANYTHING
 *   `metro@0.87`  and fourteen siblings declare `^22.13.0 || ^24.3.0 || >= 26.0.0`
 *   `eas.json`    must name an EXACT Node version — EAS has no "latest 22.x"
 *
 * `.nvmrc` says `22`, and CI resolves that through `node-version-file` to whatever the newest 22.x
 * is, so CI has never once been exposed to this. A developer on 26.x is not exposed either. Only
 * EAS is, because only EAS is pinned — and the pin was chosen from memory rather than from the
 * dependency graph, which is how it landed on 22.11.0: two patch releases under metro's floor,
 * and instantly fatal.
 *
 * ── WHY A TEST AND NOT A COMMENT ────────────────────────────────────────────
 * eas.json is JSON and cannot hold the explanation, the constraint lives in a transitive
 * dependency that will move on its own schedule, and the failure is a build minute spent to be
 * told "exited with non-zero code: 1". This is the cheapest possible place to find out instead.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { major, satisfies, valid, validRange } from "semver";

const MOBILE = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(MOBILE, "..", "..");
const read = (p: string): string => readFileSync(p, "utf8");

const easNode = (
  JSON.parse(read(join(MOBILE, "eas.json"))) as { build: { base: { node: string } } }
).build.base.node;

describe("the Node version EAS builds with", () => {
  it("is an exact version — EAS cannot resolve a range or a major", () => {
    expect(valid(easNode)).not.toBeNull();
  });

  /** `.nvmrc` is what CI and every developer resolve through; the builder must not be on another. */
  it("stays on the major line `.nvmrc` names", () => {
    expect(major(easNode)).toBe(Number(read(join(ROOT, ".nvmrc")).trim()));
  });

  it("satisfies the repository's own engines range", () => {
    const { engines } = JSON.parse(read(join(ROOT, "package.json"))) as {
      engines: { node: string };
    };
    expect(satisfies(easNode, engines.node)).toBe(true);
  });

  /**
   * THE ONE THAT ACTUALLY FIRED — and it has to scan the whole tree, not one package.
   *
   * The first version of this test resolved `metro/package.json` and checked that. It passed on
   * 22.11.0, the very version that had just broken the build, because **two metros are installed**:
   * `0.83.3` wants `>=20.19.4` and `0.87.0` wants `^22.13.0 || ^24.3.0 || >= 26.0.0`, and Node's
   * resolver handed back the lenient one. A guard that agrees with the bug is worse than no guard.
   *
   * `engine-strict` does not resolve anything — pnpm refuses to install ANY package in the tree
   * that rejects the running Node. So this asks the same question pnpm asks, of every package
   * pnpm installs, and the answer is the only one that predicts the builder.
   */
  it("satisfies every engines.node in the installed tree, the way engine-strict does", () => {
    const store = join(ROOT, "node_modules", ".pnpm");
    const offenders: string[] = [];

    for (const entry of readdirSync(store)) {
      const inner = join(store, entry, "node_modules");
      let scoped: string[];
      try {
        scoped = readdirSync(inner);
      } catch {
        continue;
      }
      // one level for `foo`, two for `@scope/bar`
      const packages = scoped.flatMap((name) =>
        name.startsWith("@")
          ? readdirSync(join(inner, name)).map((sub) => join(name, sub))
          : [name],
      );

      for (const name of packages) {
        let manifest: { name?: string; version?: string; engines?: { node?: unknown } };
        try {
          manifest = JSON.parse(read(join(inner, name, "package.json"))) as typeof manifest;
        } catch {
          continue;
        }
        const range = manifest.engines?.node;
        if (typeof range !== "string" || validRange(range) === null) continue;
        if (!satisfies(easNode, range)) {
          offenders.push(`${manifest.name ?? name}@${manifest.version ?? "?"} needs ${range}`);
        }
      }
    }

    expect(
      [...new Set(offenders)].sort(),
      `eas.json pins node ${easNode}; with engine-strict=true these refuse to install`,
    ).toEqual([]);
  });
});
