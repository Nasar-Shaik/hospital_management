/**
 * Notification service (Doc 02 A6) — render, dedupe, deliver, record.
 *
 * ONE public door: `notify()`. Callers describe WHO and WHICH TEMPLATE and WHAT
 * DATA; they never touch a channel, a transport, or the ledger. That is what lets
 * this module be handed to a School ERP intact — and what keeps the word "patient"
 * out of it (PLATFORM_STRATEGY Rule P1).
 *
 * ── THE ORDER OF OPERATIONS IS THE DESIGN ────────────────────────────────────
 *   1. resolve the template   (missing/disabled → recorded, not thrown)
 *   2. render
 *   3. CLAIM the dedupe key   ← the database arbitrates; a duplicate stops here
 *   4. send
 *   5. record the outcome
 *
 * Claiming BEFORE sending, never after: the row is the evidence that we are about
 * to try. Send-then-record loses the message on a crash in between and has no way
 * of ever knowing it did.
 */
import { createLogger } from "@medicore/logger";
import { env } from "../../config/env.js";
import { getChannel } from "./channels/channel.js";
import { renderTemplate } from "./notification.model.js";
import * as repo from "./notification.repository.js";

// Registers the channels. The registry is populated by import side effect, so
// these are load-bearing — they are not unused imports.
//
// `inapp` has no template pointing at it yet: patients have no app, and every
// message A6 sends today is patient-facing. It is registered because the STAFF
// inbox and the WhatsApp-style staff chat are the next milestone, and they deliver
// through this same door — the ledger row IS the message (see channels/inapp.ts).
import "./channels/email.js";
import "./channels/inapp.js";

const logger = createLogger({ service: "notifications" });

export interface Recipient {
  /** Where to reach them on the chosen channel. Empty is legal — see `unreachable`. */
  address?: string;
  name?: string;
  /** For the ledger's "show me everything we sent this person" query. */
  type?: string;
  id?: string;
}

export interface NotifyInput {
  templateKey: string;
  recipient: Recipient;
  /** Substituted into `{{placeholders}}`. Strings only — a template is text. */
  data: Record<string, string>;
  /**
   * The idempotency key. REQUIRED, and deliberately so.
   *
   * There is no sensible default: only the caller knows what would make this
   * message "the same message" on a redelivery. Making it optional would mean
   * every caller who forgot it gets duplicate sends, discovered by a patient.
   */
  dedupeKey: string;
  branchId?: string;
  eventId?: string;
}

/**
 * NOTE: there is no `channel` parameter, on purpose.
 *
 * THE TEMPLATE DECIDES THE CHANNEL. A caller that could override it would let the
 * appointments module decide to SMS a patient who has only ever agreed to email —
 * a consent decision made in the wrong place, by code that does not know what the
 * patient consented to. The hospital picks the channel when it configures the
 * template; the domain only says what happened.
 */

export type NotifyOutcome = "sent" | "duplicate" | "unreachable" | "suppressed" | "failed";

/**
 * Sends one message, exactly once, and records what happened either way.
 *
 * Throws ONLY when the provider fails — that is the signal the caller (a queue
 * handler) turns into a retry. Everything else that could go wrong (no template,
 * template disabled, no address, channel switched off) is a RECORDED outcome, not
 * an exception: none of them get better by trying again, and a queue that retries
 * them forever is a queue nobody reads.
 */
export async function notify(input: NotifyInput): Promise<NotifyOutcome> {
  const template = await repo.findTemplate(input.templateKey);
  if (!template) {
    // A missing template is a BUG (a caller named one that was never seeded), and
    // it is logged as one. It is not thrown, because throwing would retry it five
    // times and then bury it in a DLQ — the message is never going to render, and
    // the loud log is what actually gets it fixed.
    logger.error(
      { templateKey: input.templateKey, dedupeKey: input.dedupeKey },
      "no such notification template — nothing was sent",
    );
    return "failed";
  }

  const channel = getChannel(template.channel);
  if (!channel) {
    logger.error({ channel: template.channel }, "no such channel — nothing was sent");
    return "failed";
  }

  // Trimmed: a placeholder that renders empty must not leave "Reminder: " with a
  // dangling space in the patient's subject line.
  const rendered = template.subject ? renderTemplate(template.subject, input.data).trim() : "";
  const subject = rendered.length > 0 ? rendered : undefined;
  const body = renderTemplate(template.body, input.data);

  const claimed = await repo.claim({
    dedupeKey: input.dedupeKey,
    templateKey: input.templateKey,
    channel: template.channel,
    body,
    // Absent when the recipient has no address on this channel. The row is still
    // written — that is what `unreachable` means, and it is the record the hospital
    // uses to go and collect the address.
    ...(input.recipient.address ? { to: input.recipient.address } : {}),
    ...(subject ? { subject } : {}),
    ...(input.recipient.name ? { recipientName: input.recipient.name } : {}),
    ...(input.recipient.type ? { recipientType: input.recipient.type } : {}),
    ...(input.recipient.id ? { recipientId: input.recipient.id } : {}),
    ...(input.branchId ? { branchId: input.branchId } : {}),
    ...(input.eventId ? { eventId: input.eventId } : {}),
  });

  /** Already delivered (or already given up on). THE dedupe. */
  if (claimed.kind === "settled") {
    logger.debug(
      { dedupeKey: input.dedupeKey, templateKey: input.templateKey, was: claimed.status },
      "notification already settled — skipping duplicate",
    );
    return "duplicate";
  }

  /**
   * Another sender holds a live lease. THROW rather than return.
   *
   * Returning would report a success we did not achieve: the job completes, nothing
   * retries, and if that other sender turns out to be dead the message is lost
   * silently. Throwing costs one retry in the common case — by which time the row is
   * `sent` and we skip cleanly — and recovers the message in the uncommon one.
   */
  if (claimed.kind === "inFlight") {
    throw new Error(
      `notification ${input.dedupeKey} is being sent by another handler — retrying later`,
    );
  }

  const notification = claimed.notification;

  // The hospital turned this message off. Recorded, not sent — an admin who
  // disabled "appointment confirmations" should still be able to see that one
  // would have gone to Mrs Rao at 14:05.
  if (!template.enabled) {
    await repo.markOutcome(notification.id, "suppressed", "template is disabled");
    return "suppressed";
  }

  // The operator turned the CHANNEL off (or it was never configured). Same
  // treatment, different reason — and the ledger distinguishes them.
  if (!channel.isEnabled()) {
    const reason = env.NOTIFY_EMAIL_ENABLED
      ? `channel "${template.channel}" has no transport configured`
      : `channel "${template.channel}" is switched off by an operator`;
    await repo.markOutcome(notification.id, "suppressed", reason);
    return "suppressed";
  }

  try {
    const result = await channel.send({
      to: notification.to ?? "",
      body,
      ...(subject ? { subject } : {}),
      ...(input.recipient.name ? { recipientName: input.recipient.name } : {}),
    });

    if (result.status === "unreachable") {
      // The hospital's data problem, not ours. Recorded so they can fix it; never
      // retried, because it cannot succeed.
      await repo.markOutcome(notification.id, "unreachable", result.reason);
      logger.info(
        { templateKey: input.templateKey, recipientId: input.recipient.id, why: result.reason },
        "notification not deliverable — recipient has no address on this channel",
      );
      return "unreachable";
    }

    await repo.markSent(notification.id);
    logger.info(
      { templateKey: input.templateKey, channel: template.channel, to: notification.to },
      "notification sent",
    );
    return "sent";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await repo.markOutcome(notification.id, "failed", message);

    // Rethrow: OUR failure, and the queue's retry is the correct response. The
    // ledger row is already `failed`, so a retry updates it rather than adding a
    // second row — the dedupe key sees to that.
    logger.error({ templateKey: input.templateKey, err: message }, "notification send failed");
    throw err;
  }
}

export const listNotifications = repo.list;
export const listTemplates = repo.listTemplates;
export const updateTemplate = repo.updateTemplate;
export type { Notification, NotificationTemplate } from "./notification.repository.js";
