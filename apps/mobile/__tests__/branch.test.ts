/**
 * BRANCH RESTORATION AND SWITCHING — scenarios 6, 7 and 8 (ADR-0015, M0 §7).
 *
 * The claim under test is the one the whole mobile branch design rests on: **the phone validates
 * nothing, and `/me/branches` outranks anything it remembers.** A persisted branch id is a cache
 * of a server fact, and every path that could send one re-reads the list first.
 */
import { describe, expect, it } from "vitest";
import { BRANCH_CHN, BRANCH_HYD, PASSWORD, SLUG, USER, createHarness } from "./support/harness.js";
import { ok } from "./support/fakeApi.js";
import { storageKeys } from "../src/lib/storage.js";

const branchKey = storageKeys.activeBranch(SLUG, USER.id);

describe("6. a remembered branch is restored — but only after it is re-validated", () => {
  it("restores it when the user is still a member", async () => {
    const h = createHarness();
    h.happyPath({ branches: [BRANCH_HYD, BRANCH_CHN], canAggregate: true });
    await h.preferences.set(branchKey, BRANCH_CHN.id);

    const outcome = await h.runtime.auth.signIn(USER.email, PASSWORD, "device").then(() => {
      return h.runtime.branch.getState().activeBranchId;
    });

    expect(outcome).toBe(BRANCH_CHN.id);
    // The list was read before anything was selected. This ordering IS the rule.
    expect(h.api.callsTo("GET", "/api/v1/me/branches")).toHaveLength(1);
  });

  it("sends it as X-Active-Branch on the very next request", async () => {
    const h = createHarness();
    h.happyPath({ branches: [BRANCH_HYD, BRANCH_CHN] });
    await h.preferences.set(branchKey, BRANCH_CHN.id);
    await h.runtime.auth.signIn(USER.email, PASSWORD, "device");

    h.api.on("GET", "/api/v1/patients", () => ok([]));
    await h.runtime.api.listPatients({ limit: 1 });

    const [call] = h.api.callsTo("GET", "/api/v1/patients");
    expect(call?.headers["x-active-branch"]).toBe(BRANCH_CHN.id);
  });

  it("NEVER sends a remembered branch before the list has been read in this session", async () => {
    const h = createHarness();
    h.happyPath({ branches: [BRANCH_HYD, BRANCH_CHN] });
    await h.preferences.set(branchKey, BRANCH_CHN.id);

    /**
     * `/auth/me` is issued during bootstrap, BEFORE `/me/branches` resolves. If the store were
     * pre-loaded from preferences at launch, that first call would carry a branch nobody had
     * re-checked — which is the exact failure the `validated` flag exists to prevent.
     */
    await h.runtime.auth.signIn(USER.email, PASSWORD, "device");

    const [meCall] = h.api.callsTo("GET", "/api/v1/auth/me");
    expect(meCall?.headers["x-active-branch"]).toBeUndefined();
  });

  it("restores All-branches mode when the server still offers it", async () => {
    const h = createHarness();
    h.happyPath({ branches: [BRANCH_HYD, BRANCH_CHN], canAggregate: true });
    await h.preferences.set(branchKey, "all");

    const outcome = await h.runtime.branches.restore(USER.id);

    expect(outcome).toEqual({ outcome: "restoredAggregate" });
    expect(h.runtime.branch.getState().activeBranchId).toBeUndefined();
  });

  it("selects the only branch silently — one site is not a choice", async () => {
    const h = createHarness();
    h.happyPath({ branches: [BRANCH_HYD] });

    const outcome = await h.runtime.branches.restore(USER.id);

    expect(outcome).toEqual({ outcome: "auto", branchId: BRANCH_HYD.id });
    // Remembered, so the next launch does not re-derive it.
    expect(await h.preferences.get(branchKey)).toBe(BRANCH_HYD.id);
  });

  it("copes with a hospital that has no branches at all", async () => {
    const h = createHarness();
    h.happyPath({ branches: [] });

    expect(await h.runtime.branches.restore(USER.id)).toEqual({ outcome: "none" });
    expect(h.runtime.branch.getState().activeBranchId).toBeUndefined();
  });
});

describe("7. an invalid persisted branch is dropped, never sent", () => {
  it("drops a branch the user is no longer a member of and asks", async () => {
    const h = createHarness();
    h.happyPath({ branches: [BRANCH_HYD, BRANCH_CHN] });
    await h.preferences.set(branchKey, "branch-that-was-removed");

    const outcome = await h.runtime.branches.restore(USER.id);

    expect(outcome).toEqual({ outcome: "prompt" });
    expect(h.runtime.branch.getState().activeBranchId).toBeUndefined();
    /**
     * Erased, not merely ignored. A stale id left in storage gets sent eventually — by the next
     * code path that reads it without validating — and that is precisely the failure this guards.
     */
    expect(await h.preferences.get(branchKey)).toBeUndefined();
  });

  it("drops a RETIRED branch, which the server would still accept from a hospital-wide caller", async () => {
    const h = createHarness();
    // `/me/branches` filters to active, so a retired site simply is not in the list.
    h.happyPath({ branches: [BRANCH_HYD] });
    await h.preferences.set(branchKey, BRANCH_CHN.id);

    const outcome = await h.runtime.branches.restore(USER.id);

    /**
     * This is the client half of backend item F. `resolveActiveBranch` validates the header
     * against MEMBERSHIP, and a hospital-wide user passes for any id — including a closed site.
     * Until the server also checks status, dropping it here is the only thing preventing records
     * from being created against a branch the hospital has retired.
     */
    expect(outcome).toEqual({ outcome: "auto", branchId: BRANCH_HYD.id });
    expect(h.runtime.branch.getState().activeBranchId).toBe(BRANCH_HYD.id);
  });

  it("drops remembered All-branches mode when aggregation is no longer offered", async () => {
    const h = createHarness();
    h.happyPath({ branches: [BRANCH_HYD], canAggregate: false });
    await h.preferences.set(branchKey, "all");

    const outcome = await h.runtime.branches.restore(USER.id);

    expect(outcome).toEqual({ outcome: "auto", branchId: BRANCH_HYD.id });
    expect(await h.preferences.get(branchKey)).toBe(BRANCH_HYD.id);
  });
});

describe("8. switching branch changes the context, and clears what belonged to the old one", () => {
  it("persists the choice and sends it on the next request", async () => {
    const h = createHarness();
    h.happyPath({ branches: [BRANCH_HYD, BRANCH_CHN] });
    await h.runtime.branches.restore(USER.id);

    await h.runtime.branches.select(USER.id, BRANCH_CHN.id);

    expect(h.runtime.branch.getState().activeBranchId).toBe(BRANCH_CHN.id);
    expect(await h.preferences.get(branchKey)).toBe(BRANCH_CHN.id);

    h.api.on("GET", "/api/v1/patients", () => ok([]));
    await h.runtime.api.listPatients({ limit: 1 });
    expect(h.api.callsTo("GET", "/api/v1/patients")[0]?.headers["x-active-branch"]).toBe(
      BRANCH_CHN.id,
    );
  });

  it("discards cached server state, so the previous site's list cannot render for a frame", async () => {
    const h = createHarness();
    h.happyPath({ branches: [BRANCH_HYD, BRANCH_CHN] });
    await h.runtime.branches.restore(USER.id);
    await h.runtime.branches.select(USER.id, BRANCH_HYD.id);

    h.runtime.queryClient.setQueryData([SLUG, BRANCH_HYD.id, "patients", ""], [{ id: "hyd-1" }]);

    await h.runtime.branches.select(USER.id, BRANCH_CHN.id);

    /**
     * A list of the wrong patients is a clinical error, not a rendering glitch. M1 clears
     * everything rather than reasoning about which keys are branch-sensitive — the unoptimised
     * choice on purpose, and revisited with evidence rather than a guess.
     */
    expect(
      h.runtime.queryClient.getQueryData([SLUG, BRANCH_HYD.id, "patients", ""]),
    ).toBeUndefined();
  });

  it("does not clear anything when the user re-picks the branch they are already in", async () => {
    const h = createHarness();
    h.happyPath({ branches: [BRANCH_HYD, BRANCH_CHN] });
    await h.runtime.branches.restore(USER.id);
    await h.runtime.branches.select(USER.id, BRANCH_HYD.id);
    h.runtime.queryClient.setQueryData([SLUG, BRANCH_HYD.id, "patients", ""], [{ id: "hyd-1" }]);

    await h.runtime.branches.select(USER.id, BRANCH_HYD.id);

    // Tapping the current site in a switcher is a no-op, not a cache wipe and a round trip.
    expect(h.runtime.queryClient.getQueryData([SLUG, BRANCH_HYD.id, "patients", ""])).toEqual([
      { id: "hyd-1" },
    ]);
  });

  it("refuses to persist a branch that is not in the list it was offered from", async () => {
    const h = createHarness();
    h.happyPath({ branches: [BRANCH_HYD] });
    await h.runtime.branches.restore(USER.id);

    await h.runtime.branches.select(USER.id, "branch-invented-by-a-stale-screen");

    // Not an authorization decision — the server owns that. This stops the UI persisting a choice
    // from a list that has since been replaced.
    expect(h.runtime.branch.getState().activeBranchId).toBe(BRANCH_HYD.id);
  });

  it("refuses All-branches when the server did not offer aggregation", async () => {
    const h = createHarness();
    h.happyPath({ branches: [BRANCH_HYD], canAggregate: false });
    await h.runtime.branches.restore(USER.id);

    await h.runtime.branches.select(USER.id, undefined);

    expect(h.runtime.branch.getState().activeBranchId).toBe(BRANCH_HYD.id);
  });
});
