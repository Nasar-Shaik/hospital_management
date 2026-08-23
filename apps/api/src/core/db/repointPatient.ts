/**
 * Re-point a collection's `patientId` references from a merged record to its survivor.
 *
 * ── WHY THIS LIVES IN core/db AND NOT IN patients ───────────────────────────
 * A patient merge (patient.service.ts) declares two rows to be the same person and
 * publishes `patient.patients.merged`. EVERY module that stores a `patientId` must
 * then re-point its own references — but the patients module must NOT know the name
 * of every collection that will ever reference a patient (PLATFORM_STRATEGY Rule P1,
 * and the Constitution's "a collection is queried in exactly ONE repository"). So the
 * MECHANISM is shared and generic; the module keeps ownership by passing its OWN
 * model. This helper never names a collection — the caller does.
 *
 * ── IDEMPOTENT BY CONSTRUCTION ──────────────────────────────────────────────
 * Delivery is at-least-once (ADR-0007). After the first pass no row matches `from`
 * (they now hold `to`), so a redelivery re-points zero rows. Re-pointing an
 * already-re-pointed reference is a no-op, which is exactly the guarantee the merge
 * catalog entry demands of consumers.
 *
 * Tenant scope and the soft-delete filter are applied by tenantScopePlugin's
 * `pre("updateMany")` hook, so this only ever touches the current tenant's live rows.
 */
import { Types, type Model, type RootFilterQuery, type UpdateQuery } from "mongoose";

export interface PatientMergeRef {
  /** The merged (duplicate) patient id — the reference we are moving away from. */
  from: string;
  /** The survivor — the reference we are moving to. */
  to: string;
}

/**
 * `updateMany({ patientId: from }, { $set: { patientId: to } })` on one collection.
 *
 * `objectId` states how the collection stores the reference: most clinical collections
 * use `Schema.Types.ObjectId`, but several (appointments, the MAR, consultation notes,
 * theatre bookings, insurance, portal users) store the id as a string.
 *
 * ── WHAT THIS FLAG DOES AND DOES NOT PROTECT (measured, not assumed) ────────
 * This comment used to say a mismatch "silently matches nothing". That was tested by
 * flipping theatres from `false` to `true`, and the rows still moved: the caller passes
 * a Mongoose MODEL, and Mongoose casts a query value to the schema's declared type, so
 * it quietly repairs the wrong flag. The flag is therefore documentation-with-teeth
 * rather than a correctness switch here — it stays required so the type is stated
 * rather than guessed, and `patientMergeCoverage.int.test.ts` checks every declaration
 * against the real schema, which is what actually catches a wrong one.
 *
 * It WOULD matter for a raw collection handle, which bypasses casting. Do not use one.
 *
 * Returns the number of rows moved, for the merge's log trail.
 */
export async function repointPatientId<T>(
  model: Model<T>,
  field: string,
  ref: PatientMergeRef,
  opts: { objectId: boolean },
): Promise<number> {
  const from = opts.objectId ? new Types.ObjectId(ref.from) : ref.from;
  const to = opts.objectId ? new Types.ObjectId(ref.to) : ref.to;
  // `field` is a runtime string, so the filter/update are built dynamically and cast to
  // the model's shape — the caller guarantees `field` is the collection's patient reference.
  const filter = { [field]: from } as unknown as RootFilterQuery<T>;
  const update = { $set: { [field]: to } } as unknown as UpdateQuery<T>;
  const res = await model.updateMany(filter, update);
  return res.modifiedCount;
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE REGISTER OF PATIENT REFERENCES
 *
 * The rule at the top of this file — every module that stores a `patientId`
 * re-points its own references — protected only what somebody remembered to
 * wire up. Nothing stopped a new collection from carrying a patient and never
 * appearing in the fan-out, and for thirteen collections across eleven modules
 * that is exactly what happened: the merge fired, most of the record moved, and
 * the rest sat on a chart marked `merged` with no error anywhere.
 *
 * So the same device `clinicalInvariants.ts` uses for unique indexes is used
 * here. Every collection whose schema declares a patient reference must be in
 * ONE of the two lists below: re-pointed, or exempt with a reason. The guard
 * (`patientMergeCoverage.int.test.ts`) reads the real schemas off a provisioned
 * tenant and fails if it finds a collection in neither — and fails the other
 * way too, if an entry here no longer matches a schema.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface PatientReference {
  /** The Mongo collection, as the schema declares it. */
  collection: string;
  /** The module whose consumer moves it. One module may own several collections. */
  module: string;
  /** How the reference is stored. A mismatch matches nothing and moves zero rows, silently. */
  as: "ObjectId" | "string";
}

/** Every collection a merge re-points, and who re-points it. */
export const REPOINTED_PATIENT_REFERENCES: readonly PatientReference[] = [
  { collection: "encounters", module: "encounters", as: "ObjectId" },
  { collection: "episodesOfCare", module: "encounters", as: "ObjectId" },
  { collection: "appointments", module: "appointments", as: "string" },
  { collection: "orders", module: "orders", as: "ObjectId" },
  { collection: "reportFiles", module: "reports", as: "ObjectId" },
  { collection: "prescriptions", module: "prescriptions", as: "ObjectId" },
  { collection: "dispenses", module: "pharmacy", as: "ObjectId" },
  { collection: "vitals", module: "vitals", as: "ObjectId" },
  { collection: "allergies", module: "allergies", as: "ObjectId" },
  { collection: "wardNotes", module: "admissions", as: "ObjectId" },
  { collection: "documents", module: "documents", as: "ObjectId" },
  { collection: "charges", module: "billing", as: "ObjectId" },
  { collection: "invoices", module: "billing", as: "ObjectId" },
  { collection: "packageEnrollments", module: "billing", as: "ObjectId" },
  { collection: "walletAccounts", module: "wallet", as: "ObjectId" },
  { collection: "walletEntries", module: "wallet", as: "ObjectId" },
  { collection: "consultationNotes", module: "consultations", as: "string" },
  { collection: "medicationAdministrations", module: "mar", as: "string" },
  { collection: "encounterCodings", module: "mrd", as: "ObjectId" },
  { collection: "edTriage", module: "emergency", as: "ObjectId" },
  { collection: "otBookings", module: "theatres", as: "string" },
  { collection: "insurancePolicies", module: "insurance", as: "string" },
  { collection: "insuranceClaims", module: "insurance", as: "string" },
  { collection: "consents", module: "medicolegal", as: "ObjectId" },
  { collection: "deathRecords", module: "medicolegal", as: "ObjectId" },
  { collection: "mortuaryRegister", module: "mortuary", as: "ObjectId" },
  { collection: "ambulanceTrips", module: "ambulance", as: "string" },
  { collection: "feedbackTickets", module: "feedback", as: "string" },
  { collection: "problems", module: "problems", as: "ObjectId" },
  { collection: "users", module: "users", as: "string" },
] as const;

/**
 * Collections that hold a patient reference and MUST NOT be re-pointed. Each is here because
 * moving it would be the bug, not because nobody got round to it.
 */
export const EXEMPT_PATIENT_REFERENCES: readonly { collection: string; why: string }[] = [
  {
    collection: "auditLogs",
    why:
      "an audit entry records what was true WHEN IT HAPPENED, and the entries are hash-chained. " +
      "Re-pointing one would both rewrite history and break the chain, so the trail would report " +
      "tampering on the row a merge touched. The merge writes its OWN entry instead.",
  },
  {
    collection: "outboxEvents",
    why:
      "a published event is a record of what was published. Rewriting a payload after the fact " +
      "would make the ledger disagree with what consumers actually received, and consumers dedupe " +
      "on eventId regardless.",
  },
] as const;
