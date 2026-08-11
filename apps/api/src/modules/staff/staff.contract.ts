/**
 * Staff response contracts.
 *
 * ── THREE SHAPES FOR ONE PERSON, ON PURPOSE ─────────────────────────────────
 * `StaffMember` is the HR record and needs `staff:read`. `DoctorRef` is a name and an id — what
 * every booking dropdown needs and nothing more. `DoctorCard` adds the qualification and signature
 * the OPD slip prints. Collapsing them into one type would mean the appointment screen receives a
 * colleague's date of birth and emergency contact in order to render a name.
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves } from "../../core/http/contract.js";
import { STAFF_GENDERS, USER_STATUSES } from "../users/user.model.js";
import type { CreateStaffResult, DoctorCard, DoctorRef, StaffMember } from "./staff.service.js";

export const staffProfile = contract(
  "StaffProfile",
  z.object({
    /** "Senior Consultant", "Staff Nurse". */
    designation: z.string().optional(),
    department: z.string().optional(),
    /** Doctors: their clinical specialty. Distinct from department. */
    specialty: z.string().optional(),
    /** Doctors: the OP consultation fee in PAISE. Absent means the hospital's general tariff. */
    consultationFee: z.number().int().optional(),
    qualification: z.string().optional(),
    registrationNo: z.string().optional(),
    gender: z.enum(STAFF_GENDERS).optional(),
    dateOfBirth: z.string().optional(),
    joiningDate: z.string().optional(),
    address: z.string().optional(),
    emergencyContactName: z.string().optional(),
    emergencyContactPhone: z.string().optional(),
    /** Opt-in: show this person on the hospital's PUBLIC website. Off by default. */
    showOnPublicSite: z.boolean().optional(),
    /** A scanned signature as a `data:image/…;base64,…` URI, printed on the OPD slip. */
    signature: z.string().optional(),
  }),
);

export const staffMember = contract(
  "StaffMember",
  z.object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    status: z.enum(USER_STATUSES),
    mfaEnabled: z.boolean(),
    phone: z.string().optional(),
    employeeId: z.string().optional(),
    profile: staffProfile.optional(),
    /** Set when this login belongs to a PATIENT rather than a member of staff. */
    patientId: z.string().optional(),
    lastLoginAt: z.string().optional(),
    lockedUntil: z.string().optional(),
    roles: z.array(z.string()),
    branchIds: z.array(z.string()),
  }),
);
export type StaffMemberProof = Proves<Matches<typeof staffMember, StaffMember>>;

/** A name and an id — what a booking dropdown needs, and nothing a dropdown does not. */
export const doctorRef = contract("DoctorRef", z.object({ id: z.string(), name: z.string() }));
export type DoctorRefProof = Proves<Matches<typeof doctorRef, DoctorRef>>;

/** What the OPD slip prints above the signature line. */
export const doctorCard = contract(
  "DoctorCard",
  z.object({
    id: z.string(),
    name: z.string(),
    qualification: z.string().optional(),
    designation: z.string().optional(),
    signature: z.string().optional(),
  }),
);
export type DoctorCardProof = Proves<Matches<typeof doctorCard, DoctorCard>>;

export const createStaffResult = contract(
  "CreateStaffResult",
  z.object({
    user: staffMember,
    /** Present only when we generated it. Shown once; only its hash is stored. */
    temporaryPassword: z.string().optional(),
  }),
);
export type CreateStaffResultProof = Proves<Matches<typeof createStaffResult, CreateStaffResult>>;

export const temporaryPassword = contract(
  "TemporaryPassword",
  z.object({ temporaryPassword: z.string().optional() }),
);
