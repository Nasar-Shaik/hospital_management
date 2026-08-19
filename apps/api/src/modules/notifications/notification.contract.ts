/**
 * Notification response contracts.
 *
 * The TEMPLATE is configuration and tenant-wide; a NOTIFICATION is an operational record of one
 * message (ADR-0015 — the two were classified separately for exactly this reason).
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves } from "../../core/http/contract.js";
import { NOTIFICATION_CHANNELS, NOTIFICATION_STATUSES } from "./notification.model.js";
import { DEVICE_PLATFORMS } from "./device.model.js";
import type { Device } from "./device.repository.js";
import type {
  InboxMessage,
  Notification,
  NotificationTemplate,
} from "./notification.repository.js";

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
    /** What the message was about (M4) — the operator's "an alert about which order?". */
    resourceType: z.string().optional(),
    resourceId: z.string().optional(),
    /** When the recipient opened it in their inbox. Absent means unread. */
    readAt: z.string().optional(),
    /** The site the message was raised at (ADR-0015). */
    branchId: z.string().optional(),
    createdAt: z.string(),
  }),
);
export type NotificationProof = Proves<Matches<typeof notification, Notification>>;

/**
 * ONE MESSAGE, AS ITS RECIPIENT SEES IT — and deliberately not the same shape as `Notification`.
 *
 * The ledger contract above answers an OPERATOR's question ("did it go, how many times did we
 * try, what did SMTP say?"), so it carries `dedupeKey`, `attempts`, `error`, `status` and the
 * address it was sent to. None of that is any use to the doctor reading the message, and shipping
 * it here would have two costs worth avoiding:
 *
 *   1. It couples the inbox to the ledger. Anybody adding an operational field to `Notification`
 *      would be widening a self-service, unpermissioned route without noticing.
 *   2. `to` is an address. The inbox is reached with no permission at all; the smaller the shape
 *      the less there is to get wrong about it later.
 *
 * So this is its own contract with its own reason to exist, the same way `ReportMeta` is not
 * `ReportFile`.
 */
export const inboxMessage = contract(
  "InboxMessage",
  z.object({
    id: z.string(),
    /** Which template rendered it — how a client decides where the message points. */
    templateKey: z.string(),
    subject: z.string().optional(),
    body: z.string(),
    /** The site the message was raised at (ADR-0015) — shown, never used as a filter. */
    branchId: z.string().optional(),
    /**
     * Where the message goes when it is tapped (M4). A generic pair, because this module does not
     * know what an order is (Rule P1): the client owns the map from a kind to one of its screens.
     * Both absent for a message about nothing you can open.
     */
    resourceType: z.string().optional(),
    resourceId: z.string().optional(),
    /** Absent means unread. */
    readAt: z.string().optional(),
    createdAt: z.string(),
  }),
);
export type InboxMessageProof = Proves<Matches<typeof inboxMessage, InboxMessage>>;

/**
 * A handset this person can be reached on (M4).
 *
 * ── THE TOKEN IS NOT IN IT ──────────────────────────────────────────────────
 * It is the address itself, and the only code that needs it is the sender. The client already has
 * its own — it came from the OS — so returning it would add nothing except a route that reads back
 * the push addresses of every phone in the building. What comes back is the id, which is what
 * `DELETE /me/devices/:id` needs.
 */
export const device = contract(
  "Device",
  z.object({
    id: z.string(),
    userId: z.string(),
    platform: z.enum(DEVICE_PLATFORMS),
    active: z.boolean(),
    /** Last registration or successful delivery — how stale this address is. */
    lastSeenAt: z.string(),
    createdAt: z.string(),
  }),
);
export type DeviceProof = Proves<Matches<typeof device, Device>>;

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
