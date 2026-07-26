/**
 * How the browser reaches the API (ADR-0012, ADR-0005).
 *
 * The hostname the user is browsing IS the hospital. A browser cannot set a
 * `Host` header, so the API must be called on that same hostname — otherwise the
 * request arrives claiming to be nobody and the API answers HMS-TEN-001.
 *
 *   dev         apollo.paperlesstech.in:3000  →  apollo.paperlesstech.in:4000
 *   production  apollo.paperlesstech.in       →  apollo.paperlesstech.in/api/*  (gateway)
 *
 * Hence `NEXT_PUBLIC_API_PORT` rather than a full base URL: a hardcoded
 * `http://localhost:4000` would work on the login page of exactly zero hospitals.
 */
import { createApiClient, type ApiClient } from "@medicore/api-client";

/** Empty string in production: same origin, and the gateway routes /api/*. */
export function apiBaseUrl(): string {
  const port = process.env.NEXT_PUBLIC_API_PORT;
  if (!port) return "";
  if (typeof window === "undefined") return "";
  return `${window.location.protocol}//${window.location.hostname}:${port}`;
}

/** The tenant slug we are currently browsing — for display only, never for authorization. */
export function currentHost(): string {
  if (typeof window === "undefined") return "";
  return window.location.hostname;
}

/**
 * Where the browser actually tried to reach the API — for ERROR MESSAGES only.
 *
 * When a request dies at the network layer the user gets no status code and no
 * error body, only a thrown fetch. Telling them "check your connection" when the
 * real cause is that they typed a hostname belonging to a different machine is
 * advice that sends them looking in the wrong place. Showing the target they hit
 * makes the mistake self-evident.
 *
 * Empty in production (same origin), where there is no confusion to resolve.
 */
export function apiTarget(): string {
  return apiBaseUrl();
}

export function browserApi(
  getAccessToken?: () => string | undefined,
  onUnauthorized?: () => Promise<boolean>,
  getActiveBranch?: () => string | undefined,
): ApiClient {
  return createApiClient({
    baseUrl: apiBaseUrl(),
    ...(getAccessToken ? { getAccessToken } : {}),
    ...(onUnauthorized ? { onUnauthorized } : {}),
    ...(getActiveBranch ? { getActiveBranch } : {}),
    credentials: "include", // the refresh cookie must ride along
  });
}
