/**
 * Hospital-profile repository — the ONLY code that queries `hospitalProfile` (Constitution §6).
 *
 * The collection is a singleton per tenant (unique `{ tenantId }`, migration 0033), so there is no
 * id: the read is a `findOne` and the write is an upsert. `tenantScopePlugin` supplies the
 * `tenantId` on both, so it never appears here.
 */
import { getTenantDb } from "../../core/context/requestContext.js";
import {
  getHospitalProfileModel,
  type HospitalProfileDoc,
  type OwnershipType,
} from "./hospitalProfile.model.js";

export interface HospitalProfile {
  legalName?: string;
  registrationNumber?: string;
  taxId?: string;
  accreditations?: string[];
  establishedYear?: number;
  ownershipType?: OwnershipType;
  licensedBeds?: number;
  address?: string;
  officialEmail?: string;
  officialPhone?: string;
  website?: string;
  headName?: string;
  headTitle?: string;
}

function toProfile(doc: HospitalProfileDoc): HospitalProfile {
  return {
    ...(doc.legalName ? { legalName: doc.legalName } : {}),
    ...(doc.registrationNumber ? { registrationNumber: doc.registrationNumber } : {}),
    ...(doc.taxId ? { taxId: doc.taxId } : {}),
    ...(doc.accreditations?.length ? { accreditations: doc.accreditations } : {}),
    ...(doc.establishedYear != null ? { establishedYear: doc.establishedYear } : {}),
    ...(doc.ownershipType ? { ownershipType: doc.ownershipType } : {}),
    ...(doc.licensedBeds != null ? { licensedBeds: doc.licensedBeds } : {}),
    ...(doc.address ? { address: doc.address } : {}),
    ...(doc.officialEmail ? { officialEmail: doc.officialEmail } : {}),
    ...(doc.officialPhone ? { officialPhone: doc.officialPhone } : {}),
    ...(doc.website ? { website: doc.website } : {}),
    ...(doc.headName ? { headName: doc.headName } : {}),
    ...(doc.headTitle ? { headTitle: doc.headTitle } : {}),
  };
}

/** The saved profile, or `undefined` when the admin has never saved one (a valid, handled state). */
export async function getProfile(): Promise<HospitalProfile | undefined> {
  const doc = await getHospitalProfileModel(getTenantDb()).findOne({}).lean<HospitalProfileDoc>();
  return doc ? toProfile(doc) : undefined;
}

/**
 * Upserts the singleton. `$set` on provided keys and `$unset` on the ones explicitly cleared, so a
 * field the admin blanks is removed rather than left stale; `upsert` materialises the first save.
 */
export async function upsertProfile(patch: HospitalProfile): Promise<HospitalProfile> {
  const set: Record<string, unknown> = {};
  const unset: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    const empty =
      value == null ||
      (typeof value === "string" && value.trim() === "") ||
      (Array.isArray(value) && value.length === 0);
    if (empty) unset[key] = "";
    else set[key] = value;
  }

  const update: Record<string, unknown> = {};
  if (Object.keys(set).length) update.$set = set;
  if (Object.keys(unset).length) update.$unset = unset;

  const doc = await getHospitalProfileModel(getTenantDb())
    .findOneAndUpdate({}, update, { new: true, upsert: true, setDefaultsOnInsert: true })
    .lean<HospitalProfileDoc>();
  if (!doc) throw new Error("hospital profile upsert returned nothing");
  return toProfile(doc);
}
