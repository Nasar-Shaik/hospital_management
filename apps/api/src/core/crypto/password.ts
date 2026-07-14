/**
 * Password hashing + policy (ADR-0009, Constitution §11).
 *
 * argon2id — memory-hard, the current OWASP recommendation. Parameters follow
 * the OWASP minimum (19 MiB, t=2, p=1); they are encoded INTO the hash string,
 * so raising them later re-hashes users transparently on their next successful
 * login (`needsRehash`) rather than invalidating every credential.
 *
 * No credential ever leaves this module in plaintext, and nothing here is
 * hand-rolled crypto — that is forbidden (Constitution §11).
 */
import { randomInt } from "node:crypto";
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";
import { env } from "../../config/env.js";

/**
 * `Algorithm.Argon2id` is an ambient const enum, which `isolatedModules` forbids
 * importing as a value — so the variant is pinned by its numeric value rather
 * than left to the library's default. `hashPassword` asserts the result, so a
 * library change that silently altered this would fail immediately, not quietly.
 */
const ARGON2ID = 2;

/** OWASP argon2id baseline. Changing these is a security decision — record it in an ADR. */
const ARGON_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456, // KiB (19 MiB)
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plaintext: string): Promise<string> {
  const digest = await argonHash(plaintext, ARGON_OPTIONS);
  if (!digest.startsWith("$argon2id$")) {
    throw new Error(`expected an argon2id hash, got ${digest.slice(0, 12)}`);
  }
  return digest;
}

/**
 * Constant-time-ish verification (argon2 handles the comparison internally).
 * A malformed stored hash returns false rather than throwing: an unreadable
 * credential must fail closed, not 500.
 */
export async function verifyPassword(storedHash: string, plaintext: string): Promise<boolean> {
  try {
    return await argonVerify(storedHash, plaintext, ARGON_OPTIONS);
  } catch {
    return false;
  }
}

/** True when the stored hash was produced with weaker parameters than we now require. */
export function needsRehash(storedHash: string): boolean {
  const m = /\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)/.exec(storedHash);
  if (!m) return true; // unknown/legacy format → upgrade on next login
  const [, memory, time, parallelism] = m;
  return (
    Number(memory) < ARGON_OPTIONS.memoryCost ||
    Number(time) < ARGON_OPTIONS.timeCost ||
    Number(parallelism) < ARGON_OPTIONS.parallelism
  );
}

/**
 * Password policy. Returns the list of unmet requirements — empty means valid.
 * Length is the dominant factor, so the floor is 12 (env-tunable upward, never
 * below 8 — enforced by the env schema).
 */
export function checkPasswordPolicy(plaintext: string): string[] {
  const failures: string[] = [];
  if (plaintext.length < env.PASSWORD_MIN_LENGTH) {
    failures.push(`must be at least ${env.PASSWORD_MIN_LENGTH} characters`);
  }

  /**
   * Complexity can be switched off for LOCAL DEVELOPMENT ONLY, so a developer can
   * type `123456` fifty times a day instead of a 20-character passphrase.
   *
   * It cannot be switched off in production: `loadEnv` overrides the flag when
   * `NODE_ENV=production` and logs loudly if configuration tried to weaken it
   * (see config/env.ts). This is the difference between a convenience and a
   * vulnerability — the weak path exists, but there is no configuration, no
   * environment variable and no deploy mistake that can reach it in a hospital.
   */
  if (env.PASSWORD_REQUIRE_COMPLEXITY) {
    if (!/[a-z]/.test(plaintext)) failures.push("must contain a lowercase letter");
    if (!/[A-Z]/.test(plaintext)) failures.push("must contain an uppercase letter");
    if (!/\d/.test(plaintext)) failures.push("must contain a digit");
    if (!/[^A-Za-z0-9]/.test(plaintext)) failures.push("must contain a symbol");
  }

  return failures;
}

// Ambiguous glyphs (I/l/1, O/0) are excluded — these passwords get read aloud,
// written down, and typed from paper.
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER = "abcdefghijkmnopqrstuvwxyz";
const DIGITS = "23456789";
const SYMBOLS = "!@#$%^&*-_=+";

/**
 * A temporary password for an invited user or an admin reset. It satisfies the
 * policy BY CONSTRUCTION rather than by retrying until it happens to pass, and
 * it is generated with a CSPRNG — `Math.random()` here would be a real
 * vulnerability, not a style problem.
 */
export function generatePassword(length = 20): string {
  const alphabet = UPPER + LOWER + DIGITS + SYMBOLS;
  const required = [
    UPPER[randomInt(UPPER.length)],
    LOWER[randomInt(LOWER.length)],
    DIGITS[randomInt(DIGITS.length)],
    SYMBOLS[randomInt(SYMBOLS.length)],
  ];
  const rest = Array.from(
    { length: Math.max(0, length - required.length) },
    () => alphabet[randomInt(alphabet.length)],
  );

  // Shuffle, so the guaranteed characters aren't always in the first four slots.
  const chars = [...required, ...rest];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j] as string, chars[i] as string];
  }
  return chars.join("");
}
