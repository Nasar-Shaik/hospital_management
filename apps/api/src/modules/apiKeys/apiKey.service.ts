/**
 * API-key service — issuing, listing, resolving and revoking a hospital's API keys (A9).
 *
 * The full key is assembled and returned to the creator exactly ONCE, here. Everywhere else only
 * its digest and last 4 characters exist, so there is no path — not the list, not a re-fetch — by
 * which the plaintext can be read again. A lost key is revoked and replaced, never recovered.
 */
import { AppError } from "../../core/errors/appError.js";
import { getContext } from "../../core/context/requestContext.js";
import { generateOpaqueToken, digestToken } from "../../core/crypto/tokens.js";
import * as repo from "./apiKey.repository.js";

export type { ApiKeyMeta } from "./apiKey.repository.js";

/** The prefix that lets `authenticate` tell a key from a JWT at a glance. `mk` = MediCore key. */
export const API_KEY_PREFIX = "mk_";

export const listApiKeys = repo.list;

export interface CreateApiKeyInput {
  name: string;
  /** Optional hard expiry (a Date). Absent means the key lives until revoked. */
  expiresAt?: Date;
}

export interface CreatedApiKey extends repo.ApiKeyMeta {
  /** The full key — shown ONCE, never stored, never returned again. */
  key: string;
}

export async function createApiKey(input: CreateApiKeyInput): Promise<CreatedApiKey> {
  const ctx = getContext();
  if (!ctx.userId) {
    // A key must bind to a real user — it inherits that user's authority.
    throw new AppError("HMS-AUTH-005", 403, "Insufficient permission", {
      hint: "an API key can only be created by a signed-in user",
    });
  }

  const key = `${API_KEY_PREFIX}${generateOpaqueToken()}`;
  const meta = await repo.create({
    name: input.name,
    keyHash: digestToken(key),
    last4: key.slice(-4),
    userId: ctx.userId,
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
  });

  return { ...meta, key };
}

export async function revokeApiKey(id: string): Promise<repo.ApiKeyMeta> {
  const revoked = await repo.revoke(id);
  if (!revoked) {
    throw new AppError("HMS-GEN-404", 404, "API key not found", {
      id,
      hint: "it may already be revoked",
    });
  }
  return revoked;
}

/**
 * Resolves a presented key to the user it acts as, or `undefined` when it is not a valid, live key.
 * Called by the authenticate middleware. Stamps `lastUsedAt` best-effort — a failure there never
 * fails the request.
 */
export async function resolveApiKey(
  presented: string,
): Promise<{ userId: string; keyId: string; expiresAt?: Date } | undefined> {
  if (!presented.startsWith(API_KEY_PREFIX)) return undefined;
  const resolved = await repo.resolveByHash(digestToken(presented));
  if (!resolved) return undefined;
  void repo.touch(resolved.id);
  return {
    userId: resolved.userId,
    keyId: resolved.id,
    ...(resolved.expiresAt ? { expiresAt: resolved.expiresAt } : {}),
  };
}
