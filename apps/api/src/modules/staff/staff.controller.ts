/**
 * Staff controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler, Response } from "express";
import type { ApiEnvelope, PageMeta } from "@medicore/types";
import * as staff from "./staff.service.js";
import type { ListUsersQuery, StaffProfileBody } from "./staff.schema.js";

function ok<T>(res: Response, data: T, status = 200, meta?: PageMeta): void {
  const body: ApiEnvelope<T> = { success: true, data, ...(meta ? { meta } : {}) };
  res.status(status).json(body);
}

/**
 * Turns the wire profile into the service profile: the two date fields arrive as
 * `YYYY-MM-DD` strings and become Dates HERE, at the edge. A service that took a string and
 * parsed it would be a service with a date-format bug waiting in it (the same rule the
 * admissions and allergy controllers follow).
 */
function toServiceProfile(profile?: StaffProfileBody): staff.StaffProfile | undefined {
  if (!profile) return undefined;
  const { dateOfBirth, joiningDate, ...rest } = profile;
  return {
    ...rest,
    ...(dateOfBirth ? { dateOfBirth: new Date(`${dateOfBirth}T00:00:00.000Z`) } : {}),
    ...(joiningDate ? { joiningDate: new Date(`${joiningDate}T00:00:00.000Z`) } : {}),
  };
}

export const createStaff: RequestHandler = async (req, res) => {
  const { profile, ...rest } = req.body as Omit<staff.CreateStaffInput, "profile"> & {
    profile?: StaffProfileBody;
  };
  ok(
    res,
    await staff.createStaff({
      ...rest,
      ...(profile ? { profile: toServiceProfile(profile) } : {}),
    }),
    201,
  );
};

export const listStaff: RequestHandler = async (req, res) => {
  const query = req.query as unknown as ListUsersQuery;
  const { users, total } = await staff.listStaff(query);

  ok(res, users, 200, {
    page: query.page,
    limit: query.limit,
    total,
    hasMore: query.page * query.limit < total,
  });
};

export const getStaff: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await staff.getStaff(id));
};

/**
 * The doctors directory: who can a patient be sent to. NAMES ONLY.
 *
 * ── WHY THIS EXISTS RATHER THAN REUSING `GET /users` ────────────────────────
 * A receptionist cannot register a walk-in without choosing a doctor, so they must be
 * able to list doctors. But `GET /users` needs `user:read` — the staff-ADMIN
 * permission, which also discloses every colleague's email, MFA status and last
 * login. Handing the front desk a personnel file so they can populate a dropdown is
 * exactly the kind of over-grant that makes an RBAC model decorative.
 *
 * So: a different question gets a different endpoint. This returns `{id, name}` and
 * nothing else, for active doctors only, and is gated on `encounter:read` — which
 * every clinical and front-desk role already holds, because they all need to know who
 * the patient is waiting for.
 *
 * (This also fixes the appointments screen, which populated its doctor picker from
 * `GET /users` and was therefore broken for the receptionist — the one person who
 * uses it most.)
 */
export const listDoctors: RequestHandler = async (_req, res) => {
  ok(res, await staff.listDoctors());
};

export const updateStaff: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const { profile, ...rest } = req.body as {
    name?: string;
    phone?: string;
    employeeId?: string;
    profile?: StaffProfileBody;
  };
  ok(
    res,
    await staff.updateStaff(id, {
      ...rest,
      ...(profile ? { profile: toServiceProfile(profile) } : {}),
    }),
  );
};

export const setStaffStatus: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const { status } = req.body as { status: "active" | "disabled" };
  ok(res, await staff.setStaffStatus(id, status));
};

export const resetStaffPassword: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const { password } = req.body as { password?: string };
  ok(res, await staff.resetStaffPassword(id, password));
};
