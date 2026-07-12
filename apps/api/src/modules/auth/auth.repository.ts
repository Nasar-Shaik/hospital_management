/**
 * Auth repository — the only code that queries the auth collections.
 *
 * Repositories return plain data, never Mongoose documents, so a credential hash
 * can never be serialized into a response by accident (Doc 09 §5).
 */
import type { Connection } from "mongoose";
import { getTenantDb } from "../../core/context/requestContext.js";
import {
  getCredentialModel,
  getLoginAttemptModel,
  getMfaSecretModel,
  getPasswordHistoryModel,
  getRefreshTokenModel,
  getSessionModel,
} from "./auth.model.js";

const db = (): Connection => getTenantDb();

/* ── credentials ─────────────────────────────────────────────────────────── */

export interface StoredCredential {
  userId: string;
  passwordHash: string;
  mustChangePassword: boolean;
  passwordChangedAt: Date;
}

export async function findCredential(userId: string): Promise<StoredCredential | undefined> {
  const doc = await getCredentialModel(db()).findOne({ userId });
  if (!doc) return undefined;
  return {
    userId: doc.userId,
    passwordHash: doc.passwordHash,
    mustChangePassword: doc.mustChangePassword,
    passwordChangedAt: doc.passwordChangedAt,
  };
}

export async function upsertCredential(input: {
  userId: string;
  passwordHash: string;
  mustChangePassword?: boolean;
}): Promise<void> {
  await getCredentialModel(db()).findOneAndUpdate(
    { userId: input.userId },
    {
      userId: input.userId,
      passwordHash: input.passwordHash,
      algo: "argon2id",
      passwordChangedAt: new Date(),
      mustChangePassword: input.mustChangePassword ?? false,
    },
    { upsert: true },
  );
}

/* ── password history ────────────────────────────────────────────────────── */

export async function recentPasswordHashes(userId: string, limit: number): Promise<string[]> {
  const docs = await getPasswordHistoryModel(db())
    .find({ userId })
    .sort({ createdAt: -1 })
    .limit(limit);
  return docs.map((d) => d.passwordHash);
}

export async function addPasswordHistory(
  userId: string,
  passwordHash: string,
  keep: number,
): Promise<void> {
  const model = getPasswordHistoryModel(db());
  await model.create({ userId, passwordHash });

  // Keep the window bounded — history exists to block reuse, not to archive.
  const stale = await model.find({ userId }).sort({ createdAt: -1 }).skip(keep).select({ _id: 1 });
  if (stale.length > 0) {
    await model.deleteMany({ _id: { $in: stale.map((d) => d._id) } });
  }
}

/* ── sessions ────────────────────────────────────────────────────────────── */

export interface Session {
  id: string;
  userId: string;
  family: string;
  device?: string;
  ip?: string;
  userAgent?: string;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt?: Date;
  createdAt: Date;
}

export async function createSession(input: {
  userId: string;
  family: string;
  device?: string;
  ip?: string;
  userAgent?: string;
  expiresAt: Date;
}): Promise<Session> {
  const doc = await getSessionModel(db()).create(input);
  return {
    id: doc._id.toString(),
    userId: doc.userId,
    family: doc.family,
    ...(doc.device ? { device: doc.device } : {}),
    ...(doc.ip ? { ip: doc.ip } : {}),
    ...(doc.userAgent ? { userAgent: doc.userAgent } : {}),
    lastSeenAt: doc.lastSeenAt,
    expiresAt: doc.expiresAt,
    createdAt: doc.createdAt,
  };
}

/** Active sessions for the "where am I logged in?" screen. */
export async function listActiveSessions(userId: string): Promise<Session[]> {
  const docs = await getSessionModel(db())
    .find({ userId, revokedAt: { $exists: false }, expiresAt: { $gt: new Date() } })
    .sort({ lastSeenAt: -1 });

  return docs.map((doc) => ({
    id: doc._id.toString(),
    userId: doc.userId,
    family: doc.family,
    ...(doc.device ? { device: doc.device } : {}),
    ...(doc.ip ? { ip: doc.ip } : {}),
    ...(doc.userAgent ? { userAgent: doc.userAgent } : {}),
    lastSeenAt: doc.lastSeenAt,
    expiresAt: doc.expiresAt,
    createdAt: doc.createdAt,
  }));
}

export async function findSessionById(
  userId: string,
  sessionId: string,
): Promise<Session | undefined> {
  const doc = await getSessionModel(db()).findOne({ _id: sessionId, userId });
  if (!doc) return undefined;
  return {
    id: doc._id.toString(),
    userId: doc.userId,
    family: doc.family,
    ...(doc.device ? { device: doc.device } : {}),
    ...(doc.ip ? { ip: doc.ip } : {}),
    ...(doc.userAgent ? { userAgent: doc.userAgent } : {}),
    lastSeenAt: doc.lastSeenAt,
    expiresAt: doc.expiresAt,
    ...(doc.revokedAt ? { revokedAt: doc.revokedAt } : {}),
    createdAt: doc.createdAt,
  };
}

export async function touchSession(family: string): Promise<void> {
  await getSessionModel(db()).updateOne({ family }, { lastSeenAt: new Date() });
}

export async function revokeSessionFamily(family: string): Promise<void> {
  await getSessionModel(db()).updateOne(
    { family, revokedAt: { $exists: false } },
    { revokedAt: new Date() },
  );
}

export async function revokeAllSessions(userId: string): Promise<void> {
  await getSessionModel(db()).updateMany(
    { userId, revokedAt: { $exists: false } },
    { revokedAt: new Date() },
  );
}

/* ── refresh tokens ──────────────────────────────────────────────────────── */

export interface StoredRefreshToken {
  id: string;
  userId: string;
  sessionId: string;
  family: string;
  expiresAt: Date;
  usedAt?: Date;
  revokedAt?: Date;
}

export async function createRefreshToken(input: {
  userId: string;
  sessionId: string;
  family: string;
  tokenHash: string;
  expiresAt: Date;
}): Promise<StoredRefreshToken> {
  const doc = await getRefreshTokenModel(db()).create(input);
  return {
    id: doc._id.toString(),
    userId: doc.userId,
    sessionId: doc.sessionId,
    family: doc.family,
    expiresAt: doc.expiresAt,
  };
}

export async function findRefreshTokenByHash(
  tokenHash: string,
): Promise<StoredRefreshToken | undefined> {
  const doc = await getRefreshTokenModel(db()).findOne({ tokenHash });
  if (!doc) return undefined;
  return {
    id: doc._id.toString(),
    userId: doc.userId,
    sessionId: doc.sessionId,
    family: doc.family,
    expiresAt: doc.expiresAt,
    ...(doc.usedAt ? { usedAt: doc.usedAt } : {}),
    ...(doc.revokedAt ? { revokedAt: doc.revokedAt } : {}),
  };
}

/**
 * Atomically marks a token spent. The `usedAt: {$exists:false}` guard makes this
 * a compare-and-swap: two concurrent refreshes with the same token race here,
 * exactly one wins, and the loser is treated as reuse. Without the guard, a
 * stolen token could be replayed in the window between read and write.
 */
export async function markRefreshTokenUsed(
  tokenId: string,
  replacedByTokenId: string,
): Promise<boolean> {
  const result = await getRefreshTokenModel(db()).updateOne(
    { _id: tokenId, usedAt: { $exists: false }, revokedAt: { $exists: false } },
    { usedAt: new Date(), replacedByTokenId },
  );
  return result.modifiedCount === 1;
}

/** Reuse response: burn the entire lineage descended from that login. */
export async function revokeRefreshFamily(family: string): Promise<number> {
  const result = await getRefreshTokenModel(db()).updateMany(
    { family, revokedAt: { $exists: false } },
    { revokedAt: new Date() },
  );
  return result.modifiedCount;
}

export async function revokeAllRefreshTokens(userId: string): Promise<void> {
  await getRefreshTokenModel(db()).updateMany(
    { userId, revokedAt: { $exists: false } },
    { revokedAt: new Date() },
  );
}

/* ── MFA ─────────────────────────────────────────────────────────────────── */

export interface StoredMfaSecret {
  userId: string;
  /** Still encrypted — decryption happens in the service, at the last moment. */
  secret: string;
  confirmedAt?: Date;
  recoveryCodeHashes: string[];
}

export async function findMfaSecret(userId: string): Promise<StoredMfaSecret | undefined> {
  const doc = await getMfaSecretModel(db()).findOne({ userId });
  if (!doc) return undefined;
  return {
    userId: doc.userId,
    secret: doc.secret,
    ...(doc.confirmedAt ? { confirmedAt: doc.confirmedAt } : {}),
    recoveryCodeHashes: doc.recoveryCodeHashes,
  };
}

export async function upsertMfaSecret(input: {
  userId: string;
  secret: string;
  recoveryCodeHashes?: string[];
}): Promise<void> {
  await getMfaSecretModel(db()).findOneAndUpdate(
    { userId: input.userId },
    {
      userId: input.userId,
      type: "totp",
      secret: input.secret,
      recoveryCodeHashes: input.recoveryCodeHashes ?? [],
      // A re-enrolment resets confirmation: a pending secret must never inherit
      // the trusted state of the one it replaces.
      $unset: { confirmedAt: 1 },
    },
    { upsert: true },
  );
}

export async function confirmMfaSecret(
  userId: string,
  recoveryCodeHashes: string[],
): Promise<void> {
  await getMfaSecretModel(db()).updateOne(
    { userId },
    { confirmedAt: new Date(), recoveryCodeHashes },
  );
}

/** Recovery codes are single-use: consuming one removes it. */
export async function consumeRecoveryCode(userId: string, codeHash: string): Promise<boolean> {
  const result = await getMfaSecretModel(db()).updateOne(
    { userId, recoveryCodeHashes: codeHash },
    { $pull: { recoveryCodeHashes: codeHash } },
  );
  return result.modifiedCount === 1;
}

export async function deleteMfaSecret(userId: string): Promise<void> {
  await getMfaSecretModel(db()).deleteOne({ userId });
}

/* ── login attempts (lockout ledger) ─────────────────────────────────────── */

export async function recordLoginAttempt(input: {
  email: string;
  ip?: string;
  success: boolean;
  expiresAt: Date;
}): Promise<void> {
  await getLoginAttemptModel(db()).create({ ...input, at: new Date() });
}

/** Failures since `since` — the lockout counter. */
export async function countRecentFailures(email: string, since: Date): Promise<number> {
  return getLoginAttemptModel(db()).countDocuments({
    email: email.toLowerCase().trim(),
    success: false,
    at: { $gte: since },
  });
}

export async function lastFailureAt(email: string): Promise<Date | undefined> {
  const doc = await getLoginAttemptModel(db())
    .findOne({ email: email.toLowerCase().trim(), success: false })
    .sort({ at: -1 });
  return doc?.at;
}

/** A successful login clears the counter — the lockout is for consecutive failures. */
export async function clearFailures(email: string): Promise<void> {
  await getLoginAttemptModel(db()).deleteMany({
    email: email.toLowerCase().trim(),
    success: false,
  });
}
