/**
 * The default formulary — the pharmacy's medicine master, seeded from the pharmacy tariff.
 *
 * ── WHY THIS EXISTS, AND WHAT IT DOES NOT DO ────────────────────────────────
 * The tariff already lists every drug the hospital can dispense (category `pharmacy`); the medicine
 * master adds the pharmacy's own facts about each — its form, strength, and a stock balance. This
 * seed creates a master entry for every pharmacy tariff line, KEYED ON THE SAME CODE, so a drug the
 * doctor prescribes and the pharmacy dispenses is the same object the stock ledger decrements. It
 * is reference data, exactly like the tariff: seeded ONLY on insert (`$setOnInsert`), so a pharmacy
 * that has edited a medicine keeps its version forever.
 *
 * It deliberately seeds ZERO stock. Stock is a TRANSACTION, not reference data — a real hospital's
 * shelf count is something its pharmacist receives, never something a deploy invents. Opening stock
 * for the DEMO hospitals is loaded separately by `seedDemo.ts`, through the real `receiveStock`
 * service, so even the demo's numbers have an honest ledger entry behind them.
 */
import type { Connection } from "mongoose";
import { createLogger } from "@medicore/logger";
import { runWithContext } from "../core/context/requestContext.js";
import { getMedicineModel, type MedicineForm } from "../modules/medicines/medicine.model.js";
import { DEFAULT_TARIFF } from "./tariff.js";

const logger = createLogger({ service: "seed-formulary" });

/** Reads the physical form off the tariff name's last word ("… Tablet", "… Injection"). */
function inferForm(name: string): MedicineForm {
  const n = name.toLowerCase();
  if (n.includes("tablet")) return "tablet";
  if (n.includes("capsule")) return "capsule";
  if (n.includes("injection") || n.includes("inj ") || n.includes("inj.")) return "injection";
  if (n.includes("syrup") || n.includes("suspension")) return "syrup";
  if (n.includes("sachet")) return "sachet";
  if (n.includes("drop")) return "drops";
  if (n.includes("inhaler")) return "inhaler";
  if (n.includes("ointment") || n.includes("cream")) return "ointment";
  return "other";
}

/** Pulls a strength like "500mg", "1g", "5 mg/5 ml" out of the name, if present. */
function inferStrength(name: string): string | undefined {
  const m = name.match(/\d+(?:\.\d+)?\s?(?:mg|mcg|g|ml|iu|%)(?:\s?\/\s?\d+\s?ml)?/i);
  return m ? m[0].replace(/\s+/g, "") : undefined;
}

/** The generic/salt is the name up to the first digit ("Paracetamol 500mg Tablet" → "Paracetamol"). */
function inferGeneric(name: string): string | undefined {
  const head = name.split(/\d/)[0]?.trim();
  return head && head.length > 1 ? head : undefined;
}

/** Idempotent: inserts a master entry for each pharmacy tariff drug, never overwriting an edit. */
export async function seedFormulary(
  tenantId: string,
  tenantSlug: string,
  connection: Connection,
): Promise<number> {
  return runWithContext(
    { traceId: `seed-formulary-${tenantSlug}`, tenantId, tenantSlug, connection },
    async () => {
      const model = getMedicineModel(connection);
      let created = 0;

      for (const item of DEFAULT_TARIFF) {
        if (item.category !== "pharmacy") continue;
        const strength = inferStrength(item.name);
        const generic = inferGeneric(item.name);
        const result = await model.updateOne(
          { tenantId, code: item.code },
          {
            $setOnInsert: {
              tenantId,
              code: item.code,
              name: item.name,
              form: inferForm(item.name),
              ...(strength ? { strength } : {}),
              ...(generic ? { generic } : {}),
              stockUnits: 0,
              reorderLevel: 0,
              active: true,
            },
          },
          { upsert: true },
        );
        if (result.upsertedCount > 0) created++;
      }

      if (created > 0) logger.info({ tenantSlug, created }, "formulary seeded");
      return created;
    },
  );
}
