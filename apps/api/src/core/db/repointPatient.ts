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
 * `objectId` MUST match how the collection stores the reference: most clinical
 * collections use `Schema.Types.ObjectId`, but a few (appointments, portal users)
 * store the id as a string. A mismatch silently matches nothing — hence the flag is
 * required, not guessed.
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
