/**
 * The ONLY `new ApiClient(...)` in the application (M0 §9).
 *
 * ── WHY ONE CONSTRUCTION SITE IS A RULE AND NOT A STYLE ─────────────────────
 * Every callback below is a security decision: which token is attached, which hospital the request
 * goes to, which branch it acts in, and what happens when the session expires. A second client
 * built somewhere else would be a second set of those decisions, made by whoever was in a hurry —
 * and the one that forgets `getActiveBranch` sends a write with no site on it. A lint rule
 * (`no-restricted-imports` is the nearest available; see `eslint.config.mjs`) plus this comment is
 * the enforcement; the boundary check in `.dependency-cruiser.cjs` is the backstop.
 *
 * ── THE CALLBACKS ARE READ LIVE, NEVER CAPTURED ─────────────────────────────
 * `getAccessToken` and `getActiveBranch` are called on every request. That is what lets a token
 * refresh or a branch switch take effect on the very next call with no client rebuild, no React
 * context change and no stale closure — the property the branch switcher depends on.
 *
 * ── WHAT IS DELIBERATELY NOT SET ────────────────────────────────────────────
 * `tenantHost` — in a real build the URL *is* the host (M0 §6); setting both invites disagreement.
 * `credentials` — `"omit"`, because a phone has no cookie jar the refresh flow can rely on across
 * a cold start. The refresh token travels in the body, which is the native path the API supports.
 */
import { ApiClient, type DeprecationNotice, type LicenseHeader } from "@medicore/api-client";
import type { HospitalProfile } from "./tenant";

export interface ApiClientDeps {
  profile: HospitalProfile;
  getAccessToken: () => string | undefined;
  getActiveBranch: () => string | undefined;
  /** Returns true if a silent refresh succeeded and the failed request should be replayed. */
  onUnauthorized: () => Promise<boolean>;
  onLicenseState?: (state: LicenseHeader | null) => void;
  onDeprecation?: (notice: DeprecationNotice, path: string) => void;
  /** Injected by tests. In a build this is React Native's global `fetch`. */
  fetchImpl?: typeof fetch;
}

export function createApiClient(deps: ApiClientDeps): ApiClient {
  return new ApiClient({
    baseUrl: deps.profile.baseUrl,
    credentials: "omit",
    getAccessToken: deps.getAccessToken,
    getActiveBranch: deps.getActiveBranch,
    onUnauthorized: deps.onUnauthorized,
    ...(deps.onLicenseState ? { onLicenseState: deps.onLicenseState } : {}),
    ...(deps.onDeprecation ? { onDeprecation: deps.onDeprecation } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
}
