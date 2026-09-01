/**
 * Patient feedback and complaint response contracts.
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves } from "../../core/http/contract.js";
import {
  COMPLAINT_SEVERITIES,
  FEEDBACK_CATEGORIES,
  FEEDBACK_CHANNELS,
  FEEDBACK_KINDS,
  FEEDBACK_STATUSES,
} from "./feedback.model.js";
import type { FeedbackTicket } from "./feedback.repository.js";

const feedbackStatus = z.enum(FEEDBACK_STATUSES);

export const feedbackStatusChange = contract(
  "FeedbackStatusChange",
  z.object({
    from: feedbackStatus,
    to: feedbackStatus,
    at: z.string(),
    by: z.string().optional(),
    note: z.string().optional(),
  }),
);

export const feedbackTicket = contract(
  "FeedbackTicket",
  z.object({
    id: z.string(),
    kind: z.enum(FEEDBACK_KINDS),
    category: z.enum(FEEDBACK_CATEGORIES),
    channel: z.enum(FEEDBACK_CHANNELS),
    subject: z.string(),
    description: z.string(),
    patientId: z.string().optional(),
    /** Set when the reporter is not a registered patient — a visitor, a relative. */
    reporterName: z.string().optional(),
    reporterPhone: z.string().optional(),
    /** Feedback only: 1–5. */
    rating: z.number().optional(),
    /** Complaints only. */
    severity: z.enum(COMPLAINT_SEVERITIES).optional(),
    status: feedbackStatus,
    assignedTo: z.string().optional(),
    resolutionNote: z.string().optional(),
    statusHistory: z.array(feedbackStatusChange),
    branchId: z.string().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);
export type FeedbackTicketProof = Proves<Matches<typeof feedbackTicket, FeedbackTicket>>;
