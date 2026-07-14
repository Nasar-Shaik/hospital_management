/**
 * Platform repository — the only code that touches `platformUsers` and
 * `platformAuditLogs` (both in the MASTER database, never a tenant's).
 */
import { getMasterConnection } from "../../core/db/masterDb.js";
import {
  getPlatformAuditModel,
  getPlatformUserModel,
  type PlatformRole,
  type PlatformUserDoc,
  type PlatformUserStatus,
} from "./platform.model.js";

/** What the rest of the system may see. Never the raw document — it holds the hash. */
export interface PlatformUser {
  id: string;
  email: string;
  name: string;
  roles: PlatformRole[];
  status: PlatformUserStatus;
  mfaEnabled: boolean;
  mustChangePassword: boolean;
  lastLoginAt?: Date;
}

function toUser(doc: PlatformUserDoc): PlatformUser {
  return {
    id: doc._id.toString(),
    email: doc.email,
    name: doc.name,
    roles: doc.roles,
    status: doc.status,
    mfaEnabled: doc.mfaEnabled,
    mustChangePassword: doc.mustChangePassword,
    ...(doc.lastLoginAt ? { lastLoginAt: doc.lastLoginAt } : {}),
  };
}

export async function findPlatformUserById(id: string): Promise<PlatformUser | undefined> {
  const model = getPlatformUserModel(await getMasterConnection());
  const doc = await model.findById(id);
  return doc ? toUser(doc) : undefined;
}

/** Returns the hash too — ONLY the login path may call this. */
export async function findCredentialByEmail(
  email: string,
): Promise<(PlatformUser & { passwordHash: string }) | undefined> {
  const model = getPlatformUserModel(await getMasterConnection());
  const doc = await model.findOne({ email: email.toLowerCase().trim() });
  return doc ? { ...toUser(doc), passwordHash: doc.passwordHash } : undefined;
}

export async function createPlatformUser(input: {
  email: string;
  name: string;
  passwordHash: string;
  roles: PlatformRole[];
  mustChangePassword?: boolean;
}): Promise<PlatformUser> {
  const model = getPlatformUserModel(await getMasterConnection());
  const doc = await model.create({
    ...input,
    status: "active",
    mfaEnabled: false,
    mustChangePassword: input.mustChangePassword ?? true,
  });
  return toUser(doc);
}

export async function countPlatformUsers(): Promise<number> {
  const model = getPlatformUserModel(await getMasterConnection());
  return model.countDocuments({});
}

export async function listPlatformUsers(): Promise<PlatformUser[]> {
  const model = getPlatformUserModel(await getMasterConnection());
  const docs = await model.find({}).sort({ createdAt: 1 });
  return docs.map(toUser);
}

export async function recordPlatformLogin(id: string): Promise<void> {
  const model = getPlatformUserModel(await getMasterConnection());
  await model.updateOne({ _id: id }, { lastLoginAt: new Date() });
}

export async function setPlatformPassword(
  id: string,
  passwordHash: string,
  mustChangePassword: boolean,
): Promise<void> {
  const model = getPlatformUserModel(await getMasterConnection());
  await model.updateOne({ _id: id }, { passwordHash, mustChangePassword });
}

/* ── the operator audit trail ─────────────────────────────────────────────── */

export interface PlatformAuditInput {
  action: string;
  actorId?: string;
  actorEmail?: string;
  tenantSlug?: string;
  outcome?: "success" | "failure";
  meta?: Record<string, unknown>;
  ip?: string;
  traceId?: string;
}

export async function recordPlatformAudit(input: PlatformAuditInput): Promise<void> {
  const model = getPlatformAuditModel(await getMasterConnection());
  await model.create({
    at: new Date(),
    outcome: input.outcome ?? "success",
    ...input,
  });
}

export interface PlatformAuditEntry {
  id: string;
  at: Date;
  actorEmail?: string;
  action: string;
  tenantSlug?: string;
  outcome: "success" | "failure";
  meta?: Record<string, unknown>;
  ip?: string;
}

export async function listPlatformAudit(limit: number): Promise<PlatformAuditEntry[]> {
  const model = getPlatformAuditModel(await getMasterConnection());
  const docs = await model.find({}).sort({ at: -1 }).limit(limit);
  return docs.map((doc) => ({
    id: doc._id.toString(),
    at: doc.at,
    ...(doc.actorEmail ? { actorEmail: doc.actorEmail } : {}),
    action: doc.action,
    ...(doc.tenantSlug ? { tenantSlug: doc.tenantSlug } : {}),
    outcome: doc.outcome,
    ...(doc.meta ? { meta: doc.meta } : {}),
    ...(doc.ip ? { ip: doc.ip } : {}),
  }));
}
