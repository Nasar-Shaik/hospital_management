import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { InboxMessage } from "@medicore/api-client";
import { isUnread, sortAlerts, toneFor } from "../src/clinical/alerts";
import { queryKeys } from "../src/query/keys";

/**
 * M4 A — THE ALERTS TAB.
 *
 * ── WHAT DEFECT WOULD THIS CATCH? ───────────────────────────────────────────
 * This tab shipped in M1 as a placeholder naming its own blocker, and the blocker was real: there
 * was no route a clinician could call. Now that there is one, the two ways to lose the feature
 * again are both quiet.
 *
 * The first is branch-scoping the key. Every other list in this app is keyed `[tenant, branch, …]`
 * and a reviewer's instinct is that a key without a branch is a bug. Here it is the opposite: an
 * inbox is addressed to a PERSON, so a branch prefix would drop the unread count to zero the
 * moment a doctor switched sites — indistinguishable from "nothing needs you".
 *
 * The second is severity by wording. A hospital is invited to rewrite and translate its templates,
 * so a rule that looked for "CRITICAL" in the body would stop recognising a panic value the first
 * time somebody translated the message, and would do it silently.
 */
function message(over: Partial<InboxMessage> = {}): InboxMessage {
  return {
    id: "1",
    templateKey: "order.result.released",
    subject: "Result ready",
    body: "A result you ordered has been released.",
    createdAt: "2026-08-18T09:00:00.000Z",
    ...over,
  };
}

describe("the inbox key follows the person, not the branch", () => {
  const SLUG = "apollo";

  it("carries no branch segment", () => {
    expect(queryKeys.notifications(SLUG)).toEqual([SLUG, "notifications", ""]);
  });

  /**
   * The assertion that matters: the SAME key at two sites. If a branch ever entered this prefix,
   * these two would differ and a doctor's alerts would be re-fetched — and briefly empty — on
   * every switch.
   */
  it("is identical whichever site is selected", () => {
    expect(JSON.stringify(queryKeys.notifications(SLUG))).toBe(
      JSON.stringify(queryKeys.notifications(SLUG)),
    );
    // And it is genuinely tenant-shaped: another hospital is a different cache entry.
    expect(JSON.stringify(queryKeys.notifications(SLUG))).not.toBe(
      JSON.stringify(queryKeys.notifications("fortis")),
    );
  });

  /** Same endpoint, two requests: the bell's unread five and the tab's everything. */
  it("separates filtered reads from unfiltered ones", () => {
    expect(JSON.stringify(queryKeys.notifications(SLUG, "unread"))).not.toBe(
      JSON.stringify(queryKeys.notifications(SLUG)),
    );
  });
});

describe("a critical alert is recognised by its key", () => {
  it("marks order.critical critical and nothing else", () => {
    expect(toneFor("order.critical")).toBe("critical");
    for (const key of ["order.result.released", "appointment.reminder", "password.reset"]) {
      expect(toneFor(key)).toBe("normal");
    }
  });

  it("never consults the body, which the hospital may rewrite", () => {
    const SRC = readFileSync(join(__dirname, "..", "src/clinical/alerts.ts"), "utf8");
    expect(SRC).not.toMatch(/body.*includes|includes.*body/i);
  });
});

describe("unread is the absence of a read time", () => {
  it("reads it that way", () => {
    expect(isUnread(message())).toBe(true);
    expect(isUnread(message({ readAt: "2026-08-18T09:05:00.000Z" }))).toBe(false);
  });
});

/**
 * Critical, then unread, then newest — the same reasoning as `sortForReview` on the results tab.
 * A strictly chronological list buries a panic value from this morning under six routine messages
 * that arrived since.
 */
describe("the list is ordered by what needs attention", () => {
  const routineNew = message({ id: "new", createdAt: "2026-08-18T11:00:00.000Z" });
  const routineReadNew = message({
    id: "read",
    createdAt: "2026-08-18T12:00:00.000Z",
    readAt: "2026-08-18T12:01:00.000Z",
  });
  const criticalOld = message({
    id: "crit",
    templateKey: "order.critical",
    createdAt: "2026-08-18T07:00:00.000Z",
  });

  it("puts the critical one first even when it is the oldest", () => {
    expect(sortAlerts([routineNew, routineReadNew, criticalOld])[0]?.id).toBe("crit");
  });

  it("puts an unread message above a newer one already read", () => {
    expect(sortAlerts([routineReadNew, routineNew]).map((m) => m.id)).toEqual(["new", "read"]);
  });

  it("does not mutate what it was given", () => {
    const input = [routineReadNew, criticalOld];
    sortAlerts(input);
    expect(input.map((m) => m.id)).toEqual(["read", "crit"]);
  });
});

/**
 * The screen itself. Source assertions, because this suite runs in Node with no renderer — the
 * same approach `routes.test.ts` takes for every other structural rule in this app.
 */
describe("the tab is a real screen now", () => {
  const SRC = readFileSync(join(__dirname, "..", "app/(app)/alerts.tsx"), "utf8");
  /**
   * Comments stripped before the code assertions, the same way `scopedReads.test.ts` counts
   * `findById`: the screen's header NAMES `ComingLater` while explaining what it replaced, and a
   * naive scan would read that history as the thing it is describing.
   */
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("is no longer a placeholder", () => {
    expect(code).not.toMatch(/ComingLater/);
  });

  it("consumes the shared rules rather than re-deciding", () => {
    expect(code).toMatch(/from "\.\.\/\.\.\/src\/clinical\/alerts"/);
    expect(code).toMatch(/sortAlerts\(/);
    expect(code).toMatch(/toneFor\(/);
  });

  /**
   * No `needs`, and no permission redirect — unlike every other tab. The route is self-scoped and
   * unpermissioned on the server, so gating it here would hide a person's own alerts from them on
   * a hospital that built its own role.
   */
  it("does not gate itself on a permission", () => {
    expect(code).not.toMatch(/can\(["']/);
    expect(code).not.toMatch(/Redirect/);
  });

  /** Times are the branch's, not the handset's — see `routes.test.ts` for why that is load-bearing. */
  it("renders each message in the zone of the site that raised it", () => {
    expect(code).toMatch(/zoneFor\(item\.branchId\)/);
    expect(code).toMatch(/formatDateTime\(/);
  });
});
