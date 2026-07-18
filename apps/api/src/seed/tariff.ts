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
  // The fast-track surcharge, added on top of the consultation for an express OP visit.
  {
    code: "CONSULT_EXPRESS",
    name: "Express OP Surcharge",
    category: "consultation",
    price: 20_000,
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

  /**
   * Drugs — priced PER UNIT (per tablet, per ml, per vial).
   *
   * ── PER UNIT, BECAUSE THE PHARMACY BILLS WHAT IT HANDED OVER ────────────────
   * The charge posted at dispense multiplies this by the quantity that actually crossed
   * the counter (`billing.consumers.ts`), so a patient given 6 of their 10 prescribed
   * tablets pays for 6. A price per strip or per box could not express that, and the
   * partial handover — the pharmacy has run out, come back Thursday — is the normal case,
   * not the edge one.
   *
   * ── THIS IS A DEMO DRUG LIST, NOT A DRUG MASTER ─────────────────────────────
   * A real one carries generic and brand names, strengths, forms, schedules (H/H1/X),
   * batches, expiry and HSN codes for GST. This is fifteen common Indian OPD drugs so the
   * counter can be demonstrated the same afternoon. The codes are what `orders.code` and
   * `charges.code` join on, so they are stable even though the list is not.
   */
  { code: "DRUG_PARA_500", name: "Paracetamol 500mg Tablet", category: "pharmacy", price: 150 },
  { code: "DRUG_AMOX_500", name: "Amoxicillin 500mg Capsule", category: "pharmacy", price: 800 },
  { code: "DRUG_AZITH_500", name: "Azithromycin 500mg Tablet", category: "pharmacy", price: 2_500 },
  { code: "DRUG_PAN_40", name: "Pantoprazole 40mg Tablet", category: "pharmacy", price: 700 },
  { code: "DRUG_CETI_10", name: "Cetirizine 10mg Tablet", category: "pharmacy", price: 200 },
  { code: "DRUG_ORS", name: "ORS Sachet", category: "pharmacy", price: 1_800 },
  { code: "DRUG_METF_500", name: "Metformin 500mg Tablet", category: "pharmacy", price: 250 },
  { code: "DRUG_AMLO_5", name: "Amlodipine 5mg Tablet", category: "pharmacy", price: 180 },
  { code: "DRUG_ATOR_10", name: "Atorvastatin 10mg Tablet", category: "pharmacy", price: 400 },
  { code: "DRUG_IBU_400", name: "Ibuprofen 400mg Tablet", category: "pharmacy", price: 220 },
  { code: "DRUG_ONDAN_4", name: "Ondansetron 4mg Tablet", category: "pharmacy", price: 600 },
  {
    code: "DRUG_SALB_INH",
    name: "Salbutamol Inhaler (200 doses)",
    category: "pharmacy",
    price: 18_000,
  },
  { code: "DRUG_INJ_DICLO", name: "Diclofenac 75mg Injection", category: "pharmacy", price: 2_200 },
  { code: "DRUG_INJ_CEFT", name: "Ceftriaxone 1g Injection", category: "pharmacy", price: 4_500 },
  {
    code: "DRUG_IVFLUID_NS",
    name: "Normal Saline 500ml IV Fluid",
    category: "pharmacy",
    price: 4_000,
  },

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
