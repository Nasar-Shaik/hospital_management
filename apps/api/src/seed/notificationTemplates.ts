/**
 * The HMS notification template catalog (Doc 04 §7 `seed/`, BUSINESS_WORKFLOWS §13).
 *
 * ── WHY THE WORDING LIVES HERE AND NOT IN THE NOTIFICATIONS MODULE ──────────
 * PLATFORM_STRATEGY Rule P1: the notifications module notifies "recipients about
 * events", never "patients about appointments". Every clinical word in this product
 * is in THIS file — "Dr", "UHID", "appointment" — precisely so that none of them
 * are in the module that School ERP will inherit. That module renders whatever
 * templates it finds in the tenant's database; this file is what puts hospital
 * templates there. A school seeds fee reminders into the same collection and reuses
 * the engine untouched.
 *
 * ── THESE ARE DEFAULTS, NOT OUR WORDS ────────────────────────────────────────
 * A hospital edits them (`PUT /notifications/templates/:key`), and the moment it
 * does, `isDefault` flips false and this seed will never overwrite it again. The
 * message a patient receives is the hospital's voice, not ours — and a seed that
 * silently reverted their wording on the next deploy would be a genuinely
 * infuriating bug to diagnose.
 *
 * PLAIN TEXT, deliberately. HTML mail means inlined CSS, a text fallback, and a
 * rendering matrix; a hospital appointment reminder needs none of that, and every
 * mail client on earth renders text correctly.
 *
 * ── WHO THE MESSAGE IS FOR DECIDES THE CHANNEL ──────────────────────────────
 * STAFF messages go `inapp`: the recipient has a MediCore login, the ledger row IS the delivery,
 * and nothing needs configuring for it to arrive. PATIENT messages go `email`, because a patient
 * has no login and no app — that is the whole reason `channels/email.ts` exists.
 *
 * `password.reset` is the exception that proves it: the recipient IS staff, and it stays on email
 * because a person who cannot sign in cannot read an in-app inbox. A reset link delivered to the
 * inbox you need the password to open is a locked door with the key inside.
 */
import type { Connection } from "mongoose";
import { createLogger } from "@medicore/logger";
import { runWithContext } from "../core/context/requestContext.js";
import {
  getTemplateModel,
  type NotificationChannel,
} from "../modules/notifications/notification.model.js";

const logger = createLogger({ service: "seed-templates" });

interface TemplateSeed {
  key: string;
  channel: NotificationChannel;
  description: string;
  subject: string;
  body: string;
}

/**
 * Placeholders available to every appointment template: {{name}} {{uhid}}
 * {{doctor}} {{hospital}} {{date}} {{time}} — and {{reason}} on cancellation.
 * The renderer substitutes an unknown placeholder with EMPTY, so a typo produces a
 * bare sentence rather than a patient reading "{{doctr}}".
 */
export const DEFAULT_TEMPLATES: TemplateSeed[] = [
  {
    key: "password.reset",
    channel: "email",
    description: "Sent when a staff member requests a password reset. Carries a single-use link.",
    subject: "Reset your password",
    body: [
      "Hello {{name}},",
      "",
      "We received a request to reset the password on your account.",
      "Open the link below to choose a new one:",
      "",
      "  {{resetUrl}}",
      "",
      "The link is valid for {{validMinutes}} minutes and can be used once.",
      "If you did not ask for this, you can ignore this email — your password stays unchanged.",
    ].join("\n"),
  },
  {
    key: "patient.welcome",
    channel: "email",
    description: "Sent when a patient is registered. Carries their UHID.",
    subject: "Welcome to {{hospital}} — your UHID is {{uhid}}",
    body: [
      "Dear {{name}},",
      "",
      "You are now registered at {{hospital}}.",
      "",
      "Your Unique Hospital ID (UHID) is {{uhid}}.",
      "Please quote it whenever you call or visit — it lets us find your records instantly.",
      "",
      "{{hospital}}",
    ].join("\n"),
  },
  {
    key: "appointment.confirmation",
    channel: "email",
    description: "Sent immediately when an appointment is booked.",
    subject: "Appointment confirmed — {{date}} at {{time}}",
    body: [
      "Dear {{name}},",
      "",
      "Your appointment is confirmed.",
      "",
      "  Doctor:  {{doctor}}",
      "  When:    {{date}} at {{time}}",
      "  UHID:    {{uhid}}",
      "",
      "Please arrive 10 minutes early and bring any previous reports with you.",
      "",
      "{{hospital}}",
    ].join("\n"),
  },
  {
    key: "appointment.reminder",
    channel: "email",
    /**
     * The highest-value message in the product. A reminder that lands is a no-show
     * that does not happen — and an empty slot is revenue the hospital can never
     * recover, because the doctor was paid for that half hour either way.
     */
    description: "Sent 24 hours before an appointment. Skipped if it was cancelled or moved.",
    subject: "Reminder: {{doctor}} tomorrow at {{time}}",
    body: [
      "Dear {{name}},",
      "",
      "This is a reminder of your appointment tomorrow.",
      "",
      "  Doctor:  {{doctor}}",
      "  When:    {{date}} at {{time}}",
      "  UHID:    {{uhid}}",
      "",
      "If you cannot attend, please let us know so we can offer the slot to someone else.",
      "",
      "{{hospital}}",
    ].join("\n"),
  },
  {
    key: "appointment.cancellation",
    channel: "email",
    description: "Sent when an appointment is cancelled.",
    subject: "Appointment cancelled — {{date}} at {{time}}",
    body: [
      "Dear {{name}},",
      "",
      "Your appointment with {{doctor}} on {{date}} at {{time}} has been cancelled.",
      "",
      "{{reason}}",
      "",
      "Please contact us to book another time.",
      "",
      "{{hospital}}",
    ].join("\n"),
  },

  /* ── Orders (ADR-0013 §3) — these go to STAFF, not to patients ───────────── */

  {
    key: "order.result.released",
    /**
     * `inapp`, not `email` — see `order.critical` below for the whole argument. In short: the
     * doctor this is addressed to is a person with a MediCore login, and the ledger row is the
     * delivery. Email needs an SMTP host the hospital may not have configured, and the message is
     * "your report is ready", which is only actionable in the chart anyway.
     */
    channel: "inapp",
    /**
     * "Reports become available automatically to the requesting doctor" — this is
     * the message that makes that sentence true. Placeholders: {{doctorName}}
     * {{patientName}} {{uhid}} {{testName}}.
     *
     * It deliberately carries NO RESULT VALUE. A report is read in the chart, where
     * the reference ranges, the previous results and the rest of the picture are —
     * not in an email a doctor skims on a phone, and not in an inbox that is not
     * covered by the audit log. The message says "it is ready"; the system says what
     * it says.
     */
    description: "Tells the ordering doctor that a result has been released.",
    subject: "Result ready: {{testName}} — {{patientName}}",
    body: [
      "Dear {{doctorName}},",
      "",
      "A result you ordered has been verified and released.",
      "",
      "  Test:     {{testName}}",
      "  Patient:  {{patientName}} (UHID {{uhid}})",
      "",
      "The report is available on the patient's chart.",
      "",
      "{{hospital}}",
    ].join("\n"),
  },
  {
    key: "order.critical",
    channel: "inapp",
    /**
     * ── THE ONLY MESSAGE IN THIS FILE THAT CANNOT WAIT ──────────────────────
     * A potassium of 7.2 stops the heart. This one is sent SYNCHRONOUSLY, inside the
     * request that recorded the result, before verification and long before release
     * (order.service.ts) — it does not go near the outbox, because durable and fast
     * are different promises and the patient only has time for one of them.
     *
     * It DOES carry the value, unlike every other message here. The whole purpose is
     * to make a human act in the next few minutes, and "a critical result is ready,
     * please log in" wastes the minutes that are the point.
     *
     * ── WHY `inapp` AND NOT `email` ─────────────────────────────────────────
     * This template shipped on `email`, and `email.isEnabled()` is
     * `NOTIFY_EMAIL_ENABLED && SMTP_HOST`. On a deployment with no SMTP host — the default — the
     * most urgent message in the product was recorded `suppressed` and reached nobody. Every bit
     * of care around it (sent inline to beat the outbox, deduped per order, its outcome read
     * rather than assumed) was spent delivering to a channel that was switched off.
     *
     * `inapp` cannot be unreachable and needs nothing configured: the ledger row IS the message,
     * and writing it is the delivery (`channels/inapp.ts`). The doctor sees it on the bell the
     * next time they touch a screen, which is the floor this alert never had.
     *
     * ── WHAT THIS COSTS, AND THE DECISION THAT IS STILL OPEN ────────────────
     * A hospital that HAS working SMTP no longer gets this by email, and an email reaches a
     * consultant who is not logged in. The right answer is almost certainly BOTH — and both is
     * not free: `dedupeKey` is unique per tenant, so two channels for one cause collide on
     * `one_message_per_cause` and the second is silently dropped as a duplicate. Doing it
     * properly means the key gains the channel. Written up, with the argument on each side, in
     * `AI_Workflow/docs/COMMUNICATION_POLICY.md` rather than guessed at here.
     *
     * The channel is NOT editable through the API today (`updateTemplate` takes subject, body and
     * enabled). Changing it is a seed value plus a migration, which is how this one moved.
     */
    description: "CRITICAL result. Sent immediately to the ordering doctor, before verification.",
    subject: "CRITICAL RESULT — {{patientName}} — {{testName}}",
    body: [
      "Dear {{doctorName}},",
      "",
      "A CRITICAL result has been recorded for your patient. Please act now.",
      "",
      "  Patient:  {{patientName}} (UHID {{uhid}})",
      "  Test:     {{testName}}",
      "  Result:   {{result}}",
      "",
      "This value has NOT yet been verified by a pathologist. It is being sent to you",
      "immediately because waiting for verification could cost more than it is worth.",
      "",
      "{{hospital}}",
    ].join("\n"),
  },
];

/**
 * Idempotent: inserts what is missing, never overwrites what exists.
 *
 * Safe to run on every provision AND on every migration of an existing hospital —
 * which is how a template added in a later release reaches hospitals that were
 * provisioned before it existed, without touching the three they have rewritten.
 */
export async function seedNotificationTemplates(
  tenantId: string,
  tenantSlug: string,
  connection: Connection,
): Promise<number> {
  return runWithContext(
    { traceId: `seed-templates-${tenantSlug}`, tenantId, tenantSlug, connection },
    async () => {
      const model = getTemplateModel(connection);
      let created = 0;

      for (const template of DEFAULT_TEMPLATES) {
        const result = await model.updateOne(
          { tenantId, key: template.key },
          {
            // ONLY on insert. A hospital that rewrote its welcome message keeps its
            // words; we do not know better than they do what their patients read.
            $setOnInsert: {
              tenantId,
              key: template.key,
              channel: template.channel,
              description: template.description,
              subject: template.subject,
              body: template.body,
              enabled: true,
              isDefault: true,
            },
          },
          { upsert: true },
        );

        if (result.upsertedCount > 0) created++;
      }

      if (created > 0) logger.info({ tenantSlug, created }, "notification templates seeded");
      return created;
    },
  );
}
