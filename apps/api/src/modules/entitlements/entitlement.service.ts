/**
 * Entitlements (ADR-0010 layer 1, Doc 07) — "did this hospital BUY this?"
 *
 * The first of the three authorization questions, and the one people forget:
 *
 *     1. entitlement — is the capability part of this hospital's edition?   ← here
 *     2. permission  — does this user hold `resource:action`?               ← rbac
 *     3. row scope   — may they see THIS row?                               ← repositories
 *
 * They are genuinely different questions and must not be collapsed. Granting a
 * nurse `dialysis:record` at a clinic that never bought the dialysis module must
 * still fail — otherwise a permission edit inside one hospital silently unlocks
 * software it isn't paying for.
 *
 * Resolution: the plan's flags (code-defined edition, Doc 07) + per-tenant
 * overrides (master `featureFlags`). Cached at `ff:{tenantId}` for 5 minutes
 * (CACHE_STRATEGY). Redis failure = cache miss = a database read, never a grant.
 */
import { getEdition, type FeatureFlag } from "@medicore/permissions";
import { env } from "../../config/env.js";
import { cacheDel, cacheGet, cacheKeys, cacheSet } from "../../core/redis/redis.js";
import { getFeatureFlagModel } from "./entitlement.model.js";
import { getById as getTenant } from "../tenants/index.js";

/** Resolved, flattened: the flags this tenant may use right now. */
export async function getEnabledFeatures(tenantId: string): Promise<Set<string>> {
  const key = cacheKeys.tenantFeatures(tenantId);

  const cached = await cacheGet<string[]>(key);
  if (cached) return new Set(cached);

  const tenant = await getTenant(tenantId);
  if (!tenant) return new Set();

  // Baseline: whatever the edition includes.
  const edition = getEdition(tenant.planCode);
  const enabled = new Set<string>(edition?.flags ?? []);

  // Exceptions: per-tenant overrides, in either direction.
  const overrides = await (await getFeatureFlagModel()).find({ tenantId });
  const now = Date.now();
  for (const override of overrides) {
    // An expired override reverts to the plan — a lapsed trial must not linger.
    if (override.expiresAt && override.expiresAt.getTime() <= now) continue;
    if (override.enabled) enabled.add(override.flag);
    else enabled.delete(override.flag);
  }

  await cacheSet(key, [...enabled], env.TENANT_CACHE_TTL_SECONDS);
  return enabled;
}

export async function isFeatureEnabled(tenantId: string, flag: FeatureFlag): Promise<boolean> {
  return (await getEnabledFeatures(tenantId)).has(flag);
}

/** Sets a per-tenant override. Invalidates in the same method that writes (CACHE_STRATEGY). */
export async function setFeatureOverride(input: {
  tenantId: string;
  flag: FeatureFlag;
  enabled: boolean;
  reason?: string;
  expiresAt?: Date;
}): Promise<void> {
  const model = await getFeatureFlagModel();
  await model.findOneAndUpdate(
    { tenantId: input.tenantId, flag: input.flag },
    {
      tenantId: input.tenantId,
      flag: input.flag,
      enabled: input.enabled,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    },
    { upsert: true },
  );
  await cacheDel(cacheKeys.tenantFeatures(input.tenantId));
}

export async function clearFeatureOverride(tenantId: string, flag: FeatureFlag): Promise<void> {
  await (await getFeatureFlagModel()).deleteOne({ tenantId, flag });
  await cacheDel(cacheKeys.tenantFeatures(tenantId));
}

/** Called when the subscription changes — the plan's flag set just moved. */
export async function invalidateFeatures(tenantId: string): Promise<void> {
  await cacheDel(cacheKeys.tenantFeatures(tenantId));
}
