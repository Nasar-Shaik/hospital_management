/**
 * Notification DTOs (Doc 09 §5/§6). `.strict()` — an unexpected field is a 400.
 */
import { z } from "@medicore/validation";
import { NOTIFICATION_STATUSES } from "./notification.model.js";
import { DEVICE_PLATFORMS } from "./device.model.js";

export const listNotificationsQuerySchema = z
  .object({
    status: z.enum(NOTIFICATION_STATUSES).optional(),
    templateKey: z.string().max(100).optional(),
    recipientId: z.string().max(100).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

/**
 * The caller's own inbox. Note what is NOT here: `recipientId`. It is taken from the session, and
 * accepting it as a parameter is precisely how a self-scoped route becomes a directory of
 * everybody's mail.
 */
export const inboxQuerySchema = z
  .object({
    /**
     * NOT `z.coerce.boolean()`, which is the obvious spelling and is wrong: it turns every
     * non-empty string true, so `?unread=false` would return only the UNREAD ones — the exact
     * opposite of what the caller asked for, silently. An explicit two-value enum cannot do that,
     * and an unrecognised value is a 400 rather than a guess.
     */
    unread: z
      .enum(["true", "false"])
      .optional()
      .transform((v) => v === "true"),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export const notificationIdParamSchema = z
  .object({ id: z.string().regex(/^[a-f\d]{24}$/i, "invalid id") })
  .strict();

export const templateKeyParamSchema = z.object({ key: z.string().min(1).max(100) }).strict();

/**
 * At least one field, or the request is a no-op that still writes an audit entry
 * and flips `isDefault` — a silent way to lose the "this is still ours" marker.
 */
export const updateTemplateSchema = z
  .object({
    subject: z.string().max(200).optional(),
    body: z.string().min(1).max(5_000).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "provide at least one of: subject, body, enabled",
  });

/**
 * Registering a handset (M4).
 *
 * Note what is NOT here, for the same reason `inboxQuerySchema` has no `recipientId`: a `userId`.
 * The device is registered to the SESSION. Accepting an owner in the body is how a self-service
 * route becomes "point that consultant's critical-result alerts at my phone".
 *
 * The token is length-bounded rather than pattern-matched. Expo's format today is
 * `ExponentPushToken[…]`, and a build using a bare FCM/APNs token is a supported Expo
 * configuration — a regex would refuse a legitimate device and the symptom would be a phone that
 * never buzzes, diagnosed as a push outage.
 */
export const registerDeviceSchema = z
  .object({
    token: z.string().min(10).max(512),
    platform: z.enum(DEVICE_PLATFORMS),
  })
  .strict();

export const deviceIdParamSchema = z
  .object({ id: z.string().regex(/^[a-f\d]{24}$/i, "invalid id") })
  .strict();

export type RegisterDeviceBody = z.infer<typeof registerDeviceSchema>;
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;
export type InboxQuery = z.infer<typeof inboxQuerySchema>;
export type UpdateTemplateBody = z.infer<typeof updateTemplateSchema>;
