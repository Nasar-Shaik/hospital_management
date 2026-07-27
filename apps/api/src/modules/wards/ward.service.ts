/**
 * Ward & bed service — configuring the hospital's bed inventory (Module B4).
 *
 * Thin over the repository: it turns a duplicate key into the hospital's own sentence ("that
 * ward already exists") rather than a 500, and it refuses the one nonsensical edit (blocking a
 * bed with no reason). Occupancy is NOT its concern — that is derived by the bed board.
 */
import { AppError } from "../../core/errors/appError.js";
import * as repo from "./ward.repository.js";

export type { Ward, Bed } from "./ward.repository.js";

export const listWards = repo.listWards;
export const listBeds = repo.listBeds;
export const getWard = repo.findWardById;
export const getBed = repo.findBedById;

export interface CreateWardInput {
  name: string;
  kind: repo.CreateWardInput["kind"];
  tariffCode: string;
}

export async function createWard(input: CreateWardInput): Promise<repo.Ward> {
  try {
    return await repo.createWard(input);
  } catch (err) {
    if (repo.isDuplicateKey(err)) {
      throw new AppError("HMS-VAL-001", 409, "That ward already exists", {
        name: input.name,
        hint: "ward names are unique per hospital — pick another",
      });
    }
    throw err;
  }
}

export async function updateWard(id: string, patch: repo.UpdateWardInput): Promise<repo.Ward> {
  const existing = await repo.findWardById(id);
  if (!existing) throw new AppError("HMS-GEN-404", 404, "Ward not found", { id });
  try {
    const updated = await repo.updateWard(id, patch);
    if (!updated) throw new AppError("HMS-GEN-404", 404, "Ward not found", { id });
    return updated;
  } catch (err) {
    if (repo.isDuplicateKey(err)) {
      throw new AppError("HMS-VAL-001", 409, "That ward already exists", {
        name: patch.name,
        hint: "ward names are unique per hospital — pick another",
      });
    }
    throw err;
  }
}

export interface CreateBedInput {
  wardId: string;
  code: string;
  room?: string;
  tariffCode?: string;
}

export async function createBed(input: CreateBedInput): Promise<repo.Bed> {
  try {
    const bed = await repo.createBed(input);
    // The ward the bed was hung on does not exist (or is out of the caller's branch scope).
    if (!bed) throw new AppError("HMS-GEN-404", 404, "Ward not found", { wardId: input.wardId });
    return bed;
  } catch (err) {
    if (repo.isDuplicateKey(err)) {
      throw new AppError("HMS-VAL-001", 409, "That bed already exists in this ward", {
        code: input.code,
        hint: "bed codes are unique within a ward — pick another",
      });
    }
    throw err;
  }
}

export async function updateBed(id: string, patch: repo.UpdateBedInput): Promise<repo.Bed> {
  const existing = await repo.findBedById(id);
  if (!existing) throw new AppError("HMS-GEN-404", 404, "Bed not found", { id });

  // Blocking a bed with no reason leaves the board saying "out of service" with no answer to
  // "why?" — the one thing the ward needs to know to plan around it.
  if (patch.status === "blocked" && !(patch.blockedReason ?? existing.blockedReason)) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      blockedReason: ["say why the bed is out of service (cleaning, maintenance, reserved)"],
    });
  }

  try {
    const updated = await repo.updateBed(id, patch);
    if (!updated) throw new AppError("HMS-GEN-404", 404, "Bed not found", { id });
    return updated;
  } catch (err) {
    if (repo.isDuplicateKey(err)) {
      throw new AppError("HMS-VAL-001", 409, "That bed already exists in this ward", {
        code: patch.code,
        hint: "bed codes are unique within a ward — pick another",
      });
    }
    throw err;
  }
}
