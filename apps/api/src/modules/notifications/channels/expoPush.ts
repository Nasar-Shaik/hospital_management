/**
 * The push transport — Expo's push service (M4).
 *
 * ── WHY THIS IS NOT A `Channel` ─────────────────────────────────────────────
 * A `Channel` competes for the ledger row. `dedupeKey` is unique per tenant (migration 0011), so
 * a template delivered on two channels collides on `one_message_per_cause` and the second is
 * silently dropped as a duplicate — the problem COMMUNICATION_POLICY records for email-plus-inapp.
 *
 * Push does not have that problem because it is not a second message. `channels/inapp.ts` already
 * says what it is: *"a phone notification is a push wrapper around one of these rows, not a
 * separate system"*. The in-app row is written, is the delivery, and is authoritative; this
 * carries a knock on the door afterwards. Nothing here writes to the ledger, and a push that never
 * arrives changes nothing about what the doctor sees when they next open the app.
 *
 * ── WHY A FETCH AND NOT `expo-server-sdk` ───────────────────────────────────
 * The SDK's value is chunking, retry and receipt polling. We need the first (thirty lines), have
 * the second already (BullMQ retries the task with exponential backoff), and deliberately do not
 * want the third — receipts are read minutes later and the only actionable one,
 * `DeviceNotRegistered`, already arrives on the ticket. A dependency that duplicates the queue's
 * retry policy inside a job the queue is retrying is a second, disagreeing opinion about failure.
 *
 * ── WHAT AN ERROR HERE MEANS ────────────────────────────────────────────────
 * Throwing means "the transport failed" and the task retries. A per-message ticket error does NOT
 * throw: one dead handset among four must not re-push to the other three. The caller reads the
 * tickets and retires what Expo says is gone.
 */
import { createLogger } from "@medicore/logger";
import type { PushChannelId } from "@medicore/types";
import { env } from "../../../config/env.js";

const logger = createLogger({ service: "expo-push" });

/** Expo's per-request ceiling. Anything longer is refused outright. */
const CHUNK = 100;

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  /** Never displayed by the OS — this is what the app reads on tap. */
  data: Record<string, string>;
  /**
   * `high` gets the message past Android's Doze and iOS's throttling. Used for the one alert that
   * cannot wait; everything else travels `default` so a hospital's routine traffic does not train
   * the OS to deprioritise the urgent one.
   */
  priority: "default" | "high";
  /**
   * Which Android channel presents it (K4-01). Android only — iOS ignores the field.
   *
   * ── PRIORITY IS NOT ENOUGH, WHICH IS THE WHOLE DEFECT ───────────────────
   * `priority` governs DELIVERY: whether FCM wakes a dozing handset. On Android 8+ the
   * INTERRUPTION — sound, heads-up banner, lock-screen visibility — is decided by the channel and
   * by nothing else, and the user owns it from the moment it is created. Sending `high` to a
   * single channel therefore bought delivery speed and left every routine result buzzing exactly
   * like a critical potassium.
   *
   * ── AND IT IS NOT OPTIONAL ──────────────────────────────────────────────
   * Required, not `?`. If a message names a channel the app has not created, Android displays
   * NOTHING — no fallback, no error, an `ok` ticket from Expo either way. Making this optional
   * would let a new call site omit it and lose alerts silently, so the type refuses instead. The
   * ids come from `@medicore/types`, which is also what the app creates.
   */
  channelId: PushChannelId;
}

export type PushTicket =
  | { status: "ok"; to: string }
  /** `error` is Expo's machine-readable reason — `DeviceNotRegistered` is the one we act on. */
  | { status: "error"; to: string; message: string; error?: string };

export interface PushTransportResult {
  tickets: PushTicket[];
}

interface ExpoTicketResponse {
  data?: { status: string; message?: string; details?: { error?: string } }[];
  errors?: { message?: string }[];
}

/** False when an operator has switched push off — the 3am kill switch, same as email's. */
export function isPushEnabled(): boolean {
  return env.PUSH_ENABLED;
}

/**
 * Hands a batch to Expo and returns one ticket per message, in the order given.
 *
 * The ordering matters: the caller maps a ticket back to the device that earned it, and Expo
 * answers positionally. A response whose length does not match the request is therefore a protocol
 * failure rather than a partial success, and is thrown as one.
 */
export async function sendPush(messages: PushMessage[]): Promise<PushTransportResult> {
  const tickets: PushTicket[] = [];

  for (let i = 0; i < messages.length; i += CHUNK) {
    const chunk = messages.slice(i, i + CHUNK);
    const response = await fetch(env.EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        // Optional: only a project with "enhanced security" enabled requires it.
        ...(env.EXPO_ACCESS_TOKEN ? { authorization: `Bearer ${env.EXPO_ACCESS_TOKEN}` } : {}),
      },
      body: JSON.stringify(chunk),
    });

    if (!response.ok) {
      // OUR failure (or Expo's) — retryable, so it throws. A 400 usually means a malformed
      // message, which retrying will not fix; it is still surfaced rather than swallowed,
      // because a silently dropped alert is the failure this milestone exists to remove.
      throw new Error(`expo push responded ${String(response.status)}`);
    }

    const payload = (await response.json()) as ExpoTicketResponse;

    if (payload.errors && payload.errors.length > 0) {
      throw new Error(
        `expo push refused the batch: ${payload.errors.map((e) => e.message ?? "?").join("; ")}`,
      );
    }

    const data = payload.data ?? [];
    if (data.length !== chunk.length) {
      throw new Error(
        `expo push returned ${String(data.length)} tickets for ${String(chunk.length)} messages`,
      );
    }

    chunk.forEach((message, index) => {
      const ticket = data[index];
      if (ticket?.status === "ok") {
        tickets.push({ status: "ok", to: message.to });
        return;
      }
      tickets.push({
        status: "error",
        to: message.to,
        message: ticket?.message ?? "unknown push failure",
        ...(ticket?.details?.error ? { error: ticket.details.error } : {}),
      });
    });
  }

  logger.debug(
    { messages: messages.length, failed: tickets.filter((t) => t.status === "error").length },
    "expo push batch delivered",
  );

  return { tickets };
}
