/**
 * Notifications — the delivery ledger and the template catalog (Doc 02 A6).
 *
 * ── THIS IS A PLATFORM MODULE, AND ITS VOCABULARY IS THE POINT ───────────────
 * PLATFORM_STRATEGY Rule P1: platform modules notify "recipients about events",
 * never "patients about appointments". There is not one clinical word in this
 * module, and that is not fastidiousness — it is the entire School-ERP bet. The
 * day a school sends a fee reminder to a parent, it uses this file unchanged; the
 * word "patient" anywhere in here would make that a rewrite instead of an import.
 *
 * The HMS meaning of a message therefore lives OUTSIDE this module: the
 * appointments module knows that `appointment.booked` deserves a confirmation and
 * a day-before reminder, and it asks this module to deliver one. This module knows
 * only that *someone* wants *some template* rendered and sent to *some recipient*.
 *
 * ── WHY A LEDGER AND NOT JUST A SEND() ──────────────────────────────────────
 * Every message is a row before it is an email. Three reasons, in order of how
 * often they matter:
 *
 *   1. IDEMPOTENCY. Delivery is at-least-once (ADR-0007): the consumer WILL see
 *      `appointment.booked` twice. `dedupeKey` + a unique index is what stops the
 *      patient getting two confirmations — the DATABASE decides, not a check.
 *   2. "Did they get it?" is the single commonest support question in a hospital,
 *      and "the SMTP call returned 250" is not an answer anyone can look up.
 *   3. A suppressed message (kill switch on) is still recorded, so an operator can
 *      see exactly what WOULD have gone out while the switch was down.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { tenantScopePlugin } from "../../core/db/plugins/tenantScope.js";
import { auditPlugin } from "../../core/db/plugins/auditPlugin.js";

/**
 * Channels. Only `email` is implemented (COST_OPTIMIZATION's ladder is
 * push → WhatsApp → SMS, cheapest reachable first — and every one of those needs
 * a paid provider and a business verification we do not have yet).
 *
 * The enum carries the unimplemented ones anyway so the ledger can record what a
 * message *should* have gone out on once a provider exists, and so adding one is
 * a channel implementation rather than a migration.
 */
export const NOTIFICATION_CHANNELS = ["email", "sms", "whatsapp", "push", "inapp"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/**
 * The lifecycle of one message.
 *
 * `unreachable` and `failed` are deliberately different states, and confusing them
 * is how a hospital ends up blaming the software for its own data:
 *
 *   unreachable → WE are fine; the recipient has no address on this channel.
 *                 The fix is to collect the patient's email. Nobody should be paged.
 *   failed      → WE are broken; SMTP refused or timed out.
 *                 The fix is ours, and the job retries.
 *   suppressed  → nothing was wrong; an operator had the channel switched off.
 */
export const NOTIFICATION_STATUSES = [
  "pending",
  "sent",
  "failed",
  "unreachable",
  "suppressed",
] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export interface NotificationDoc {
  _id: Types.ObjectId;
  tenantId: string;
  branchId?: string;

  /** Which template rendered it — the join back to the catalog. */
  templateKey: string;
  channel: NotificationChannel;

  /**
   * Who it went to, denormalized AT SEND TIME.
   *
   * Deliberately a copy, not a reference. A ledger that resolves the address by
   * following a `recipientId` would show today's email next to a message sent to
   * last year's — which is precisely the question the ledger exists to answer
   * ("where did it actually go?"). The recipient ref is kept alongside for search.
   *
   * OPTIONAL, and that is the whole point of `unreachable`. A patient with no email
   * address still gets a row — the row IS the record that we could not reach them,
   * and it is what an admin filters on to go and collect the address. Requiring this
   * field would make the commonest data problem in a hospital unrepresentable.
   */
  to?: string;
  recipientName?: string;
  recipientType?: string;
  recipientId?: string;

  subject?: string;
  body: string;

  /**
   * THE IDEMPOTENCY KEY. Unique per tenant (see migration 0011).
   *
   * Every caller derives this from something stable about the message's CAUSE —
   * `${eventId}:${templateKey}` for an event-driven message, or a natural key like
   * `reminder:{id}:24h` for a scheduled one. Two deliveries of the same event
   * therefore collide on the index and the second one loses.
   */
  dedupeKey: string;

  status: NotificationStatus;
  attempts: number;
  /**
   * When a sender took ownership of this row — a LEASE, not a timestamp.
   *
   * It is what tells a second handler "someone is sending this RIGHT NOW" apart
   * from "someone started sending this and died". Without it those two look
   * identical (both are `pending`), and treating a live sender as a dead one sends
   * the patient two emails. A stale lease is how a crashed sender's work is
   * recovered; a fresh one is how a concurrent duplicate is refused.
   */
  claimedAt?: Date;
  sentAt?: Date;
  /** Why it is not `sent` — the sentence a support agent reads. */
  error?: string;

  /**
   * When the RECIPIENT opened it. Absent means unread — which is what the badge counts.
   *
   * Deliberately not a `read: boolean`. "When" answers a question a boolean cannot: a critical
   * alert that sat unopened for forty minutes is a different event from one read immediately, and
   * that difference is the only evidence anybody will have when the case is reviewed.
   *
   * Only ever set by the person named in `recipientId` (see `markRead`), never by an admin
   * clearing somebody else's inbox — a message marked read by another party is not a message
   * anybody read.
   */
  readAt?: Date;

  /** The event that caused it, when there was one. For tracing a message home. */
  eventId?: string;
  traceId?: string;

  createdAt: Date;
  updatedAt: Date;
}

const notificationSchema = new Schema<NotificationDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String },

    templateKey: { type: String, required: true },
    channel: { type: String, enum: NOTIFICATION_CHANNELS, required: true },

    to: { type: String },
    recipientName: { type: String },
    recipientType: { type: String },
    recipientId: { type: String },

    subject: { type: String },
    body: { type: String, required: true },

    dedupeKey: { type: String, required: true },

    status: { type: String, enum: NOTIFICATION_STATUSES, required: true, default: "pending" },
    attempts: { type: Number, required: true, default: 0 },
    claimedAt: { type: Date },
    sentAt: { type: Date },
    error: { type: String },

    readAt: { type: Date },

    eventId: { type: String },
    traceId: { type: String },
  },
  { timestamps: true, collection: "notifications", autoIndex: false },
);

notificationSchema.plugin(tenantScopePlugin);

/**
 * A notification body contains whatever the template put in it — for a hospital
 * that means a name, a doctor and a time, which is PHI. The ledger is therefore
 * audited as PHI, and `body`/`to` are NOT diffed into the audit trail: an audit
 * entry that copies the message would duplicate the PHI it is meant to police.
 */
notificationSchema.plugin(auditPlugin, {
  resource: "notification",
  category: "phi",
  ignore: ["body", "subject", "to", "attempts"],
});

/**
 * The template catalog. Per tenant, because a hospital rewrites these — the
 * wording of the message a patient receives is the hospital's voice, not ours.
 *
 * Seeded at provisioning with the product's defaults (seed/notificationTemplates.ts,
 * which is where the healthcare wording lives — NOT in this module).
 */
export interface NotificationTemplateDoc {
  _id: Types.ObjectId;
  tenantId: string;
  /** Stable id the calling code uses. Never rendered. */
  key: string;
  channel: NotificationChannel;
  /** What this message is for, in the admin UI. */
  description?: string;
  /** `{{placeholder}}` syntax — see renderTemplate(). */
  subject?: string;
  body: string;
  /**
   * Off means "this hospital does not want this message". The notification is
   * recorded as `suppressed`, never silently dropped: a message that vanishes
   * without trace is indistinguishable from a bug.
   */
  enabled: boolean;
  /** False for hospital-authored templates — the seed will not overwrite those. */
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const notificationTemplateSchema = new Schema<NotificationTemplateDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    key: { type: String, required: true, trim: true },
    channel: { type: String, enum: NOTIFICATION_CHANNELS, required: true, default: "email" },
    description: { type: String, trim: true },
    subject: { type: String, trim: true },
    body: { type: String, required: true },
    enabled: { type: Boolean, required: true, default: true },
    isDefault: { type: Boolean, required: true, default: true },
  },
  { timestamps: true, collection: "notificationTemplates", autoIndex: false },
);

notificationTemplateSchema.plugin(tenantScopePlugin);
// Admin, not PHI: a template is configuration. It holds placeholders, not a
// person — the PHI only exists once one is rendered, which is the ledger's row.
notificationTemplateSchema.plugin(auditPlugin, {
  resource: "notificationTemplate",
  category: "admin",
});

export function getNotificationModel(conn: Connection): Model<NotificationDoc> {
  return (
    (conn.models.Notification as Model<NotificationDoc>) ??
    conn.model<NotificationDoc>("Notification", notificationSchema)
  );
}

export function getTemplateModel(conn: Connection): Model<NotificationTemplateDoc> {
  return (
    (conn.models.NotificationTemplate as Model<NotificationTemplateDoc>) ??
    conn.model<NotificationTemplateDoc>("NotificationTemplate", notificationTemplateSchema)
  );
}

/**
 * `{{name}}` substitution. Deliberately not a template engine.
 *
 * Handlebars/EJS would add a dependency, a compile step and — the reason that
 * actually decides it — arbitrary logic inside a string that a hospital admin can
 * edit through the web UI. A template language is a scripting language, and this
 * one would be scriptable by whoever owns the `notification:manage` permission.
 * Substitution is the whole feature; anything more is an attack surface.
 *
 * An unknown placeholder renders as EMPTY, not as `{{foo}}`: a patient receiving
 * "Your appointment is at {{time}}" is worse than one receiving a slightly bare
 * sentence, and the template editor shows the available variables.
 */
export function renderTemplate(text: string, data: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_match, key: string) => data[key] ?? "");
}
