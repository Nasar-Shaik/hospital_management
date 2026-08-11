/**
 * Public site response contracts.
 *
 * `PublicSite` is what an ANONYMOUS visitor receives and `EditableSite` is what an administrator
 * edits. The difference is `doctors`: the public shape carries the opted-in doctor list, the
 * editable one does not, because that list is derived from staff records rather than site
 * settings. Two names for two audiences — one shape would mean the editor screen decides what a
 * stranger can read.
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves } from "../../core/http/contract.js";
import type { EditableSite, PublicSite } from "./site.service.js";

export const siteService = contract(
  "SiteService",
  z.object({
    name: z.string(),
    description: z.string().optional(),
    /** An icon key the front-end maps to a glyph. The UI falls back to a default. */
    icon: z.string().optional(),
  }),
);

export const siteStat = contract("SiteStat", z.object({ label: z.string(), value: z.string() }));

export const siteContact = contract(
  "SiteContact",
  z.object({
    phone: z.string().optional(),
    email: z.string().optional(),
    address: z.string().optional(),
    /** The number a patient calls in an emergency — shown apart from the desk line. */
    emergencyPhone: z.string().optional(),
    /** Opening hours as free text. Not structured, on purpose. */
    hoursText: z.string().optional(),
  }),
);

export const siteSocial = contract(
  "SiteSocial",
  z.object({
    website: z.string().optional(),
    facebook: z.string().optional(),
    instagram: z.string().optional(),
    twitter: z.string().optional(),
    youtube: z.string().optional(),
    linkedin: z.string().optional(),
  }),
);

export const siteAnnouncement = contract(
  "SiteAnnouncement",
  z.object({ text: z.string(), link: z.string().optional() }),
);

/** Only name, specialty and designation — never contact details or HR fields. */
export const publicDoctor = contract(
  "PublicDoctor",
  z.object({
    id: z.string(),
    name: z.string(),
    specialty: z.string().optional(),
    designation: z.string().optional(),
  }),
);

const siteFields = {
  /** The registered hospital name — the document title, even when a brand name is set. */
  hospitalName: z.string(),
  /** The brand name shown in the header. */
  displayName: z.string(),
  accentColor: z.string(),
  tagline: z.string(),
  about: z.string(),
  services: z.array(siteService),
  stats: z.array(siteStat),
  contact: siteContact,
  social: siteSocial,
  metaDescription: z.string(),
  /** Whether a logo has been uploaded — fetch it from `GET /site/logo` when true. */
  hasLogo: z.boolean(),
  /** When false the site is hidden and visitors go straight to sign-in. */
  published: z.boolean(),
};

export const publicSite = contract(
  "PublicSite",
  z.object({
    ...siteFields,
    announcement: siteAnnouncement.optional(),
    doctors: z.array(publicDoctor),
  }),
);
export type PublicSiteProof = Proves<Matches<typeof publicSite, PublicSite>>;

export const editableSite = contract(
  "EditableSite",
  z.object({ ...siteFields, announcement: siteAnnouncement.optional() }),
);
export type EditableSiteProof = Proves<Matches<typeof editableSite, EditableSite>>;

export const logoUploadedAck = contract("LogoUploadedAck", z.object({ uploaded: z.literal(true) }));
export const logoDeletedAck = contract("LogoDeletedAck", z.object({ deleted: z.literal(true) }));
