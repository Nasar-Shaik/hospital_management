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

function sourceFiles(dir: string, extensions = [".tsx"]): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full, extensions);
    return extensions.some((e) => entry.name.endsWith(e)) ? [full] : [];
  });
}

const routeFiles = (dir: string): string[] => sourceFiles(dir);

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

/**
 * ── THE SELECTOR THAT SPINS THE APP ─────────────────────────────────────────
 * `useStore` is `useSyncExternalStore`: it compares snapshots with `Object.is` and re-renders when
 * they differ. A selector that CONSTRUCTS its result — `s.user?.roles ?? []` — returns a fresh
 * array every call, so it never equals the previous one. React re-renders, re-reads, gets another
 * new array, and spins until "Maximum update depth exceeded".
 *
 * It is invisible in review (the line reads as ordinary defaulting), it typechecks, it bundles, and
 * it only fires once a real screen mounts — which is why it survived to a device. A selector must
 * return something already IN the store, or a primitive. Defaults belong at the call site.
 *
 * Limitation, stated plainly: this reads the selector written at the call site. A named selector
 * passed by reference (`useBranch(activeBranchLabel)`) is not followed, so a helper that allocates
 * would slip through.
 */
describe("a store selector never returns a value it just built", () => {
  const ALLOCATES: [RegExp, string][] = [
    [/\?\?\s*\[\]/, "?? [] mints a new array"],
    [/\?\?\s*\{\}/, "?? {} mints a new object"],
    [/\.(?:map|filter|slice|concat|flatMap|sort)\(/, "array methods return new arrays"],
    [/new\s+(?:Set|Map|Array|Object)\(/, "constructs a new collection"],
    [/=>\s*\[[^\]]/, "returns an array literal"],
    [/=>\s*\{\s*\w+\s*:/, "returns an object literal"],
    [/\[\s*\.\.\./, "spreads into a new array"],
  ];

  const HOOK = /\buse(?:Session|Branch|Connectivity|Store)\s*\(/;

  const scanned = [
    ...sourceFiles(APP_DIR, [".ts", ".tsx"]),
    ...sourceFiles(join(APP_DIR, "..", "src"), [".ts", ".tsx"]),
  ];

  it("scans the files that actually contain selectors", () => {
    const withHooks = scanned.filter((f) => HOOK.test(read(f)));
    expect(withHooks.length).toBeGreaterThan(4);
  });

  it.each(scanned.map((f) => [relative(join(APP_DIR, ".."), f).split(sep).join("/"), f]))(
    "%s",
    (name, file) => {
      const lines = read(file).split("\n");
      lines.forEach((line, index) => {
        if (!HOOK.test(line)) return;
        // The selector is everything after the arrow; the store argument before it is irrelevant.
        const body = line.slice(line.indexOf("=>") + 2);
        if (!line.includes("=>")) return;

        for (const [pattern, why] of ALLOCATES) {
          expect(
            pattern.test(body),
            `${name}:${String(index + 1)} — ${why}, so the snapshot never compares equal and the ` +
              `screen re-renders forever. Select the stored value and default at the call site.\n` +
              `    ${line.trim()}`,
          ).toBe(false);
        }
      });
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
