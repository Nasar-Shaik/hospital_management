/**
 * THE ERROR FOUNDATION — scenarios 12, 13, 14 and 15.
 *
 * Every failure the API can produce arrives here as an `ApiClientError` with a CODE, and leaves as
 * words a nurse can act on. Two rules are load-bearing and both are asserted:
 *
 *   · the server's `message` is never rendered — it is written for a developer, and a reworded
 *     server string must not change what a phone says;
 *   · a 2xx carrying `Idempotency-Replayed` is a SUCCESS, because that is the mechanism that makes
 *     "tap again" safe.
 */
import { describe, expect, it } from "vitest";
import { ApiClientError } from "@medicore/api-client";
import {
  isBranchProblem,
  isNetworkFailure,
  isSessionExpired,
  toUserMessage,
} from "../src/lib/net/errors.js";
import { shouldRetryMutation, shouldRetryRead } from "../src/lib/net/retry.js";
import { PASSWORD, USER, createHarness } from "./support/harness.js";
import { created, fail, ok } from "./support/fakeApi.js";

const apiError = (status: number, code: string, details?: unknown): ApiClientError =>
  new ApiClientError(status, code, "developer-facing text", details, "trace-1");

describe("12. a 403 is explained, and never bounced to the login screen", () => {
  it("maps HMS-AUTH-005 to a permission message with somewhere to go", () => {
    const message = toUserMessage(apiError(403, "HMS-AUTH-005"));

    expect(message.title).toBe("You do not have access");
    expect(message.action).toBe("contactAdmin");
    expect(message.severity).toBe("inline");
    // The distinction that prevents an infinite loop: forbidden is not unauthenticated.
    expect(isSessionExpired(apiError(403, "HMS-AUTH-005"))).toBe(false);
  });

  it("treats a 403 as a signal that the branch may have changed under us", () => {
    expect(isBranchProblem(apiError(403, "HMS-AUTH-005"))).toBe(true);
    expect(isBranchProblem(apiError(400, "HMS-BRANCH-001"))).toBe(true);
    expect(isBranchProblem(apiError(404, "HMS-GEN-404"))).toBe(false);
  });

  it("separates a lapsed subscription from a permission problem — it blocks the whole app", () => {
    const licence = toUserMessage(apiError(403, "HMS-TEN-005"));
    expect(licence.severity).toBe("blocking");

    const plan = toUserMessage(apiError(403, "HMS-PLAN-002"));
    expect(plan.severity).toBe("inline");
  });

  it("never renders the server's own message", () => {
    for (const code of ["HMS-AUTH-005", "HMS-TEN-005", "HMS-REQ-003", "HMS-VAL-001"]) {
      const message = toUserMessage(apiError(403, code));
      expect(message.body).not.toContain("developer-facing text");
      expect(message.title).not.toContain("developer-facing text");
    }
  });
});

describe("13. the three 409s mean different things and must not be collapsed", () => {
  it("HMS-REQ-002 (key reused for a different request) says reload, NOT retry", () => {
    const message = toUserMessage(apiError(409, "HMS-REQ-002"));

    /**
     * The one 409 where "try again" is actively wrong: retrying re-sends the same mismatched key
     * and gets the same refusal. Reloading is what recovers, because it re-reads the record and
     * mints a fresh key.
     */
    expect(message.action).toBe("reload");
    expect(message.title).toBe("Already submitted");
  });

  it("HMS-REQ-004 (still in flight) says wait, and warns against submitting again", () => {
    const message = toUserMessage(apiError(409, "HMS-REQ-004"));
    expect(message.action).toBe("retry");
    expect(message.body).toMatch(/do not submit again/i);
  });

  it("HMS-REQ-003 (someone else changed it) says reload and reapply", () => {
    const message = toUserMessage(apiError(409, "HMS-REQ-003"));
    expect(message.action).toBe("reload");
    expect(message.title).toBe("Changed by someone else");
  });

  it("preserves the structured detail the API sent, and the traceId", () => {
    const message = toUserMessage(apiError(409, "HMS-REQ-002", { existingId: "pay-1" }));
    expect(message.code).toBe("HMS-REQ-002");
    expect(message.traceId).toBe("trace-1");
  });

  it("maps a 400's field errors straight onto the form", () => {
    const message = toUserMessage(
      apiError(400, "HMS-VAL-001", { fields: { email: ["is not valid"], name: ["is required"] } }),
    );

    expect(message.fields).toEqual({ email: ["is not valid"], name: ["is required"] });
    expect(message.title).toBe("Check the form");
  });
});

describe("14. a transport failure is not an API failure", () => {
  it("says 'no connection' rather than parsing a platform-specific message", () => {
    const message = toUserMessage(new TypeError("Network request failed"));

    expect(message.title).toBe("No connection");
    expect(message.action).toBe("retry");
    expect(isNetworkFailure(new TypeError("Network request failed"))).toBe(true);
    expect(isNetworkFailure(apiError(500, "HMS-GEN-500"))).toBe(false);
  });

  it("flips the connectivity store, so the write guard can explain itself before the attempt", async () => {
    const h = createHarness();
    h.happyPath();
    await h.runtime.auth.signIn(USER.email, PASSWORD, "device");
    expect(h.runtime.connectivity.getState().online).toBe(true);

    h.api.goOffline();
    h.api.on("GET", "/api/v1/patients", () => ok([]));
    await expect(h.runtime.api.listPatients({ limit: 1 })).rejects.toBeInstanceOf(TypeError);

    /**
     * Connectivity is observed at the transport, not from a native module: the question the UI is
     * really asking is "will a save arrive?", and only an actual request answers it. Hospital wifi
     * with no route to the API reports "connected" to every OS-level check.
     */
    expect(h.runtime.connectivity.getState().online).toBe(false);

    h.api.goOnline();
    await h.runtime.api.listPatients({ limit: 1 });
    expect(h.runtime.connectivity.getState().online).toBe(true);
  });

  it("retries a read on a transport failure, and never retries a mutation", () => {
    expect(shouldRetryRead(0, new TypeError("Network request failed"))).toBe(true);
    expect(shouldRetryRead(0, apiError(503, "HMS-GEN-503"))).toBe(true);

    // A 4xx does not become a 2xx by asking again — retrying only delays the error.
    expect(shouldRetryRead(0, apiError(403, "HMS-AUTH-005"))).toBe(false);
    expect(shouldRetryRead(0, apiError(429, "HMS-REQ-001"))).toBe(false);
    expect(shouldRetryRead(5, apiError(500, "HMS-GEN-500"))).toBe(false);

    /**
     * Never, for any status. The transport cannot know whether the first attempt reached the
     * server, so an automatic retry of a payment is how a phone charges twice. Retry is a USER
     * action carrying the same Idempotency-Key.
     */
    expect(shouldRetryMutation()).toBe(false);
  });

  it("reports a 5xx as the hospital's system, not as something the user did", () => {
    const message = toUserMessage(apiError(500, "HMS-GEN-500"));
    expect(message.body).toMatch(/not something you did/i);
    expect(message.action).toBe("retry");
  });

  it("still produces a safe message for a code it has never seen", () => {
    const message = toUserMessage(apiError(418, "HMS-FUTURE-999"));
    expect(message.title).toBe("Something went wrong");
    expect(message.body).not.toContain("developer-facing text");
    expect(message.code).toBe("HMS-FUTURE-999");
  });
});

describe("15. a replayed idempotent response is a success", () => {
  it("resolves normally when the API answers with Idempotency-Replayed", async () => {
    const h = createHarness();
    h.happyPath();
    await h.runtime.auth.signIn(USER.email, PASSWORD, "device");

    const deposit = { id: "dep-1", amount: 500 };
    h.api.once("POST", "/api/v1/patients/p1/wallet/deposits", () => created(deposit));
    h.api.on("POST", "/api/v1/patients/p1/wallet/deposits", () =>
      created(deposit, { "idempotency-replayed": "true" }),
    );

    const first = await h.runtime.api.depositToWallet(
      "p1",
      { amount: 500, method: "cash" },
      "intent-key-0001",
    );
    const retried = await h.runtime.api.depositToWallet(
      "p1",
      { amount: 500, method: "cash" },
      "intent-key-0001",
    );

    /**
     * The property that makes "tap again" safe. A replay is a 2xx, so it must NOT be rendered as
     * a duplicate, an error or a second deposit — it is the original answer, returned again.
     */
    expect(retried).toEqual(first);

    const calls = h.api.callsTo("POST", "/api/v1/patients/p1/wallet/deposits");
    expect(calls).toHaveLength(2);
    // The SAME key on both — a fresh key per tap protects nothing, which was the web's bug.
    expect(calls[0]?.headers["idempotency-key"]).toBe("intent-key-0001");
    expect(calls[1]?.headers["idempotency-key"]).toBe("intent-key-0001");
  });

  it("does surface a genuine key conflict as an error, so the two are not confused", async () => {
    const h = createHarness();
    h.happyPath();
    await h.runtime.auth.signIn(USER.email, PASSWORD, "device");

    h.api.on("POST", "/api/v1/patients/p1/wallet/deposits", () =>
      fail(409, "HMS-REQ-002", "Duplicate request"),
    );

    await expect(
      h.runtime.api.depositToWallet("p1", { amount: 900, method: "cash" }, "intent-key-0001"),
    ).rejects.toMatchObject({ code: "HMS-REQ-002" });
  });
});
