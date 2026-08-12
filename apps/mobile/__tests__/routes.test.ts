/**
 * ROUTE GUARDS — every route that reads the runtime must be behind `requireRuntime`.
 *
 * ── WHY THIS TEST IS A SOURCE SCAN AND NOT A RENDER ─────────────────────────
 * M1's whole test strategy is that the logic worth defending lives outside React, so the suite
 * runs in Node with no renderer, no simulator and no Android SDK. That strategy has exactly one
 * blind spot, and this file covers it: a route module can compile, bundle, typecheck and pass all
 * 79 of the other tests while throwing on its own first render.
 *
 * It did. On a fresh install Expo Router resolves `/` to `(app)/index`, so the signed-in layout
 * mounted before any hospital had been chosen and `useRuntime()` threw — the app was unusable on
 * a new device, and nothing in the gate noticed.
 *
 * The invariant is structural, so a structural check catches it honestly: a route that reads the
 * runtime must be guarded, in itself or in a layout above it. What this cannot tell you is whether
 * the redirect it renders goes somewhere sensible — that still needs a device or a dev client.
 *
 * It is written against the FILESYSTEM rather than a hand-maintained list on purpose. An M2 screen
 * is only useful to its author if it is protected the day it is added, not the day someone
 * remembers to add it here.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "app");

/**
 * Everything that reaches into the runtime. `useRuntime` is the obvious one; the store hooks are
 * the dangerous ones, because they read it INDIRECTLY and a screen using only `useSession` looks
 * entirely innocent while failing in precisely the same way.
 *
 * `useOptionalRuntime` is deliberately absent — tolerating no runtime is the whole point of it.
 */
const RUNTIME_HOOKS = [
  "useRuntime",
  "useSession",
  "useBranch",
  "useConnectivity",
  "useCapabilities",
  "useActiveBranchLabel",
  "useBranchResolved",
  "useAppLifecycle",
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".tsx") ? [full] : [];
  });
}

const routeFiles = sourceFiles;

const read = (file: string): string => readFileSync(file, "utf8");

/** Which runtime hooks a module calls. Matches the call, not the import, so a re-export cannot hide. */
function hooksUsedIn(source: string): string[] {
  return RUNTIME_HOOKS.filter((hook) => new RegExp(`\\b${hook}\\s*\\(`).test(source));
}

/**
 * Only the DEFAULT EXPORT counts. Expo Router renders that and nothing else, so a `requireRuntime`
 * used on some inner component leaves the route itself wide open — and crediting a mere mention
 * would let one guarded helper in the root layout vouch for every screen in the app.
 */
const isGuarded = (source: string): boolean =>
  /export\s+default\s+requireRuntime\s*\(/.test(source);

/** The layouts that wrap a route, outermost first — the same chain Expo Router renders. */
function layoutsAbove(file: string): string[] {
  const layouts: string[] = [];
  for (let dir = dirname(file); dir.startsWith(APP_DIR); dir = dirname(dir)) {
    const layout = join(dir, "_layout.tsx");
    if (layout !== file && routes.includes(layout)) layouts.unshift(layout);
  }
  return layouts;
}

const routes = routeFiles(APP_DIR);
const shortName = (file: string): string => relative(APP_DIR, file).split(sep).join("/");

describe("a route cannot read the runtime unless something guarantees there is one", () => {
  it("finds the route tree at all", () => {
    // Guards the guard: a scan that silently matches nothing passes every assertion below.
    expect(routes.length).toBeGreaterThan(10);
    expect(routes.map(shortName)).toContain("(app)/_layout.tsx");
  });

  it.each(routes.map((file) => [shortName(file), file]))(
    "%s is guarded, or touches nothing that needs guarding",
    (_name, file) => {
      const used = hooksUsedIn(read(file));
      if (used.length === 0) return;

      const guarded = isGuarded(read(file)) || layoutsAbove(file).some((l) => isGuarded(read(l)));

      expect(
        guarded,
        `${shortName(file)} calls ${used.join(", ")} but neither it nor any layout above it is ` +
          `wrapped in requireRuntime. On a device with no hospital chosen this route throws on ` +
          `its first render.`,
      ).toBe(true);
    },
  );

  it("guards the group layout specifically, since it is the one `/` lands on", () => {
    // The regression itself. `(app)/_layout.tsx` covers every screen beneath it, so if this one
    // guard is ever removed the fix above is undone wholesale rather than one screen at a time.
    expect(isGuarded(read(join(APP_DIR, "(app)", "_layout.tsx")))).toBe(true);
  });

  it("leaves the hospital picker reachable, or the guard has nowhere to send anyone", () => {
    // `requireRuntime` redirects here. If this screen ever starts reading the runtime the redirect
    // becomes a loop that renders as a frozen splash — the hardest possible failure to diagnose.
    expect(hooksUsedIn(read(join(APP_DIR, "hospital.tsx")))).toEqual([]);
  });
});

/**
 * ── WHY THIS EXISTS WHEN `typedRoutes` IS SWITCHED ON ───────────────────────
 * It is switched on and it does nothing. Expo Router writes the route union to `.expo/types`,
 * which `tsconfig.json` excludes — and it has to, because `.expo` is generated by the dev server
 * and absent from a fresh clone. Type checking that only works on machines that have run
 * `expo start` is worse than none: it passes locally and quietly stops checking in CI.
 *
 * So the same guarantee is taken here instead, from the filesystem, where CI can also see it.
 */
describe("every route a screen navigates to is a route that exists", () => {
  /** `app/(app)/queue.tsx` → `/queue`. Group segments are grouping only; they are not in the URL. */
  function urlFor(file: string): string | undefined {
    const rel = relative(APP_DIR, file).replace(/\.tsx$/, "");
    const segments = rel.split(sep).filter((s) => !/^\(.*\)$/.test(s));
    const leaf = segments.at(-1);
    if (leaf === undefined || leaf === "_layout" || leaf.startsWith("+")) return undefined;
    if (leaf === "index") segments.pop();
    return `/${segments.join("/")}`;
  }

  const known = new Set(routes.map(urlFor).filter((u): u is string => u !== undefined));

  /** Only literals. A template literal is dynamic and cannot be checked without running it. */
  const LINKS = [
    /(?:href|pathname)\s*[=:]\s*\{?\s*["'](\/[^"']*)["']/g,
    /router\.(?:push|replace|navigate)\(\s*["'](\/[^"']*)["']/g,
  ];

  const sources = [...routes, ...sourceFiles(join(APP_DIR, "..", "src"))];

  it("knows the route table", () => {
    expect(known).toContain("/");
    expect(known).toContain("/hospital");
    expect(known.size).toBeGreaterThan(8);
  });

  it.each(sources.map((f) => [relative(join(APP_DIR, ".."), f).split(sep).join("/"), f]))(
    "%s links only to real screens",
    (name, file) => {
      const source = read(file);
      for (const pattern of LINKS) {
        for (const [, target] of source.matchAll(pattern)) {
          expect(known, `${name} navigates to "${target ?? ""}", which is not a screen`).toContain(
            target,
          );
        }
      }
    },
  );
});

describe("the settings screen renders the tabs the bar cannot fit", () => {
  it("consumes splitTabs' overflow", () => {
    /**
     * The overflow was computed and discarded, so a user entitled to more than five tabs simply
     * lost the surplus — an administrator could not open Billing at all. Settings is the "More"
     * the tab bar's own comment promises, and it is reachable from every screen's header.
     */
    const settings = read(join(APP_DIR, "(app)", "settings.tsx"));
    expect(settings).toMatch(/splitTabs/);
    expect(settings).toMatch(/overflow/);
  });
});
