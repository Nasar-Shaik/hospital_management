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
  // M2. `useClinical` and `useZoneFor` read the runtime for the api-client and the branch list;
  // `usePatient` reads it through `useClinical`, one level down, which is exactly the indirection
  // that makes a screen using only it look innocent while failing on the same first render.
  "useClinical",
  "useZoneFor",
  "usePatient",
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

/**
 * The file with its comments removed — for the checks that are about CODE.
 *
 * This codebase documents heavily, and the prose legitimately quotes the things the scans below
 * forbid: `https://apollo.paperlesstech.in` as an example base URL, `toLocaleTimeString()` as the
 * bug being avoided. Scanning the raw text would fail on the explanation of the rule, which is the
 * fastest way to teach everybody to delete the comment instead of the mistake.
 *
 * Line comments are matched only when NOT preceded by a colon, so the `//` inside a `https://`
 * that appears in real code still survives to be caught.
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

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

/**
 * ── THE THREE ARCHITECTURE RULES M2 CAN LOSE SILENTLY ───────────────────────
 * Each of these is a one-line mistake that typechecks, bundles, passes every behavioural test, and
 * is invisible in review because the line looks completely ordinary. They are checked structurally
 * for the same reason the route guards are: the compiler has no opinion about any of them.
 */
describe("a clinical time is never rendered in the device's zone", () => {
  /**
   * `new Date(iso).toLocaleTimeString()` is the bug. It reads correctly, it is what the web app
   * still does, and on a phone it silently re-times the whole ward round to wherever the reader is
   * standing — turning an "08:00 dose" into a different number for every person who looks at it.
   *
   * `Intl.DateTimeFormat` WITHOUT a `timeZone` is the same bug wearing a longer name.
   *
   * `src/lib/time.ts` is the one exemption: it is the module that takes a zone and applies it, and
   * it is unit-tested against fixed instants in `foundation.test.ts` and `clinical.test.ts`.
   */
  const DEVICE_CLOCK: [RegExp, string][] = [
    [/\.toLocaleTimeString\s*\(/, "toLocaleTimeString() formats in the DEVICE's zone"],
    [/\.toLocaleDateString\s*\(/, "toLocaleDateString() formats in the DEVICE's zone"],
    [/\.toLocaleString\s*\(/, "toLocaleString() formats in the DEVICE's zone"],
    [
      /\.getHours\s*\(\)|\.getDate\s*\(\)(?!\s*[-+])/,
      "getHours/getDate read the DEVICE's calendar",
    ],
  ];

  /**
   * ── `src/clinical/patient.ts` WAS EXEMPT, AND THAT IS HOW IT HID (M2 L) ────
   * `ageInYears` read `now.getFullYear()` / `getMonth()` / `getDate()` — the DEVICE's calendar —
   * and the exemption above it meant this scan walked straight past. A consultant reviewing a
   * Hyderabad ward from London at 21:00 is already on the next IST day, so a patient whose
   * birthday is today at the hospital was shown a year younger on their own chart.
   *
   * It now derives today from `formatDayKey(now, zone)` like everything else, so the exemption is
   * gone and this scan is its regression test. `src/lib/time.ts` remains the only one, because it
   * is the module that takes a zone and applies it.
   */
  const EXEMPT = ["src/lib/time.ts"];

  const scanned = [
    ...sourceFiles(APP_DIR, [".ts", ".tsx"]),
    ...sourceFiles(join(APP_DIR, "..", "src"), [".ts", ".tsx"]),
  ];

  it("scans something", () => {
    expect(scanned.length).toBeGreaterThan(20);
  });

  it.each(scanned.map((f) => [relative(join(APP_DIR, ".."), f).split(sep).join("/"), f]))(
    "%s",
    (name, file) => {
      if (EXEMPT.includes(name)) return;
      const source = codeOnly(read(file));

      for (const [pattern, why] of DEVICE_CLOCK) {
        expect(
          pattern.test(source),
          `${name} — ${why}. A clinical timestamp goes UTC → the BRANCH's zone → display; use ` +
            `formatTime/formatDateTime from src/lib/time.ts with a zone from useZoneFor().`,
        ).toBe(false);
      }

      /**
       * A formatter built with no `timeZone` falls back to the device's. Matched by looking at the
       * options object that follows, which is crude but catches the realistic mistake — someone
       * reaching for `Intl` directly instead of the helpers.
       */
      for (const [, options] of source.matchAll(/new Intl\.DateTimeFormat\s*\(([^)]*)\)/g)) {
        expect(
          (options ?? "").includes("timeZone"),
          `${name} builds an Intl.DateTimeFormat with no timeZone, so it formats in the device's ` +
            `zone. Pass the branch's zone.`,
        ).toBe(true);
      }
    },
  );

  it("proves src/lib/time.ts is the only place that formats at all", () => {
    // Guards the exemption: if the helpers move, this list has to move with them, and the check
    // above stops being vacuous rather than silently passing on a file that no longer exists.
    expect(read(join(APP_DIR, "..", "src", "lib", "time.ts"))).toMatch(/timeZone: zone/);
  });
});

describe("nothing reaches the network except through the ApiClient", () => {
  /**
   * The rule is in the M2 brief and it is worth a machine check: one `fetch("/api/v1/...")` inside
   * a screen bypasses the tenant host, the bearer token, `X-Active-Branch`, the refresh-and-replay
   * on 401 and `ApiClientError` — five guarantees, silently, in one line that looks like normal
   * code. `src/lib/runtime.ts` is the one place a `fetch` legitimately appears: it wraps the
   * transport to observe connectivity, and hands it to the client.
   */
  const EXEMPT = ["src/lib/runtime.ts", "src/lib/apiClient.ts"];
  const scanned = [
    ...sourceFiles(APP_DIR, [".ts", ".tsx"]),
    ...sourceFiles(join(APP_DIR, "..", "src"), [".ts", ".tsx"]),
  ];

  it.each(scanned.map((f) => [relative(join(APP_DIR, ".."), f).split(sep).join("/"), f]))(
    "%s",
    (name, file) => {
      if (EXEMPT.includes(name)) return;
      const source = codeOnly(read(file));

      expect(
        /\bfetch\s*\(/.test(source),
        `${name} calls fetch() directly. Every request goes through @medicore/api-client, which ` +
          `owns the tenant host, the token, the active-branch header, the 401 replay and the ` +
          `error type.`,
      ).toBe(false);

      expect(
        /["'`]https?:\/\//.test(source),
        `${name} contains an absolute URL. The base URL is derived from the hospital profile ` +
          `(src/lib/tenant.ts); a literal one would point a build at somebody else's server.`,
      ).toBe(false);

      // A hand-built query key would sidestep the branch prefix, which is the whole point of
      // `keys.ts`. Descriptors come from `query/clinical.ts`; screens spread them.
      if (!name.startsWith("src/query/")) {
        expect(
          /queryKey\s*:\s*\[/.test(source),
          `${name} builds a queryKey from an inline array. Branch-sensitive keys must come from ` +
            `src/query/keys.ts — via a descriptor in src/query/clinical.ts — or the ` +
            `[tenant, branch] prefix gets forgotten on exactly one screen. ` +
            `\`queryKey: queryKeys.something(...)\` is the allowed form.`,
        ).toBe(false);
      }
    },
  );
});

describe("a screen that writes clinical text protects it", () => {
  /**
   * ── THE PROTECTION IS TWO RULES, AND ONLY ONE IS SCANNABLE ──────────────────
   * The load-bearing one is that a failed save never clears the form: the mutation's `onSuccess`
   * is the ONLY place the baseline moves, so a 500, a timeout or a dropped connection leaves every
   * word on screen. That lives inside a component's state and cannot be checked from here — it is
   * covered by the consultation tests in `writes.test.ts` at the module level (`patchFor` /
   * `isDirty` against an unmoved baseline).
   *
   * The one that CAN be checked structurally is the second: a screen holding unsaved clinical text
   * must intercept navigation away from it. `useUnsavedChanges` hooks `beforeRemove`, which is the
   * one event every exit fires — the header chevron, the hardware back button, and the edge swipe.
   * Forgetting it is a one-line omission that loses a consultation note to a habitual back-swipe,
   * and nothing else in the gate would notice.
   */
  const WRITES = /\buseClinicalWrite\s*\(/;
  const PROTECTS = /\buseUnsavedChanges\s*\(/;

  /**
   * The order pad writes, and deliberately does not ask. What it holds is a SELECTION of catalogue
   * codes — two taps to rebuild, no typed clinical information — so a confirmation on the way out
   * would be a dialog that trains people to dismiss dialogs. The moment it grows a free-text field
   * it must come off this list.
   */
  const NO_TYPED_CONTENT = ["app/order-pad/[encounterId].tsx"];

  it.each(routes.map((file) => [shortName(file), file]))("%s", (name, file) => {
    const source = codeOnly(read(file));
    if (!WRITES.test(source)) return;
    if (NO_TYPED_CONTENT.includes(`app/${name}`)) return;

    expect(
      PROTECTS.test(source),
      `app/${name} performs a clinical write but never calls useUnsavedChanges. A doctor who ` +
        `swipes back mid-note loses it silently. Add the guard, or add the screen to ` +
        `NO_TYPED_CONTENT with a reason if it holds nothing worth protecting.`,
    ).toBe(true);
  });

  it("finds the write screens at all, so the check is not vacuous", () => {
    const writers = routes.filter((file) => WRITES.test(codeOnly(read(file))));
    expect(writers.length).toBeGreaterThanOrEqual(3);
  });
});

describe("a branch id is never taken from navigation", () => {
  /**
   * The active branch comes from the validated switcher and nowhere else (M0 §7, ADR-0015). A
   * route param, a deep link or a push payload carrying `branchId` would be a caller-supplied
   * branch — and the app would send it as `X-Active-Branch` on every subsequent request, which is
   * precisely the "never trust a branchId from navigation" rule.
   */
  const scanned = [
    ...sourceFiles(APP_DIR, [".ts", ".tsx"]),
    ...sourceFiles(join(APP_DIR, "..", "src"), [".ts", ".tsx"]),
  ];

  it.each(scanned.map((f) => [relative(join(APP_DIR, ".."), f).split(sep).join("/"), f]))(
    "%s",
    (name, file) => {
      const source = codeOnly(read(file));
      // `useLocalSearchParams<{...}>()` declares exactly what a route accepts. A branch in there
      // is the mistake; matching the declaration catches it at the point it is introduced.
      for (const [, declared] of source.matchAll(/useLocalSearchParams\s*<([^>]*)>/g)) {
        expect(
          /branch/i.test(declared ?? ""),
          `${name} declares a branch-shaped route param (${declared ?? ""}). The active branch ` +
            `comes only from the validated /me/branches selection.`,
        ).toBe(false);
      }

      for (const [, declared] of source.matchAll(/params:\s*\{([^}]*)\}/g)) {
        expect(
          /branchId/.test(declared ?? ""),
          `${name} passes a branchId through navigation params. Routes carry RECORD ids, which ` +
            `the server authorizes; the branch is not one of them.`,
        ).toBe(false);
      }
    },
  );
});

describe("bed occupancy is never worked out on the phone", () => {
  /**
   * ── THE FAILURE THIS PREVENTS IS A WARD THAT LOOKS FULL ─────────────────────
   * `/bed-board` derives every bed's state from the whole ward's inventory joined to every open
   * stay, in one server-side query, and hands back `{ total, free, occupied, blocked }` per ward.
   * The app's job is to render those numbers.
   *
   * The tempting alternative is to count them from what is on screen — `beds.filter(b => b.state
   * === "free").length` — and it is wrong in the specific way that matters: the ward list is capped
   * at 100 stays and shows one ward at a time, so a count taken from it describes the PAGE. A
   * forty-bed ward would report as nearly empty, or a ward with one visible patient as full, and a
   * bed board that disagrees with the ward clerk's is worse than having none.
   *
   * So no file compares a bed state at all. Nothing in the app needs to: `placementsByEncounter`
   * reads `bed.occupant`, which is the fact, and `groupByWard` passes the server's `counts` through
   * untouched.
   */
  const OCCUPANCY = /\bstate\s*===\s*["'](free|occupied|blocked)["']/;

  const scanned = [
    ...sourceFiles(APP_DIR, [".ts", ".tsx"]),
    ...sourceFiles(join(APP_DIR, "..", "src"), [".ts", ".tsx"]),
  ];

  it.each(scanned.map((f) => [relative(join(APP_DIR, ".."), f).split(sep).join("/"), f]))(
    "%s",
    (name, file) => {
      expect(
        OCCUPANCY.test(codeOnly(read(file))),
        `${name} compares a bed's state, which is the first line of counting occupancy locally. ` +
          `The server owns free/occupied/blocked — render \`ward.counts\` from /bed-board instead.`,
      ).toBe(false);
    },
  );

  it("proves the counts really are read from the board", () => {
    // Guards the scan above: if nothing consumed the server's numbers, forbidding a local count
    // would pass while the screen showed no occupancy at all.
    expect(read(join(APP_DIR, "..", "src", "clinical", "ipd.ts"))).toMatch(/ward\.counts/);
    expect(read(join(APP_DIR, "inpatients.tsx"))).toMatch(/occupancy\.free/);
  });
});

describe("an IPD write always goes through its reconciliation", () => {
  /**
   * ── THE TWO WEAKEST ENDPOINTS IN THE APP ────────────────────────────────────
   * `POST /encounters/:id/notes` has no idempotency key and no de-duplication, so a retry after a
   * lost response leaves TWO permanent notes on a medico-legal chart. `POST /encounters/:id/
   * discharge` has no key either; what it has is two state guards, which turn a retry into
   * `HMS-STATE-001` — a false error for something that worked.
   *
   * Both are safe only because `clinical/wardNote.ts` and `clinical/discharge.ts` classify every
   * ambiguous ending against the record. A screen that reached for the client method directly would
   * skip that entirely and look completely ordinary doing it — `api.addWardNote(id, text)` is a
   * perfectly reasonable-looking line. This is the check that stops it.
   */
  const RECONCILED = new Set(["addWardNote", "discharge"]);

  it.each(routes.map((file) => [shortName(file), file]))("%s", (name, file) => {
    const source = codeOnly(read(file));

    for (const [, receiver, method] of source.matchAll(/\b(\w+)\.(addWardNote|discharge)\s*\(/g)) {
      if (!RECONCILED.has(method ?? "")) continue;
      expect(
        receiver,
        `app/${name} calls ${receiver ?? "?"}.${method ?? "?"}() directly. IPD writes go through ` +
          `useClinicalMutations() — mutations.${method ?? "?"}(...) — which wraps the ` +
          `reconciliation. Calling the client method skips it, and the failure is silent: a ` +
          `duplicate ward note, or a successful discharge reported as an error.`,
      ).toBe("mutations");
    }
  });

  it("finds the IPD write screens, so the check is not vacuous", () => {
    const writers = routes.filter((file) =>
      /mutations\.(addWardNote|discharge)\s*\(/.test(codeOnly(read(file))),
    );
    expect(writers.map(shortName).sort()).toEqual([
      "discharge/[encounterId].tsx",
      "ward-note/[encounterId].tsx",
    ]);
  });
});

describe("the lock gate stands above the whole app", () => {
  /**
   * ── A GATE ONE SCREEN CAN FORGET IS NOT A GATE ──────────────────────────────
   * `LockGate` returns `null` for the tree beneath it, which only works if it is mounted ABOVE the
   * navigator — once, at the root, in the same place and for the same reason as `PrivacyCover`.
   * Mounted per screen it would be forgotten by the next screen anybody adds, and the failure is
   * silent: the app looks locked everywhere the author remembered and shows a chart everywhere
   * they did not.
   */
  const root = read(join(APP_DIR, "_layout.tsx"));

  it("is mounted at the root, next to the privacy cover", () => {
    expect(root).toMatch(/<LockGate\s*\/>/);
    expect(root).toMatch(/<PrivacyCover\s*\/>/);
  });

  it("paints AFTER the privacy cover, so the gate wins while both are up", () => {
    // On a resume both are briefly mounted. If the cover were last it would paint over the gate,
    // and dropping the cover first would flash the chart underneath.
    const code = codeOnly(root);
    expect(code.indexOf("<LockGate")).toBeGreaterThan(code.indexOf("<PrivacyCover"));
  });

  it("is the only place either one is mounted", () => {
    const mounts = routes.filter((file) =>
      /<(LockGate|PrivacyCover)\s*\/>/.test(codeOnly(read(file))),
    );
    expect(mounts.map(shortName)).toEqual(["_layout.tsx"]);
  });

  it("no screen renders its own lock — the root owns it", () => {
    for (const file of routes) {
      if (shortName(file) === "_layout.tsx") continue;
      expect(
        /useLock\s*\(/.test(codeOnly(read(file))),
        `app/${shortName(file)} reads the lock store. The gate is rendered once at the root; a ` +
          `screen that consults it is either duplicating the gate or working around it.`,
      ).toBe(false);
    }
  });
});

describe("the biometric prompt has exactly one owner", () => {
  /**
   * The same rule the Keychain and AsyncStorage have, and for the same reason: a direct import
   * anywhere in `src/lib` would make every file that touches the lock un-runnable outside a
   * simulator, and the attempt ladder is precisely what must be proven by a test. The eslint rule
   * says so too; this says it where a reviewer reading the tests will see it.
   */
  const scanned = [
    ...sourceFiles(APP_DIR, [".ts", ".tsx"]),
    ...sourceFiles(join(APP_DIR, "..", "src"), [".ts", ".tsx"]),
  ];

  it.each(scanned.map((f) => [relative(join(APP_DIR, ".."), f).split(sep).join("/"), f]))(
    "%s",
    (name, file) => {
      if (name === "src/platform/biometrics.ts") return;
      expect(
        /from\s+["']expo-local-authentication["']/.test(codeOnly(read(file))),
        `${name} imports expo-local-authentication directly. Go through the ` +
          `BiometricAuthenticator port so the lock policy stays testable without a device.`,
      ).toBe(false);
    },
  );

  it("finds the one owner, so the rule is not vacuous", () => {
    expect(read(join(APP_DIR, "..", "src", "platform", "biometrics.ts"))).toMatch(
      /from "expo-local-authentication"/,
    );
  });
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

/* ════════════════════════════════════════════════════════════════════════════
 * M2 L — the release-hardening rules, checked structurally
 * ══════════════════════════════════════════════════════════════════════════ */

describe("the licence has exactly one owner", () => {
  /**
   * M1's failure here was not a wrong value, it was a value with no source: `useWriteGuard` passed
   * `licenceExpired: false` because nothing fed it. The obvious repair — let each write screen
   * decide for itself — would recreate that in five places, and the fifth one would read the
   * header state and block on GRACE, refusing to save a prescription at a hospital the server is
   * still serving.
   *
   * So the derivation lives in `lib/licence.ts`, is applied in `useWriteGuard`, and nowhere else
   * may name the states at all.
   */
  const scanned = [
    ...sourceFiles(APP_DIR, [".ts", ".tsx"]),
    ...sourceFiles(join(APP_DIR, "..", "src"), [".ts", ".tsx"]),
  ];

  const OWNERS = [
    "src/lib/licence.ts",
    "src/state/licence.ts",
    "src/hooks/useWrite.ts",
    "src/hooks/useStores.ts",
    "src/lib/runtime.ts",
    "src/components/LicenceNotice.tsx",
    /**
     * The error map names `HMS-TEN-005` because rendering a code as a sentence is its whole job —
     * it is the one place any wire code becomes user-facing text, and the licence is not special
     * enough to be an exception to that. It decides no POLICY: it produces a message, and the
     * blocking full-screen state that goes with it.
     */
    "src/lib/net/errors.ts",
  ];

  it.each(scanned.map((f) => [relative(join(APP_DIR, ".."), f).split(sep).join("/"), f]))(
    "%s",
    (name, file) => {
      if (OWNERS.includes(name)) return;
      const source = codeOnly(read(file));

      expect(
        /["'](?:EXPIRING|GRACE)["']|HMS-TEN-005/.test(source),
        `${name} decides something about the licence itself. There is one derivation — ` +
          `blocksWrites()/licenceNotice() in src/lib/licence.ts — and screens render its answer. ` +
          `A second opinion is how GRACE ends up blocking a write the server would have accepted.`,
      ).toBe(false);
    },
  );

  it("proves the guard actually consumes it, so the rule is not vacuous", () => {
    // `codeOnly`, because the comment above the guard quotes the very literal being forbidden —
    // scanning the raw text would fail on the explanation of the rule rather than on a breach.
    const guard = codeOnly(read(join(APP_DIR, "..", "src", "hooks", "useWrite.ts")));
    expect(guard).toMatch(/licenceExpired: blocksWrites\(licence\)/);
    // The literal that started all this. If it comes back, the guard is lying again.
    expect(guard).not.toMatch(/licenceExpired:\s*false/);
  });

  it("wires the runtime to both channels, because either alone is wrong", () => {
    const runtime = read(join(APP_DIR, "..", "src", "lib", "runtime.ts"));
    // The header channel: ACTIVE/EXPIRING/GRACE, on every served response.
    expect(runtime).toMatch(/onLicenseState/);
    // The refusal channel: the ONLY way expiry is observable, since a refused request never
    // reaches `setLicenseHeaders` and so can never carry an EXPIRED header.
    expect(runtime).toMatch(/isLicenceRefusal/);
  });
});

describe("nothing clinical is written to disk", () => {
  /**
   * M0 §5/§15: the Keychain holds ONE refresh token, AsyncStorage holds non-secret settings, and
   * the query cache lives in memory and dies with the process. A persisted chart on a phone that
   * is lost is a breach with no revocation path — there is no "sign out remotely" for a file.
   *
   * The realistic mistake is not a rogue `writeFile`; it is somebody reaching for a cache persister
   * to make a cold start feel faster. That is the import this looks for.
   */
  const scanned = [
    ...sourceFiles(APP_DIR, [".ts", ".tsx"]),
    ...sourceFiles(join(APP_DIR, "..", "src"), [".ts", ".tsx"]),
  ];

  const BANNED: [RegExp, string][] = [
    [
      /persistQueryClient|createSyncStoragePersister|createAsyncStoragePersister/,
      "persists the query cache, which is the whole chart",
    ],
    [
      /@react-native-async-storage\/async-storage/,
      "imports AsyncStorage directly instead of the Preferences port",
    ],
    [/expo-secure-store/, "imports the Keychain directly instead of the SecureStorage port"],
    [/expo-file-system/, "writes to the filesystem"],
    [
      /\bconsole\.(?:log|info|debug)\s*\(/,
      "logs to the console, which on a release build is a PHI sink nobody reads",
    ],
  ];

  const PORTS = [
    "src/platform/preferences.ts",
    "src/platform/secureStore.ts",
    "src/platform/profiles.ts",
    "src/lib/log.ts",
  ];

  it.each(scanned.map((f) => [relative(join(APP_DIR, ".."), f).split(sep).join("/"), f]))(
    "%s",
    (name, file) => {
      if (PORTS.includes(name)) return;
      const source = codeOnly(read(file));

      for (const [pattern, why] of BANNED) {
        expect(pattern.test(source), `${name} ${why}.`).toBe(false);
      }
    },
  );

  it("keeps the analytics pipeline empty, as M0 §15 requires until a scrubber exists", () => {
    const manifest = JSON.parse(read(join(APP_DIR, "..", "package.json"))) as {
      dependencies?: Record<string, string>;
    };
    const deps = Object.keys(manifest.dependencies ?? {});

    for (const vendor of ["sentry", "amplitude", "mixpanel", "segment", "firebase", "bugsnag"]) {
      expect(
        deps.some((dep) => dep.toLowerCase().includes(vendor)),
        `${vendor} is installed. No analytics or crash SDK may ship before the PHI scrubber ` +
          `exists (M0 §15) — a stack trace and a screen name are enough to identify a patient.`,
      ).toBe(false);
    }
  });

  it("proves the log context cannot carry a patient at all", () => {
    /**
     * The signature IS the control: `LogContext` is an allow-list of primitives, and there is no
     * overload taking an arbitrary object. A leak requires editing that interface, which is
     * exactly where a reviewer is looking.
     */
    const log = read(join(APP_DIR, "..", "src", "lib", "log.ts"));
    expect(log).toMatch(/interface LogContext/);
    for (const field of ["name", "patient", "uhid", "dob", "diagnosis", "note"]) {
      expect(
        new RegExp(`^\\s*${field}\\??:`, "m").test(log),
        `LogContext has a '${field}' field. Every field here is written to a log line; this one ` +
          `carries PHI.`,
      ).toBe(false);
    }
  });
});
