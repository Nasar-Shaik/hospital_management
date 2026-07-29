/**
 * Feedback & complaint service — the register and its lifecycle (Module B10).
 *
 * It enforces the two rules the shape cannot: a `complaint` is triaged (severity), `feedback` is
 * scored (rating) — neither borrows the other's field; and a status only moves along an edge the
 * machine allows, with a resolution that actually says how.
 */
import { getContext } from "../../core/context/requestContext.js";
import { AppError } from "../../core/errors/appError.js";
import * as repo from "./feedback.repository.js";
import { canTransition, type FeedbackStatus } from "./feedback.model.js";

export type { FeedbackTicket } from "./feedback.repository.js";

export const listTickets = repo.listTickets;

export async function getTicket(id: string): Promise<repo.FeedbackTicket> {
  const ticket = await repo.findById(id);
  if (!ticket) throw new AppError("HMS-GEN-404", 404, "Ticket not found", { id });
  return ticket;
}

export async function createTicket(input: repo.CreateTicketInput): Promise<repo.FeedbackTicket> {
  // A rating belongs to feedback, a severity to a complaint — carrying the wrong one is a
  // category error, so drop it rather than store a complaint with a 5-star rating.
  const cleaned: repo.CreateTicketInput = {
    ...input,
    ...(input.kind === "feedback" ? { severity: undefined } : { rating: undefined }),
  };
  return repo.createTicket(cleaned);
}

export async function assignTicket(
  id: string,
  assignedTo: string | null,
): Promise<repo.FeedbackTicket> {
  const ticket = await repo.assign(id, assignedTo);
  if (!ticket) throw new AppError("HMS-GEN-404", 404, "Ticket not found", { id });
  return ticket;
}

export async function transitionTicket(
  id: string,
  to: FeedbackStatus,
  note?: string,
): Promise<repo.FeedbackTicket> {
  const existing = await repo.findDocById(id);
  if (!existing) throw new AppError("HMS-GEN-404", 404, "Ticket not found", { id });

  if (!canTransition(existing.status, to)) {
    throw new AppError("HMS-STATE-001", 422, "Invalid state transition", {
      from: existing.status,
      to,
    });
  }

  // Resolving without saying how is not a resolution — it just hides the ticket from the list.
  if (to === "resolved" && !(note && note.trim())) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      note: ["say how the complaint was resolved"],
    });
  }

  const ctx = getContext();
  const updated = await repo.setStatus(id, to, {
    from: existing.status,
    to,
    at: new Date(),
    ...(ctx.userId ? { by: ctx.userId } : {}),
    ...(note && note.trim() ? { note: note.trim() } : {}),
  });
  if (!updated) throw new AppError("HMS-GEN-404", 404, "Ticket not found", { id });
  return updated;
}
