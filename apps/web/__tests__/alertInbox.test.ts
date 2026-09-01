import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { InboxMessage } from "@medicore/api-client";
import { badgeCount, isUnread, sortForBell, titleFor, toneFor } from "../lib/alerts";

/**
 * THE ALERT INBOX — the rules, apart from the pixels.
 *
 * ── WHAT DEFECT WOULD THIS CATCH? ───────────────────────────────────────────
 * The inbox exists because a critical result reached nobody. The way to lose that a second time
 * is not to delete it — it is to let the critical alert become indistinguishable from four routine
 * ones in a five-row dropdown, or to let the rule that recognises it depend on wording a hospital
 * is explicitly invited to rewrite.
 *
 * So these pin the two decisions that carry the weight: severity is read from the TEMPLATE KEY
 * (ours) and never from the body (theirs), and the bell sorts by severity where the page sorts by
 * time.
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

describe("a critical alert is recognised by its key, not by its words", () => {
  it("marks order.critical critical", () => {
    expect(toneFor("order.critical")).toBe("critical");
  });

  it("leaves the ordinary messages ordinary", () => {
    for (const key of ["order.result.released", "appointment.reminder", "password.reset"]) {
      expect(toneFor(key)).toBe("normal");
    }
  });

  /**
   * The hospital owns the wording — `PUT /notifications/templates/:key` exists precisely so it can
   * rewrite or translate every message. A severity rule that searched the body for "CRITICAL"
   * would stop recognising the most important message in the product the first time a hospital
   * ran it through a translator, and would do it silently.
   */
  /**
   * These two cases cannot go red from a change inside `toneFor`, and that is the point: the
   * function takes a KEY and nothing else, so the body is unreachable to it by signature. They
   * state the guarantee; the source test below is the one that fires if somebody widens the
   * signature to let the body back in.
   */
  it("does not depend on the body, which the hospital may rewrite", () => {
    const translated = message({
      templateKey: "order.critical",
      subject: "GAMBHIR PARINAAM",
      body: "koi CRITICAL shabd nahin",
    });
    expect(toneFor(translated.templateKey)).toBe("critical");

    // And the converse: a routine message that merely contains the word is still routine.
    const shouting = message({ body: "this is not a CRITICAL result, do not panic" });
    expect(toneFor(shouting.templateKey)).toBe("normal");
  });

  it("reads severity from the key even in a source sense", () => {
    const SRC = readFileSync(join(__dirname, "..", "lib/alerts.ts"), "utf8");
    // `body` must not be consulted by the tone rule. Named here because the tempting shortcut is
    // exactly one line long.
    expect(SRC).not.toMatch(/body.*includes|includes.*body/i);
  });
});

describe("unread is the absence of a read time", () => {
  it("treats a message with no readAt as unread", () => {
    expect(isUnread(message())).toBe(true);
  });

  it("treats one with a readAt as read", () => {
    expect(isUnread(message({ readAt: "2026-08-18T09:05:00.000Z" }))).toBe(false);
  });
});

/**
 * A critical potassium from this morning must not be pushed out of a five-row preview by four
 * routine results that came back since. The server returns newest-first — right for the page,
 * wrong for the bell.
 */
describe("the bell shows what matters before what is recent", () => {
  const routineNew = message({ id: "new", createdAt: "2026-08-18T11:00:00.000Z" });
  const routineOld = message({ id: "old", createdAt: "2026-08-18T08:00:00.000Z" });
  const criticalOld = message({
    id: "crit",
    templateKey: "order.critical",
    createdAt: "2026-08-18T07:00:00.000Z",
  });

  it("puts the critical one first even when it is the oldest", () => {
    const sorted = sortForBell([routineNew, routineOld, criticalOld]);
    expect(sorted[0]?.id).toBe("crit");
  });

  it("orders the rest newest first", () => {
    const sorted = sortForBell([routineOld, routineNew, criticalOld]);
    expect(sorted.map((m) => m.id)).toEqual(["crit", "new", "old"]);
  });

  it("does not mutate what it was given", () => {
    const input = [routineOld, criticalOld];
    sortForBell(input);
    expect(input.map((m) => m.id)).toEqual(["old", "crit"]);
  });
});

describe("the badge", () => {
  it("says nothing when there is nothing", () => {
    expect(badgeCount(0)).toBeNull();
    expect(badgeCount(-1)).toBeNull();
  });

  it("counts what there is", () => {
    expect(badgeCount(1)).toBe("1");
    expect(badgeCount(99)).toBe("99");
  });

  /** Two characters of room. A person with 247 unread needs to open the list, not read the figure. */
  it("caps rather than overflowing", () => {
    expect(badgeCount(100)).toBe("99+");
    expect(badgeCount(4_000)).toBe("99+");
  });
});

describe("a message always has something to show as its heading", () => {
  it("uses the subject", () => {
    expect(titleFor(message({ subject: "Result ready: CBC" }))).toBe("Result ready: CBC");
  });

  /** The subject is editable and a hospital can save an empty one; a blank row looks like a fault. */
  it("falls back to the template key when the hospital blanked the subject", () => {
    expect(titleFor({ subject: "   ", templateKey: "order.critical" })).toBe("Order critical");
    expect(titleFor({ templateKey: "appointment.reminder" })).toBe("Appointment reminder");
  });
});

/**
 * The surfaces must CONSUME the shared rules. An inline copy in one of them is how two screens
 * come to disagree about which alert is critical — the same failure the payment hold had, where
 * two comments in one file said opposite things.
 */
describe("both surfaces use the shared rules", () => {
  const BELL = readFileSync(join(__dirname, "..", "components/AlertBell.tsx"), "utf8");
  const PAGE = readFileSync(join(__dirname, "..", "app/alerts/page.tsx"), "utf8");

  it("the bell imports them", () => {
    expect(BELL).toMatch(/from "\.\.\/lib\/alerts"/);
    expect(BELL).toMatch(/sortForBell\(/);
    expect(BELL).toMatch(/badgeCount\(/);
  });

  it("the page imports them", () => {
    expect(PAGE).toMatch(/from "\.\.\/\.\.\/lib\/alerts"/);
    expect(PAGE).toMatch(/toneFor\(/);
    expect(PAGE).toMatch(/isUnread\(/);
  });

  /**
   * One request serves the badge and the preview: under `unread=true` the page meta's `total` IS
   * the unread count. A second call to count would be a wasted round trip on every page load.
   */
  it("the bell asks once, with the filter that makes the count free", () => {
    expect(BELL).toMatch(/myNotifications\(\{\s*unread:\s*true/);
    expect(BELL).toMatch(/meta\.total/);
  });

  /** The page keeps the server's chronological order — sorting it would make "when" unreadable. */
  it("the page does not re-sort the server's order", () => {
    expect(PAGE).not.toMatch(/sortForBell/);
  });
});
