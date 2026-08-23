/**
 * User repository — the ONLY code that queries the `users` collection
 * (Constitution §6: no module reaches MongoDB outside a repository).
 *
 * Every query runs on the request-scoped tenant connection, so a user lookup is
 * physically incapable of crossing hospitals.
 */
import { Types } from "mongoose";
import type { StaffProfile, UserDoc, UserStatus } from "./user.model.js";
import { getUserModel } from "./user.model.js";
import { getTenantDb } from "../../core/context/requestContext.js";
import { repointPatientId, type PatientMergeRef } from "../../core/db/repointPatient.js";

/** What the rest of the system is allowed to see. Never the raw Mongoose document (Doc 09 §5). */
export interface User {
  id: string;
  email: string;
  name: string;
  status: UserStatus;
  mfaEnabled: boolean;
  phone?: string;
  employeeId?: string;
  profile?: StaffProfile;
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
    ...(doc.profile ? { profile: doc.profile } : {}),
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
  profile?: StaffProfile;
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

export interface UpdateUserInput {
  name?: string;
  phone?: string;
  employeeId?: string;
  profile?: StaffProfile;
}

export async function update(userId: string, input: UpdateUserInput): Promise<User | undefined> {
  /**
   * `profile` is set as a whole. The controller merges the incoming fields onto the
   * existing profile before calling this, so a partial edit never silently drops the
   * fields it did not include — a lesson worth stating because "PATCH replaced my whole
   * profile with two fields" is the classic partial-update bug.
   */
  const doc = await getUserModel(getTenantDb()).findOneAndUpdate({ _id: userId }, input, {
    new: true,
  });
  return doc ? toUser(doc) : undefined;
}

/**
 * How many staff accounts this hospital occupies — the live count behind the
 * seat limit (Doc 07). Counted, never cached: a drifted counter that over-reports
 * would lock a hospital out of hiring.
 */
export async function count(
  options: { excludeStatuses?: UserStatus[]; ids?: string[] } = {},
): Promise<number> {
  const query: Record<string, unknown> = {};
  if (options.excludeStatuses?.length) {
    query.status = { $nin: options.excludeStatuses };
  }
  /**
   * Narrows the count to a named set — how "how many DOCTORS?" is answered without this module
   * learning what a doctor is. RBAC supplies the ids that hold the role; this counts the ones
   * that are still real accounts. An empty set counts zero rather than everything: `$in: []`
   * matches nothing, which is the honest reading of "none of them hold that role".
   */
  if (options.ids) {
    query._id = {
      $in: options.ids
        .filter((id) => Types.ObjectId.isValid(id))
        .map((id) => new Types.ObjectId(id)),
    };
  }
  return getUserModel(getTenantDb()).countDocuments(query);
}

export interface ListUsersFilter {
  page: number;
  limit: number;
  q?: string;
  status?: UserStatus;
  /**
   * Ids to leave out, applied BEFORE paging so the page numbers and the total agree with what is
   * shown. The caller decides who these are — `users` deliberately knows nothing about branches
   * (the binding lives in `rbac`), so this stays a plain id list rather than a scope concept.
   */
  excludeIds?: string[];
}

export interface UserPage {
  users: User[];
  total: number;
}

export async function list(filter: ListUsersFilter): Promise<UserPage> {
  const model = getUserModel(getTenantDb());

  const query: Record<string, unknown> = {};
  if (filter.status) query.status = filter.status;
  if (filter.excludeIds && filter.excludeIds.length > 0) query._id = { $nin: filter.excludeIds };
  if (filter.q) {
    // Anchored, escaped: an unescaped user string in a regex is both a
    // correctness bug and a ReDoS vector.
    const safe = filter.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query.$or = [
      { name: { $regex: safe, $options: "i" } },
      { email: { $regex: `^${safe}`, $options: "i" } },
    ];
  }

  const [docs, total] = await Promise.all([
    model
      .find(query)
      .sort({ createdAt: -1 })
      .skip((filter.page - 1) * filter.limit)
      .limit(filter.limit),
    model.countDocuments(query),
  ]);

  return { users: docs.map(toUser), total };
}

/**
 * A patient-portal login follows the chart it can read.
 *
 * Nothing writes `patientId` today — the portal is declared and not built — so this re-points zero
 * rows and will keep doing so until it ships. It is here rather than on an exemption list because
 * of what the alternative costs: the day the portal lands, a merged patient keeps a login pointing
 * at a chart marked `merged`, and the symptom is a patient who signs in to an empty record. An
 * exemption written today would still be sitting there on that day.
 *
 * If BOTH records had a login, both now reach the survivor. Two accounts for one human is untidy
 * and correct; one account reaching a retired chart is neither.
 *
 * `patientId` is a STRING.
 */
export async function repointPatient(ref: PatientMergeRef): Promise<number> {
  return repointPatientId(getUserModel(getTenantDb()), "patientId", ref, { objectId: false });
}
