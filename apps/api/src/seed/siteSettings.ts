/**
 * Seeds a hospital's public website at provisioning, so it has a presentable page from birth.
 *
 * `$setOnInsert` only: this writes a STARTER site the first time and never again. The moment an
 * admin edits their page, that is their content — re-running provisioning (or a repair script)
 * must not stamp the marketing copy back to the default. A hospital that has never touched the
 * editor still renders fine because the service composes over defaults; the seed simply gives
 * them something concrete to edit rather than a blank form.
 */
import type { Connection } from "mongoose";
import { createLogger } from "@medicore/logger";
import { runWithContext } from "../core/context/requestContext.js";
import { getSiteSettingsModel } from "../modules/site/site.model.js";

const logger = createLogger({ service: "seed-site" });

export async function seedSiteSettings(
  tenantId: string,
  tenantSlug: string,
  connection: Connection,
  hospitalName: string,
): Promise<boolean> {
  return runWithContext(
    { traceId: `seed-site-${tenantSlug}`, tenantId, tenantSlug, connection },
    async () => {
      const model = getSiteSettingsModel(connection);

      const result = await model.updateOne(
        { tenantId },
        {
          $setOnInsert: {
            tenantId,
            branding: { displayName: hospitalName },
            tagline: "Compassionate, expert care — close to home.",
            about:
              `${hospitalName} brings together experienced clinicians, modern facilities and a ` +
              `commitment to putting patients first. From emergencies to routine check-ups, our ` +
              `teams are here to help — every hour of every day.`,
            services: [
              {
                name: "24/7 Emergency",
                description: "Round-the-clock casualty and trauma care.",
                icon: "emergency",
              },
              {
                name: "Outpatient (OPD)",
                description: "Consult our specialists across departments.",
                icon: "stethoscope",
              },
              {
                name: "Diagnostics & Lab",
                description: "Pathology and imaging under one roof.",
                icon: "flask",
              },
              {
                name: "Pharmacy",
                description: "In-house pharmacy for your prescriptions.",
                icon: "pill",
              },
              {
                name: "Inpatient Care",
                description: "Comfortable wards and dedicated nursing.",
                icon: "bed",
              },
              {
                name: "Surgery",
                description: "Modern operating theatres and expert surgeons.",
                icon: "scalpel",
              },
            ],
            stats: [
              { label: "Emergency care", value: "24/7" },
              { label: "Specialities", value: "20+" },
              { label: "Expert clinicians", value: "50+" },
            ],
            contact: { hoursText: "OPD 8:00am – 8:00pm · Emergency 24/7" },
            published: true,
          },
        },
        { upsert: true },
      );

      const created = result.upsertedCount > 0;
      if (created) logger.info({ tenantSlug }, "site settings seeded");
      return created;
    },
  );
}
