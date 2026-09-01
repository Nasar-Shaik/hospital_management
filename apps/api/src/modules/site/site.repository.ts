/**
 * Site-settings repository — the ONLY code that queries `siteSettings` (Constitution §6).
 *
 * The collection is a singleton per tenant (unique `{ tenantId }`, migration 0022), so there
 * are no ids to pass around: every read is "the settings for THIS tenant", and the write is an
 * upsert. `tenantScopePlugin` supplies the `tenantId` on both, so it never appears here.
 */
import { getTenantDb } from "../../core/context/requestContext.js";
import { getSiteSettingsModel, type SiteSettingsDoc, type SiteLogo } from "./site.model.js";

/**
 * The saved settings, or `undefined` if this hospital has never saved any (a valid state).
 *
 * `logo.data` is PROJECTED OUT — the logo bytes are read exactly once, by the download. Every
 * other read (the public site, the editor) only needs to know a logo EXISTS, which `logo.size`
 * and `logo.contentType` answer without dragging the binary along.
 */
export async function getSettings(): Promise<SiteSettingsDoc | undefined> {
  const doc = await getSiteSettingsModel(getTenantDb())
    .findOne({}, { "logo.data": 0 })
    .lean<SiteSettingsDoc>();
  return doc ?? undefined;
}

/** The logo bytes, for the public download. The only read that touches `logo.data`. */
export async function getLogo(): Promise<{ contentType: string; data: Buffer } | undefined> {
  const doc = await getSiteSettingsModel(getTenantDb())
    .findOne({}, { logo: 1 })
    .lean<{ logo?: SiteLogo }>();
  if (!doc?.logo?.data) return undefined;
  return { contentType: doc.logo.contentType, data: toBuffer(doc.logo.data) };
}

/** `.lean()` hands a Buffer back as a BSON Binary; coerce to a real Buffer (see reportFiles). */
function toBuffer(raw: unknown): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  const binary = raw as { buffer?: Buffer; value?: () => Buffer };
  if (binary.buffer && Buffer.isBuffer(binary.buffer)) return binary.buffer;
  if (typeof binary.value === "function") return binary.value();
  return Buffer.from(raw as Uint8Array);
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

/** Removes the logo. `$unset` because `upsertSettings` only ever `$set`s. */
export async function clearLogo(): Promise<void> {
  await getSiteSettingsModel(getTenantDb()).updateOne({}, { $unset: { logo: "" } });
}
