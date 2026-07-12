/**
 * User service — account lifecycle (STATE_MACHINE_CATALOG §12).
 *
 * Transitions live in ONE guard here, never as scattered `if (status === …)`
 * checks (catalog: "Adding an entity lifecycle").
 */
import { AppError } from "../../core/errors/appError.js";
import * as repo from "./user.repository.js";
import type { User } from "./user.repository.js";
import type { UserStatus } from "./user.model.js";

/** Legal transitions — STATE_MACHINE_CATALOG §12. Anything absent is rejected. */
const ALLOWED_TRANSITIONS: Record<UserStatus, readonly UserStatus[]> = {
  invited: ["active", "locked", "archived"],
  active: ["disabled", "locked", "archived"],
  locked: ["active", "archived"],
  disabled: ["active", "archived"],
  archived: [],
};

export class InvalidUserTransitionError extends AppError {
  constructor(from: UserStatus, to: UserStatus) {
    super("HMS-STATE-001", 422, "Invalid state transition", { from, to });
  }
}

export async function transitionStatus(
  userId: string,
  to: UserStatus,
  lockedUntil?: Date,
): Promise<User> {
  const current = await repo.findById(userId);
  if (!current) throw new AppError("HMS-GEN-404", 404, "User not found", { userId });

  if (!ALLOWED_TRANSITIONS[current.status].includes(to)) {
    throw new InvalidUserTransitionError(current.status, to);
  }

  const updated = await repo.updateStatus(userId, to, lockedUntil);
  if (!updated) throw new AppError("HMS-GEN-404", 404, "User not found", { userId });
  return updated;
}

/**
 * Creates a user. Credentials are NOT set here — that is the `auth` module's
 * job, so a user always exists before a password can reference it, and this
 * module never touches a secret.
 */
export async function createUser(input: repo.CreateUserInput): Promise<User> {
  const existing = await repo.findByEmail(input.email);
  if (existing) {
    throw new AppError("HMS-VAL-001", 409, "Email already registered", { email: input.email });
  }
  return repo.create(input);
}

export const getById = repo.findById;
export const getByEmail = repo.findByEmail;
export const recordLogin = repo.recordLogin;
export const setMfaEnabled = repo.setMfaEnabled;
