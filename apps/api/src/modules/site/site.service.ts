/**
 * The public website of one hospital, assembled.
 *
 * Two audiences read this module:
 *   - the world, through `getPublicSite()` — no login, so it returns only what is safe to show
 *     a stranger, and it ALWAYS returns something presentable (saved content over defaults);
 *   - the hospital's own admin, through `getEditableSite()` / `updateSite()` — the raw saved
 *     fields, so an empty box in the editor means "not set" rather than showing the default as
 *     if it had been typed.
 *
 * The doctors are NOT stored here: they are pulled live from the staff directory (opt-in per
 * person), so the site reflects who actually works here today without a second edit.
 */
import { getContext } from "../../core/context/requestContext.js";
import { getById as getTenant } from "../tenants/index.js";
import { listPublicDoctors, type PublicDoctor } from "../staff/index.js";
import * as repo from "./site.repository.js";
import type {
  SiteAnnouncement,
  SiteContact,
  SiteService,
  SiteSettingsDoc,
  SiteSocial,
  SiteStat,
} from "./site.model.js";

/** The platform's default accent — the same teal the app ships with (tokens.css brand-600). */
const DEFAULT_ACCENT = "#0d9488";

/** What a visitor to `apollo.localhost/` receives. Everything here is public and always set. */
export interface PublicSite {
  /** The registered hospital name — used for the document title and SEO even if a brand name is set. */
  hospitalName: string;
  /** The brand name shown in the header (branding.displayName, falling back to hospitalName). */
  displayName: string;
  accentColor: string;
  tagline: string;
  about: string;
  services: SiteService[];
  stats: SiteStat[];
  contact: SiteContact;
  social: SiteSocial;
  announcement?: SiteAnnouncement;
  metaDescription: string;
  doctors: PublicDoctor[];
  /** When false the site is hidden — the web layer sends visitors straight to sign-in. */
  published: boolean;
}

/** The saved fields, for the admin editor. Absent fields mean "not set", shown as blanks. */
export interface EditableSite {
  hospitalName: string;
  displayName: string;
  accentColor: string;
  tagline: string;
  about: string;
  services: SiteService[];
  stats: SiteStat[];
  contact: SiteContact;
  social: SiteSocial;
  announcement: SiteAnnouncement | undefined;
  metaDescription: string;
  published: boolean;
}

/** Sensible starter services so a brand-new hospital's page is not empty. */
function defaultServices(): SiteService[] {
  return [
    {
      name: "24/7 Emergency",
      description: "Round-the-clock casualty and trauma care.",
      icon: "emergency",
    },
    {
      name: "Outpatient (OPD)",
      description: "Consult our specialists across departments.",
      icon: "stethoscope",
    },
    {
      name: "Diagnostics & Lab",
      description: "Pathology and imaging under one roof.",
      icon: "flask",
    },
    { name: "Pharmacy", description: "In-house pharmacy for your prescriptions.", icon: "pill" },
    {
      name: "Inpatient Care",
      description: "Comfortable wards and dedicated nursing.",
      icon: "bed",
    },
    {
      name: "Surgery",
      description: "Modern operating theatres and expert surgeons.",
      icon: "scalpel",
    },
  ];
}

async function hospitalName(): Promise<string> {
  const tenant = await getTenant(getContext().tenantId);
  return tenant?.hospitalName ?? "Our Hospital";
}

/**
 * The public payload: saved content merged OVER defaults, plus the live doctors list.
 *
 * Every field resolves to a real value — a hospital that has saved nothing still gets its name,
 * the default accent, starter services and an inviting tagline. That is the whole point of
 * composing over defaults rather than returning nulls the front-end must paper over.
 */
export async function getPublicSite(): Promise<PublicSite> {
  const [name, saved, doctors] = await Promise.all([
    hospitalName(),
    repo.getSettings(),
    listPublicDoctors(),
  ]);

  const displayName = saved?.branding?.displayName?.trim() || name;
  const tagline = saved?.tagline?.trim() || "Compassionate, expert care — close to home.";

  return {
    hospitalName: name,
    displayName,
    accentColor: saved?.branding?.accentColor?.trim() || DEFAULT_ACCENT,
    tagline,
    about:
      saved?.about?.trim() ||
      `${displayName} brings together experienced clinicians, modern facilities and a commitment ` +
        `to putting patients first. From emergencies to routine check-ups, our teams are here to help.`,
    services: saved?.services?.length ? saved.services : defaultServices(),
    stats: saved?.stats ?? [],
    contact: saved?.contact ?? {},
    social: saved?.social ?? {},
    ...(saved?.announcement?.text ? { announcement: saved.announcement } : {}),
    metaDescription: saved?.metaDescription?.trim() || tagline,
    doctors,
    published: saved?.published ?? true,
  };
}

/** The saved fields for the editor — defaults fill display-only gaps, never overwrite saved blanks. */
export async function getEditableSite(): Promise<EditableSite> {
  const [name, saved] = await Promise.all([hospitalName(), repo.getSettings()]);
  return {
    hospitalName: name,
    displayName: saved?.branding?.displayName ?? "",
    accentColor: saved?.branding?.accentColor ?? DEFAULT_ACCENT,
    tagline: saved?.tagline ?? "",
    about: saved?.about ?? "",
    services: saved?.services ?? [],
    stats: saved?.stats ?? [],
    contact: saved?.contact ?? {},
    social: saved?.social ?? {},
    announcement: saved?.announcement,
    metaDescription: saved?.metaDescription ?? "",
    published: saved?.published ?? true,
  };
}

export interface UpdateSiteInput {
  displayName?: string;
  accentColor?: string;
  tagline?: string;
  about?: string;
  services?: SiteService[];
  stats?: SiteStat[];
  contact?: SiteContact;
  social?: SiteSocial;
  announcement?: SiteAnnouncement | null;
  metaDescription?: string;
  published?: boolean;
}

/**
 * Saves an admin's edits. Branding fields are nested under `branding`, so they are grouped in
 * the patch; everything else maps straight through. `announcement: null` clears the strip.
 */
export async function updateSite(input: UpdateSiteInput): Promise<EditableSite> {
  const patch: Partial<Omit<SiteSettingsDoc, "_id" | "tenantId" | "createdAt" | "updatedAt">> = {};

  if (input.displayName !== undefined || input.accentColor !== undefined) {
    patch.branding = {
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      ...(input.accentColor !== undefined ? { accentColor: input.accentColor } : {}),
    };
  }
  if (input.tagline !== undefined) patch.tagline = input.tagline;
  if (input.about !== undefined) patch.about = input.about;
  if (input.services !== undefined) patch.services = input.services;
  if (input.stats !== undefined) patch.stats = input.stats;
  if (input.contact !== undefined) patch.contact = input.contact;
  if (input.social !== undefined) patch.social = input.social;
  if (input.announcement !== undefined) {
    patch.announcement = input.announcement ?? undefined;
  }
  if (input.metaDescription !== undefined) patch.metaDescription = input.metaDescription;
  if (input.published !== undefined) patch.published = input.published;

  await repo.upsertSettings(patch);
  return getEditableSite();
}
