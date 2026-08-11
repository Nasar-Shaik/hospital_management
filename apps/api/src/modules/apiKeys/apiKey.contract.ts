/**
 * API key response contracts.
 *
 * `ApiKeyMeta` never carries the key. `CreatedApiKey` does, exactly once, on the response to the
 * call that made it — there is no route that can return it again, because only its hash is stored.
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves } from "../../core/http/contract.js";
import type { ApiKeyMeta } from "./apiKey.repository.js";
import type { CreatedApiKey } from "./apiKey.service.js";

const apiKeyFields = {
  id: z.string(),
  name: z.string(),
  /** The last four characters, so a person can tell two keys apart in a list. */
  last4: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
  expiresAt: z.string().optional(),
  revokedAt: z.string().optional(),
  lastUsedAt: z.string().optional(),
};

export const apiKeyMeta = contract("ApiKeyMeta", z.object(apiKeyFields));
export type ApiKeyMetaProof = Proves<Matches<typeof apiKeyMeta, ApiKeyMeta>>;

export const createdApiKey = contract(
  "CreatedApiKey",
  z.object({ ...apiKeyFields, key: z.string() }),
);
export type CreatedApiKeyProof = Proves<Matches<typeof createdApiKey, CreatedApiKey>>;
