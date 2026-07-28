/**
 * Hospital-profile service (Module B1).
 *
 * Thin by design: the profile is reference data with no cross-document invariants, so the service is
 * a stable seam (validation lives in the schema, persistence in the repository). A read never fails
 * on a missing document — it returns an empty profile, which the editor renders as blank fields.
 */
import * as repo from "./hospitalProfile.repository.js";

export type { HospitalProfile } from "./hospitalProfile.repository.js";

/** The saved profile, or an empty object when none has been saved yet. */
export async function getProfile(): Promise<repo.HospitalProfile> {
  return (await repo.getProfile()) ?? {};
}

export async function saveProfile(patch: repo.HospitalProfile): Promise<repo.HospitalProfile> {
  return repo.upsertProfile(patch);
}
