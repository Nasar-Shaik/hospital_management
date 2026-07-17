/**
 * Subscription repository — the only code that touches `plans`, `usageCounters`,
 * and the `subscription` block on a tenant registry entry.
 */
import { Types } from "mongoose";
import { EDITIONS, type EditionDefinition } from "@medicore/permissions";
import { getMasterConnection } from "../../core/db/masterDb.js";
import { getPlanModel, getUsageCounterModel, type PlanDoc } from "./subscription.model.js";

export interface Plan {
  code: string;
  name: string;
  entitlements: string[];
  limits: EditionDefinition["limits"];
  priceMinor?: number;
  currency?: string;
}

function toPlan(doc: PlanDoc): Plan {
  return {
    code: doc.code,
    name: doc.name,
    entitlements: doc.entitlements,
    limits: doc.limits,
    ...(doc.priceMinor !== undefined ? { priceMinor: doc.priceMinor } : {}),
    ...(doc.currency ? { currency: doc.currency } : {}),
  };
}

/**
 * Mirrors the code catalog into `plans`.
 *
 * Entitlements and limits are OVERWRITTEN from code on every run — they are a
 * projection, and a hand-edited row that disagrees with the code would make a
 * hospital's feature set depend on which one you happened to read. Price is NOT
 * overwritten: that is commercial data an operator sets, and code has no opinion.
 */
export async function syncPlans(): Promise<number> {
  const model = await getPlanModel();
  let synced = 0;

  for (const edition of Object.values(EDITIONS) as EditionDefinition[]) {
    await model.updateOne(
      { code: edition.code },
      {
        $set: {
          name: edition.name,
          entitlements: [...edition.flags],
          limits: edition.limits,
          active: true,
        },
        $setOnInsert: { code: edition.code, currency: "INR" },
      },
      { upsert: true },
    );
    synced += 1;
  }

  return synced;
}

export async function listPlans(): Promise<Plan[]> {
  const docs = await (await getPlanModel()).find({ active: true }).sort({ code: 1 });
  return docs.map(toPlan);
}

export async function findPlan(code: string): Promise<Plan | undefined> {
  const doc = await (await getPlanModel()).findOne({ code: code.toUpperCase() });
  return doc ? toPlan(doc) : undefined;
}

/** Writes the tenant's chosen edition onto the registry entry (Doc 03 §1.1). */
export async function setTenantPlan(tenantId: string, planCode: string): Promise<void> {
  const master = await getMasterConnection();
  await master
    .collection("tenants")
    .updateOne(
      { _id: new Types.ObjectId(tenantId) },
      { $set: { "subscription.planCode": planCode, "subscription.status": "active" } },
    );
}

/* ── usage counters (for metrics that cannot be counted on demand) ────────── */

export async function incrementUsage(
  tenantId: string,
  metric: string,
  by = 1,
  period = "total",
): Promise<number> {
  const model = await getUsageCounterModel();
  const doc = await model.findOneAndUpdate(
    { tenantId, metric, period },
    { $inc: { value: by } },
    { upsert: true, new: true },
  );
  return doc.value;
}

export async function readUsage(
  tenantId: string,
  metric: string,
  period = "total",
): Promise<number> {
  const doc = await (await getUsageCounterModel()).findOne({ tenantId, metric, period });
  return doc?.value ?? 0;
}
