/**
 * API-key repository — the ONLY code that queries `apiKeys` (Constitution §6).
 *
 * `keyHash` never leaves the module: the list projects it out, and the resolve path returns only
 * the identity a request needs. `tenantScopePlugin` supplies `tenantId`, so a key presented to one
 * hospital's host is looked up in that hospital's database and no other — cross-tenant use simply
 * finds nothing.
 */
import { Types } from "mongoose";
import { getContext, getTenantDb } from "../../core/context/requestContext.js";
import { getApiKeyModel, type ApiKeyDoc } from "./apiKey.model.js";

/** Metadata only — never the digest. What the management list is built from. */
export interface ApiKeyMeta {
  id: string;
  name: string;
  last4: string;
  createdBy: string;
  createdAt: Date;
  expiresAt?: Date;
  revokedAt?: Date;
  lastUsedAt?: Date;
}

function toMeta(doc: Omit<ApiKeyDoc, "keyHash">): ApiKeyMeta {
  return {
    id: doc._id.toString(),
    name: doc.name,
    last4: doc.last4,
    createdBy: doc.createdBy,
    createdAt: doc.createdAt,
    ...(doc.expiresAt ? { expiresAt: doc.expiresAt } : {}),
    ...(doc.revokedAt ? { revokedAt: doc.revokedAt } : {}),
    ...(doc.lastUsedAt ? { lastUsedAt: doc.lastUsedAt } : {}),
  };
}

export interface CreateApiKeyInput {
  name: string;
  keyHash: string;
  last4: string;
  userId: string;
  expiresAt?: Date;
}

export async function create(input: CreateApiKeyInput): Promise<ApiKeyMeta> {
  const ctx = getContext();
  const doc = await getApiKeyModel(getTenantDb()).create({
    tenantId: ctx.tenantId,
    name: input.name,
    keyHash: input.keyHash,
    last4: input.last4,
    userId: input.userId,
    createdBy: ctx.userId ?? "system",
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
  });
  return toMeta(doc.toObject() as ApiKeyDoc);
}

/** All of the hospital's keys, newest first — the management list. Digest projected out. */
export async function list(): Promise<ApiKeyMeta[]> {
  const docs = await getApiKeyModel(getTenantDb())
    .find({}, { keyHash: 0 })
    .sort({ createdAt: -1 })
    .lean<Omit<ApiKeyDoc, "keyHash">[]>();
  return docs.map(toMeta);
}

/** The identity a presented key resolves to — for the authenticate middleware. */
export interface ResolvedKey {
  id: string;
  userId: string;
  expiresAt?: Date;
}

/**
 * Resolves a presented key's digest to its identity, or `undefined` when the key is unknown,
 * revoked or expired. The single hot-path query; served by the `{tenantId, keyHash}` unique index.
 */
export async function resolveByHash(keyHash: string): Promise<ResolvedKey | undefined> {
  const doc = await getApiKeyModel(getTenantDb())
    .findOne({ keyHash }, { userId: 1, expiresAt: 1, revokedAt: 1 })
    .lean<Pick<ApiKeyDoc, "_id" | "userId" | "expiresAt" | "revokedAt">>();
  if (!doc) return undefined;
  if (doc.revokedAt) return undefined;
  if (doc.expiresAt && doc.expiresAt.getTime() <= Date.now()) return undefined;
  return {
    id: doc._id.toString(),
    userId: doc.userId,
    ...(doc.expiresAt ? { expiresAt: doc.expiresAt } : {}),
  };
}

/** Best-effort "last used" stamp — never on the request's critical path. */
export async function touch(id: string): Promise<void> {
  if (!Types.ObjectId.isValid(id)) return;
  await getApiKeyModel(getTenantDb())
    .updateOne({ _id: new Types.ObjectId(id) }, { $set: { lastUsedAt: new Date() } })
    .catch(() => undefined);
}

/** Revokes a key. Returns the updated metadata, or `undefined` if there was no such live key. */
export async function revoke(id: string): Promise<ApiKeyMeta | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getApiKeyModel(getTenantDb())
    .findOneAndUpdate(
      { _id: new Types.ObjectId(id), revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date() } },
      { new: true, projection: { keyHash: 0 } },
    )
    .lean<Omit<ApiKeyDoc, "keyHash">>();
  return doc ? toMeta(doc) : undefined;
}
