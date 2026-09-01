import { Platform } from "react-native";

/**
 * What appears in the user's session list: "iPhone / iOS 18".
 *
 * Deliberately coarse. A precise device fingerprint would make the sessions screen more useful and
 * would also be a durable identifier for the person holding the phone — and this string is stored
 * server-side against every session. Model class and OS version are enough for someone to
 * recognise their own device and revoke one they do not.
 */
export function deviceLabel(): string {
  const os = Platform.OS === "ios" ? "iOS" : Platform.OS === "android" ? "Android" : Platform.OS;
  return `${os} ${String(Platform.Version)}`;
}
