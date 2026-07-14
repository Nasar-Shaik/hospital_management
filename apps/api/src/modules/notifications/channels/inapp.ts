/**
 * The in-app channel — and the reason it is the DEFAULT one for staff.
 *
 * ── THE DELIVERY IS THE ROW ─────────────────────────────────────────────────
 * Every other channel hands a message to a system that can lose it: SMTP can
 * refuse, a phone can be off, a gateway can bill you and drop it anyway. In-app has
 * no such gap. The ledger row IS the message — writing it and delivering it are the
 * same act, in the same database, in one write. There is nothing to retry, nothing
 * to bounce, and no provider to pay.
 *
 * That is why this channel cannot return `unreachable`: a staff member always has
 * an id, and an id is the only address this channel needs. Compare `email.ts`, where
 * half the code exists to cope with a patient who never gave us an address.
 *
 * ── WHO IT IS FOR ────────────────────────────────────────────────────────────
 * STAFF. Doctors, the front desk, the superintendent — people who are already
 * logged into MediCore, and for whom a badge in the corner of the screen beats an
 * email they will read tomorrow. It is also what the mobile app will read: a phone
 * notification is a push wrapper around one of these rows, not a separate system.
 *
 * PATIENTS cannot be reached this way. They have no app and no login, which is
 * exactly why `email.ts` exists and why the appointment reminder still goes out by
 * mail. A channel that could not reach the patient is not a channel that can carry
 * the highest-value message in the product.
 *
 * ── REAL TIME ────────────────────────────────────────────────────────────────
 * The inbox is polled today (GET /notifications/me). ADR-0008 accepts Socket.IO as
 * the push transport, and this is the one place it will hook in — when chat lands
 * and there is a live socket per user, this send() gains one line that emits to that
 * user's room. The row is still written first: a socket is a delivery optimization,
 * never the record. A message that exists only in a socket frame is a message that
 * did not survive the user's train going into a tunnel.
 */
import { registerChannel, type Channel, type OutboundMessage, type SendResult } from "./channel.js";

const inAppChannel: Channel = {
  name: "inapp",

  // Always on. There is no transport to configure and no provider to be down —
  // switching it off would only mean refusing to write a row we have already
  // decided to write.
  isEnabled: () => true,

  send(_message: OutboundMessage): Promise<SendResult> {
    // Nothing to do. The service already claimed the ledger row, and that row is
    // the message: the user's inbox is a query over `notifications`, not a copy of
    // one. Marking it `sent` (which the service does next) is the delivery.
    return Promise.resolve({ status: "sent" });
  },
};

registerChannel(inAppChannel);
