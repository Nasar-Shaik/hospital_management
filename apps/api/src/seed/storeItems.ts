/**
 * The general store's starter list — the dozen things a hospital store room actually runs out of.
 *
 * ── WHY A STARTER LIST AT ALL ───────────────────────────────────────────────
 * The same reasoning as `labTests.ts` and `icdCodes.ts`: a master that ships empty is a module
 * nobody ever opens twice. A store keeper meeting a blank screen has to invent codes, units and
 * reorder levels for two hundred items before the software does anything for them, and the
 * realistic outcome is that they go back to the register book.
 *
 * ── AND WHY IT IS SHORT ─────────────────────────────────────────────────────
 * Twelve rows, not two hundred. This is a STARTING POINT a hospital edits, not a claim to know
 * what they stock — and a long invented list would be worse than a short one, because it would
 * take longer to weed than to type. Every row is `$setOnInsert`: what a hospital has curated is
 * theirs, and re-running this never overwrites it.
 *
 * ── ZERO STOCK, DELIBERATELY ────────────────────────────────────────────────
 * Stock is a TRANSACTION, not reference data. No shelf row is created here at all: a real
 * hospital's count is something its store keeper receives, never something a deploy invents.
 * Opening stock for the DEMO hospitals is loaded by `seedDemo.ts` through the real `receive`
 * service, so even the demo's numbers have an honest ledger entry behind them. Exactly the rule
 * `formulary.ts` follows for drugs.
 *
 * ── THE REORDER LEVELS ARE A PROMPT, NOT A POLICY ───────────────────────────
 * Roughly a week of a small hospital's use, so the "running low" flag means something on day one.
 * A hospital's real levels depend on its consumption and its supplier's lead time, which is why
 * they are editable on the screen and why nothing in the code treats them as more than a flag.
 */
import type { Connection } from "mongoose";
import { createLogger } from "@medicore/logger";
import { runWithContext } from "../core/context/requestContext.js";
import {
  getInventoryItemModel,
  type ItemCategory,
  type ItemUnit,
} from "../modules/inventory/inventory.model.js";

const logger = createLogger({ service: "seed-store-items" });

interface StarterItem {
  code: string;
  name: string;
  category: ItemCategory;
  unit: ItemUnit;
  reorderLevel: number;
}

export const STARTER_STORE_ITEMS: StarterItem[] = [
  {
    code: "GLOVE-M",
    name: "Examination gloves, medium",
    category: "consumable",
    unit: "box",
    reorderLevel: 20,
  },
  {
    code: "GLOVE-L",
    name: "Examination gloves, large",
    category: "consumable",
    unit: "box",
    reorderLevel: 20,
  },
  {
    code: "SYR-5ML",
    name: "Disposable syringe 5 ml",
    category: "consumable",
    unit: "box",
    reorderLevel: 15,
  },
  {
    code: "IV-SET",
    name: "IV infusion set",
    category: "consumable",
    unit: "piece",
    reorderLevel: 50,
  },
  {
    code: "CANN-20G",
    name: "IV cannula 20G",
    category: "consumable",
    unit: "box",
    reorderLevel: 10,
  },
  {
    code: "GAUZE",
    name: "Sterile gauze swab",
    category: "consumable",
    unit: "pack",
    reorderLevel: 25,
  },
  {
    code: "COTTON",
    name: "Absorbent cotton roll",
    category: "consumable",
    unit: "roll",
    reorderLevel: 12,
  },
  {
    code: "MASK-3PLY",
    name: "Surgical mask, 3-ply",
    category: "consumable",
    unit: "box",
    reorderLevel: 20,
  },
  {
    code: "SPIRIT",
    name: "Surgical spirit",
    category: "consumable",
    unit: "litre",
    reorderLevel: 10,
  },
  { code: "BEDSHEET", name: "Bed sheet", category: "linen", unit: "piece", reorderLevel: 40 },
  {
    code: "OT-DRAPE",
    name: "Sterile OT drape",
    category: "linen",
    unit: "piece",
    reorderLevel: 20,
  },
  {
    code: "PHENYL",
    name: "Floor disinfectant",
    category: "housekeeping",
    unit: "litre",
    reorderLevel: 15,
  },
];

export async function seedStoreItems(
  tenantId: string,
  tenantSlug: string,
  connection: Connection,
): Promise<number> {
  return runWithContext(
    { traceId: `seed-store-items-${tenantSlug}`, tenantId, tenantSlug, connection },
    async () => {
      const model = getInventoryItemModel(connection);
      let created = 0;

      for (const item of STARTER_STORE_ITEMS) {
        const result = await model.updateOne(
          { tenantId, code: item.code },
          {
            // ONLY on insert — a hospital's edited name, unit or reorder level is theirs.
            $setOnInsert: {
              tenantId,
              code: item.code,
              name: item.name,
              category: item.category,
              unit: item.unit,
              reorderLevel: item.reorderLevel,
              active: true,
            },
          },
          { upsert: true },
        );
        if (result.upsertedCount > 0) created++;
      }

      if (created > 0) logger.info({ tenantSlug, created }, "store item list seeded");
      return created;
    },
  );
}
