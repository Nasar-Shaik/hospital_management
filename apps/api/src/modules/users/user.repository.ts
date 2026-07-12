/**
 * User repository — the ONLY code that queries the `users` collection
 * (Constitution §6: no module reaches MongoDB outside a repository).
 *
 * Every query runs on the request-scoped tenant connection, so a user lookup is
 * physically incapable of crossing hospitals.
 */
import type { UserDoc, UserStatus } from "./user.model.js";
import { getUserModel } from "./user.model.js";
import { getTenantDb } from "../../core/context/requestContext.js";

/** What the rest of the system is allowed to see. Never the raw Mongoose document (Doc 09 §5). */
export interface User {
  id: string;
  email: string;
  name: string;
  status: UserStatus;
  mfaEnabled: boolean;
  phone?: string;
  employeeId?: string;
  patientId?: string;
  lastLoginAt?: Date;
  lockedUntil?: Date;
}

function toUser(doc: UserDoc): User {
  return {
    id: doc._id.toString(),
    email: doc.email,
    name: doc.name,
    status: doc.status,
    mfaEnabled: doc.mfaEnabled,
    ...(doc.phone ? { phone: doc.phone } : {}),
    ...(doc.employeeId ? { employeeId: doc.employeeId } : {}),
    ...(doc.patientId ? { patientId: doc.patientId } : {}),
    ...(doc.lastLoginAt ? { lastLoginAt: doc.lastLoginAt } : {}),
    ...(doc.lockedUntil ? { lockedUntil: doc.lockedUntil } : {}),
  };
}

export async function findByEmail(email: string): Promise<User | undefined> {
  const doc = await getUserModel(getTenantDb()).findOne({ email: email.toLowerCase().trim() });
  return doc ? toUser(doc) : undefined;
}

export async function findById(userId: string): Promise<User | undefined> {
  const doc = await getUserModel(getTenantDb()).findById(userId);
  return doc ? toUser(doc) : undefined;
}

export interface CreateUserInput {
  email: string;
  name: string;
  status?: UserStatus;
  phone?: string;
  employeeId?: string;
  patientId?: string;
}

export async function create(input: CreateUserInput): Promise<User> {
  const doc = await getUserModel(getTenantDb()).create({
    ...input,
    status: input.status ?? "invited",
    mfaEnabled: false,
  });
  return toUser(doc);
}

export async function updateStatus(
  userId: string,
  status: UserStatus,
  lockedUntil?: Date,
): Promise<User | undefined> {
  const doc = await getUserModel(getTenantDb()).findOneAndUpdate(
    { _id: userId },
    status === "locked" ? { status, lockedUntil } : { status, $unset: { lockedUntil: 1 } },
    { new: true },
  );
  return doc ? toUser(doc) : undefined;
}

export async function setMfaEnabled(userId: string, enabled: boolean): Promise<void> {
  await getUserModel(getTenantDb()).updateOne({ _id: userId }, { mfaEnabled: enabled });
}

export async function recordLogin(userId: string): Promise<void> {
  await getUserModel(getTenantDb()).updateOne(
    { _id: userId },
    { lastLoginAt: new Date(), $unset: { lockedUntil: 1 } },
  );
}
