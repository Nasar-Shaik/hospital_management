/**
 * JWT access tokens (ADR-0009, HS256).
 *
 * Claims are exactly what ADR-0009 specifies: `{userId, tenantId, roles, branchIds}`.
 * Permissions are deliberately NOT in the token — they are resolved per request
 * from the cache/DB (Phase 1C), so revoking a permission takes effect
 * immediately instead of waiting out the token's life.
 *
 * `tid` is the load-bearing claim: `authenticate` rejects any token whose `tid`
 * differs from the host-resolved tenant (HMS-TEN-003). Host and token are two
 * independent factors, and both must agree before a handler runs.
 *
 * Verification is stateless — no database on the hot path (ADR-0009 consequence).
 */
import { jwtVerify, SignJWT, type JWTPayload } from "jose";
import { env } from "../../config/env.js";
import { newId } from "./tokens.js";

const ALGORITHM = "HS256";
const secret = new TextEncoder().encode(env.API_JWT_SECRET);

/** `access` authorizes requests; `mfa` only authorizes completing an MFA challenge. */
export type TokenType = "access" | "mfa";

export interface AccessTokenClaims {
  /** userId */
  sub: string;
  /** tenant registry id — must match the host-resolved tenant */
  tid: string;
  tsl: string;
  /**
   * The actor's email. Carried in the token purely so that every audit entry can
   * name a human without a database read on the write path (Doc 09 §9). It is not
   * a secret — it is the holder's own address — and it is never used for identity:
   * `sub` is who you are, this is only how the trail spells it.
   */
  eml?: string;
  roles: string[];
  branchIds: string[];
  typ: TokenType;
  /** token id — used by the Redis revocation blocklist on logout */
  jti: string;
  exp: number;
}

export interface SignAccessTokenInput {
  userId: string;
  tenantId: string;
  tenantSlug: string;
  email?: string;
  roles: string[];
  branchIds: string[];
}

export interface SignedToken {
  token: string;
  jti: string;
  expiresAt: Date;
  expiresInSeconds: number;
}

async function sign(
  payload: JWTPayload,
  typ: TokenType,
  ttlSeconds: number,
  subject: string,
): Promise<SignedToken> {
  const jti = newId();
  const now = Math.floor(Date.now() / 1000);
  const exp = now + ttlSeconds;

  const token = await new SignJWT({ ...payload, typ })
    .setProtectedHeader({ alg: ALGORITHM })
    .setIssuer(env.API_JWT_ISSUER)
    .setSubject(subject)
    .setJti(jti)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(secret);

  return { token, jti, expiresAt: new Date(exp * 1000), expiresInSeconds: ttlSeconds };
}

export async function signAccessToken(input: SignAccessTokenInput): Promise<SignedToken> {
  return sign(
    {
      tid: input.tenantId,
      tsl: input.tenantSlug,
      ...(input.email ? { eml: input.email } : {}),
      roles: input.roles,
      branchIds: input.branchIds,
    },
    "access",
    env.ACCESS_TOKEN_TTL_SECONDS,
    input.userId,
  );
}

/**
 * Issued when the password is correct but MFA is still outstanding. It carries
 * no roles and is accepted ONLY by the MFA-verify endpoint, so a stolen
 * challenge token cannot be used as an access token.
 */
export async function signMfaChallengeToken(input: {
  userId: string;
  tenantId: string;
  tenantSlug: string;
}): Promise<SignedToken> {
  return sign(
    { tid: input.tenantId, tsl: input.tenantSlug, roles: [], branchIds: [] },
    "mfa",
    env.MFA_CHALLENGE_TTL_SECONDS,
    input.userId,
  );
}

/**
 * Verifies signature, issuer and expiry, and asserts the token is of the
 * expected type. Throws on any failure — callers map that to HMS-AUTH-002.
 */
export async function verifyToken(token: string, expected: TokenType): Promise<AccessTokenClaims> {
  const { payload } = await jwtVerify(token, secret, {
    algorithms: [ALGORITHM],
    issuer: env.API_JWT_ISSUER,
  });

  const claims = payload as unknown as AccessTokenClaims;
  if (claims.typ !== expected) {
    throw new Error(`token type mismatch: expected ${expected}, got ${String(claims.typ)}`);
  }
  return claims;
}
