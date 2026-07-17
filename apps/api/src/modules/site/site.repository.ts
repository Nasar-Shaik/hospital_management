/**
 * Site-settings repository — the ONLY code that queries `siteSettings` (Constitution §6).
 *
 * The collection is a singleton per tenant (unique `{ tenantId }`, migration 0022), so there
 * are no ids to pass around: every read is "the settings for THIS tenant", and the write is an
 * upsert. `tenantScopePlugin` supplies the `tenantId` on both, so it never appears here.
 */
import { getTenantDb } from "../../core/context/requestContext.js";
import { getSiteSettingsModel, type SiteSettingsDoc } from "./site.model.js";

/** The saved settings, or `undefined` if this hospital has never saved any (a valid state). */
export async function getSettings(): Promise<SiteSettingsDoc | undefined> {
  const doc = await getSiteSettingsModel(getTenantDb()).findOne({}).lean<SiteSettingsDoc>();
  return doc ?? undefined;
}

/**
 * Creates or updates this tenant's settings from a partial patch.
 *
 * `$set` only the fields the caller supplied, so an editor that saves the contact block does
 * not blank the services list. `upsert` means the first save materialises the document —
 * seeding is convenience, not a precondition.
 */
export async function upsertSettings(
  patch: Partial<Omit<SiteSettingsDoc, "_id" | "tenantId" | "createdAt" | "updatedAt">>,
): Promise<SiteSettingsDoc> {
  const doc = await getSiteSettingsModel(getTenantDb())
    .findOneAndUpdate({}, { $set: patch }, { new: true, upsert: true, setDefaultsOnInsert: true })
    .lean<SiteSettingsDoc>();

  if (!doc) throw new Error("site settings upsert returned nothing");
  return doc;
}
