/**
 * Feedback & complaint DTOs (Doc 09 §5/§6). `.strict()` — an unexpected field is a 400.
 */
import { z } from "@medicore/validation";
import {
  FEEDBACK_KINDS,
  FEEDBACK_CATEGORIES,
  FEEDBACK_CHANNELS,
  COMPLAINT_SEVERITIES,
  FEEDBACK_STATUSES,
} from "./feedback.model.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "invalid id");

export const createTicketSchema = z
  .object({
    kind: z.enum(FEEDBACK_KINDS),
    category: z.enum(FEEDBACK_CATEGORIES),
    channel: z.enum(FEEDBACK_CHANNELS),
    subject: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(4000),
    patientId: objectId.optional(),
    reporterName: z.string().trim().max(120).optional(),
    reporterPhone: z.string().trim().max(20).optional(),
    rating: z.number().int().min(1).max(5).optional(),
    severity: z.enum(COMPLAINT_SEVERITIES).optional(),
  })
  .strict();

export const listTicketsQuerySchema = z
  .object({
    kind: z.enum(FEEDBACK_KINDS).optional(),
    status: z.enum(FEEDBACK_STATUSES).optional(),
    category: z.enum(FEEDBACK_CATEGORIES).optional(),
    assignedTo: objectId.optional(),
  })
  .strict();

/** `assignedTo: null` un-assigns the ticket. */
export const assignTicketSchema = z.object({ assignedTo: objectId.nullable() }).strict();

export const transitionTicketSchema = z
  .object({
    to: z.enum(FEEDBACK_STATUSES),
    note: z.string().trim().max(2000).optional(),
  })
  .strict();

export const idParamSchema = z.object({ id: objectId }).strict();

export type CreateTicketBody = z.infer<typeof createTicketSchema>;
export type ListTicketsQuery = z.infer<typeof listTicketsQuerySchema>;
export type AssignTicketBody = z.infer<typeof assignTicketSchema>;
export type TransitionTicketBody = z.infer<typeof transitionTicketSchema>;
