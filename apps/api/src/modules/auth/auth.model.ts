/**
 * Auth storage (tenant DB — Doc 03 §2, ADR-0009).
 *
 * Everything secret in the platform lives in these five collections, and nothing
 * here is ever returned to a client:
 *
 *   credentials     argon2id password hash            (verify-only → hashed)
 *   passwordHistory previous hashes, to block reuse   (verify-only → hashed)
 *   refreshTokens   SHA-256 digest of the token       (verify-only → hashed)
 *   mfaSecrets      TOTP seed, AES-256-GCM encrypted  (must be read back → encrypted)
 *   loginAttempts   brute-force ledger, TTL-expired
 *
 * The hash/encrypt split is deliberate: a secret we only ever *check* is hashed;
 * a secret we must *reproduce* is encrypted. Encrypting a password would be a
 * defect, and hashing a TOTP seed would make it unusable.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { tenantScopePlugin } from "../../core/db/plugins/tenantScope.js";

/* ── credentials ─────────────────────────────────────────────────────────── */

export interface CredentialDoc {
  _id: Types.ObjectId;
  tenantId: string;
  userId: string;
  passwordHash: string;
  /** Recorded so a future KDF migration knows what it is looking at. */
  algo: string;
  passwordChangedAt: Date;
  /** Forces a change on next login (invited users, admin resets). */
  mustChangePassword: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const credentialSchema = new Schema<CredentialDoc>(
  {
    userId: { type: String, required: true },
    passwordHash: { type: String, required: true },
    algo: { type: String, required: true, default: "argon2id" },
    passwordChangedAt: { type: Date, required: true, default: () => new Date() },
    mustChangePassword: { type: Boolean, default: false },
  },
  { timestamps: true, collection: "credentials", autoIndex: false },
);
credentialSchema.plugin(tenantScopePlugin);

/* ── passwordHistory ─────────────────────────────────────────────────────── */

export interface PasswordHistoryDoc {
  _id: Types.ObjectId;
  tenantId: string;
  userId: string;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
}

const passwordHistorySchema = new Schema<PasswordHistoryDoc>(
  {
    userId: { type: String, required: true },
    passwordHash: { type: String, required: true },
  },
  { timestamps: true, collection: "passwordHistory", autoIndex: false },
);
passwordHistorySchema.plugin(tenantScopePlugin);

/* ── sessions ────────────────────────────────────────────────────────────── */

export interface SessionDoc {
  _id: Types.ObjectId;
  tenantId: string;
  userId: string;
  /** One refresh-token family per session/device (ADR-0009). */
  family: string;
  device?: string;
  ip?: string;
  userAgent?: string;
  lastSeenAt: Date;
  /** TTL: Mongo removes the row once the refresh window has fully elapsed. */
  expiresAt: Date;
  revokedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const sessionSchema = new Schema<SessionDoc>(
  {
    userId: { type: String, required: true },
    family: { type: String, required: true },
    device: { type: String },
    ip: { type: String },
    userAgent: { type: String },
    lastSeenAt: { type: Date, required: true, default: () => new Date() },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date },
  },
  { timestamps: true, collection: "sessions", autoIndex: false },
);
sessionSchema.plugin(tenantScopePlugin);

/* ── refreshTokens ───────────────────────────────────────────────────────── */

export interface RefreshTokenDoc {
  _id: Types.ObjectId;
  tenantId: string;
  userId: string;
  sessionId: string;
  /** Family id — shared by every token descended from one login. */
  family: string;
  /** SHA-256 digest. The plaintext exists only in the client's hands. */
  tokenHash: string;
  expiresAt: Date;
  /** Set the moment the token is exchanged. A second exchange = reuse = theft. */
  usedAt?: Date;
  revokedAt?: Date;
  /** Audit trail of the rotation chain. */
  replacedByTokenId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const refreshTokenSchema = new Schema<RefreshTokenDoc>(
  {
    userId: { type: String, required: true },
    sessionId: { type: String, required: true },
    family: { type: String, required: true },
    tokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date },
    revokedAt: { type: Date },
    replacedByTokenId: { type: String },
  },
  { timestamps: true, collection: "refreshTokens", autoIndex: false },
);
refreshTokenSchema.plugin(tenantScopePlugin);

/* ── mfaSecrets ──────────────────────────────────────────────────────────── */

export interface MfaSecretDoc {
  _id: Types.ObjectId;
  tenantId: string;
  userId: string;
  type: "totp";
  /** AES-256-GCM ciphertext (core/crypto/fieldEncryption) — never plaintext. */
  secret: string;
  /** Until this is set, the secret is a pending enrolment and MFA is NOT active. */
  confirmedAt?: Date;
  /** Digested single-use recovery codes. */
  recoveryCodeHashes: string[];
  createdAt: Date;
  updatedAt: Date;
}

const mfaSecretSchema = new Schema<MfaSecretDoc>(
  {
    userId: { type: String, required: true },
    type: { type: String, enum: ["totp"], required: true, default: "totp" },
    secret: { type: String, required: true },
    confirmedAt: { type: Date },
    recoveryCodeHashes: { type: [String], default: [] },
  },
  { timestamps: true, collection: "mfaSecrets", autoIndex: false },
);
mfaSecretSchema.plugin(tenantScopePlugin);

/* ── loginAttempts ───────────────────────────────────────────────────────── */

export interface LoginAttemptDoc {
  _id: Types.ObjectId;
  tenantId: string;
  /** Stored even when no such user exists — that is the signal we need. */
  email: string;
  ip?: string;
  success: boolean;
  at: Date;
  /** TTL — the ledger is for lockout and anomaly detection, not permanent record. */
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const loginAttemptSchema = new Schema<LoginAttemptDoc>(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    ip: { type: String },
    success: { type: Boolean, required: true },
    at: { type: Date, required: true, default: () => new Date() },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, collection: "loginAttempts", autoIndex: false },
);
loginAttemptSchema.plugin(tenantScopePlugin);

/* ── passwordResetTokens ─────────────────────────────────────────────────── */

export interface PasswordResetTokenDoc {
  _id: Types.ObjectId;
  tenantId: string;
  userId: string;
  /** SHA-256 digest. The plaintext lives only in the link we email; we can verify, never reveal. */
  tokenHash: string;
  expiresAt: Date;
  /** Set the moment it is spent. A reset token is single-use — a second use is refused. */
  usedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const passwordResetTokenSchema = new Schema<PasswordResetTokenDoc>(
  {
    userId: { type: String, required: true },
    tokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date },
  },
  { timestamps: true, collection: "passwordResetTokens", autoIndex: false },
);
passwordResetTokenSchema.plugin(tenantScopePlugin);

/* ── model accessors (bound to the request's tenant connection) ──────────── */

export function getCredentialModel(conn: Connection): Model<CredentialDoc> {
  return (
    (conn.models.Credential as Model<CredentialDoc>) ??
    conn.model<CredentialDoc>("Credential", credentialSchema)
  );
}

export function getPasswordHistoryModel(conn: Connection): Model<PasswordHistoryDoc> {
  return (
    (conn.models.PasswordHistory as Model<PasswordHistoryDoc>) ??
    conn.model<PasswordHistoryDoc>("PasswordHistory", passwordHistorySchema)
  );
}

export function getSessionModel(conn: Connection): Model<SessionDoc> {
  return (
    (conn.models.Session as Model<SessionDoc>) ?? conn.model<SessionDoc>("Session", sessionSchema)
  );
}

export function getRefreshTokenModel(conn: Connection): Model<RefreshTokenDoc> {
  return (
    (conn.models.RefreshToken as Model<RefreshTokenDoc>) ??
    conn.model<RefreshTokenDoc>("RefreshToken", refreshTokenSchema)
  );
}

export function getMfaSecretModel(conn: Connection): Model<MfaSecretDoc> {
  return (
    (conn.models.MfaSecret as Model<MfaSecretDoc>) ??
    conn.model<MfaSecretDoc>("MfaSecret", mfaSecretSchema)
  );
}

export function getLoginAttemptModel(conn: Connection): Model<LoginAttemptDoc> {
  return (
    (conn.models.LoginAttempt as Model<LoginAttemptDoc>) ??
    conn.model<LoginAttemptDoc>("LoginAttempt", loginAttemptSchema)
  );
}

export function getPasswordResetTokenModel(conn: Connection): Model<PasswordResetTokenDoc> {
  return (
    (conn.models.PasswordResetToken as Model<PasswordResetTokenDoc>) ??
    conn.model<PasswordResetTokenDoc>("PasswordResetToken", passwordResetTokenSchema)
  );
}
