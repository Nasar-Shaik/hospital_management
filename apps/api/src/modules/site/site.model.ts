/**
 * Site settings — a hospital's public-facing website content and brand.
 *
 * ── ONE DOCUMENT PER HOSPITAL, LIVING IN THE HOSPITAL'S OWN DATABASE ─────────
 * A hospital's marketing site — its name, colours, the services it advertises, how to reach
 * it — is the hospital's own content, so it lives in the hospital's own tenant database, not
 * in the platform registry. The registry keeps only what ROUTING needs (slug, custom domain,
 * status, plan); everything a visitor reads is here. A unique index on `tenantId` (migration
 * 0022) makes this a singleton: there is exactly one public site per hospital.
 *
 * ── IT IS PUBLIC BY DESIGN, SO IT CARRIES NO PHI AND NO SECRETS ─────────────
 * `GET /api/v1/site` is served WITHOUT authentication (the same way the login page is), so
 * every field here is safe to show a stranger who typed the address. The doctors shown on the
 * site are NOT stored here — they are pulled live from the staff directory, opt-in per person
 * (see the site service), so a doctor who leaves stops appearing without anyone editing this.
 *
 * ── A MISSING DOCUMENT IS NOT AN ERROR ──────────────────────────────────────
 * A hospital provisioned before this feature, or one whose admin has never opened the editor,
 * still has a presentable site: the service composes whatever is saved here OVER defaults
 * derived from the hospital's name. So every field is optional, and the absence of the whole
 * document is a valid, handled state.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { tenantScopePlugin } from "../../core/db/plugins/tenantScope.js";

/** A single advertised service / department card. */
export interface SiteService {
  name: string;
  description?: string;
  /** An icon key the front-end maps to a glyph. Free-form; the UI falls back to a default. */
  icon?: string;
}

/** A headline number on the landing page ("500+ beds", "40 specialists"). */
export interface SiteStat {
  label: string;
  value: string;
}

export interface SiteContact {
  phone?: string;
  email?: string;
  address?: string;
  /** The number a patient calls in an emergency — shown prominently, apart from the desk line. */
  emergencyPhone?: string;
  /** Opening hours as free text ("OPD 8am–8pm · Emergency 24/7"). Not structured on purpose. */
  hoursText?: string;
}

export interface SiteBranding {
  /** The name shown as the brand. Defaults to the hospital's registered name. */
  displayName?: string;
  /** Accent colour as `#rrggbb`. Drives the site's primary colour; validated in the schema. */
  accentColor?: string;
}

/** Off-site links shown in the footer. All optional; an empty set renders nothing. */
export interface SiteSocial {
  website?: string;
  facebook?: string;
  instagram?: string;
  twitter?: string;
  youtube?: string;
  linkedin?: string;
}

/**
 * A dismissible notice strip across the top of the site — "Flu vaccination now available",
 * "New cardiology wing open". The one piece of content a hospital changes weekly, so it is a
 * first-class field rather than something buried in the about text.
 */
export interface SiteAnnouncement {
  text: string;
  /** Optional call-to-action the strip links to (an internal anchor or an external URL). */
  link?: string;
}

export interface SiteSettingsDoc {
  _id: Types.ObjectId;
  tenantId: string;

  branding?: SiteBranding;
  tagline?: string;
  /** The "about us" block. Free text; rendered as paragraphs split on blank lines. */
  about?: string;
  services: SiteService[];
  stats: SiteStat[];
  contact?: SiteContact;
  social?: SiteSocial;
  announcement?: SiteAnnouncement;

  /**
   * SEO description for the `<meta name="description">` and Open Graph tags. Defaults to the
   * tagline when unset. Bounded because search engines truncate past ~160 chars anyway.
   */
  metaDescription?: string;

  /**
   * Whether the public site is live. `false` means a visitor to the root is sent straight to
   * sign-in — for a hospital that has bought the platform but not yet finished its page, and
   * does not want a half-built site indexed. Defaults to `true`: the seeded starter site is
   * presentable from birth.
   */
  published: boolean;

  createdAt: Date;
  updatedAt: Date;
}

const serviceSchema = new Schema<SiteService>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 600 },
    icon: { type: String, trim: true, maxlength: 40 },
  },
  { _id: false },
);

const statSchema = new Schema<SiteStat>(
  {
    label: { type: String, required: true, trim: true, maxlength: 60 },
    value: { type: String, required: true, trim: true, maxlength: 40 },
  },
  { _id: false },
);

const siteSettingsSchema = new Schema<SiteSettingsDoc>(
  {
    tenantId: { type: String, required: true, index: true },

    branding: {
      type: {
        displayName: { type: String, trim: true, maxlength: 120 },
        accentColor: { type: String, trim: true },
      },
      default: undefined,
      _id: false,
    },
    tagline: { type: String, trim: true, maxlength: 200 },
    about: { type: String, trim: true, maxlength: 4000 },
    services: { type: [serviceSchema], default: [] },
    stats: { type: [statSchema], default: [] },
    contact: {
      type: {
        phone: { type: String, trim: true, maxlength: 40 },
        email: { type: String, trim: true, maxlength: 160 },
        address: { type: String, trim: true, maxlength: 400 },
        emergencyPhone: { type: String, trim: true, maxlength: 40 },
        hoursText: { type: String, trim: true, maxlength: 200 },
      },
      default: undefined,
      _id: false,
    },
    social: {
      type: {
        website: { type: String, trim: true, maxlength: 200 },
        facebook: { type: String, trim: true, maxlength: 200 },
        instagram: { type: String, trim: true, maxlength: 200 },
        twitter: { type: String, trim: true, maxlength: 200 },
        youtube: { type: String, trim: true, maxlength: 200 },
        linkedin: { type: String, trim: true, maxlength: 200 },
      },
      default: undefined,
      _id: false,
    },
    announcement: {
      type: {
        text: { type: String, trim: true, maxlength: 300 },
        link: { type: String, trim: true, maxlength: 300 },
      },
      default: undefined,
      _id: false,
    },
    metaDescription: { type: String, trim: true, maxlength: 320 },

    published: { type: Boolean, required: true, default: true },
  },
  // The unique `{ tenantId }` index that makes this a singleton is owned by migration 0022,
  // never autoIndex — the same discipline as every other tenant collection.
  { timestamps: true, collection: "siteSettings", autoIndex: false },
);

siteSettingsSchema.plugin(tenantScopePlugin);

export function getSiteSettingsModel(conn: Connection): Model<SiteSettingsDoc> {
  return (
    (conn.models.SiteSettings as Model<SiteSettingsDoc>) ??
    conn.model<SiteSettingsDoc>("SiteSettings", siteSettingsSchema)
  );
}
