/**
 * Patient DTOs (Doc 09 §5/§6). `.strict()` — an unexpected field is a 400.
 *
 * Note what is NOT required: date of birth, phone, address, gender beyond
 * "unknown". A registration form that cannot describe an unconscious patient from
 * a road accident is a form the emergency department bypasses on paper — and a
 * paper record is a record the rest of this system cannot see
 * (BUSINESS_WORKFLOWS §1: "emergency unknown patient → temp UHID, reconcile later").
 * Only a NAME is mandatory, because you must be able to call the patient something.
 */
import { z } from "@medicore/validation";
import { BLOOD_GROUPS, GENDERS, PATIENT_STATUSES } from "./patient.model.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "invalid id");

/** A DOB in the future is a typo, always. A DOB before 1875 is a typo too. */
const dob = z.coerce
  .date()
  .max(new Date(), "date of birth cannot be in the future")
  .min(new Date("1875-01-01"), "date of birth is implausible");

const contact = z
  .object({
    phone: z.string().min(6).max(20).optional(),
    email: z.string().email().max(254).optional(),
  })
  .strict();

const address = z
  .object({
    line1: z.string().max(200).optional(),
    line2: z.string().max(200).optional(),
    city: z.string().max(100).optional(),
    state: z.string().max(100).optional(),
    postalCode: z.string().max(20).optional(),
    country: z.string().max(100).optional(),
  })
  .strict();

export const registerPatientSchema = z
  .object({
    name: z.string().min(2).max(160),
    gender: z.enum(GENDERS).default("unknown"),
    dob: dob.optional(),
    bloodGroup: z.enum(BLOOD_GROUPS).optional(),
    branchId: objectId.optional(),
    contact: contact.optional(),
    address: address.optional(),
    /** Overrides a duplicate warning. The service additionally requires `patient:merge`. */
    force: z.boolean().default(false),
  })
  .strict();

export const updatePatientSchema = z
  .object({
    name: z.string().min(2).max(160).optional(),
    gender: z.enum(GENDERS).optional(),
    dob: dob.optional(),
    bloodGroup: z.enum(BLOOD_GROUPS).optional(),
    contact: contact.optional(),
    address: address.optional(),
  })
  .strict();

export const listPatientsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    /** Matches a UHID prefix, a name fragment, or a phone prefix. */
    q: z.string().max(160).optional(),
    status: z.enum(PATIENT_STATUSES).optional(),
  })
  .strict();

/** The as-you-type duplicate check the registration form calls before submitting. */
export const duplicateCheckSchema = z
  .object({
    name: z.string().min(2).max(160),
    gender: z.enum(GENDERS).optional(),
    dob: dob.optional(),
    phone: z.string().min(6).max(20).optional(),
    excludeId: objectId.optional(),
  })
  .strict();

export const mergePatientsSchema = z
  .object({
    /** The record that survives; the one everything is re-pointed to. */
    survivorId: objectId,
    /** The record folded into the survivor. Kept forever, never deleted. */
    duplicateId: objectId,
    /**
     * Required, and not a dropdown. A merge is irreversible in practice and the
     * next person to look at this needs to know WHY it was done — "same patient,
     * confirmed with Aadhaar at desk 3" is worth a hundred audit entries reading
     * "reason: DUPLICATE".
     */
    reason: z.string().min(5).max(500),
  })
  .strict();

export const idParamSchema = z.object({ id: objectId }).strict();

export const uhidParamSchema = z
  .object({
    uhid: z
      .string()
      .min(3)
      .max(32)
      .regex(/^[A-Za-z0-9-]+$/, "invalid UHID"),
  })
  .strict();

export type RegisterPatientBody = z.infer<typeof registerPatientSchema>;
export type ListPatientsQuery = z.infer<typeof listPatientsQuerySchema>;
export type DuplicateCheckBody = z.infer<typeof duplicateCheckSchema>;
export type MergePatientsBody = z.infer<typeof mergePatientsSchema>;
