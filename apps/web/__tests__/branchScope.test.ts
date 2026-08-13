/**
 * The branch-scope decisions, in plain Node — the half of W-1 that is arithmetic rather than
 * mounting. (The mounting half is proved by rendering, in `branchScope.render.test.tsx`.)
 *
 * `reconcileBranch` is the one that had never been tested and is the one most likely to be wrong:
 * it decides what a tab does with a remembered branch after the user's access has changed
 * underneath it. Every case below is a real situation — a transfer between sites, a revoked
 * binding, a single-site nurse, a regional administrator — and getting any of them wrong strands
 * someone on a screen whose every request fails.
 */
import { describe, expect, it } from "vitest";
import {
  ALL_BRANCHES,
  branchScopeId,
  discardsViewState,
  reconcileBranch,
} from "../lib/branchScope";

const hyd = { id: "branch-hyd" };
const che = { id: "branch-che" };

describe("branchScopeId", () => {
  it("is stable for the same tenant and branch", () => {
    expect(branchScopeId({ tenant: "apollo.test", branchId: "b1" })).toBe(
      branchScopeId({ tenant: "apollo.test", branchId: "b1" }),
    );
  });

  it("separates branches, tenants, and the aggregate view", () => {
    const base = branchScopeId({ tenant: "apollo.test", branchId: "b1" });
    expect(branchScopeId({ tenant: "apollo.test", branchId: "b2" })).not.toBe(base);
    expect(branchScopeId({ tenant: "sunrise.test", branchId: "b1" })).not.toBe(base);
    expect(branchScopeId({ tenant: "apollo.test", branchId: null })).not.toBe(base);
  });

  it("names the aggregate view explicitly rather than leaving a blank", () => {
    // A blank segment would collide with a tenant whose branch id happened to be empty, and reads
    // as "unset" in a debugger when it means "deliberately across all sites".
    expect(branchScopeId({ tenant: "apollo.test", branchId: null })).toContain(ALL_BRANCHES);
  });
});

describe("discardsViewState", () => {
  it("does not discard on first render — there is nothing to discard", () => {
    expect(discardsViewState(undefined, "apollo.test::b1")).toBe(false);
  });

  it("discards when the scope moves", () => {
    expect(discardsViewState("apollo.test::b1", "apollo.test::b2")).toBe(true);
    expect(discardsViewState("apollo.test::b1", `apollo.test::${ALL_BRANCHES}`)).toBe(true);
  });

  it("does not discard when the scope is unchanged", () => {
    expect(discardsViewState("apollo.test::b1", "apollo.test::b1")).toBe(false);
  });
});

describe("reconcileBranch — what a tab does with a remembered branch", () => {
  it("keeps a remembered branch the user can still reach, and writes nothing", () => {
    expect(
      reconcileBranch({ stored: "branch-hyd", branches: [hyd, che], canAggregate: true }),
    ).toEqual({ branchId: "branch-hyd", persist: false });
  });

  /**
   * The case that matters most. A nurse transferred from Hyderabad to Chennai still has
   * `branch-hyd` in this tab's sessionStorage. Sending it would make the server reject every
   * request while the switcher displayed a site she no longer works at — a dead screen with no
   * explanation on it.
   */
  it("drops a remembered branch the user can no longer reach", () => {
    expect(reconcileBranch({ stored: "branch-hyd", branches: [che], canAggregate: true })).toEqual({
      branchId: null,
      persist: true,
    });
  });

  it("pins a single-site user to their only branch, and records it", () => {
    expect(reconcileBranch({ stored: null, branches: [che], canAggregate: false })).toEqual({
      branchId: "branch-che",
      persist: true,
    });
  });

  it("re-pins a single-site user whose remembered branch is stale", () => {
    expect(reconcileBranch({ stored: "branch-hyd", branches: [che], canAggregate: false })).toEqual(
      { branchId: "branch-che", persist: true },
    );
  });

  /**
   * A single-branch user who MAY aggregate is a different person — a regional administrator whose
   * access happens to be one site today. Pinning them would silently remove a mode they hold.
   */
  it("does not pin a single-branch user who may aggregate", () => {
    expect(reconcileBranch({ stored: null, branches: [che], canAggregate: true })).toEqual({
      branchId: null,
      persist: false,
    });
  });

  it("leaves a multi-branch user in aggregate mode when nothing is remembered", () => {
    expect(reconcileBranch({ stored: null, branches: [hyd, che], canAggregate: true })).toEqual({
      branchId: null,
      persist: false,
    });
  });

  it("survives a user bound to no branch at all", () => {
    expect(reconcileBranch({ stored: "branch-hyd", branches: [], canAggregate: false })).toEqual({
      branchId: null,
      persist: true,
    });
  });

  /**
   * A branch id belonging to ANOTHER HOSPITAL can only arrive by tampering — sessionStorage is
   * per-origin, and a different tenant is a different origin. It is refused for the same reason
   * as any unreachable id: it is not in the list the server just sent for this user.
   */
  it("refuses a branch id that is not in the user's own list, whatever its origin", () => {
    expect(
      reconcileBranch({
        stored: "a-branch-at-another-hospital",
        branches: [hyd, che],
        canAggregate: true,
      }),
    ).toEqual({ branchId: null, persist: true });
  });
});
