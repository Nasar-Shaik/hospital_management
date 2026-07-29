/**
 * Feedback & complaint controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler, Response } from "express";
import type { ApiEnvelope } from "@medicore/types";
import * as feedback from "./feedback.service.js";
import type {
  CreateTicketBody,
  ListTicketsQuery,
  AssignTicketBody,
  TransitionTicketBody,
} from "./feedback.schema.js";

function ok<T>(res: Response, data: T, status = 200): void {
  const body: ApiEnvelope<T> = { success: true, data };
  res.status(status).json(body);
}

export const listTickets: RequestHandler = async (req, res) => {
  ok(res, await feedback.listTickets(req.query as ListTicketsQuery));
};

export const createTicket: RequestHandler = async (req, res) => {
  ok(res, await feedback.createTicket(req.body as CreateTicketBody), 201);
};

export const getTicket: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await feedback.getTicket(id));
};

export const assignTicket: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const { assignedTo } = req.body as AssignTicketBody;
  ok(res, await feedback.assignTicket(id, assignedTo));
};

export const transitionTicket: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const { to, note } = req.body as TransitionTicketBody;
  ok(res, await feedback.transitionTicket(id, to, note));
};
