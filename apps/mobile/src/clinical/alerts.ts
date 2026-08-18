/**
 * How the alerts tab reads a message — the rules, apart from the screen.
 *
 * ── THE SAME SHAPE AS `clinical/results.ts`, ON PURPOSE ─────────────────────
 * That module decides which results need attention and in what order; this one does the same for
 * messages. Both are pure, both are tested in Node with no renderer, and both exist because a rule
 * written inside a `renderItem` cannot be exercised by a test and acquires a second, subtly
 * different copy the moment another surface needs it.
 *
 * The web app has its own copy of these rules in `apps/web/lib/alerts.ts`. That IS a fork, and a
 * deliberate one for now: the two are eight lines each and the shared home for real clinical
 * primitives is `@medicore/api-client` (`marSlotTaken`, `attemptVitals` …), which is reserved for
 * logic where a divergence would be a SAFETY defect. A badge cap that differs by one is not that.
 * If a third surface appears, or these grow past presentation, they move.
 */
import type { InboxMessage } from "@medicore/api-client";

export type AlertTone = "critical" | "normal";

/**
 * Severity comes from the template KEY, never the body.
 *
 * A hospital is invited to rewrite and translate every template
 * (`PUT /notifications/templates/:key`), so a rule that searched the text for "CRITICAL" would
 * silently stop recognising the most urgent message in the product the first time somebody
 * translated it. The key is ours and does not move.
 */
const CRITICAL_TEMPLATES = new Set(["order.critical"]);

export function toneFor(templateKey: string): AlertTone {
  return CRITICAL_TEMPLATES.has(templateKey) ? "critical" : "normal";
}

export function isUnread(message: Pick<InboxMessage, "readAt">): boolean {
  return message.readAt === undefined;
}

/**
 * Critical first, then unread, then newest.
 *
 * The server returns newest-first, which buries a critical potassium from this morning under four
 * routine results that came back since — the same reasoning as `sortForReview` on the results tab,
 * where the band is not a filter the user has to discover.
 *
 * Unread outranks recency for the same reason at a smaller scale: a message you have already read
 * is one you have already acted on, and it should not sit above one you have not.
 */
export function sortAlerts(messages: InboxMessage[]): InboxMessage[] {
  const rank = (m: InboxMessage): number =>
    (toneFor(m.templateKey) === "critical" ? 0 : 2) + (isUnread(m) ? 0 : 1);

  return [...messages].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    return Date.parse(b.createdAt) - Date.parse(a.createdAt);
  });
}
