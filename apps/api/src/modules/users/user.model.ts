/**
 * User identity (tenant DB `users`, Doc 03 §2).
 *
 * WHY THIS IS ITS OWN MODULE: a user record is referenced by both `auth`
 * (credentials, sessions) and `rbac` (role bindings). If `users` lived inside
 * `auth`, then `rbac` → `auth` (to validate a user) and `auth` → `rbac` (to put
 * roles in the token) would form a cycle, which the Constitution forbids and CI
 * rejects. Splitting identity out keeps the graph acyclic:
 *
 *      auth ──▶ users ◀── rbac
 *        └────────▶ rbac
 *
 * This collection holds NO secrets. Password hashes, MFA seeds and tokens live
 * in the `auth` module's collections, so a query that returns a user can never
 * accidentally serialize a credential.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { tenantScopePlugin } from "../../core/db/plugins/tenantScope.js";
import { auditPlugin } from "../../core/db/plugins/auditPlugin.js";

/** User-account lifecycle — STATE_MACHINE_CATALOG §12. Only `active` may authenticate. */
export const USER_STATUSES = ["invited", "active", "locked", "disabled", "archived"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const STAFF_GENDERS = ["male", "female", "other"] as const;
export type StaffGender = (typeof STAFF_GENDERS)[number];

/**
 * The professional / HR record for a staff member. Every field is optional — a hospital
 * registers a doctor in a hurry and fills the rest in later, and a registration form that
 * refuses to save until every box is ticked is a form that gets bypassed on paper.
 *
 * Which fields the UI ASKS for depends on the role (a doctor is prompted for specialty and
 * medical-council registration; a cashier is not), but the storage is one flexible shape so
 * a person who changes role does not lose the fields that still apply. `specialty` also drives
 * the per-doctor consultation fee (Track D).
 */
export interface StaffProfile {
  /** "Senior Consultant", "Staff Nurse". */
  designation?: string;
  /** "Cardiology", "Radiology". */
  department?: string;
  /** Doctors: their clinical specialty. Distinct from department. */
  specialty?: string;
  /**
   * Doctors: the OP consultation fee in PAISE, charged when a patient starts an encounter with
   * them. Absent means "use the hospital's general consultation tariff" — so a hospital that
   * prices consultations one flat rate never has to set this, and a specialist who charges more
   * simply carries their own number. A government hospital's zero-tariff policy still overrides
   * it to ₹0, because that is a billing MODE, not a per-doctor choice.
   */
  consultationFee?: number;
  /** "MBBS, MD", "B.Sc MLT". */
  qualification?: string;
  /** Medical-council / professional registration or licence number. */
  registrationNo?: string;
  gender?: StaffGender;
  dateOfBirth?: Date;
  joiningDate?: Date;
  address?: string;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
}

export interface UserDoc {
  _id: Types.ObjectId;
  tenantId: string;
  email: string;
  name: string;
  status: UserStatus;
  phone?: string;
  /** Set when the user is also a staff member (module F1). */
  employeeId?: string;
  /** Professional / HR details, captured for staff. See `StaffProfile`. */
  profile?: StaffProfile;
  /** Set for patient-portal identities — scope `self` only (ADR-0009). */
  patientId?: string;
  /** True only once a TOTP secret has been CONFIRMED, never at setup time. */
  mfaEnabled: boolean;
  lastLoginAt?: Date;
  /** Set when an automatic lockout is in force (STATE_MACHINE_CATALOG §12). */
  lockedUntil?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<UserDoc>(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    status: { type: String, enum: USER_STATUSES, required: true, default: "invited" },
    phone: { type: String, trim: true },
    employeeId: { type: String },
    profile: {
      type: {
        designation: { type: String, trim: true, maxlength: 120 },
        department: { type: String, trim: true, maxlength: 120 },
        specialty: { type: String, trim: true, maxlength: 120 },
        consultationFee: { type: Number, min: 0, max: 100_000_000 },
        qualification: { type: String, trim: true, maxlength: 200 },
        registrationNo: { type: String, trim: true, maxlength: 80 },
        gender: { type: String, enum: STAFF_GENDERS },
        dateOfBirth: { type: Date },
        joiningDate: { type: Date },
        address: { type: String, trim: true, maxlength: 500 },
        emergencyContactName: { type: String, trim: true, maxlength: 120 },
        emergencyContactPhone: { type: String, trim: true, maxlength: 20 },
      },
      // `default: undefined`, never `{}` — an empty object would make the audit hash-chain
      // see a "profile changed" diff on an untouched record (the trap on duplicateOverride).
      default: undefined,
      _id: false,
    },
    patientId: { type: String },
    mfaEnabled: { type: Boolean, default: false },
    lastLoginAt: { type: Date },
    lockedUntil: { type: Date },
  },
  // Indexes are owned by migration 0005, not by autoIndex: index creation is a
  // deliberate, reviewable migration step, never a side effect of a deploy.
  { timestamps: true, collection: "users", autoIndex: false },
);

userSchema.plugin(tenantScopePlugin);

/**
 * Every change to a user account is recorded (Doc 09 §9). "Who gave this person
 * access, and when" is the first question of any breach investigation, and the
 * answer has to exist before the breach, not be reconstructed after it.
 *
 * `lastLoginAt` and `lockedUntil` are ignored here — not because they do not
 * matter, but because they matter TOO much to be recorded as anonymous field
 * diffs. `auth` records them as named security events (`auth.login.succeeded`,
 * `auth.account.locked`) with the surrounding facts an investigator needs. Left
 * to the plugin, every single login would also produce a content-free
 * "user.updated" entry, and a trail that is 95% noise is a trail nobody reads.
 */
userSchema.plugin(auditPlugin, {
  resource: "user",
  category: "admin",
  ignore: ["lastLoginAt", "lockedUntil"],
});

export function getUserModel(conn: Connection): Model<UserDoc> {
  return (conn.models.User as Model<UserDoc>) ?? conn.model<UserDoc>("User", userSchema);
}
