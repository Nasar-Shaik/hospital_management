/**
 * Site-settings DTO (Doc 09 §5/§6: Zod is the single source of DTO truth; `.strict()` so an
 * unexpected field is a 400, not a silently ignored one).
 *
 * This is the ADMIN write contract. The public read has no input to validate. Every field is
 * optional — the editor saves whatever section the admin touched — but each field that IS sent
 * is bounded, because this content is rendered to the open internet.
 */
import { z } from "@medicore/validation";

/** `#rrggbb`. Rejecting shorthand/other forms keeps the value safe to drop straight into CSS. */
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be a 6-digit hex colour like #0d9488");

const serviceSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(600).optional(),
    icon: z.string().trim().max(40).optional(),
  })
  .strict();

const statSchema = z
  .object({
    label: z.string().trim().min(1).max(60),
    value: z.string().trim().min(1).max(40),
  })
  .strict();

const contactSchema = z
  .object({
    phone: z.string().trim().max(40).optional(),
    email: z.string().trim().max(160).optional(),
    address: z.string().trim().max(400).optional(),
    emergencyPhone: z.string().trim().max(40).optional(),
    hoursText: z.string().trim().max(200).optional(),
  })
  .strict();

const socialSchema = z
  .object({
    website: z.string().trim().max(200).optional(),
    facebook: z.string().trim().max(200).optional(),
    instagram: z.string().trim().max(200).optional(),
    twitter: z.string().trim().max(200).optional(),
    youtube: z.string().trim().max(200).optional(),
    linkedin: z.string().trim().max(200).optional(),
  })
  .strict();

const announcementSchema = z
  .object({
    text: z.string().trim().min(1).max(300),
    link: z.string().trim().max(300).optional(),
  })
  .strict();

export const updateSiteSchema = z
  .object({
    displayName: z.string().trim().max(120).optional(),
    accentColor: hexColor.optional(),
    tagline: z.string().trim().max(200).optional(),
    about: z.string().trim().max(4000).optional(),
    services: z.array(serviceSchema).max(24).optional(),
    stats: z.array(statSchema).max(8).optional(),
    contact: contactSchema.optional(),
    social: socialSchema.optional(),
    // `null` clears the strip; omitting it leaves the current one untouched.
    announcement: announcementSchema.nullable().optional(),
    metaDescription: z.string().trim().max(320).optional(),
    published: z.boolean().optional(),
  })
  .strict();

export type UpdateSiteBody = z.infer<typeof updateSiteSchema>;
