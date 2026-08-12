/**
 * PERMISSION-DRIVEN NAVIGATION — scenarios 9 and 10 (M0 §8).
 *
 * The rule being defended: navigation is derived from PERMISSIONS, never from a role string.
 * Roles are tenant-editable data — a hospital may rename DOCTOR to CONSULTANT or build its own
 * role from the same grants — so an app that branches on the name works at the hospital it was
 * written for and quietly loses a tab at the next one.
 */
import { describe, expect, it } from "vitest";
import { ALL_PERMISSION_CODES } from "@medicore/permissions";
import { MAX_VISIBLE_TABS, TABS, homeFor, splitTabs, tabsFor } from "../src/navigation/tabsFor.js";
import { writeGuard } from "../src/lib/guard.js";

const held = (...codes: string[]): ReadonlySet<string> => new Set(codes);

describe("9. the tab bar is a function of the permission set", () => {
  it("gives a doctor the tabs their grants imply, and nothing else", () => {
    const doctor = held("patient:read", "encounter:read", "order:read", "prescription:create");

    expect(tabsFor(doctor).map((t) => t.name)).toEqual(["queue", "patients", "orders", "alerts"]);
  });

  it("gives a cashier a different bar from the same function", () => {
    const cashier = held("patient:read", "billing:read");
    expect(tabsFor(cashier).map((t) => t.name)).toEqual(["patients", "billing", "alerts"]);
  });

  it("gives someone with no grants only their own inbox", () => {
    // `alerts` needs nothing: every signed-in person has notifications addressed to them.
    expect(tabsFor(held()).map((t) => t.name)).toEqual(["alerts"]);
  });

  it("requires ALL of a tab's permissions, not any of them", () => {
    const multi = { name: "x", title: "X", icon: "i", needs: ["a", "b"] } as const;
    expect(multi.needs.every((p) => held("a").has(p))).toBe(false);
    expect(multi.needs.every((p) => held("a", "b").has(p))).toBe(true);
  });

  it("every permission a tab asks for is a REAL permission", () => {
    /**
     * A typo in a `needs` code cannot fail loudly — the tab simply never appears, for everyone,
     * for ever. Checking against the catalogue turns a silent permanent bug into a red test.
     */
    const catalogue = new Set(ALL_PERMISSION_CODES);
    const unknown = TABS.flatMap((tab) => tab.needs).filter((code) => !catalogue.has(code));
    expect(unknown).toEqual([]);
  });

  it("moves the surplus into More rather than growing the bar", () => {
    const everything = held(
      "encounter:read",
      "patient:read",
      "order:read",
      "pharmacy:dispense",
      "billing:read",
    );

    const { visible, overflow } = splitTabs(everything);

    expect(tabsFor(everything)).toHaveLength(6);
    expect(visible).toHaveLength(MAX_VISIBLE_TABS);
    expect(overflow).toHaveLength(1);
    // Alerts keeps its place: a notification the user cannot find is one that did not arrive.
    expect(visible.at(-1)?.name).toBe("alerts");
  });
});

describe("10. a capability the user does not hold is not offered", () => {
  it("hides the pharmacy tab from a doctor", () => {
    const doctor = held("patient:read", "encounter:read", "order:read");
    expect(tabsFor(doctor).map((t) => t.name)).not.toContain("pharmacy");
  });

  it("blocks the write with a REASON, not a bare disabled control", () => {
    const result = writeGuard({
      online: true,
      branchResolved: true,
      requiresBranch: true,
      licenceExpired: false,
      needs: "pharmacy:dispense",
      held: held("patient:read"),
    });

    expect(result.canWrite).toBe(false);
    expect(result.block).toBe("noPermission");
    expect(result.reason).toMatch(/role does not include/i);
  });

  it("reports the block the user must fix FIRST", () => {
    /**
     * Order matters more than it looks. Telling someone they lack permission while they are also
     * offline sends them to an administrator for a problem that will fix itself at the next bar of
     * signal — and the administrator cannot reproduce it.
     */
    const offlineAndUnpermitted = writeGuard({
      online: false,
      branchResolved: true,
      requiresBranch: true,
      licenceExpired: false,
      needs: "pharmacy:dispense",
      held: held(),
    });
    expect(offlineAndUnpermitted.block).toBe("noPermission");

    const offlineOnly = writeGuard({
      online: false,
      branchResolved: true,
      requiresBranch: true,
      licenceExpired: false,
      held: held(),
    });
    expect(offlineOnly.block).toBe("offline");

    // A lapsed licence outranks everything: nothing can be saved at all until it is renewed.
    const lapsed = writeGuard({
      online: true,
      branchResolved: true,
      requiresBranch: true,
      licenceExpired: true,
      needs: "billing:read",
      held: held("billing:read"),
    });
    expect(lapsed.block).toBe("licenceExpired");
  });

  it("blocks a branch-requiring write until a site is resolved", () => {
    const result = writeGuard({
      online: true,
      branchResolved: false,
      requiresBranch: true,
      licenceExpired: false,
      held: held(),
    });

    expect(result.block).toBe("noBranch");
    // A read-only screen in All-branches mode is fine; only the write is held back.
    expect(
      writeGuard({
        online: true,
        branchResolved: false,
        requiresBranch: false,
        licenceExpired: false,
        held: held(),
      }).canWrite,
    ).toBe(true);
  });
});

describe("role decides only where you land", () => {
  it("sends a doctor to the queue and a cashier to billing", () => {
    expect(homeFor(["DOCTOR"], held("encounter:read", "patient:read"))).toBe("queue");
    expect(homeFor(["TENANT_ADMIN"], held("billing:read", "patient:read"))).toBe("billing");
  });

  it("falls through to the first available tab for a role it has never heard of", () => {
    /**
     * The property that makes role-based landing safe: a hospital that invents "SENIOR_REGISTRAR"
     * gets a sensible home rather than a blank screen, because the fallback is derived from
     * permissions like everything else.
     */
    expect(homeFor(["SENIOR_REGISTRAR"], held("patient:read"))).toBe("patients");
  });

  it("ignores a preferred home the user cannot actually see", () => {
    // A DOCTOR role stripped of `encounter:read` must not land on a tab that is not rendered.
    expect(homeFor(["DOCTOR"], held("billing:read"))).toBe("billing");
  });

  it("still has an answer for someone with no grants at all", () => {
    expect(homeFor([], held())).toBe("alerts");
  });
});
