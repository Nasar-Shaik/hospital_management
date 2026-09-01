/**
 * Site module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5).
 *
 * Owns a hospital's public website content (the `siteSettings` singleton in the tenant DB):
 * the brand, the marketing copy, the services it advertises, how to reach it. Serves one public
 * endpoint (`GET /site`) that a logged-out visitor hits, and the admin editor behind it.
 *
 * Depends on `tenants` (for the hospital's name) and `staff` (for the opt-in doctors list);
 * nothing depends on it. Not PHI — every field is safe to show the open internet by design.
 */
export { siteRouter } from "./site.routes.js";

export {
  getPublicSite,
  getEditableSite,
  updateSite,
  type PublicSite,
  type EditableSite,
  type UpdateSiteInput,
} from "./site.service.js";

export type {
  SiteService,
  SiteStat,
  SiteContact,
  SiteSocial,
  SiteAnnouncement,
  SiteBranding,
} from "./site.model.js";
