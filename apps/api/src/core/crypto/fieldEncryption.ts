/**
 * Field-level encryption at rest — AES-256-GCM (Constitution §11).
 *
 * For secrets the application must be able to READ BACK: TOTP seeds today,
 * per-tenant integration credentials (payment/SMS/HL7 keys) later. Anything that
 * only needs verification (passwords, refresh tokens) is hashed instead — see
 * `password.ts` / `tokens.ts`. Never use this for a credential you can hash.
 *
 * GCM is authenticated: tampering with a stored ciphertext fails decryption
 * rather than yielding a silently wrong secret.
 *
 * Format: `v1.<iv-b64url>.<tag-b64url>.<ciphertext-b64url>` — the version prefix
 * exists so a future key rotation or algorithm change can be rolled out lazily.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../../config/env.js";

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit nonce — the GCM standard

let cachedKey: Buffer | undefined;

/** Accepts base64 or hex; must decode to exactly 32 bytes. Fails at first use, loudly. */
function key(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = env.API_ENCRYPTION_KEY;
  const decoded = /^[0-9a-f]{64}$/i.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64");
  if (decoded.length !== 32) {
    throw new Error(
      `API_ENCRYPTION_KEY must decode to 32 bytes (got ${String(decoded.length)}). Generate with: openssl rand -base64 32`,
    );
  }
  cachedKey = decoded;
  return cachedKey;
}

export function encryptField(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptField(encoded: string): string {
  const [version, ivB64, tagB64, dataB64] = encoded.split(".");
  if (version !== VERSION || !ivB64 || !tagB64 || !dataB64) {
    throw new Error("encrypted field is malformed or uses an unsupported version");
  }
  const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
