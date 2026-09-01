/**
 * How the inbox reads a message — the rules, apart from the components that render them.
 *
 * Extracted for the same reason `lib/results.ts` and `lib/payment.ts` are: a rule written inline
 * in JSX cannot be tested without mounting a page, and it acquires a second, slightly different
 * copy the first time another surface needs it. The bell and the inbox page are two surfaces over
 * one list, so that was going to happen here on day one.
 */
import type { InboxMessage } from "@medicore/api-client";

/**
 * How loudly to draw a message.
 *
 * ── WHY THIS READS THE TEMPLATE KEY AND NOT THE BODY ────────────────────────
 * The body is the hospital's words. A hospital rewrites its templates — that is the whole point of
 * `PUT /notifications/templates/:key` — so a rule that looked for "CRITICAL" in the text would
 * quietly stop recognising the most important message in the product the first time somebody
 * translated it or softened the wording. The KEY is ours and does not change.
 */
export type Tone = "critical" | "normal";

/** The one template whose whole purpose is to make somebody act within minutes. */
const CRITICAL_TEMPLATES = new Set(["order.critical"]);

export function toneFor(templateKey: string): Tone {
  return CRITICAL_TEMPLATES.has(templateKey) ? "critical" : "normal";
}

export function isUnread(message: Pick<InboxMessage, "readAt">): boolean {
  return message.readAt === undefined;
}

/**
 * What to show when a message has no subject.
 *
 * Every shipped template has one, but the subject is editable and a hospital can save an empty
 * string. A row with a blank heading looks like a rendering fault; the key, tidied, at least says
 * what kind of message it is.
 */
export function titleFor(message: Pick<InboxMessage, "subject" | "templateKey">): string {
  const subject = message.subject?.trim();
  if (subject) return subject;

  return message.templateKey
    .split(".")
    .join(" ")
    .replace(/^./, (c) => c.toUpperCase());
}

/**
 * Sorts what the bell shows: critical first, then newest.
 *
 * The server returns newest-first, which is right for the full inbox and wrong for a five-row
 * dropdown — a critical potassium from this morning must not be pushed out of the preview by four
 * routine results that came back since. The full page keeps the server's order, because there a
 * chronological list is what a person is reading.
 */
export function sortForBell(messages: InboxMessage[]): InboxMessage[] {
  return [...messages].sort((a, b) => {
    const byTone =
      Number(toneFor(b.templateKey) === "critical") - Number(toneFor(a.templateKey) === "critical");
    if (byTone !== 0) return byTone;
    return Date.parse(b.createdAt) - Date.parse(a.createdAt);
  });
}

/**
 * The number on the badge. Capped, because the badge is a dot with room for two characters and
 * "247" either overflows it or shrinks the type to something nobody can read. A person with more
 * than 99 unread alerts does not need the exact figure; they need to open the list.
 */
export function badgeCount(unread: number): string | null {
  if (unread <= 0) return null;
  return unread > 99 ? "99+" : String(unread);
}
