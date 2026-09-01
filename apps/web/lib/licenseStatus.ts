/**
 * Client-side licence status (ADR-0016) — a tiny pub/sub the API client feeds.
 *
 * Every tenant response carries the hospital's licence state in `X-License-State` /
 * `X-License-Days-Left` (set by `resolveTenant`). The API client reads those headers
 * on each call and hands them here via `setLicenseStatus`; the renewal banner
 * subscribes. Kept OUT of React state on purpose: a header arrives on every request,
 * and pushing that through the auth context would re-render the whole app each time.
 *
 * A hard-expired licence never reaches here — the request is refused before the app
 * renders — so this only ever describes EXPIRING (heads-up) or GRACE (past expiry,
 * still served).
 */
import type { LicenseHeader } from "@medicore/api-client";

export type LicenseStatus = LicenseHeader;

let current: LicenseStatus | null = null;
const listeners = new Set<() => void>();

/** Fed by the API client after every response. `null` clears the banner (perpetual / renewed). */
export function setLicenseStatus(next: LicenseStatus | null): void {
  // Skip the notify when nothing meaningful changed, so a burst of requests with the
  // same state does not thrash subscribers.
  if (sameStatus(current, next)) return;
  current = next;
  for (const l of listeners) l();
}

export function getLicenseStatus(): LicenseStatus | null {
  return current;
}

export function subscribeLicense(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function sameStatus(a: LicenseStatus | null, b: LicenseStatus | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.state === b.state && a.daysLeft === b.daysLeft;
}
