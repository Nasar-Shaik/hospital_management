/**
 * M4 — STAFF PUSH. Registration, release, and where a tap lands.
 *
 * ── WHAT IS REAL HERE ───────────────────────────────────────────────────────
 * The real `createRuntime`, the real `@medicore/api-client`, the real session store and the real
 * auth controller, driven against a fake transport and a fake notification service. What is
 * substituted is exactly the two edges a phone owns: the network and the OS.
 *
 * ── WHAT DEFECT WOULD THIS CATCH? ───────────────────────────────────────────
 * Four, and each has a shape this milestone could plausibly have shipped:
 *
 *   A phone that never registers. The call sits in `bootstrap`, which is also where permissions
 *   and branches are read — an early return added to any of those would silently take push with
 *   it, and the symptom is nothing at all happening, ever, on one build.
 *
 *   A phone that keeps ringing after sign-out. The release is fire-and-forget by design, so
 *   nothing downstream fails if it is dropped, which is exactly why it needs asserting here.
 *
 *   Registration failure taking the session with it. A declined permission must not stop a doctor
 *   signing in — the inbox is the message, and push is a knock on the door.
 *
 *   A tap that opens the wrong thing, or nothing. The mapping is pure and therefore testable; the
 *   listener plumbing above it is not, and is a device check.
 */
import { describe, expect, it } from "vitest";
import { createHarness, PASSWORD, USER } from "./support/harness";
import { destinationFor, readPayload } from "../src/lib/push";
import { tabsFor, splitTabs, homeFor } from "../src/navigation/tabsFor";

/* ── 1. registering ───────────────────────────────────────────────────────── */

describe("1. signing in registers this handset", () => {
  it("sends the OS token and the platform, and nothing else", async () => {
    const h = createHarness();
    h.happyPath();

    await h.runtime.auth.signIn(USER.email, PASSWORD, "device");

    const [call] = h.api.callsTo("POST", "/api/v1/me/devices");
    expect(call, "the phone never registered for alerts").toBeTruthy();
    expect(call?.body).toEqual({ token: "ExponentPushToken[test]", platform: "ios" });
  });

  /**
   * The ORDINARY case, and the one that must be silent: a simulator, Expo Go since SDK 53, a
   * declined permission, or a build with no EAS project id. Every one of them is a phone that
   * works perfectly and does not buzz.
   */
  it("registers nothing when the OS has no token to give", async () => {
    const h = createHarness();
    h.happyPath();
    h.push.credential = undefined;

    await h.runtime.auth.signIn(USER.email, PASSWORD, "device");

    expect(h.api.callsTo("POST", "/api/v1/me/devices")).toEqual([]);
    expect(h.runtime.session.getState().status, "sign-in was affected").toBe("signedIn");
  });

  /** A revoked permission is not a failed sign-in. */
  it("signs in normally when the notification service throws", async () => {
    const h = createHarness();
    h.happyPath();
    h.push.failNext = true;

    await h.runtime.auth.signIn(USER.email, PASSWORD, "device");

    expect(h.runtime.session.getState().status).toBe("signedIn");
    expect(h.api.callsTo("POST", "/api/v1/me/devices")).toEqual([]);
  });

  /** And a server that refuses the registration is not a failed sign-in either. */
  it("signs in normally when the server refuses the registration", async () => {
    const h = createHarness();
    h.happyPath();
    h.api.on("POST", "/api/v1/me/devices", () => new Response("", { status: 500 }));

    await h.runtime.auth.signIn(USER.email, PASSWORD, "device");

    expect(h.runtime.session.getState().status).toBe("signedIn");
  });

  /**
   * The credential is what the whole lifecycle hangs on, so it is asserted from BOTH ends: with a
   * token the phone registers (above), and without one — a simulator, Expo Go, a build with no EAS
   * project — nothing is sent and nothing is remembered to release later.
   */
  it("remembers nothing to release when it never registered", async () => {
    const bare = createHarness();
    bare.happyPath();
    bare.push.credential = undefined;

    await bare.runtime.auth.signIn(USER.email, PASSWORD, "device");
    await bare.runtime.auth.signOut();
    await new Promise((resolve) => setImmediate(resolve));

    expect(bare.api.callsTo("POST", "/api/v1/me/devices")).toEqual([]);
    expect(bare.api.calls.filter((c) => c.method === "DELETE")).toEqual([]);
  });
});

/* ── 2. releasing ─────────────────────────────────────────────────────────── */

describe("2. signing out stops this handset ringing", () => {
  it("releases the device it registered", async () => {
    const h = createHarness();
    h.happyPath();
    await h.runtime.auth.signIn(USER.email, PASSWORD, "device");

    await h.runtime.auth.signOut();
    // Fire-and-forget by design — the session must not wait on it — so settle the microtask queue.
    await new Promise((resolve) => setImmediate(resolve));

    expect(h.api.callsTo("DELETE", "/api/v1/me/devices/device-1")).toHaveLength(1);
  });

  /** Nothing registered, nothing to release — and certainly no request with `undefined` in the URL. */
  it("releases nothing when it never registered", async () => {
    const h = createHarness();
    h.happyPath();
    h.push.credential = undefined;
    await h.runtime.auth.signIn(USER.email, PASSWORD, "device");

    await h.runtime.auth.signOut();
    await new Promise((resolve) => setImmediate(resolve));

    expect(
      h.api.calls.filter((c) => c.method === "DELETE" && c.path.includes("/me/devices")),
    ).toEqual([]);
  });

  /**
   * A release that fails must not leave the app half signed out. The server holds the other half
   * of this guarantee anyway: the next sign-in on this handset REASSIGNS the token.
   */
  it("completes the sign-out even when the release fails", async () => {
    const h = createHarness();
    h.happyPath();
    await h.runtime.auth.signIn(USER.email, PASSWORD, "device");
    h.api.on("DELETE", "/api/v1/me/devices/device-1", () => new Response("", { status: 500 }));

    await h.runtime.auth.signOut();
    await new Promise((resolve) => setImmediate(resolve));

    expect(h.runtime.session.getState().status).toBe("signedOut");
    expect(h.runtime.session.getState().accessToken).toBeUndefined();
  });
});

/* ── 3. where a tap lands ─────────────────────────────────────────────────── */

describe("3. a notification opens what it is about", () => {
  it("sends a result alert to that order", () => {
    expect(destinationFor({ resourceType: "order", resourceId: "o-1" })).toBe("/order/o-1");
  });

  it("sends a patient-shaped message to that chart", () => {
    expect(destinationFor({ resourceType: "patient", resourceId: "p-1" })).toBe("/patient/p-1");
  });

  /**
   * A fleet of phones is never all on one build. A message about a screen that shipped after this
   * binary must open SOMETHING, and the alert list is the honest something — the message is there,
   * in full, whatever this build can or cannot render.
   */
  it("falls back to the inbox for a kind this build does not know", () => {
    expect(destinationFor({ resourceType: "theatre-booking", resourceId: "t-1" })).toBe("/alerts");
  });

  it("falls back to the inbox when there is nothing to open", () => {
    expect(destinationFor({ templateKey: "password.reset" })).toBe("/alerts");
    expect(destinationFor({ resourceType: "order" })).toBe("/alerts");
  });

  /**
   * The one input to this app that no schema validated, that did not come through the client, and
   * that may have been sitting in a notification tray since before this build was installed.
   */
  it("reads a hostile or empty payload without throwing", () => {
    expect(readPayload(undefined)).toEqual({});
    expect(readPayload(null)).toEqual({});
    expect(readPayload("not an object")).toEqual({});
    expect(readPayload({ resourceType: 42, resourceId: ["x"] })).toEqual({});
    expect(readPayload({ resourceType: "order", resourceId: "o-1", extra: "ignored" })).toEqual({
      resourceType: "order",
      resourceId: "o-1",
    });
  });

  /** A tap reaches whoever subscribed, and the subscription can be dropped. */
  it("delivers a tap to the shell, and stops when it unsubscribes", () => {
    const h = createHarness();
    const seen: string[] = [];
    const off = h.push.onOpened((payload) => seen.push(destinationFor(payload)));

    h.push.open({ resourceType: "order", resourceId: "o-9" });
    expect(seen).toEqual(["/order/o-9"]);

    off();
    h.push.open({ resourceType: "order", resourceId: "o-10" });
    expect(seen, "the shell kept receiving taps after unsubscribing").toEqual(["/order/o-9"]);
    expect(h.push.subscribers).toBe(0);
  });
});

/* ── 4. what the hospital bought ──────────────────────────────────────────── */

describe("4. the tab bar answers to the edition as well as the role", () => {
  const NURSE = new Set(["encounter:read", "patient:read", "nursing:manage", "emr:read"]);

  it("carries the edition into the session on sign-in", async () => {
    const h = createHarness();
    h.happyPath({ features: ["module.ops.opd", "module.clinical.nursing"] });

    await h.runtime.auth.signIn(USER.email, PASSWORD, "device");

    expect([...h.runtime.session.getState().features]).toEqual([
      "module.ops.opd",
      "module.clinical.nursing",
    ]);
  });

  /**
   * ── THE DEFECT THIS CLOSES (D20, one client late) ─────────────────────────
   * A nurse at a clinic with no nursing module holds `nursing:manage` — a permission is a fact
   * about the USER — and the Ward tab could only ever answer `HMS-PLAN-002`. The web shell has
   * gated on both halves since August.
   */
  it("hides the ward from a hospital that never bought the nursing module", () => {
    const withIt = tabsFor(NURSE, new Set(["module.ops.opd", "module.clinical.nursing"]));
    const without = tabsFor(NURSE, new Set(["module.ops.opd"]));

    expect(withIt.map((t) => t.name)).toContain("ward");
    expect(without.map((t) => t.name)).not.toContain("ward");
  });

  it("hides the dispense counter from a hospital without the pharmacy module", () => {
    const held = new Set(["pharmacy:dispense"]);
    expect(tabsFor(held, new Set(["module.pharmacy.dispensing"])).map((t) => t.name)).toContain(
      "pharmacy",
    );
    expect(tabsFor(held, new Set(["module.ops.opd"])).map((t) => t.name)).not.toContain("pharmacy");
  });

  /**
   * An unknown edition must not blank the bar. The set is empty for the moment between sign-in and
   * `/auth/me` returning, and a bar that hid itself would flicker on every cold start — worse, a
   * `/auth/me` that stopped sending `features` would silently take the ward away from every nurse
   * on the platform.
   */
  it("shows everything the permissions allow while the edition is still unknown", () => {
    expect(tabsFor(NURSE).map((t) => t.name)).toContain("ward");
    expect(tabsFor(NURSE, undefined).map((t) => t.name)).toContain("ward");
  });

  /** The edition reaches the overflow split and the landing tab, not just the visible list. */
  it("is applied by splitTabs and homeFor too, not only by tabsFor", () => {
    const everything = new Set([
      "encounter:read",
      "patient:read",
      "order:read",
      "nursing:manage",
      "pharmacy:dispense",
      "billing:read",
    ]);
    const clinic = new Set(["module.ops.opd"]);

    expect(splitTabs(everything, clinic).visible.map((t) => t.name)).not.toContain("ward");
    expect(splitTabs(everything, clinic).overflow.map((t) => t.name)).not.toContain("pharmacy");
    expect(homeFor(["PHARMACIST"], everything, clinic)).not.toBe("pharmacy");
  });
});
