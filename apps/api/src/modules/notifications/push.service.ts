/**
 * Push delivery (M4) — the knock on the door after the message is already safe.
 *
 * ── THE ORDER OF OPERATIONS, AND WHY PUSH IS LAST ───────────────────────────
 *   1. the in-app row is claimed, rendered and marked `sent`   ← the message. Authoritative.
 *   2. `push.deliver` is queued for it                          ← this file. Best effort.
 *
 * Everything about that order is deliberate. The ledger row is written inside the act that caused
 * it, and it is what the doctor sees whenever they next open the app — on a dead battery, a lost
 * handset, a phone with notifications denied, or an Expo outage, the alert is still there. Push is
 * the difference between "they will see it" and "they will see it NOW", which is worth a great
 * deal for a critical potassium and is worth nothing if buying it costs the record.
 *
 * So this runs on the task queue, off the request path: `order.critical` is sent SYNCHRONOUSLY
 * inside the request that recorded the result (order.service.ts), and an HTTP call to Expo inside
 * that request would put a third-party's latency between a technician and a saved critical value.
 * The queue gives it retries, exponential backoff and a DLQ for free (taskQueue.ts).
 *
 * ── WHAT THE LOCK SCREEN IS ALLOWED TO SAY ──────────────────────────────────
 * NOT the rendered subject or body, which is the obvious implementation and the wrong one. The
 * in-app subject for the most urgent template reads "CRITICAL RESULT — Kamala Devi — Serum
 * Potassium": a name, a test and a diagnosis-shaped fact, displayed by the OS on a locked handset
 * lying face-up on a desk, to anyone walking past.
 *
 * The push therefore carries a fixed, identifier-free line per template — what happened, never who
 * — and the identifiers ride in `data`, which the OS does not display. The app reads the real
 * message from the ledger after unlock, which it had to do anyway because the row is the record.
 * A template nobody has classified falls through to the generic line, so the failure mode of
 * forgetting one is silence about the patient rather than disclosure.
 */
import { createLogger } from "@medicore/logger";
import { PUSH_CHANNEL, type PushChannelId } from "@medicore/types";
import { getContext } from "../../core/context/requestContext.js";
import { isPushEnabled, sendPush, type PushMessage } from "./channels/expoPush.js";
import * as devices from "./device.repository.js";
import * as repo from "./notification.repository.js";

const logger = createLogger({ service: "push" });

/** The task name. Registered in `notifications/index.ts`, scheduled by `notification.service.ts`. */
export const PUSH_TASK = "push.deliver";

/** What a locked screen may show, per template. Identifier-free by construction. */
interface PushCopy {
  title: string;
  body: string;
  urgent?: boolean;
}

const COPY: Record<string, PushCopy> = {
  "order.critical": {
    title: "Critical result",
    body: "A critical result needs you now. Open MediCore.",
    urgent: true,
  },
  "order.result.released": {
    title: "Result ready",
    body: "A result you ordered has been released.",
  },
};

const FALLBACK: PushCopy = { title: "MediCore", body: "You have a new alert." };

export function copyFor(templateKey: string): PushCopy {
  return COPY[templateKey] ?? FALLBACK;
}

/**
 * Which Android channel presents this template (K4-01).
 *
 * ── ONE FACT, TWO CONSEQUENCES ──────────────────────────────────────────────
 * `urgent` on the copy above is the single place a template is called clinically urgent, and it
 * now decides BOTH how the message travels (`priority`, which is about Doze) and how it arrives
 * (the channel, which is about interrupting a human). Deriving them separately is how they come
 * to disagree — and the disagreement that matters is a critical result routed to a quiet channel,
 * which looks exactly like a phone that never rang.
 *
 * A named function rather than a ternary inline in `deliver`, for the same reason `shouldPush` is
 * one: the integration suite can prove a message went out with a channel on it, but only a pure
 * predicate can be falsified cheaply in every direction — including the direction that matters
 * most, which is "would this still pass if both mapped to the same channel". See
 * `notificationChannels.test.ts`.
 *
 * An unclassified template is not urgent, so it lands on the routine channel. That matches the
 * copy fallback ("You have a new alert"): forgetting to classify a template costs a quiet
 * notification, never a false alarm at 3am.
 */
export function channelFor(templateKey: string): PushChannelId {
  return copyFor(templateKey).urgent ? PUSH_CHANNEL.critical : PUSH_CHANNEL.routine;
}

/**
 * Whether a delivered message earns a knock on a phone.
 *
 * ── WHY THIS IS A NAMED PREDICATE AND NOT AN `if` ───────────────────────────
 * Because the `if` could not be falsified. It lives on the path after `markSent`, and the only
 * non-`inapp` template in the product goes out by email — which, on any machine without an SMTP
 * host, is `suppressed` before it ever gets there. A test aimed at the rule was therefore passing
 * for a reason that had nothing to do with the rule, and would have gone on passing if the rule
 * were deleted. Pulling it out makes the claim checkable on its own terms.
 *
 * `inapp` is the right predicate rather than "is the recipient staff": that channel carries the
 * staff messages precisely BECAUSE only staff have logins, so a patient — no app, no login, no
 * device row — is excluded by construction rather than by a check somebody has to remember.
 */
export function shouldPush(channel: string, recipientId?: string): boolean {
  return channel === "inapp" && Boolean(recipientId);
}

/**
 * Delivers one notification to every handset its recipient is currently reachable on.
 *
 * Idempotent by consequence rather than by a key: the task is scheduled with
 * `jobId: push-<notificationId>`, so BullMQ refuses a duplicate schedule, and a RETRY that
 * re-pushes is the correct behaviour — a second buzz for an alert that did not arrive beats a
 * silent one that did not either.
 *
 * Throws only on a transport failure, which is the queue's signal to retry. Everything that
 * cannot be fixed by trying again — no such row, nobody to reach, a handset Expo says is gone —
 * is recorded and returns, for exactly the reason `notify()` gives.
 */
export async function deliver(data: Record<string, unknown>): Promise<void> {
  if (!isPushEnabled()) {
    logger.debug({ data }, "push is switched off by an operator — nothing sent");
    return;
  }

  const notificationId = typeof data.notificationId === "string" ? data.notificationId : undefined;
  if (!notificationId) {
    // A malformed job. Retrying re-reads the same malformed job, so it is logged and dropped.
    logger.error({ data }, "push task without a notificationId — dropped");
    return;
  }

  const notification = await repo.findById(notificationId);
  if (!notification?.recipientId) {
    logger.info({ notificationId }, "nothing to push — no such message, or nobody to reach");
    return;
  }

  const handsets = await devices.listActiveFor(notification.recipientId);
  if (handsets.length === 0) {
    // The overwhelmingly common case: a doctor who has never opened the phone app. The in-app
    // row is already delivered, so this is not a failure of anything.
    logger.debug({ notificationId }, "recipient has no registered device");
    return;
  }

  const copy = copyFor(notification.templateKey);
  const messages: PushMessage[] = handsets.map((handset) => ({
    to: handset.token,
    title: copy.title,
    body: copy.body,
    priority: copy.urgent ? "high" : "default",
    channelId: channelFor(notification.templateKey),
    data: {
      notificationId,
      templateKey: notification.templateKey,
      ...(notification.resourceType ? { resourceType: notification.resourceType } : {}),
      ...(notification.resourceId ? { resourceId: notification.resourceId } : {}),
      ...(notification.branchId ? { branchId: notification.branchId } : {}),
    },
  }));

  const { tickets } = await sendPush(messages);

  const delivered: string[] = [];
  for (const ticket of tickets) {
    if (ticket.status === "ok") {
      delivered.push(ticket.to);
      continue;
    }

    /**
     * ── THE ONE TICKET ERROR WORTH ACTING ON ──────────────────────────────
     * The app was uninstalled, or the OS rotated the token. Expo will refuse this address
     * forever, so leaving it active means every future alert for this person pays for a
     * guaranteed failure — and, worse, a batch that is entirely dead looks identical to a transport
     * outage, which is what would make a real outage invisible. Retire it here, on the
     * transport's own word.
     */
    if (ticket.error === "DeviceNotRegistered") {
      await devices.deactivateToken(ticket.to, "expo: DeviceNotRegistered");
      logger.info({ notificationId }, "device token retired — expo says it is gone");
      continue;
    }

    logger.warn(
      { notificationId, err: ticket.message, code: ticket.error },
      "push ticket failed for one device",
    );
  }

  await devices.touch(delivered);

  /**
   * A batch in which EVERY message failed for a reason that was not "this handset is gone" is a
   * transport problem wearing per-message clothing (Expo rate-limiting, a credentials fault). It
   * throws so the queue retries; a partial failure does not, because retrying would re-push to
   * the handsets that already buzzed.
   */
  const retriable = tickets.filter(
    (t) => t.status === "error" && t.error !== "DeviceNotRegistered",
  );
  if (retriable.length > 0 && retriable.length === tickets.length) {
    throw new Error(`every push failed for notification ${notificationId}`);
  }

  logger.info(
    { notificationId, devices: messages.length, delivered: delivered.length },
    "push delivered",
  );
}

/**
 * Registers this handset to the caller. The route's whole body.
 *
 * The recipient is the SESSION, never a parameter — the same rule as the inbox itself. A
 * `userId` in the body would let any signed-in user point somebody else's alerts at their own
 * phone, which is the one way this feature could leak a hospital's clinical traffic.
 */
export async function registerDevice(input: {
  token: string;
  platform: "ios" | "android";
}): Promise<devices.Device> {
  const userId = getContext().userId;
  if (!userId) throw new Error("no session — device registration requires an authenticated user");
  return devices.register({ userId, token: input.token, platform: input.platform });
}

/** Retires one of the caller's own handsets. Returns false when they had no such device. */
export async function releaseDevice(id: string, reason = "signed-out"): Promise<boolean> {
  const userId = getContext().userId;
  if (!userId) return false;
  return devices.deactivate({ id, userId, reason });
}

/** The caller's own handsets. */
export async function listOwnDevices(): Promise<devices.Device[]> {
  const userId = getContext().userId;
  if (!userId) return [];
  return devices.listFor(userId);
}

export type { Device } from "./device.repository.js";
