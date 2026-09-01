/**
 * Registered devices — where a recipient can be reached by push (M4).
 *
 * ── WHY THIS LIVES IN THE NOTIFICATIONS MODULE ──────────────────────────────
 * It is an ADDRESS BOOK, and this module already owns the question "how do we reach this
 * recipient?". `email` resolves that from the user record; push resolves it from here. Putting it
 * in its own module would split delivery across two places and add a composition-root entry for a
 * table only the sender reads.
 *
 * PLATFORM_STRATEGY Rule P1 still holds: there is not one clinical word here. A school pushing a
 * fee reminder to a parent's phone uses this file unchanged.
 *
 * ── THE TOKEN IDENTIFIES A PHONE, NOT A PERSON — AND THAT IS THE SAFETY RULE ─
 * The unique index is `{ tenantId, token }`, deliberately NOT `{ tenantId, userId, token }`.
 *
 * An Expo push token belongs to an INSTALLATION. When a second doctor signs in on the same
 * handset — a shared ward phone, a device handed over at shift change — the token must MOVE to
 * them, not gain a second row. With a per-user index both rows would be active, and the doctor who
 * went home would keep receiving their patients' critical results on a phone now in somebody
 * else's pocket. The index makes that unrepresentable rather than relying on the register call to
 * remember to clean up.
 *
 * ── AND IT IS SCOPED TO THE HOSPITAL ────────────────────────────────────────
 * `tenantScopePlugin`, like everything else. One physical phone signed into two hospitals has two
 * rows in two databases that can never see each other, and neither can push through the other's
 * (`listActiveFor` reads the tenant's own collection). The mobile app holds one hospital per
 * install, so in practice the second row is deactivated at sign-out before the first exists.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { tenantScopePlugin } from "../../core/db/plugins/tenantScope.js";
import { auditPlugin } from "../../core/db/plugins/auditPlugin.js";

/** What we can actually deliver to today. Expo speaks both; nothing else is wired. */
export const DEVICE_PLATFORMS = ["ios", "android"] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

export interface DeviceDoc {
  _id: Types.ObjectId;
  tenantId: string;

  /** The recipient this handset currently belongs to. REASSIGNED on re-registration — see above. */
  userId: string;

  /**
   * The Expo push token — `ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]`.
   *
   * Not a credential of ours and not a secret of the user's: it is an address Expo hands out, and
   * anyone holding it can only reach the device through OUR Expo project. Stored in the clear so
   * `DeviceNotRegistered` can be matched back to a row and retired.
   */
  token: string;
  platform: DevicePlatform;

  /**
   * False once the phone signed out, or once Expo told us the token is dead.
   *
   * Deactivated, never deleted. "This person had a phone and it stopped being reachable on the
   * 14th" is a question an incident review asks about an alert nobody answered, and a deleted row
   * answers it with silence.
   */
  active: boolean;
  /** Last registration or successful send — how stale this address is. */
  lastSeenAt: Date;
  deactivatedAt?: Date;
  /** `signed-out`, or the ticket error Expo returned. */
  deactivatedReason?: string;

  createdAt: Date;
  updatedAt: Date;
}

const deviceSchema = new Schema<DeviceDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    token: { type: String, required: true },
    platform: { type: String, enum: DEVICE_PLATFORMS, required: true },
    active: { type: Boolean, required: true, default: true },
    lastSeenAt: { type: Date, required: true, default: () => new Date() },
    deactivatedAt: { type: Date },
    deactivatedReason: { type: String },
  },
  { timestamps: true, collection: "devices", autoIndex: false },
);

deviceSchema.plugin(tenantScopePlugin);

/**
 * `security`, not `admin`. Registering a device is the act that decides where a hospital's alerts
 * physically arrive, and the question an investigation asks — "which handset was this delivered
 * to, and who owned it that day?" — is the same shape as "which session was this done from".
 *
 * The token is NOT diffed into the trail: it is the address itself, and an audit entry that copies
 * the address duplicates the thing it exists to police (the same rule `notification` follows for
 * `to` and `body`).
 */
deviceSchema.plugin(auditPlugin, {
  resource: "device",
  category: "security",
  ignore: ["token", "lastSeenAt"],
});

export function getDeviceModel(conn: Connection): Model<DeviceDoc> {
  return (conn.models.Device as Model<DeviceDoc>) ?? conn.model<DeviceDoc>("Device", deviceSchema);
}
