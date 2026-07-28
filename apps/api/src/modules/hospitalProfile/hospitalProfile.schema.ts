/**
 * Hospital-profile DTO (Doc 09 §5/§6). `.strict()` — an unexpected field is a 400.
 *
 * Every field is optional: the whole document is optional, and a PUT can save just the fields the
 * admin has filled so far. A blank string is allowed and means "clear this field" (the repository
 * `$unset`s it).
 */
import { z } from "@medicore/validation";
import { OWNERSHIP_TYPES } from "./hospitalProfile.model.js";

const currentYear = new Date().getFullYear();

export const saveHospitalProfileSchema = z
  .object({
    legalName: z.string().trim().max(200).optional(),
    registrationNumber: z.string().trim().max(80).optional(),
    taxId: z.string().trim().max(40).optional(),
    accreditations: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
    establishedYear: z.coerce.number().int().min(1800).max(currentYear).optional(),
    ownershipType: z.enum(OWNERSHIP_TYPES).optional(),
    licensedBeds: z.coerce.number().int().min(0).max(100_000).optional(),
    address: z.string().trim().max(500).optional(),
    officialEmail: z.string().trim().max(160).optional(),
    officialPhone: z.string().trim().max(40).optional(),
    website: z.string().trim().max(200).optional(),
    headName: z.string().trim().max(120).optional(),
    headTitle: z.string().trim().max(120).optional(),
  })
  .strict();

export type SaveHospitalProfileBody = z.infer<typeof saveHospitalProfileSchema>;
