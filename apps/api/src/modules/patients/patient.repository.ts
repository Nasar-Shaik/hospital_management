/**
 * Patient repository — the ONLY code that queries `patients` (Constitution §6).
 *
 * Every query runs on the request-scoped tenant connection, so a patient lookup is physically
 * incapable of crossing hospitals. That wall is absolute and is not what the rest of this note is
 * about.
 *
 * ── BRANCH IS NOT A SECOND WALL HERE, AND THE SPLIT IS DELIBERATE ───────────
 * `scopeFilter()` is applied to some reads and NOT others, per ADR-0015 §5, which makes patient
 * identity tenant-level while operational records stay at their site:
 *
 *   IDENTITY, tenant-wide   `findByIdentity`, `findByUhid`, `findCandidates` (the MPI)
 *                           — who this person IS. One human, one UHID, across every site.
 *   REGISTER, branch-scoped `list` — a site's own book of patients; `branchId` is provenance and,
 *                           in the ADR's words, "the default list scope".
 *   WRITE, branch-scoped    `update` — see the note there; narrow while undecided.
 *
 * If you are here because a cross-branch read surprised you, read the block above `findByIdentity`
 * before changing anything: the wall that used to be there was measured, and it disclosed the same
 * record through the MPI while forcing a duplicate chart.
 */
import { Types, type ClientSession } from "mongoose";
import { getTenantDb, getContext } from "../../core/context/requestContext.js";
import { scopeFilter } from "../../middleware/authorize.js";
import { getPatientModel, nameKeyOf } from "./patient.model.js";
import type { BloodGroup, Gender, PatientDoc, PatientStatus } from "./patient.model.js";

/** What leaves the module. Never the raw Mongoose document (Doc 09 §5). */
export interface Patient {
  id: string;
  uhid: string;
  name: string;
  gender: Gender;
  status: PatientStatus;
  dob?: Date;
  bloodGroup?: BloodGroup;
  branchId?: string;
  contact: { phone?: string; email?: string };
  address?: {
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  };
  mergedInto?: string;
  mergedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

function toPatient(doc: PatientDoc): Patient {
  return {
    id: doc._id.toString(),
    uhid: doc.uhid,
    name: doc.name,
    gender: doc.gender,
    status: doc.status,
    contact: {
      ...(doc.contact?.phone ? { phone: doc.contact.phone } : {}),
      ...(doc.contact?.email ? { email: doc.contact.email } : {}),
    },
    ...(doc.dob ? { dob: doc.dob } : {}),
    ...(doc.bloodGroup ? { bloodGroup: doc.bloodGroup } : {}),
    ...(doc.branchId ? { branchId: doc.branchId } : {}),
    ...(doc.address ? { address: doc.address } : {}),
    ...(doc.mergedInto ? { mergedInto: doc.mergedInto.toString() } : {}),
    ...(doc.mergedAt ? { mergedAt: doc.mergedAt } : {}),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * Allocates the next UHID (Doc 03 §5.1: atomic `$inc`, never read-then-write).
 *
 * Runs INSIDE the caller's transaction on purpose, and that has a consequence
 * worth stating plainly: two clerks registering a patient at the same instant
 * contend on this one counter document, and one of them takes a write conflict
 * and is retried by `withTransaction`. Registration is therefore serialized per
 * hospital.
 *
 * That is the trade we want. The alternative — allocating the number outside the
 * transaction — never blocks, but burns a UHID every time a registration is
 * abandoned or fails, so the sequence grows holes. A hospital's UHIDs are audited,
 * quoted to patients and printed on wristbands; "why does our register jump from
 * 4417 to 4419" is a question nobody should have to answer. At registration
 * volumes (a few per minute at the busiest desk) the contention is invisible.
 *
 * A raw collection write: `counters` carries no schema and no plugins — a counter
 * bump is not an auditable clinical event, and auditing it would recurse.
 */
export async function nextUhid(session: ClientSession): Promise<string> {
  const ctx = getContext();

  const result = await ctx.connection
    .collection<{ _id: string; tenantId: string; seq: number }>("counters")
    .findOneAndUpdate(
      { _id: "uhid" },
      { $inc: { seq: 1 }, $setOnInsert: { tenantId: ctx.tenantId } },
      { upsert: true, returnDocument: "after", session },
    );

  const seq = result?.seq;
  if (typeof seq !== "number") {
    throw new Error("UHID allocation failed — refusing to register a patient without a UHID");
  }

  // Six digits covers a million patients; it widens on its own rather than
  // truncating, so the millionth patient gets UH1000000 and nothing breaks.
  return `UH${String(seq).padStart(6, "0")}`;
}

export interface CreatePatientInput {
  uhid: string;
  name: string;
  gender: Gender;
  dob?: Date;
  bloodGroup?: BloodGroup;
  branchId?: string;
  contact?: { phone?: string; email?: string };
  address?: Patient["address"];
  registeredBy?: string;
  duplicateOverride?: { at: Date; by: string; candidateIds: string[] };
}

export async function create(input: CreatePatientInput, session: ClientSession): Promise<Patient> {
  const [doc] = await getPatientModel(getTenantDb()).create(
    [
      {
        ...input,
        nameKey: nameKeyOf(input.name),
        contact: input.contact ?? {},
        status: "active",
      },
    ],
    { session },
  );

  if (!doc) throw new Error("patient insert returned no document");
  return toPatient(doc);
}

/**
 * ── IDENTITY IS TENANT-WIDE. DO NOT ADD `scopeFilter()` TO THESE TWO. ────────
 *
 * ADR-0015 §5 is normative and explicit: "`patient.branchId` is the REGISTERING branch —
 * provenance and the default list scope — **never** an ownership wall: lookup by UHID is
 * tenant-wide, so a patient registered in Hyderabad is found in Chennai." §7's scope table lists
 * patients and allergies as tenant-wide "Identity and safety", and says why in one line: "An
 * allergy that does not follow the patient to another site can kill them."
 *
 * Both reads below WERE branch-scoped, against that ADR, and the effect was measured rather than
 * argued. A branch-confined receptionist at Hyderabad, holding only `patient:read`:
 *
 *     GET  /patients/<chennai-id>          → 404          (the wall)
 *     POST /patients/check-duplicates      → 200, and returned that same Chennai patient with
 *                                            id, uhid, name, gender, contact, address, branchId
 *
 * The MPI (`findCandidates` below) has never been scoped and must never be — it is what stops a
 * second chart. So the wall disclosed the record through one route and withheld it through
 * another, under the SAME permission. It bought no privacy at all, and it cost the thing the ADR
 * exists to protect: the clerk could see the patient existed, could not open them, and the only
 * way forward was to register a second chart. A second chart means a second UHID and an EMPTY
 * allergy list, so the other site's medication round renders "None recorded" — which reads as
 * *cleared*, not as *unknown*.
 *
 * Widening these two does not widen anything else, and that is the whole safety argument. Every
 * operational record carries the TREATING branch and is filtered on its own read path —
 * encounters (`findOne({_id, ...scopeFilter()})`), orders, admissions, MAR, ward notes, and
 * vitals-by-encounter (scoped by resolving the encounter first, see `vitals.repository.ts`).
 * Resolving who a patient IS grants nothing about what was done to them, where.
 *
 * `session` is for the merge service, which resolves both sides inside its transaction.
 */
export async function findByIdentity(
  id: string,
  session?: ClientSession,
): Promise<Patient | undefined> {
  const doc = await getPatientModel(getTenantDb())
    .findById(id)
    .session(session ?? null);
  return doc ? toPatient(doc) : undefined;
}

/** The UHID IS the identity — the case ADR-0015 §5 names in so many words. See above. */
export async function findByUhid(uhid: string): Promise<Patient | undefined> {
  const doc = await getPatientModel(getTenantDb()).findOne({
    uhid: uhid.toUpperCase().trim(),
  });
  return doc ? toPatient(doc) : undefined;
}

export interface UpdatePatientInput {
  name?: string;
  gender?: Gender;
  dob?: Date;
  bloodGroup?: BloodGroup;
  contact?: { phone?: string; email?: string };
  address?: Patient["address"];
}

export async function update(
  id: string,
  input: UpdatePatientInput,
  session: ClientSession,
): Promise<Patient | undefined> {
  // `nameKey` is derived, so it must be rewritten whenever the name is — otherwise
  // the MPI keeps matching on the OLD name and a corrected spelling silently stops
  // being findable as a duplicate.
  const patch: Record<string, unknown> = { ...input };
  if (input.name) patch.nameKey = nameKeyOf(input.name);

  /**
   * Still branch-scoped, deliberately, and NOT widened alongside the identity reads above.
   *
   * ADR-0015 §5 makes identity tenant-wide; it says nothing about who may EDIT the demographic
   * record, and a write is the safe place to stay narrow while that is undecided. Correcting a
   * spelling or a phone number stays with the registering site.
   *
   * The asymmetry is real and known: a site treating a visiting patient can read them and cannot
   * correct their address. That is friction, not a safety gap, and widening a write nobody asked
   * to widen would be the engineer deciding policy. Flagged for a product decision rather than
   * taken here.
   */
  const doc = await getPatientModel(getTenantDb()).findOneAndUpdate(
    { _id: id, status: "active", ...scopeFilter() },
    patch,
    { new: true, session },
  );
  return doc ? toPatient(doc) : undefined;
}

/** Marks a record merged. The row is kept forever — see the merge service. */
export async function markMerged(
  id: string,
  survivorId: string,
  session: ClientSession,
): Promise<Patient | undefined> {
  const doc = await getPatientModel(getTenantDb()).findOneAndUpdate(
    { _id: id, status: "active" },
    { status: "merged", mergedInto: survivorId, mergedAt: new Date() },
    { new: true, session },
  );
  return doc ? toPatient(doc) : undefined;
}

/**
 * MPI candidate lookup — the query behind duplicate detection.
 *
 * Casts a WIDE net (any of: same phone, same normalized name, same date of birth)
 * and lets the scorer in `mpi.ts` decide. Recall matters more than precision here:
 * a candidate the clerk dismisses in half a second costs nothing, while a
 * duplicate that is never surfaced becomes a second chart with half the patient's
 * allergies on it.
 *
 * Merged records are excluded — they are already somebody else's duplicate, and
 * offering one as a merge target would build a chain.
 */
export async function findCandidates(criteria: {
  nameKey: string;
  phone?: string;
  dob?: Date;
  excludeId?: string;
}): Promise<Patient[]> {
  const or: Record<string, unknown>[] = [{ nameKey: criteria.nameKey }];
  if (criteria.phone) or.push({ "contact.phone": criteria.phone });
  if (criteria.dob) or.push({ dob: criteria.dob });

  const query: Record<string, unknown> = { status: "active", $or: or };
  if (criteria.excludeId) query._id = { $ne: criteria.excludeId };

  // Bounded: a common name at a large hospital could otherwise return thousands,
  // and no human reviews a list of thousands — they click through it.
  const docs = await getPatientModel(getTenantDb()).find(query).limit(25);
  return docs.map(toPatient);
}

export interface ListPatientsFilter {
  page: number;
  limit: number;
  q?: string;
  status?: PatientStatus;
  /** Half-open, already resolved to instants by the service — see `listPatients`. */
  createdFrom?: Date;
  createdBefore?: Date;
}

export async function list(
  filter: ListPatientsFilter,
): Promise<{ patients: Patient[]; total: number }> {
  const model = getPatientModel(getTenantDb());

  // Merged records are hidden by default: to a clerk they are not a patient, they
  // are an artifact of a mistake that has already been corrected.
  const query: Record<string, unknown> = { status: filter.status ?? "active", ...scopeFilter() };

  /**
   * Half-open — `$gte` the first instant of the first day, `$lt` the first instant of the day
   * AFTER the last. The alternative, `$lte` the last millisecond, is the classic off-by-one that
   * drops whoever registered at 23:59:59.7 on the closing day, and does it silently.
   *
   * Sorting is already `createdAt: -1`, so this narrows the same index the list is ordered by.
   */
  if (filter.createdFrom || filter.createdBefore) {
    query.createdAt = {
      ...(filter.createdFrom ? { $gte: filter.createdFrom } : {}),
      ...(filter.createdBefore ? { $lt: filter.createdBefore } : {}),
    };
  }

  if (filter.q) {
    // Escaped: an unescaped user string in a regex is both a correctness bug and
    // a ReDoS vector.
    const safe = filter.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query.$or = [
      { uhid: { $regex: `^${safe}`, $options: "i" } },
      { name: { $regex: safe, $options: "i" } },
      { "contact.phone": { $regex: `^${safe}` } },
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

  return { patients: docs.map(toPatient), total };
}

/** Live count — never stored (the A2 lesson: a drifted counter locks a hospital out). */
export async function count(): Promise<number> {
  return getPatientModel(getTenantDb()).countDocuments({ status: "active" });
}

/**
 * Resolve a set of patient ids to their display identity (UHID + name) in ONE query.
 *
 * For reports and activity panels that hold a list of patient ids and need to show who they are,
 * without N round-trips or dragging back the whole chart. Unknown or invalid ids are simply
 * absent from the result. Tenant-isolated by the query hook; no row scope, because a report is a
 * hospital-wide read (its caller is gated by the report permission, not this lookup).
 */
export async function namesByIds(
  ids: string[],
): Promise<{ id: string; uhid: string; name: string }[]> {
  const objectIds = ids
    .filter((id) => Types.ObjectId.isValid(id))
    .map((id) => new Types.ObjectId(id));
  if (objectIds.length === 0) return [];

  const docs = await getPatientModel(getTenantDb())
    .find({ _id: { $in: objectIds } }, { uhid: 1, name: 1 })
    .lean<{ _id: Types.ObjectId; uhid: string; name: string }[]>();

  return docs.map((d) => ({ id: d._id.toString(), uhid: d.uhid, name: d.name }));
}
