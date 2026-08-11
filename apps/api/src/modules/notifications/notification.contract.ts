/**
 * Notification response contracts.
 *
 * The TEMPLATE is configuration and tenant-wide; a NOTIFICATION is an operational record of one
 * message (ADR-0015 — the two were classified separately for exactly this reason).
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves } from "../../core/http/contract.js";
import { NOTIFICATION_CHANNELS, NOTIFICATION_STATUSES } from "./notification.model.js";
import type { Notification, NotificationTemplate } from "./notification.repository.js";

const channel = z.enum(NOTIFICATION_CHANNELS);

export const notification = contract(
  "Notification",
  z.object({
    id: z.string(),
    templateKey: z.string(),
    channel,
    /** Absent when the recipient had no address on this channel — see `unreachable`. */
    to: z.string().optional(),
    recipientName: z.string().optional(),
    recipientType: z.string().optional(),
    recipientId: z.string().optional(),
    subject: z.string().optional(),
    body: z.string(),
    /** What makes a resend the SAME message rather than a second one. */
    dedupeKey: z.string(),
    status: z.enum(NOTIFICATION_STATUSES),
    attempts: z.number(),
    sentAt: z.string().optional(),
    error: z.string().optional(),
    eventId: z.string().optional(),
    createdAt: z.string(),
  }),
);
export type NotificationProof = Proves<Matches<typeof notification, Notification>>;

export const notificationTemplate = contract(
  "NotificationTemplate",
  z.object({
    id: z.string(),
    key: z.string(),
    channel,
    description: z.string().optional(),
    subject: z.string().optional(),
    body: z.string(),
    enabled: z.boolean(),
    /** True while this is still the shipped default — a hospital has not edited it. */
    isDefault: z.boolean(),
    updatedAt: z.string(),
  }),
);
export type NotificationTemplateProof = Proves<
  Matches<typeof notificationTemplate, NotificationTemplate>
>;
