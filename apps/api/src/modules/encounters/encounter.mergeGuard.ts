/**
 * What the encounters module has to say about a proposed patient merge.
 *
 * One rule, and it is the only precondition on a merge anywhere in the product: **two open visits
 * cannot become one patient.** `one_open_encounter_per_patient` (clinicalInvariants.ts) allows a
 * patient at most one open encounter, so re-pointing the duplicate's onto a survivor who already
 * has one is a duplicate key error — raised inside the merge fan-out, after every other module has
 * already moved its references. See `core/policy/mergeGuards.ts` for the whole shape of that
 * failure and why this is a refusal rather than a repair.
 *
 * It REFUSES and does nothing else. Which of the two visits is the real one is a clinical decision
 * — the same one the MPI already stops and asks a human to make — and a merge that silently closed
 * somebody's visit to make itself possible would be making that decision on their behalf.
 */
import { AppError } from "../../core/errors/appError.js";
import type { MergeGuard } from "../../core/policy/mergeGuards.js";
import * as repo from "./encounter.repository.js";

export const openVisitMergeGuard: MergeGuard = async (survivorId, duplicateId) => {
  const [survivorOpen, duplicateOpen] = await Promise.all([
    repo.findOpenForPatient(survivorId),
    repo.findOpenForPatient(duplicateId),
  ]);

  // Only the collision is refused. One open visit is the ordinary case and merges cleanly — the
  // duplicate's encounter simply moves, which is what a merge is for.
  if (!survivorOpen || !duplicateOpen) return;

  throw new AppError(
    "HMS-PAT-003",
    409,
    "Both patients have an open visit — close one before merging",
    {
      survivorId,
      duplicateId,
      survivorEncounterId: survivorOpen.id,
      duplicateEncounterId: duplicateOpen.id,
      hint:
        "close or cancel one of the two visits, then merge. Which visit is the real one is a " +
        "clinical decision, and the merge will not make it for you.",
    },
  );
};
