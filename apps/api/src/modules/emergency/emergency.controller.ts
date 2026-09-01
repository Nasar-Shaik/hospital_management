/**
 * Emergency department controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler } from "express";
import * as ed from "./emergency.service.js";
import type { TriageBody, TransferOutBody } from "./emergency.schema.js";
import { ok } from "../../core/http/respond.js";

export const board: RequestHandler = async (_req, res) => {
  ok(res, await ed.board());
};

export const triage: RequestHandler = async (req, res) => {
  const body = req.body as TriageBody;
  ok(
    res,
    await ed.triage({
      encounterId: body.encounterId,
      priority: body.priority,
      ...(body.chiefComplaint ? { chiefComplaint: body.chiefComplaint } : {}),
    }),
    201,
  );
};

export const transferOut: RequestHandler = async (req, res) => {
  const body = req.body as TransferOutBody;
  ok(
    res,
    await ed.transferOut({
      encounterId: body.encounterId,
      destination: body.destination,
      ...(body.note ? { note: body.note } : {}),
    }),
    201,
  );
};
