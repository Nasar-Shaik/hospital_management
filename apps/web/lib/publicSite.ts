/**
 * Server-side fetch of the current hospital's public website content.
 *
 * The public site is SERVER-rendered — a marketing page has to be crawlable, and a hospital's
 * name and services are the first thing a search engine should see, not a client-side spinner.
 * So this runs on the Next server, reads the `Host` header (the host IS the hospital, ADR-0012),
 * and calls the API on that same host. The API's `resolveTenant` keys off that Host exactly as it
 * does for a browser request, so `apollo.localhost` resolves to the apollo database and no other.
 *
 * A failure here is NOT fatal: an unknown host, a suspended tenant, or an API that is down all
 * return `null`, and the page renders a neutral fallback rather than a stack trace. A public
 * website that 500s is worse than one that is a little generic.
 */
import { headers } from "next/headers";
import type { PublicSite } from "@medicore/api-client";

/** Where the API lives for a given browsing host. Mirrors `lib/api.ts` `apiBaseUrl`, server-side. */
function apiOrigin(hostHeader: string): string {
  const port = process.env.NEXT_PUBLIC_API_PORT;
  // Dev: the API is a sibling port on the same hostname (apollo.localhost:4000).
  if (port) return `http://${hostHeader.split(":")[0]}:${port}`;
  // Prod: same origin, the gateway routes /api/* — but a server fetch needs an absolute URL.
  return `https://${hostHeader}`;
}

export async function fetchPublicSite(): Promise<PublicSite | null> {
  const host = (await headers()).get("host") ?? "";
  if (!host) return null;

  try {
    const res = await fetch(`${apiOrigin(host)}/api/v1/site`, {
      headers: { host },
      // Marketing content changes rarely but must reflect an admin's save promptly — a short
      // revalidate keeps the page fast without making an edit invisible for long.
      next: { revalidate: 30 },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { success: boolean; data: PublicSite };
    return body.success ? body.data : null;
  } catch {
    return null;
  }
}
