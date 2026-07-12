/**
 * Auth service (ADR-0009). Framework-free: it reads the tenant from the request
 * context, never from `req` (Doc 09 §11).
 *
 * The two properties this file exists to guarantee:
 *
 *  1. LOGIN IS NOT AN ORACLE. Unknown email, wrong password, disabled account and
 *     locked account all produce the identical HMS-AUTH-001 response, and the
 *     unknown-email path still pays the cost of an argon2 verification so the
 *     timing does not leak existence either.
 *
 *  2. A STOLEN REFRESH TOKEN CANNOT BE USED TWICE. Rotation is a compare-and-swap
 *     on `usedAt`; the second presentation of any token — by the thief or by the
 *     victim, whoever is second — revokes the entire family. The legitimate user
 *     gets logged out, which is the point: a silent theft becomes a visible one.
 */
import { randomUUID } from "node:crypto";
import { Secret, TOTP } from "otpauth";
import { env } from "../../config/env.js";
import { getContext } from "../../core/context/requestContext.js";
import {
  InvalidCredentialsError,
  MfaRequiredError,
  SessionExpiredError,
  TenantMismatchError,
  TokenReuseDetectedError,
  AppError,
} from "../../core/errors/appError.js";
import {
  checkPasswordPolicy,
  hashPassword,
  needsRehash,
  verifyPassword,
} from "../../core/crypto/password.js";
import {
  digestToken,
  generateOpaqueToken,
  generateRecoveryCodes,
  newId,
} from "../../core/crypto/tokens.js";
import { decryptField, encryptField } from "../../core/crypto/fieldEncryption.js";
import { signAccessToken, signMfaChallengeToken, verifyToken } from "../../core/crypto/jwt.js";
import { cacheKeys, cacheSet } from "../../core/redis/redis.js";
import * as users from "../users/index.js";
import type { User } from "../users/index.js";
import { getRoleClaims } from "../rbac/index.js";
import * as repo from "./auth.repository.js";
import type { Session } from "./auth.repository.js";

/**
 * A real argon2 hash of a value nobody knows. Verifying against it makes the
 * "no such user" path cost the same as the "wrong password" path (~50ms), so an
 * attacker cannot enumerate accounts with a stopwatch.
 */
let dummyHashPromise: Promise<string> | undefined;
function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(randomUUID());
  return dummyHashPromise;
}

export interface DeviceInfo {
  ip?: string;
  userAgent?: string;
  device?: string;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  roles: string[];
  branchIds: string[];
  mfaEnabled: boolean;
  mustChangePassword: boolean;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Access-token life in seconds; the client refreshes before it elapses. */
  expiresIn: number;
  user: AuthenticatedUser;
}

/** Password was right, but the account demands a second factor first. */
export interface MfaChallenge {
  mfaRequired: true;
  mfaToken: string;
  expiresIn: number;
}

export type LoginResult = TokenPair | MfaChallenge;

export function isMfaChallenge(result: LoginResult): result is MfaChallenge {
  return "mfaRequired" in result;
}

/* ── login ───────────────────────────────────────────────────────────────── */

const lockoutWindowMs = (): number => env.LOGIN_LOCKOUT_MINUTES * 60_000;

/**
 * Auto-unlock: a lock is a time window, not a permanent state. A user locked out
 * at 09:00 with a 15-minute window is `active` again at 09:15 without an admin
 * touching anything (STATE_MACHINE_CATALOG §12).
 */
async function resolveLockState(user: User): Promise<User> {
  if (user.status !== "locked") return user;
  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) return user;
  return users.transitionStatus(user.id, "active");
}

async function registerFailure(email: string, device: DeviceInfo, user?: User): Promise<void> {
  await repo.recordLoginAttempt({
    email,
    ...(device.ip ? { ip: device.ip } : {}),
    success: false,
    // The ledger outlives the lockout window so the last failure is still
    // readable when we compute `lockedUntil`.
    expiresAt: new Date(Date.now() + lockoutWindowMs() * 4),
  });

  if (!user) return;

  const failures = await repo.countRecentFailures(email, new Date(Date.now() - lockoutWindowMs()));
  if (failures >= env.LOGIN_MAX_ATTEMPTS && user.status === "active") {
    await users.transitionStatus(user.id, "locked", new Date(Date.now() + lockoutWindowMs()));
  }
}

export async function login(
  email: string,
  password: string,
  device: DeviceInfo = {},
): Promise<LoginResult> {
  const normalized = email.toLowerCase().trim();
  const found = await users.getByEmail(normalized);
  const user = found ? await resolveLockState(found) : undefined;

  // Still locked → refuse without even checking the password, so a brute-forcer
  // gains nothing by continuing, and record nothing (a locked account must not
  // be lockable *further* by an attacker; that would be a denial-of-service on
  // the real owner).
  if (user?.status === "locked") {
    throw new InvalidCredentialsError({ lockedUntil: user.lockedUntil });
  }

  const credential = user ? await repo.findCredential(user.id) : undefined;

  // One verification always runs — real hash when we have one, decoy otherwise.
  const passwordOk = await verifyPassword(
    credential?.passwordHash ?? (await dummyHash()),
    password,
  );

  // `invited` has no password yet, `disabled`/`archived` may not log in.
  if (!user || !credential || user.status !== "active" || !passwordOk) {
    await registerFailure(normalized, device, user);
    throw new InvalidCredentialsError();
  }

  await repo.recordLoginAttempt({
    email: normalized,
    ...(device.ip ? { ip: device.ip } : {}),
    success: true,
    expiresAt: new Date(Date.now() + lockoutWindowMs() * 4),
  });
  await repo.clearFailures(normalized);
  await users.recordLogin(user.id);

  // Transparent KDF upgrade: when we raise argon2 parameters, users are migrated
  // one successful login at a time, with no forced reset.
  if (needsRehash(credential.passwordHash)) {
    await repo.upsertCredential({
      userId: user.id,
      passwordHash: await hashPassword(password),
      mustChangePassword: credential.mustChangePassword,
    });
  }

  const mfa = user.mfaEnabled ? await repo.findMfaSecret(user.id) : undefined;
  if (mfa?.confirmedAt) {
    const ctx = getContext();
    const challenge = await signMfaChallengeToken({
      userId: user.id,
      tenantId: ctx.tenantId,
      tenantSlug: ctx.tenantSlug,
    });
    return {
      mfaRequired: true,
      mfaToken: challenge.token,
      expiresIn: challenge.expiresInSeconds,
    };
  }

  return issueTokens(user, credential.mustChangePassword, device);
}

/* ── token issuance ──────────────────────────────────────────────────────── */

async function issueTokens(
  user: User,
  mustChangePassword: boolean,
  device: DeviceInfo,
): Promise<TokenPair> {
  const ctx = getContext();
  const claims = await getRoleClaims(user.id);

  const family = newId();
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);

  const session = await repo.createSession({
    userId: user.id,
    family,
    ...(device.device ? { device: device.device } : {}),
    ...(device.ip ? { ip: device.ip } : {}),
    ...(device.userAgent ? { userAgent: device.userAgent } : {}),
    expiresAt,
  });

  const refreshToken = generateOpaqueToken();
  await repo.createRefreshToken({
    userId: user.id,
    sessionId: session.id,
    family,
    tokenHash: digestToken(refreshToken),
    expiresAt,
  });

  const access = await signAccessToken({
    userId: user.id,
    tenantId: ctx.tenantId,
    tenantSlug: ctx.tenantSlug,
    roles: claims.roles,
    branchIds: claims.branchIds,
  });

  return {
    accessToken: access.token,
    refreshToken,
    expiresIn: access.expiresInSeconds,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      roles: claims.roles,
      branchIds: claims.branchIds,
      mfaEnabled: user.mfaEnabled,
      mustChangePassword,
    },
  };
}

/* ── refresh (rotation + reuse detection) ────────────────────────────────── */

/** Burns a family completely: its sessions and every token descended from it. */
async function burnFamily(family: string): Promise<void> {
  await repo.revokeRefreshFamily(family);
  await repo.revokeSessionFamily(family);
}

export async function refresh(presentedToken: string, device: DeviceInfo = {}): Promise<TokenPair> {
  const stored = await repo.findRefreshTokenByHash(digestToken(presentedToken));
  if (!stored) throw new SessionExpiredError();

  // REUSE: this token was already exchanged. Either it was stolen and the thief
  // is second, or it was stolen and the victim is second — we cannot tell, and
  // it does not matter. The family dies.
  if (stored.usedAt) {
    await burnFamily(stored.family);
    throw new TokenReuseDetectedError({ family: stored.family });
  }

  // REVOKED but never used: the family was already killed deliberately — logout,
  // session revocation, or a password change. Distinguishing this from reuse
  // matters: replaying a token after logout is ordinary client behaviour, and
  // reporting it as HMS-AUTH-003 would fire a security alert on a non-event.
  if (stored.revokedAt) throw new SessionExpiredError({ reason: "session revoked" });

  if (stored.expiresAt.getTime() <= Date.now()) throw new SessionExpiredError();

  const session = await repo.findSessionById(stored.userId, stored.sessionId);
  if (!session || session.revokedAt) throw new SessionExpiredError();

  const user = await users.getById(stored.userId);
  if (!user || user.status !== "active") {
    // A disabled or archived user must not be able to keep refreshing.
    await burnFamily(stored.family);
    throw new SessionExpiredError();
  }

  // Rotate: mint the successor, then compare-and-swap the predecessor to spent.
  const nextToken = generateOpaqueToken();
  const created = await repo.createRefreshToken({
    userId: stored.userId,
    sessionId: stored.sessionId,
    family: stored.family,
    tokenHash: digestToken(nextToken),
    expiresAt: stored.expiresAt, // rotation does NOT extend the family's life
  });

  const won = await repo.markRefreshTokenUsed(stored.id, created.id);
  if (!won) {
    // Someone else spent this exact token between our read and our write. That
    // is the race a thief creates; the family dies, including the successor we
    // just minted (same family).
    await burnFamily(stored.family);
    throw new TokenReuseDetectedError({ family: stored.family });
  }

  await repo.touchSession(stored.family);

  const ctx = getContext();
  const claims = await getRoleClaims(user.id);
  const credential = await repo.findCredential(user.id);
  const access = await signAccessToken({
    userId: user.id,
    tenantId: ctx.tenantId,
    tenantSlug: ctx.tenantSlug,
    roles: claims.roles,
    branchIds: claims.branchIds,
  });

  void device; // device info is captured at login; rotation keeps the session's

  return {
    accessToken: access.token,
    refreshToken: nextToken,
    expiresIn: access.expiresInSeconds,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      roles: claims.roles,
      branchIds: claims.branchIds,
      mfaEnabled: user.mfaEnabled,
      mustChangePassword: credential?.mustChangePassword ?? false,
    },
  };
}

/* ── logout & sessions ───────────────────────────────────────────────────── */

/**
 * Revokes the presented refresh-token family and blocklists the current access
 * token. Blocklisting matters because access tokens are verified statelessly:
 * without it, a logged-out token stays valid for up to its remaining life.
 *
 * If Redis is unavailable the blocklist write fails soft, and revocation
 * degrades to "effective within the access-token TTL" (≤15 min) — the bound
 * ADR-0009 already accepts. Refresh is revoked in Mongo regardless, so the
 * session cannot be extended.
 */
export async function logout(input: {
  refreshToken?: string;
  accessJti?: string;
  accessExpiresAt?: number;
}): Promise<void> {
  if (input.refreshToken) {
    const stored = await repo.findRefreshTokenByHash(digestToken(input.refreshToken));
    if (stored) await burnFamily(stored.family);
  }

  if (input.accessJti && input.accessExpiresAt) {
    const ttl = Math.max(1, input.accessExpiresAt - Math.floor(Date.now() / 1000));
    await cacheSet(cacheKeys.revokedToken(input.accessJti), 1, ttl);
  }
}

export async function listSessions(userId: string): Promise<Session[]> {
  return repo.listActiveSessions(userId);
}

/** Revokes one session (a device) — "sign out my other laptop". */
export async function revokeSession(userId: string, sessionId: string): Promise<void> {
  const session = await repo.findSessionById(userId, sessionId);
  if (!session) throw new AppError("HMS-GEN-404", 404, "Session not found", { sessionId });
  await burnFamily(session.family);
}

/** Nuclear option: every device, everywhere. Used after a password change. */
export async function revokeAllSessions(userId: string): Promise<void> {
  await repo.revokeAllRefreshTokens(userId);
  await repo.revokeAllSessions(userId);
}

/* ── passwords ───────────────────────────────────────────────────────────── */

async function assertPasswordAcceptable(userId: string, newPassword: string): Promise<void> {
  const failures = checkPasswordPolicy(newPassword);
  if (failures.length > 0) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", { password: failures });
  }

  // Reuse check must compare against HASHES, one verify per historical entry —
  // there is no way to do this with an equality query, and that is by design.
  const history = await repo.recentPasswordHashes(userId, env.PASSWORD_HISTORY_SIZE);
  for (const previous of history) {
    if (await verifyPassword(previous, newPassword)) {
      throw new AppError("HMS-VAL-001", 400, "Validation failed", {
        password: [
          `must not repeat any of your last ${String(env.PASSWORD_HISTORY_SIZE)} passwords`,
        ],
      });
    }
  }
}

/**
 * Sets a password without knowing the old one — for invitation acceptance and
 * admin/operator resets. Never expose this on a route that a user reaches
 * without proving who they are.
 */
export async function setPassword(
  userId: string,
  newPassword: string,
  options: { mustChangePassword?: boolean } = {},
): Promise<void> {
  await assertPasswordAcceptable(userId, newPassword);

  const passwordHash = await hashPassword(newPassword);
  await repo.upsertCredential({
    userId,
    passwordHash,
    ...(options.mustChangePassword !== undefined
      ? { mustChangePassword: options.mustChangePassword }
      : {}),
  });
  await repo.addPasswordHistory(userId, passwordHash, env.PASSWORD_HISTORY_SIZE);
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const credential = await repo.findCredential(userId);
  if (!credential || !(await verifyPassword(credential.passwordHash, currentPassword))) {
    throw new InvalidCredentialsError();
  }

  await setPassword(userId, newPassword, { mustChangePassword: false });

  // A password change is a trust boundary: every existing session was minted
  // under the old secret, so all of them die. The caller re-logs in.
  await revokeAllSessions(userId);
}

/* ── MFA (TOTP) ──────────────────────────────────────────────────────────── */

function totpFor(secretBase32: string, email: string): TOTP {
  return new TOTP({
    issuer: env.API_JWT_ISSUER,
    label: email,
    algorithm: "SHA1", // RFC 6238 default — what every authenticator app implements
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secretBase32),
  });
}

export interface MfaSetupResult {
  /** Feed to a QR code. Contains the seed — treat as a secret in transit and in logs. */
  otpauthUrl: string;
  /** For manual entry when the camera fails. */
  secret: string;
}

/**
 * Begins enrolment. The secret is stored ENCRYPTED and UNCONFIRMED: until the
 * user proves they can generate a code from it, MFA is not active — otherwise a
 * failed enrolment would lock the user out of their own account.
 */
export async function setupMfa(userId: string): Promise<MfaSetupResult> {
  const user = await users.getById(userId);
  if (!user) throw new AppError("HMS-GEN-404", 404, "User not found", { userId });

  const secret = new Secret({ size: 20 }).base32;
  await repo.upsertMfaSecret({ userId, secret: encryptField(secret) });

  return { otpauthUrl: totpFor(secret, user.email).toString(), secret };
}

export interface MfaActivationResult {
  /** Shown exactly once. We store only digests, so they cannot be re-displayed. */
  recoveryCodes: string[];
}

export async function activateMfa(userId: string, code: string): Promise<MfaActivationResult> {
  const user = await users.getById(userId);
  const stored = await repo.findMfaSecret(userId);
  if (!user || !stored) {
    throw new AppError("HMS-GEN-404", 404, "No pending MFA enrolment", { userId });
  }

  const totp = totpFor(decryptField(stored.secret), user.email);
  if (totp.validate({ token: code, window: 1 }) === null) {
    throw new InvalidCredentialsError({ mfa: "invalid code" });
  }

  const recoveryCodes = generateRecoveryCodes();
  await repo.confirmMfaSecret(userId, recoveryCodes.map(digestToken));
  await users.setMfaEnabled(userId, true);

  return { recoveryCodes };
}

/**
 * Completes a login that stopped at the MFA gate. The challenge token proves the
 * password step already succeeded; it carries no roles and is rejected anywhere
 * an access token is expected.
 */
export async function verifyMfaChallenge(
  mfaToken: string,
  code: string,
  device: DeviceInfo = {},
): Promise<TokenPair> {
  const ctx = getContext();

  let claims;
  try {
    claims = await verifyToken(mfaToken, "mfa");
  } catch {
    throw new SessionExpiredError({ reason: "MFA challenge expired — start again" });
  }
  // The challenge was issued for one hospital; it may not be redeemed at another.
  if (claims.tid !== ctx.tenantId) throw new TenantMismatchError();

  const user = await users.getById(claims.sub);
  const stored = await repo.findMfaSecret(claims.sub);
  if (!user || user.status !== "active" || !stored?.confirmedAt)
    throw new InvalidCredentialsError();

  const totp = totpFor(decryptField(stored.secret), user.email);
  const codeOk = totp.validate({ token: code, window: 1 }) !== null;
  const recoveryOk = codeOk ? false : await repo.consumeRecoveryCode(claims.sub, digestToken(code));

  if (!codeOk && !recoveryOk) throw new InvalidCredentialsError({ mfa: "invalid code" });

  const credential = await repo.findCredential(user.id);
  return issueTokens(user, credential?.mustChangePassword ?? false, device);
}

/** Disabling MFA re-proves the password: an unlocked laptop must not be enough. */
export async function disableMfa(userId: string, password: string): Promise<void> {
  const credential = await repo.findCredential(userId);
  if (!credential || !(await verifyPassword(credential.passwordHash, password))) {
    throw new InvalidCredentialsError();
  }
  await repo.deleteMfaSecret(userId);
  await users.setMfaEnabled(userId, false);
}

/** Throws HMS-AUTH-004 when a privileged action demands MFA the user has not set up. */
export function assertMfaEnrolled(user: { mfaEnabled: boolean }): void {
  if (!user.mfaEnabled) throw new MfaRequiredError({ reason: "enrol in MFA to continue" });
}

/* ── the "who am I" projection ───────────────────────────────────────────── */

export async function getCurrentUser(userId: string): Promise<AuthenticatedUser> {
  const user = await users.getById(userId);
  if (!user) throw new AppError("HMS-GEN-404", 404, "User not found", { userId });

  const claims = await getRoleClaims(userId);
  const credential = await repo.findCredential(userId);

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    roles: claims.roles,
    branchIds: claims.branchIds,
    mfaEnabled: user.mfaEnabled,
    mustChangePassword: credential?.mustChangePassword ?? false,
  };
}

export type { Session };
