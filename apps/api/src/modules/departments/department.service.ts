/**
 * Department service — configuring the hospital's organisational units (Modules B2/B3).
 *
 * Thin over the repository, with two jobs the repository must not do:
 *   1. Turn a duplicate code into the hospital's own sentence ("that code is taken") not a 500.
 *   2. GUARD THE HIERARCHY — refuse a parent that does not exist, a department parented to itself,
 *      or a parent that would make a department its own ancestor (a cycle). A cycle is the one
 *      corruption a tree cannot survive: every "walk up to the root" read loops forever.
 */
import { AppError } from "../../core/errors/appError.js";
import * as repo from "./department.repository.js";

export type { Department } from "./department.repository.js";

export const listDepartments = repo.list;
export const getDepartment = repo.findById;

/**
 * Would setting `childId`'s parent to `proposedParentId` create a cycle? Walks up from the proposed
 * parent following `parentId`; if the walk reaches `childId`, the edge closes a loop. The visited
 * set is a belt-and-braces guard so a pre-existing cycle cannot hang this check either.
 */
async function wouldCycle(childId: string, proposedParentId: string): Promise<boolean> {
  if (childId === proposedParentId) return true;
  const seen = new Set<string>([childId]);
  let cursor: string | undefined = proposedParentId;
  while (cursor) {
    if (seen.has(cursor)) return true;
    seen.add(cursor);
    const doc: repo.Department | undefined = await repo.findById(cursor);
    cursor = doc?.parentId;
  }
  return false;
}

/** Validates a proposed parent exists and closes no cycle. `childId` is undefined on create. */
async function assertParentValid(parentId: string, childId?: string): Promise<void> {
  const parent = await repo.findDocById(parentId);
  if (!parent) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      parentId: ["that parent department does not exist"],
    });
  }
  if (childId && (await wouldCycle(childId, parentId))) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      parentId: ["a department cannot be a descendant of itself"],
    });
  }
}

export interface CreateDepartmentInput {
  name: string;
  code: string;
  kind: repo.CreateDepartmentInput["kind"];
  parentId?: string;
  headStaffId?: string;
  description?: string;
}

export async function createDepartment(input: CreateDepartmentInput): Promise<repo.Department> {
  if (input.parentId) await assertParentValid(input.parentId);
  try {
    return await repo.create(input);
  } catch (err) {
    if (repo.isDuplicateKey(err)) {
      throw new AppError("HMS-VAL-001", 409, "That department code is already in use", {
        code: input.code,
        hint: "department codes are unique per hospital — pick another",
      });
    }
    throw err;
  }
}

export async function updateDepartment(
  id: string,
  patch: repo.UpdateDepartmentInput,
): Promise<repo.Department> {
  const existing = await repo.findDocById(id);
  if (!existing) throw new AppError("HMS-GEN-404", 404, "Department not found", { id });

  // A non-null parent must exist and must not close a cycle back onto this department.
  if (patch.parentId) await assertParentValid(patch.parentId, id);

  // The code is immutable (records carry it), so an update can never collide — no dup-key guard.
  const updated = await repo.update(id, patch);
  if (!updated) throw new AppError("HMS-GEN-404", 404, "Department not found", { id });
  return updated;
}
