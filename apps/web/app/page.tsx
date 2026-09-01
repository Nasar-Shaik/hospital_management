/**
 * The hospital's public home page — served at the tenant root (e.g. `apollo.localhost/`).
 *
 * This used to redirect straight to `/dashboard`. Now a visitor who has never signed in first
 * meets the hospital's own website — its name, services, doctors and how to reach it — and steps
 * into sign-in from there, exactly like a real hospital's site. Content is fetched server-side so
 * the page is crawlable and instant (see `lib/publicSite.ts`).
 *
 * Three outcomes:
 *   - content resolved & published  → render the site;
 *   - content resolved but UNpublished → send the visitor to sign-in (the hospital has hidden its
 *     half-built page on purpose);
 *   - nothing resolved (unknown host, API down) → a neutral fallback that still offers sign-in,
 *     because a public URL must never answer with a stack trace.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { fetchPublicSite } from "../lib/publicSite";
import { PublicSite } from "../components/public/PublicSite";

const REFRESH_COOKIE = "hms_refresh";

export async function generateMetadata(): Promise<Metadata> {
  const site = await fetchPublicSite();
  if (!site) return { title: "Hospital Management" };
  const title = `${site.displayName} — ${site.tagline}`;
  return {
    title,
    description: site.metaDescription,
    openGraph: {
      title,
      description: site.metaDescription,
      siteName: site.displayName,
      type: "website",
    },
  };
}

export default async function HomePage() {
  const [site, cookieStore] = await Promise.all([fetchPublicSite(), cookies()]);
  const isAuthed = cookieStore.has(REFRESH_COOKIE);

  if (!site) return <Fallback />;
  if (!site.published) redirect("/login");

  return <PublicSite site={site} isAuthed={isAuthed} />;
}

/** Shown only when the host resolves to no hospital, or the API is unreachable. */
function Fallback() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--color-bg-subtle)] px-4">
      <div className="w-full max-w-md text-center">
        <h1 className="text-2xl font-semibold text-[var(--color-fg)]">Hospital Management</h1>
        <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
          This site is being set up. If you have an account, you can sign in below.
        </p>
        <Link
          href="/login"
          className="mt-6 inline-block rounded-lg bg-[var(--color-brand-600)] px-5 py-3 text-sm font-semibold text-[var(--color-on-accent)]"
        >
          Sign in
        </Link>
      </div>
    </main>
  );
}
