/**
 * Push, as this app's own logic sees it (M4).
 *
 * ── WHY A PORT, LIKE `BiometricAuthenticator` ───────────────────────────────
 * Everything below runs in Node with no simulator, no Xcode and no Android SDK, because the parts
 * worth defending are decisions rather than native calls: whether to register at all, what a
 * notification's payload means, where a tap should land. `expo-notifications` lives behind
 * `platform/pushNotifications.ts` and is substituted in tests — the same boundary the lock uses,
 * and for the same reason: no simulator will deny a permission, rotate a token or deliver a
 * malformed payload on request.
 *
 * The runtime is built WITHOUT a registrar in tests and in any build that has none, and simply
 * never registers. A phone that cannot receive push is not a degraded app: the inbox is the
 * message, and it is unchanged (`app/(app)/alerts.tsx`).
 */

/** What the OS gives us, when it gives us anything. */
export interface PushCredential {
  token: string;
  platform: "ios" | "android";
}

/** A notification's payload, as the server sent it — see `push.service.ts`. */
export interface PushPayload {
  notificationId?: string;
  templateKey?: string;
  resourceType?: string;
  resourceId?: string;
  branchId?: string;
}

export interface PushRegistrar {
  /**
   * The device's push address, or `undefined` when there is not going to be one.
   *
   * Undefined is the ORDINARY answer, not a failure: a simulator has no token, Expo Go has not
   * carried remote push since SDK 53, a user can decline the permission, and a build with no EAS
   * project id cannot mint one. Every one of those is a phone that works perfectly and does not
   * buzz, so none of them may throw.
   */
  getCredential(): Promise<PushCredential | undefined>;
  /**
   * Calls back when the user taps a notification, and once at startup if the app was launched by
   * one. Returns an unsubscribe.
   */
  onOpened(handler: (payload: PushPayload) => void): () => void;
}

/**
 * Where a notification opens (M4).
 *
 * ── THE MAP LIVES HERE, NOT ON THE SERVER ───────────────────────────────────
 * The message carries `resourceType: "order"`, never `/order/64b7…`. A route is a fact about THIS
 * app — the web client sends the same message to a different screen, and a URL minted by the
 * server would be wrong for one of them the first time either renamed a route. It would also put
 * a client's navigation inside a platform module that is not allowed to know what an order is.
 *
 * An unknown kind lands on the inbox rather than nowhere. A build that is older than the message
 * it received is the normal case in a fleet of phones — an alert for a screen that shipped last
 * month must still open something, and the alert list is the honest something.
 */
export function destinationFor(payload: PushPayload): string {
  const id = payload.resourceId;
  if (!id) return "/alerts";

  switch (payload.resourceType) {
    case "order":
      return `/order/${id}`;
    case "patient":
      return `/patient/${id}`;
    default:
      return "/alerts";
  }
}

/**
 * Reads a payload out of whatever the OS handed over.
 *
 * Defensive on purpose: this is the ONE input to the app that did not come through the api-client,
 * was not validated by a schema, and can have been sitting in a notification tray since before
 * this build was installed. A missing field is normal; a hostile one is not worth crashing over.
 */
export function readPayload(raw: unknown): PushPayload {
  if (typeof raw !== "object" || raw === null) return {};
  const data = raw as Record<string, unknown>;
  const str = (key: string): string | undefined =>
    typeof data[key] === "string" ? data[key] : undefined;

  return {
    ...(str("notificationId") ? { notificationId: str("notificationId") } : {}),
    ...(str("templateKey") ? { templateKey: str("templateKey") } : {}),
    ...(str("resourceType") ? { resourceType: str("resourceType") } : {}),
    ...(str("resourceId") ? { resourceId: str("resourceId") } : {}),
    ...(str("branchId") ? { branchId: str("branchId") } : {}),
  };
}
