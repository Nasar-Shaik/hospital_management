/**
 * Device repository — the ONLY code that queries `devices` (Constitution §6).
 */
import { getTenantDb } from "../../core/context/requestContext.js";
import { getDeviceModel, type DeviceDoc, type DevicePlatform } from "./device.model.js";

/** What leaves the module. Never the raw Mongoose document (Doc 09 §5). */
export interface Device {
  id: string;
  userId: string;
  platform: DevicePlatform;
  active: boolean;
  lastSeenAt: Date;
  createdAt: Date;
}

/**
 * The token is deliberately NOT on `Device`.
 *
 * It is an address, and the only code that needs it is the sender. A route that returned it would
 * let any signed-in caller read back the push addresses of the phones in the building — and the
 * client already has its own token; it came from the OS. What a caller gets back is an id, which
 * is what `DELETE /me/devices/:id` needs and nothing else.
 */
function toDevice(doc: DeviceDoc): Device {
  return {
    id: doc._id.toString(),
    userId: doc.userId,
    platform: doc.platform,
    active: doc.active,
    lastSeenAt: doc.lastSeenAt,
    createdAt: doc.createdAt,
  };
}

/** A device row WITH its address — sender-only. */
export interface Addressable extends Device {
  token: string;
}

/**
 * Registers a handset to a user, or moves it to them.
 *
 * ── ONE UPSERT, KEYED ON THE TOKEN ALONE ────────────────────────────────────
 * Keyed on `{ token }` and not `{ userId, token }`, for the reason in `device.model.ts`: the token
 * is the phone. Signing in as somebody else on a handset REASSIGNS it, in one atomic write, so
 * there is never an instant where two people are both reachable on it.
 *
 * It also revives a row deactivated at the last sign-out (`active: true`, reasons cleared) rather
 * than accumulating a row per session — a doctor who signs in and out twice a day would otherwise
 * leave sixty dead rows a month behind them.
 */
export async function register(input: {
  userId: string;
  token: string;
  platform: DevicePlatform;
}): Promise<Device> {
  const doc = await getDeviceModel(getTenantDb())
    .findOneAndUpdate(
      { token: input.token },
      {
        $set: {
          userId: input.userId,
          platform: input.platform,
          active: true,
          lastSeenAt: new Date(),
        },
        $unset: { deactivatedAt: "", deactivatedReason: "" },
      },
      { new: true, upsert: true },
    )
    .lean<DeviceDoc>();

  return toDevice(doc);
}

/**
 * Retires one device, and ONLY if it belongs to the caller.
 *
 * `userId` is part of the filter rather than checked after the read: a check-then-write can be
 * written correctly and still be got wrong by the next person editing it, and the thing being
 * protected is one user's ability to silence another's alerts. Returns false when there was
 * nothing of theirs to retire, which the route answers as a 404 rather than a lie.
 */
export async function deactivate(input: {
  id: string;
  userId: string;
  reason: string;
}): Promise<boolean> {
  const result = await getDeviceModel(getTenantDb()).findOneAndUpdate(
    { _id: input.id, userId: input.userId },
    { $set: { active: false, deactivatedAt: new Date(), deactivatedReason: input.reason } },
    { new: true },
  );
  return result !== null;
}

/**
 * Retires a token by its VALUE — what Expo's `DeviceNotRegistered` gives us.
 *
 * No `userId`: the sender is the system, acting on the transport's own report that the app was
 * uninstalled or the token rotated. Scoped to the tenant by the plugin, like every other read.
 */
export async function deactivateToken(token: string, reason: string): Promise<void> {
  await getDeviceModel(getTenantDb()).updateOne(
    { token },
    { $set: { active: false, deactivatedAt: new Date(), deactivatedReason: reason } },
  );
}

/** Every phone this recipient can currently be reached on. The sender's only read. */
export async function listActiveFor(userId: string): Promise<Addressable[]> {
  const docs = await getDeviceModel(getTenantDb())
    .find({ userId, active: true })
    .lean<DeviceDoc[]>();
  return docs.map((doc) => ({ ...toDevice(doc), token: doc.token }));
}

/** The caller's own handsets — what `GET /me/devices` answers. */
export async function listFor(userId: string): Promise<Device[]> {
  const docs = await getDeviceModel(getTenantDb())
    .find({ userId, active: true })
    .sort({ lastSeenAt: -1 })
    .lean<DeviceDoc[]>();
  return docs.map(toDevice);
}

/** Marks a successful delivery, so `lastSeenAt` means "we reached it", not "it said hello". */
export async function touch(tokens: string[]): Promise<void> {
  if (tokens.length === 0) return;
  await getDeviceModel(getTenantDb()).updateMany(
    { token: { $in: tokens } },
    { $set: { lastSeenAt: new Date() } },
  );
}
