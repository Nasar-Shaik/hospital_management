/**
 * The email channel — SMTP via nodemailer.
 *
 * ── WHY A DEPENDENCY AT ALL (Guidelines: "never introduce unnecessary libraries")
 * SMTP is a stateful, multi-step protocol with TLS upgrade, authentication
 * mechanisms, line-ending rules, and MIME encoding for anything that is not plain
 * 7-bit ASCII — which includes every patient name with an accent in it. Hand-
 * rolling that is not a saving; it is a second product. nodemailer is the standard
 * Node SMTP client, has no native build step, and is the one library here I would
 * defend on a whiteboard. It stays behind the `Channel` interface, so replacing it
 * with a provider SDK later touches this file and nothing else.
 *
 * ── DEV ─────────────────────────────────────────────────────────────────────
 * Mailhog (infra/docker/docker-compose.yml) accepts anything on :1025 and shows it
 * at http://localhost:8025. Nothing leaves the machine, which is the only
 * acceptable posture for a system whose test fixtures are patient names.
 */
import nodemailer, { type Transporter } from "nodemailer";
import { createLogger } from "@medicore/logger";
import { env } from "../../../config/env.js";
import { registerChannel, type Channel, type OutboundMessage, type SendResult } from "./channel.js";

const logger = createLogger({ service: "notify-email" });

let transporter: Transporter | undefined;

/**
 * Lazy, and cached. Built on first send rather than at import: a pod that never
 * sends an email (a worker-less deploy, a test run) should not open a TCP
 * connection to a mail server to prove it could have.
 */
function getTransport(): Transporter | undefined {
  if (!env.SMTP_HOST) return undefined;
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    ...(env.SMTP_USER && env.SMTP_PASSWORD
      ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } }
      : {}),
  });

  logger.info({ host: env.SMTP_HOST, port: env.SMTP_PORT }, "smtp transport created");
  return transporter;
}

/** Not validation — a gate. An address with no `@` cannot be delivered to, and
 *  handing it to SMTP produces a provider error that looks like an outage. */
function looksDeliverable(address: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);
}

const emailChannel: Channel = {
  name: "email",

  isEnabled: () => env.NOTIFY_EMAIL_ENABLED && Boolean(env.SMTP_HOST),

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!message.to || !looksDeliverable(message.to)) {
      return { status: "unreachable", reason: "recipient has no valid email address" };
    }

    const transport = getTransport();
    if (!transport) {
      // Not a throw: a machine with no mail server configured is a degraded
      // pipeline, not a broken one. The message is recorded and life goes on.
      return { status: "unreachable", reason: "no SMTP host configured" };
    }

    // A throw here is deliberate — it is what makes BullMQ retry the job.
    await transport.sendMail({
      from: env.MAIL_FROM,
      to: message.recipientName ? `${message.recipientName} <${message.to}>` : message.to,
      subject: message.subject ?? "",
      text: message.body,
    });

    return { status: "sent" };
  },
};

registerChannel(emailChannel);

/** Test seam: drop the cached transport so a new SMTP config takes effect. */
export function resetEmailTransport(): void {
  transporter = undefined;
}
