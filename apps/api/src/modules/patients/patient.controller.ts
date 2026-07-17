/**
 * Patient controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler, Response } from "express";
import type { ApiEnvelope, PageMeta } from "@medicore/types";
import * as patients from "./patient.service.js";
import type {
  DuplicateCheckBody,
  ListPatientsQuery,
  MergePatientsBody,
  RegisterPatientBody,
} from "./patient.schema.js";

function ok<T>(res: Response, data: T, status = 200, meta?: PageMeta): void {
  const body: ApiEnvelope<T> = { success: true, data, ...(meta ? { meta } : {}) };
  res.status(status).json(body);
}

export const registerPatient: RequestHandler = async (req, res) => {
  const input = req.body as RegisterPatientBody;
  ok(res, await patients.registerPatient(input), 201);
};

export const listPatients: RequestHandler = async (req, res) => {
  const query = req.query as unknown as ListPatientsQuery;
  const { patients: rows, total } = await patients.listPatients(query);

  ok(res, rows, 200, {
    page: query.page,
    limit: query.limit,
    total,
    hasMore: query.page * query.limit < total,
  });
};

export const getPatient: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await patients.getPatient(id));
};

export const getPatientByUhid: RequestHandler = async (req, res) => {
  const { uhid } = req.params as { uhid: string };
  ok(res, await patients.getPatientByUhid(uhid));
};

export const updatePatient: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await patients.updatePatient(id, req.body as { name?: string }));
};

/** POST, not GET: the body carries PHI, and a GET would put a patient's name and phone number into every access log and browser history on the way. */
export const checkDuplicates: RequestHandler = async (req, res) => {
  const input = req.body as DuplicateCheckBody;
  ok(res, await patients.findDuplicates(input));
};

export const mergePatients: RequestHandler = async (req, res) => {
  const input = req.body as MergePatientsBody;
  ok(res, await patients.mergePatients(input));
};
