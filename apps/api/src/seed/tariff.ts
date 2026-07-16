/**
 * The default tariff (Doc 04 §7 `seed/`).
 *
 * ── THESE ARE DEFAULTS, NOT OUR PRICES ──────────────────────────────────────
 * Every hospital sets its own. This exists so a newly provisioned hospital can be
 * demonstrated the same afternoon instead of needing a data-entry project first, and
 * so an order for `CBC` resolves to *something* rather than silently posting ₹0.
 *
 * Seeded ONLY on insert (`$setOnInsert`), so a hospital that has priced its own CBC
 * keeps its number forever. A seed that reverted a customer's price list on the next
 * deploy would be an infuriating bug to diagnose and an expensive one to have shipped.
 *
 * ── PAISE. ALWAYS PAISE ─────────────────────────────────────────────────────
 * 50000 is ₹500.00. Nothing in the money path is ever a float.
 *
 * ── A GOVERNMENT HOSPITAL GETS THESE PRICES TOO ─────────────────────────────
 * And that is deliberate, not an oversight. `zero_tariff` means the PATIENT is charged
 * ₹0 (`billing.service.ts`), while the tariff still records what the care was worth —
 * which is exactly what the state needs to cost the encounter. Free to the patient is
 * not free to the exchequer.
 */
import type { Connection } from "mongoose";
import { createLogger } from "@medicore/logger";
import { runWithContext } from "../core/context/requestContext.js";
import { getServiceItemModel, type ChargeCategory } from "../modules/billing/billing.model.js";

const logger = createLogger({ service: "seed-tariff" });

interface TariffSeed {
  code: string;
  name: string;
  category: ChargeCategory;
  /** Paise. */
  price: number;
}

export const DEFAULT_TARIFF: TariffSeed[] = [
  // Consultation — `CONSULT_GEN` is the code `billing.consumers.ts` posts on arrival.
  { code: "CONSULT_GEN", name: "General Consultation", category: "consultation", price: 50_000 },
  {
    code: "CONSULT_SPEC",
    name: "Specialist Consultation",
    category: "consultation",
    price: 90_000,
  },
  {
    code: "CONSULT_FOLLOWUP",
    name: "Follow-up Consultation",
    category: "consultation",
    price: 25_000,
  },

  // Laboratory
  { code: "CBC", name: "Complete Blood Count", category: "lab", price: 35_000 },
  { code: "LFT", name: "Liver Function Test", category: "lab", price: 60_000 },
  { code: "RFT", name: "Renal Function Test", category: "lab", price: 60_000 },
  { code: "GLU", name: "Blood Glucose (Fasting)", category: "lab", price: 12_000 },
  { code: "K", name: "Serum Potassium", category: "lab", price: 25_000 },
  { code: "LIPID", name: "Lipid Profile", category: "lab", price: 70_000 },
  { code: "TSH", name: "Thyroid Profile (TSH)", category: "lab", price: 45_000 },
  { code: "URINE_RE", name: "Urine Routine Examination", category: "lab", price: 20_000 },
  { code: "DENGUE_NS1", name: "Dengue NS1 Antigen", category: "lab", price: 80_000 },

  // Radiology
  { code: "XRAY_CHEST_PA", name: "X-ray Chest PA View", category: "radiology", price: 45_000 },
  { code: "XRAY_LIMB", name: "X-ray Limb", category: "radiology", price: 40_000 },
  { code: "USG_ABDOMEN", name: "Ultrasound Abdomen", category: "radiology", price: 120_000 },
  { code: "CT_HEAD", name: "CT Scan Head (Plain)", category: "radiology", price: 350_000 },
  { code: "ECG", name: "ECG (12-lead)", category: "radiology", price: 30_000 },

  // Procedures
  { code: "DRESS", name: "Wound Dressing", category: "procedure", price: 20_000 },
  { code: "INJ", name: "Injection Administration", category: "procedure", price: 10_000 },
  { code: "NEB", name: "Nebulisation", category: "procedure", price: 15_000 },

  // Beds — priced per DAY. The admission module posts one of these each night.
  { code: "BED_GEN", name: "General Ward (per day)", category: "bed", price: 150_000 },
  { code: "BED_SEMI", name: "Semi-private Room (per day)", category: "bed", price: 300_000 },
  { code: "BED_PVT", name: "Private Room (per day)", category: "bed", price: 500_000 },
  { code: "BED_ICU", name: "ICU (per day)", category: "bed", price: 1_200_000 },
];

/** Idempotent: inserts what is missing, never overwrites what a hospital has priced. */
export async function seedTariff(
  tenantId: string,
  tenantSlug: string,
  connection: Connection,
): Promise<number> {
  return runWithContext(
    { traceId: `seed-tariff-${tenantSlug}`, tenantId, tenantSlug, connection },
    async () => {
      const model = getServiceItemModel(connection);
      let created = 0;

      for (const item of DEFAULT_TARIFF) {
        const result = await model.updateOne(
          { tenantId, code: item.code },
          {
            // ONLY on insert. Their price list is theirs.
            $setOnInsert: {
              tenantId,
              code: item.code,
              name: item.name,
              category: item.category,
              price: item.price,
              active: true,
            },
          },
          { upsert: true },
        );
        if (result.upsertedCount > 0) created++;
      }

      if (created > 0) logger.info({ tenantSlug, created }, "tariff seeded");
      return created;
    },
  );
}
