/**
 * Tenant selection — the hospital is a base URL, and nothing more (M0 §6).
 *
 * ── THE APP DOES NOT IMPLEMENT MULTI-TENANCY ────────────────────────────────
 * The web gets its tenant from the browser's Host header, which it cannot set. A phone has no such
 * constraint, so it *chooses* — and that choice is expressed the only way the backend accepts it:
 * by calling `https://<slug>.<domain>`. `resolveTenant.ts` on the server is untouched, there is no
 * tenant id in a header, and there is no second tenant system here. The app stores a URL.
 *
 * Note what is deliberately absent: `tenantHost`. The api-client offers it for server-side callers
 * whose URL cannot carry the host (the API's own tests use it). In a real build the URL *is* the
 * host, and setting both would let them disagree.
 */

/** A hospital the user has added to this device. Not a secret — it is a public hostname. */
export interface HospitalProfile {
  /** The tenant slug, e.g. `apollo`. Lower-case, the subdomain. */
  slug: string;
  /** What the user sees in the switcher. Defaults to the slug until `/auth/me` gives us better. */
  label: string;
  /** `https://apollo.paperlesstech.in` — what `ApiClient.baseUrl` is set to. */
  baseUrl: string;
  /** Remembered to pre-fill the login field. Never a password, never a token. */
  lastUserEmail?: string;
}

/**
 * Slugs the platform reserves for itself (`admin.paperlesstech.in` is the operator console).
 * Mirrors the server's reserved list — duplicated deliberately: this is a *typo guard* that gives
 * the user a useful message offline, not an authorization decision. The server still refuses.
 */
const RESERVED = new Set(["admin", "api", "www", "app", "mail", "console", "static", "assets"]);

/** DNS label rules, which is what a slug becomes: a–z, 0–9 and hyphens, not at either end. */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export type SlugProblem = "empty" | "format" | "reserved";

export function validateSlug(raw: string): SlugProblem | undefined {
  const slug = raw.trim().toLowerCase();
  if (!slug) return "empty";
  if (!SLUG_PATTERN.test(slug)) return "format";
  if (RESERVED.has(slug)) return "reserved";
  return undefined;
}

export interface ResolveBaseUrlOptions {
  /** `paperlesstech.in`, or `localhost:4000` in development. From `app.config.ts` → `extra`. */
  tenantDomain: string;
  /** Only development may produce an `http://` URL. */
  insecureTransportAllowed: boolean;
}

/**
 * `apollo` + `paperlesstech.in` → `https://apollo.paperlesstech.in`.
 *
 * ── WHY THIS REFUSES RATHER THAN DEGRADES ───────────────────────────────────
 * A production build that can be talked into `http://` is a production build that can have its
 * traffic read on hospital wifi. There is no configuration path to it: the flag comes from the
 * build profile, so the only binary that can produce a plain-HTTP URL is a development one that
 * never reaches a store.
 */
export function resolveBaseUrl(slug: string, options: ResolveBaseUrlOptions): string {
  const problem = validateSlug(slug);
  if (problem) throw new Error(`invalid hospital code (${problem})`);

  const scheme = options.insecureTransportAllowed ? "http" : "https";
  return `${scheme}://${slug.trim().toLowerCase()}.${options.tenantDomain}`;
}

export function createProfile(slug: string, options: ResolveBaseUrlOptions): HospitalProfile {
  const normalised = slug.trim().toLowerCase();
  return { slug: normalised, label: normalised, baseUrl: resolveBaseUrl(normalised, options) };
}
