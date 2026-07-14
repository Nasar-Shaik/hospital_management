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
