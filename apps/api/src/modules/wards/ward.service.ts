/**
 * Ward & bed service — configuring the hospital's bed inventory (Module B4).
 *
 * Thin over the repository: it turns a duplicate key into the hospital's own sentence ("that
 * ward already exists") rather than a 500, and it refuses the one nonsensical edit (blocking a
 * bed with no reason). Occupancy is NOT its concern — that is derived by the bed board.
 */
import { AppError } from "../../core/errors/appError.js";
import * as repo from "./ward.repository.js";

export type { Ward, Room, Bed } from "./ward.repository.js";

export const listWards = repo.listWards;
export const listRooms = repo.listRooms;
export const listBeds = repo.listBeds;
/** Every bed in the hospital, across sites — the meter behind a plan's bed allowance. */
export const countBeds = repo.countBeds;
export const getWard = repo.findWardById;
export const getRoom = repo.findRoomById;
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

export interface CreateRoomInput {
  wardId: string;
  kind: repo.CreateRoomInput["kind"];
  name: string;
  tariffCode?: string;
}

export async function createRoom(input: CreateRoomInput): Promise<repo.Room> {
  try {
    const room = await repo.createRoom(input);
    // The ward the room was hung on does not exist (or is out of the caller's branch scope).
    if (!room) throw new AppError("HMS-GEN-404", 404, "Ward not found", { wardId: input.wardId });
    return room;
  } catch (err) {
    if (repo.isDuplicateKey(err)) {
      throw new AppError("HMS-VAL-001", 409, "That room already exists in this ward", {
        name: input.name,
        hint: "room names are unique within a ward — pick another",
      });
    }
    throw err;
  }
}

export async function updateRoom(id: string, patch: repo.UpdateRoomInput): Promise<repo.Room> {
  const existing = await repo.findRoomById(id);
  if (!existing) throw new AppError("HMS-GEN-404", 404, "Room not found", { id });
  try {
    const updated = await repo.updateRoom(id, patch);
    if (!updated) throw new AppError("HMS-GEN-404", 404, "Room not found", { id });
    return updated;
  } catch (err) {
    if (repo.isDuplicateKey(err)) {
      throw new AppError("HMS-VAL-001", 409, "That room already exists in this ward", {
        name: patch.name,
        hint: "room names are unique within a ward — pick another",
      });
    }
    throw err;
  }
}

export interface CreateBedInput {
  wardId: string;
  roomId?: string;
  code: string;
  room?: string;
  tariffCode?: string;
}

export async function createBed(input: CreateBedInput): Promise<repo.Bed> {
  try {
    const bed = await repo.createBed(input);
    // The ward does not exist, or the named room is missing / belongs to a different ward.
    if (!bed)
      throw new AppError("HMS-GEN-404", 404, "Ward or room not found", {
        wardId: input.wardId,
        ...(input.roomId ? { roomId: input.roomId } : {}),
        hint: "the room must belong to the chosen ward",
      });
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
    // The bed exists (checked above), so a miss here is a room that is missing or in another ward.
    if (!updated)
      throw new AppError("HMS-GEN-404", 404, "Room not found", {
        id,
        ...(patch.roomId ? { roomId: patch.roomId } : {}),
        hint: "the room must belong to the bed's ward",
      });
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
