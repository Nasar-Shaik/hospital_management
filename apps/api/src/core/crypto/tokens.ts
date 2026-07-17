/**
 * Opaque token generation + digesting (ADR-0009).
 *
 * Refresh tokens, invitation tokens and password-reset tokens are HIGH-ENTROPY
 * random strings, not passwords. They are therefore digested with SHA-256, not
 * argon2: a slow KDF buys nothing against a 256-bit random secret, and it would
 * put an argon2 hash on the hot refresh path. What matters is that the plaintext
 * is never stored — a database leak must not yield usable tokens.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

/** 256 bits of entropy, URL-safe. Returned to the client ONCE and never stored. */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

/** What we persist. Deterministic, so lookup is a single indexed query. */
export function digestToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Compares digests without leaking position through timing. */
export function digestsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Token/session/family identifier. */
export function newId(): string {
  return randomUUID();
}

/**
 * MFA recovery codes — shown once at enrolment, stored digested. Formatted in
 * groups because a human has to copy them onto paper.
 */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = randomBytes(5).toString("hex").toUpperCase(); // 10 chars
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}
