/**
 * The channel contract.
 *
 * A channel knows how to put a rendered message in front of a human. It knows
 * NOTHING about templates, dedupe, the ledger, or why the message is being sent —
 * those belong to the service. This is the seam that makes SMS a new file rather
 * than a refactor.
 *
 * ── THE THREE OUTCOMES, AND WHY THEY ARE NOT TWO ────────────────────────────
 * A channel does not return a boolean, because "it didn't go" has two completely
 * different causes and they need opposite responses:
 *
 *   sent        → delivered to the provider.
 *   unreachable → the recipient has no address on this channel. NOT AN ERROR.
 *                 Retrying cannot help; a patient with no email will still have no
 *                 email in five minutes. The hospital fixes this by collecting the
 *                 address, and nobody should be woken up for it.
 *   throw       → the provider failed (refused, timed out, credentials wrong).
 *                 This IS an error, the job retries, and if it keeps failing an
 *                 operator needs to know.
 *
 * Collapsing `unreachable` into a failure is how a queue fills with permanently
 * doomed retries and a real outage gets lost in the noise.
 */
export interface OutboundMessage {
  to: string;
  subject?: string;
  body: string;
  recipientName?: string;
}

export type SendResult = { status: "sent" } | { status: "unreachable"; reason: string };

export interface Channel {
  readonly name: string;
  /** False when the channel has no transport configured, or an operator switched it off. */
  isEnabled(): boolean;
  /** Throws on provider failure — the caller turns that into a retry. */
  send(message: OutboundMessage): Promise<SendResult>;
}

const registry = new Map<string, Channel>();

export function registerChannel(channel: Channel): void {
  registry.set(channel.name, channel);
}

export function getChannel(name: string): Channel | undefined {
  return registry.get(name);
}
