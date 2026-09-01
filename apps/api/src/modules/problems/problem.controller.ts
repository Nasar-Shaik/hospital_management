/**
 * Problem list controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler } from "express";
import * as problems from "./problem.service.js";
import type { AddProblemBody, PromoteProblemBody, ResolveProblemBody } from "./problem.schema.js";
import { ok } from "../../core/http/respond.js";

export const list: RequestHandler = async (req, res) => {
  const { patientId } = req.params as { patientId: string };
  ok(res, await problems.listProblems(patientId));
};

export const add: RequestHandler = async (req, res) => {
  const { patientId } = req.params as { patientId: string };
  const body = req.body as AddProblemBody;
  ok(
    res,
    await problems.addProblem({
      patientId,
      title: body.title,
      ...(body.code ? { code: body.code } : {}),
      ...(body.onsetDate ? { onsetDate: body.onsetDate } : {}),
    }),
    201,
  );
};

export const promote: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const body = req.body as PromoteProblemBody;
  ok(
    res,
    await problems.promoteDiagnosis(id, {
      diagnosisIndex: body.diagnosisIndex,
      ...(body.code ? { code: body.code } : {}),
      ...(body.onsetDate ? { onsetDate: body.onsetDate } : {}),
    }),
    201,
  );
};

export const resolve: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const body = req.body as ResolveProblemBody;
  ok(res, await problems.resolveProblem(id, body.reason));
};
