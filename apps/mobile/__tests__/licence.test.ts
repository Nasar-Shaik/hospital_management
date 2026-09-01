/**
 * THE LICENCE (M2 L) — the loose end M1 left, closed and proven.
 *
 * ── WHAT WAS ACTUALLY WRONG ─────────────────────────────────────────────────
 * `createRuntime` accepted an `onLicenseState` hook and nothing passed one, so `useWriteGuard`
 * hard-coded `licenceExpired: false`. The guard's own contract had a branch that no input could
 * ever reach — the shape of bug that survives every review, because the line reads as a value
 * rather than as an assumption.
 *
 * ── THE PART THAT TOOK READING THE SERVER TO GET RIGHT ──────────────────────
 * There is no `EXPIRED` licence header, and there cannot be one. `resolveTenant` evaluates the
 * licence BEFORE the response exists: past grace it throws `HMS-TEN-005` and `setLicenseHeaders` is
 * never reached. So the header carries ACTIVE, EXPIRING or GRACE — the states of a hospital that is
 * still being served — and expiry is only ever observable as a refusal.
 *
 * A client that waited for a header saying EXPIRED would wait forever. A client that read the
 * ABSENCE of headers as expiry would disable every write button at every perpetual hospital. Both
 * mistakes are one line, and the tests below are the ones that catch them.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MutationObserver } from "@tanstack/query-core";
import { BRANCH_HYD, PASSWORD, USER, createHarness } from "./support/harness";
import { fail, okPaged } from "./support/fakeApi";
import { page, patient } from "./support/fixtures";
import {
  blocksWrites,
  fromHeader,
  isLicenceRefusal,
  licenceNotice,
  LICENCE_UNKNOWN,
  type Licence,
} from "../src/lib/licence";
import { createLicenceStore, currentLicence } from "../src/state/licence";
import { writeGuard } from "../src/lib/guard";
import type { MobileRuntime } from "../src/lib/runtime";

const PATIENTS = "/api/v1/patients";

/** Reads a source file, relative to `apps/mobile` — the idiom `routes.test.ts` already uses. */
const MOBILE = join(dirname(fileURLToPath(import.meta.url)), "..");
const readSource = (path: string): string => readFileSync(join(MOBILE, path), "utf8");

const licenceOf = (runtime: MobileRuntime): Licence => currentLicence(runtime.licence.getState());

/** Headers exactly as `resolveTenant` stamps them. */
const headers = (state: string, daysLeft: string): Record<string, string> => ({
  "x-license-state": state,
  "x-license-days-left": daysLeft,
});

async function signedIn() {
  const h = createHarness();
  h.happyPath({ branches: [BRANCH_HYD] });
  await h.runtime.auth.signIn(USER.email, PASSWORD, "device");
  await h.runtime.branches.select(USER.id, BRANCH_HYD.id);
  return h;
}

/** One read, no retries, no cache reuse — so each test observes its own response. */
function read(h: Awaited<ReturnType<typeof signedIn>>, key: string) {
  return h.runtime.queryClient.fetchQuery({
    queryKey: ["licence-probe", key],
    queryFn: () => h.runtime.api.listPatients({ limit: 1 }),
    retry: false,
    staleTime: 0,
  });
}

/* ════════════════════════════════════════════════════════════════════════════
 * THE POLICY
 * ══════════════════════════════════════════════════════════════════════════ */

describe("1. what the header can and cannot say", () => {
  it("reads the three states the API actually sends", () => {
    expect(fromHeader({ state: "ACTIVE", daysLeft: 40 })).toEqual({
      state: "ACTIVE",
      daysLeft: 40,
    });
    expect(fromHeader({ state: "EXPIRING", daysLeft: 5 })).toEqual({
      state: "EXPIRING",
      daysLeft: 5,
    });
    expect(fromHeader({ state: "GRACE", daysLeft: 2 })).toEqual({ state: "GRACE", daysLeft: 2 });
  });

  it("treats NO headers as perpetual, not as expired — the fail-open that matters", () => {
    /**
     * `setLicenseHeaders` returns early when the hospital has no expiry at all. A hospital that
     * paid indefinitely therefore looks exactly like a non-tenant call, and reading that absence as
     * expiry would disable every write button at the customers who owe nothing.
     */
    expect(fromHeader(null)).toEqual(LICENCE_UNKNOWN);
    expect(blocksWrites(fromHeader(null))).toBe(false);
  });
});

describe("2. only the licence gate's own refusal counts as expiry", () => {
  it("recognises HMS-TEN-005", () => {
    expect(isLicenceRefusal({ code: "HMS-TEN-005", status: 403 })).toBe(true);
  });

  it("does NOT mistake an ordinary permission refusal for a lapsed subscription", () => {
    /**
     * Both are 403. Matching on the status would send a doctor who tapped a route their role does
     * not include to ring their administrator about the hospital's billing.
     */
    expect(isLicenceRefusal({ code: "HMS-AUTH-005", status: 403 })).toBe(false);
    expect(isLicenceRefusal({ code: "HMS-TEN-002", status: 403 })).toBe(false);
    expect(isLicenceRefusal(new TypeError("Network request failed"))).toBe(false);
    expect(isLicenceRefusal(undefined)).toBe(false);
  });
});

describe("3. grace warns; only expiry blocks", () => {
  it("blocks writes on EXPIRED and on nothing else", () => {
    expect(blocksWrites({ state: "EXPIRED", daysLeft: 0 })).toBe(true);
    expect(blocksWrites({ state: "GRACE", daysLeft: 2 })).toBe(false);
    expect(blocksWrites({ state: "EXPIRING", daysLeft: 5 })).toBe(false);
    expect(blocksWrites({ state: "ACTIVE", daysLeft: null })).toBe(false);
  });

  it("keeps a hospital in grace fully able to record what was done to a patient", () => {
    /**
     * The deliberate policy call, asserted so it cannot be "tidied" into blocking. A hospital in
     * grace is one the SERVER is still choosing to serve; refusing to save a prescription over a
     * late invoice would be this app inventing a rule the API does not have, in the one place where
     * the cost lands on a patient rather than on whoever owes the money.
     */
    const guard = writeGuard({
      online: true,
      branchResolved: true,
      requiresBranch: true,
      licenceExpired: blocksWrites({ state: "GRACE", daysLeft: 1 }),
      needs: "emr:write",
      held: new Set(["emr:write"]),
    });
    expect(guard.canWrite).toBe(true);
  });

  it("blocks first, and explains, when the licence has actually lapsed", () => {
    const guard = writeGuard({
      online: true,
      branchResolved: true,
      requiresBranch: true,
      licenceExpired: blocksWrites({ state: "EXPIRED", daysLeft: 0 }),
      needs: "emr:write",
      held: new Set(["emr:write"]),
    });
    expect(guard.canWrite).toBe(false);
    expect(guard.block).toBe("licenceExpired");
    expect(guard.reason).toMatch(/administrator/i);
  });
});

describe("4. the banner says something worth reading, or nothing", () => {
  it("counts down the grace window in days", () => {
    const notice = licenceNotice({ state: "GRACE", daysLeft: 3 });
    expect(notice?.tone).toBe("danger");
    expect(notice?.message).toContain("3 days");
  });

  it("gets the singular right, because '1 days' reads as a bug and undermines the warning", () => {
    expect(licenceNotice({ state: "GRACE", daysLeft: 1 })?.message).toContain("1 day left");
    expect(licenceNotice({ state: "EXPIRING", daysLeft: 1 })?.message).toContain("in 1 day");
  });

  it("warns before expiry in a different tone from after it", () => {
    expect(licenceNotice({ state: "EXPIRING", daysLeft: 7 })?.tone).toBe("warning");
  });

  it("says nothing at all when there is nothing to say", () => {
    expect(licenceNotice({ state: "ACTIVE", daysLeft: null })).toBeUndefined();
    // EXPIRED is silent here on purpose: every screen is already showing the blocking error, and
    // two messages about one problem read as two problems.
    expect(licenceNotice({ state: "EXPIRED", daysLeft: 0 })).toBeUndefined();
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * THE STORE — where the two channels are kept from overwriting each other
 * ══════════════════════════════════════════════════════════════════════════ */

describe("5. a refusal cannot be erased by the response that carried it", () => {
  it("survives the null header that arrives on the very same request", () => {
    /**
     * THE bug this store's shape exists to prevent. The api-client reports the licence header on
     * EVERY response including errors, and a refused request has no licence headers — so the
     * refusal arrives at `observed()` as `null`, meaning "perpetual". Held in one field, the
     * response proving the licence has lapsed would set the state to ACTIVE, and which of the two
     * callbacks won would depend on the order the client happens to invoke them in.
     */
    const store = createLicenceStore();
    store.getState().refuse();
    store.getState().observed(null);

    expect(currentLicence(store.getState()).state).toBe("EXPIRED");
  });

  it("is cleared only by a request that actually came back", () => {
    const store = createLicenceStore();
    store.getState().refuse();
    expect(currentLicence(store.getState()).state).toBe("EXPIRED");

    store.getState().served();
    expect(currentLicence(store.getState()).state).toBe("ACTIVE");
  });

  it("keeps the warning after a renewal, because it is usually still true", () => {
    const store = createLicenceStore();
    store.getState().observed({ state: "GRACE", daysLeft: 2 });
    store.getState().refuse();
    store.getState().served();

    expect(currentLicence(store.getState())).toEqual({ state: "GRACE", daysLeft: 2 });
  });

  it("forgets everything on sign-out", () => {
    const store = createLicenceStore();
    store.getState().observed({ state: "GRACE", daysLeft: 2 });
    store.getState().refuse();
    store.getState().reset();

    expect(currentLicence(store.getState())).toEqual(LICENCE_UNKNOWN);
  });
});

describe("6. the selector never mints a value", () => {
  it("returns the same reference twice, in both branches", () => {
    /**
     * `currentLicence` is passed to `useStore` BY NAME, which is the one blind spot `routes.test.ts`
     * admits to — it scans inline arrows and does not follow a named selector. A freshly built
     * `{ state: "EXPIRED", … }` would never compare equal under `Object.is`, so React would
     * re-render, re-select, get another new object and spin until "Maximum update depth exceeded".
     */
    const store = createLicenceStore();
    expect(currentLicence(store.getState())).toBe(currentLicence(store.getState()));

    store.getState().refuse();
    expect(currentLicence(store.getState())).toBe(currentLicence(store.getState()));
  });

  it("does not churn the snapshot when a response repeats what the last one said", () => {
    // `observed` runs on every response — dozens a minute on a round. An unconditional write would
    // hand every subscriber a new object and re-render the banner per request for no new fact.
    const store = createLicenceStore();
    store.getState().observed({ state: "EXPIRING", daysLeft: 5 });
    const first = currentLicence(store.getState());
    store.getState().observed({ state: "EXPIRING", daysLeft: 5 });

    expect(currentLicence(store.getState())).toBe(first);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * END TO END — the real client, the real cache, the real headers
 * ══════════════════════════════════════════════════════════════════════════ */

describe("7. an active licence is normal operation", () => {
  it("reads ACTIVE off a served response and blocks nothing", async () => {
    const h = await signedIn();
    h.api.on("GET", PATIENTS, () => okPaged(page([patient()]), headers("ACTIVE", "40")));

    await read(h, "active");

    expect(licenceOf(h.runtime)).toEqual({ state: "ACTIVE", daysLeft: 40 });
    expect(blocksWrites(licenceOf(h.runtime))).toBe(false);
  });

  it("stays writable at a perpetual hospital, which sends no licence headers at all", async () => {
    const h = await signedIn();
    h.api.on("GET", PATIENTS, () => okPaged(page([patient()])));

    await read(h, "perpetual");

    expect(licenceOf(h.runtime)).toEqual(LICENCE_UNKNOWN);
    expect(blocksWrites(licenceOf(h.runtime))).toBe(false);
  });
});

describe("8. an expiring or lapsed licence warns without stopping the ward", () => {
  it("surfaces EXPIRING with the day count the server computed", async () => {
    const h = await signedIn();
    h.api.on("GET", PATIENTS, () => okPaged(page([patient()]), headers("EXPIRING", "6")));

    await read(h, "expiring");

    expect(licenceOf(h.runtime)).toEqual({ state: "EXPIRING", daysLeft: 6 });
    expect(licenceNotice(licenceOf(h.runtime))?.tone).toBe("warning");
    expect(blocksWrites(licenceOf(h.runtime))).toBe(false);
  });

  it("surfaces GRACE, and still permits clinical writes", async () => {
    const h = await signedIn();
    h.api.on("GET", PATIENTS, () => okPaged(page([patient()]), headers("GRACE", "2")));

    await read(h, "grace");

    expect(licenceOf(h.runtime)).toEqual({ state: "GRACE", daysLeft: 2 });
    expect(licenceNotice(licenceOf(h.runtime))?.tone).toBe("danger");
    expect(blocksWrites(licenceOf(h.runtime))).toBe(false);
  });
});

describe("9. an expired licence is learned from the refusal, because nothing else can tell us", () => {
  it("blocks writes after a READ is refused with HMS-TEN-005", async () => {
    const h = await signedIn();
    h.api.on("GET", PATIENTS, () => fail(403, "HMS-TEN-005", "Subscription expired"));

    await expect(read(h, "expired")).rejects.toMatchObject({ code: "HMS-TEN-005" });

    expect(licenceOf(h.runtime).state).toBe("EXPIRED");
    expect(blocksWrites(licenceOf(h.runtime))).toBe(true);
  });

  it("blocks writes after a WRITE is refused with HMS-TEN-005", async () => {
    const h = await signedIn();
    h.api.on("PUT", "/api/v1/encounters/e1/consultation", () =>
      fail(403, "HMS-TEN-005", "Subscription expired"),
    );

    const observer = new MutationObserver(h.runtime.queryClient, {
      mutationFn: () => h.runtime.api.saveConsultation("e1", { chiefComplaint: "cough" }),
      retry: false,
    });
    await observer.mutate(undefined).catch(() => undefined);

    expect(licenceOf(h.runtime).state).toBe("EXPIRED");
  });

  it("does NOT block after an ordinary 403, which is a different problem entirely", async () => {
    const h = await signedIn();
    h.api.on("GET", PATIENTS, () => fail(403, "HMS-AUTH-005", "Insufficient permission"));

    await expect(read(h, "forbidden")).rejects.toMatchObject({ code: "HMS-AUTH-005" });

    expect(licenceOf(h.runtime).state).toBe("ACTIVE");
    expect(blocksWrites(licenceOf(h.runtime))).toBe(false);
  });
});

describe("10. the licence changing during an active session", () => {
  it("blocks when it lapses, and unblocks when the operator renews", async () => {
    const h = await signedIn();

    // Healthy.
    h.api.on("GET", PATIENTS, () => okPaged(page([patient()]), headers("GRACE", "1")));
    await read(h, "before");
    expect(blocksWrites(licenceOf(h.runtime))).toBe(false);

    // The grace window closes mid-round. Every request now dies in `resolveTenant`.
    h.api.on("GET", PATIENTS, () => fail(403, "HMS-TEN-005"));
    await expect(read(h, "lapsed")).rejects.toMatchObject({ code: "HMS-TEN-005" });
    expect(blocksWrites(licenceOf(h.runtime))).toBe(true);

    /**
     * The operator renews. Nothing tells the phone — there is no push, and no endpoint a clinician
     * may read. The evidence is simply that a request came back at all, which a hard-expired
     * hospital cannot produce.
     */
    h.api.on("GET", PATIENTS, () => okPaged(page([patient()]), headers("ACTIVE", "365")));
    await read(h, "renewed");

    expect(licenceOf(h.runtime)).toEqual({ state: "ACTIVE", daysLeft: 365 });
    expect(blocksWrites(licenceOf(h.runtime))).toBe(false);
  });

  it("does not carry a refusal into the next person's session", async () => {
    const h = await signedIn();
    h.api.on("GET", PATIENTS, () => fail(403, "HMS-TEN-005"));
    await expect(read(h, "lapsed")).rejects.toMatchObject({ code: "HMS-TEN-005" });
    expect(blocksWrites(licenceOf(h.runtime))).toBe(true);

    await h.runtime.auth.signOut();

    // A renewal can happen while nobody is signed in; the next session learns from its own
    // responses rather than inheriting a stale refusal that would disable every write button.
    expect(licenceOf(h.runtime)).toEqual(LICENCE_UNKNOWN);
  });
});

describe("11. the server stays the authority", () => {
  it("still sends the write, and still surfaces the server's refusal, when the phone thought it was fine", async () => {
    /**
     * The guard decides whether a request is worth ATTEMPTING. It is not authorization and must
     * never be mistaken for it — so a licence the phone believes is active does not make a refused
     * write succeed, and the refusal is what the user is shown.
     */
    const h = await signedIn();
    h.api.on("GET", PATIENTS, () => okPaged(page([patient()]), headers("ACTIVE", "40")));
    await read(h, "healthy");
    expect(blocksWrites(licenceOf(h.runtime))).toBe(false);

    h.api.on("POST", "/api/v1/encounters/e1/notes", () => fail(403, "HMS-TEN-005"));
    await expect(h.runtime.api.addWardNote("e1", "Reviewed.")).rejects.toMatchObject({
      code: "HMS-TEN-005",
    });
  });

  it("never writes the licence to disk — it is re-learned from responses every session", async () => {
    /**
     * Deliberately not persisted. A remembered "EXPIRED" would outlive the renewal that fixed it
     * and disable a working hospital's write buttons until somebody reinstalled the app; a
     * remembered "ACTIVE" would be a stale claim about something only the server can answer.
     */
    const h = await signedIn();
    h.api.on("GET", PATIENTS, () => okPaged(page([patient()]), headers("GRACE", "2")));
    await read(h, "grace");

    const written = [...h.preferences.snapshot().entries(), ...h.secureStore.snapshot().entries()];
    expect(JSON.stringify(written)).not.toMatch(/GRACE|licen[cs]e/i);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * D8 — THE WARNING HAS TO REACH A SCREEN
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * ── WHAT EVERY TEST ABOVE FAILED TO NOTICE ──────────────────────────────────
 * Section 4 proves `licenceNotice()` returns the right sentence in the right tone, in five ways.
 * All five would pass just as happily if the component that renders it were deleted, and
 * `routes.test.ts` only asserts that the file is ALLOWED to know about the licence, not that
 * anything mounts it. Between them they look like coverage of a feature and cover only its policy.
 *
 * That gap is not hypothetical: an audit of this component on 2026-08-16 searched `src/` and the
 * ROOT layout, concluded "zero importers", and filed it as dead code. The mount was real and one
 * directory away, in the `(app)` group layout. A test asserting reachability would have answered
 * that in a second — so here it is, along with the inset rule the real defect turned out to be.
 *
 * Structural, per this suite's house rule: these are React Native components, the runner is Node,
 * and rendering a navigator here would test a mock. What can be checked exactly is that the wiring
 * exists and that the two halves of the inset agreement still agree.
 */
describe("6. the banner is actually mounted, and owns the notch", () => {
  const SHELL = readSource("app/(app)/_layout.tsx");
  const BANNER = readSource("src/components/LicenceNotice.tsx");

  it("is rendered by the signed-in shell, above the navigator", () => {
    expect(SHELL).toMatch(/import \{ LicenceNotice \}/);
    // Mounted, not merely imported — an unused import is exactly what the audit thought it found.
    expect(SHELL).toMatch(/<LicenceNotice\s*\/>/);
  });

  /**
   * It must sit ABOVE the navigator, not inside a screen. A banner on the home tab is missed by
   * everyone who deep-links into a chart, which is most of how this app is used.
   */
  it("sits above the tab navigator rather than inside one screen", () => {
    const banner = SHELL.indexOf("<LicenceNotice");
    const tabs = SHELL.indexOf("<Tabs");

    expect(banner).toBeGreaterThan(-1);
    expect(tabs).toBeGreaterThan(-1);
    expect(banner).toBeLessThan(tabs);
  });

  /**
   * ── THE DEFECT THAT WAS ACTUALLY REPORTED ─────────────────────────────────
   * Mounted above the navigator puts the bar OUTSIDE everything that handles a notch — `Screen`
   * applies insets per screen and React Navigation's header applies its own, but both are below
   * this. Without its own top inset the bar paints from y=0, under the clock and the carrier
   * icons. That is what a user saw and described as the banner being "in the notifications place".
   */
  it("pads itself past the status bar, because nothing above it will", () => {
    expect(BANNER).toMatch(/useSafeAreaInsets/);
    expect(BANNER).toMatch(/paddingTop:\s*insets\.top/);
  });

  /**
   * The other half of the same rule. React Navigation reads `SafeAreaInsetsContext`, so if the
   * banner consumes the inset AND the navigator consumes it again, the header sits a status bar's
   * height too low. Exactly one of them may own it, and which one depends on whether the banner is
   * showing — so the shell must derive that from the same policy the banner uses.
   */
  it("stops the navigator consuming the same inset twice", () => {
    expect(SHELL).toMatch(/SafeAreaInsetsContext\.Provider/);
    expect(SHELL).toMatch(/top:\s*0/);
    // From the shared hook, never a second copy of the policy — see `useLicenceNotice`.
    expect(SHELL).toMatch(/useLicenceNotice/);
  });

  it("keeps the navigator's own insets untouched when there is no banner", () => {
    // The ternary, not an unconditional zero: a healthy licence must leave the header exactly as
    // it was, or this fix would push every header under the status bar on almost every day.
    expect(SHELL).toMatch(/notice\s*\?\s*\{\s*\.\.\.insets,\s*top:\s*0\s*\}\s*:\s*insets/);
  });

  /**
   * The banner and the shell must never disagree about whether it is showing, so both ask one
   * hook, and that hook delegates to the one derivation `routes.test.ts` protects.
   */
  it("derives visibility from the single policy, in both places", () => {
    const hook = readSource("src/hooks/useLicenceNotice.ts");

    expect(hook).toMatch(/licenceNotice\(useLicence\(\)\)/);
    /**
     * The CALL, not the mention. Asserting `/useLicenceNotice/` passes on the leftover import line
     * alone — proved by falsification: swapping the body back to `licenceNotice(useLicence())` left
     * this test green. A guard that survives the thing it guards against is not a guard.
     */
    expect(BANNER).toMatch(/useLicenceNotice\(\)/);
    expect(BANNER).not.toMatch(/licenceNotice\(/);
    expect(SHELL).toMatch(/useLicenceNotice\(\)/);
  });
});
