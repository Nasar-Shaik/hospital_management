/**
 * The hospital's public website — a single, server-rendered landing page.
 *
 * Every hospital gets this the moment it is provisioned; the CONTENT is the tenant's own (name,
 * accent colour, services, doctors, contact), fetched server-side so the page is crawlable and
 * fast. There is no client JavaScript here on purpose: a marketing page that a search engine and
 * a slow phone both render instantly beats one that waits for hydration to show a hospital's name.
 *
 * The one thing that varies per viewer is where "Sign in" points once they already have a
 * session — that decision is made by the page (from the cookie) and passed in as `isAuthed`.
 */
import Link from "next/link";
import type { CSSProperties, JSX, ReactNode } from "react";
import type { PublicSite as Site } from "@medicore/api-client";

/* ── colour helpers (run once, server-side) ─────────────────────────────────── */

function clampHex(hex: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : "#0d9488";
}

function shift(hex: string, amount: number): string {
  const n = parseInt(clampHex(hex).slice(1), 16);
  const ch = (shiftBits: number) => {
    const c = (n >> shiftBits) & 0xff;
    return Math.max(0, Math.min(255, Math.round(c + amount)));
  };
  const r = ch(16);
  const g = ch(8);
  const b = ch(0);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

/** White or near-black, whichever reads on the accent (WCAG relative luminance). */
function ink(hex: string): string {
  const n = parseInt(clampHex(hex).slice(1), 16);
  const srgb = [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const lum = 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
  return lum > 0.45 ? "#0b1220" : "#ffffff";
}

/** A glyph for a service card. Free-form icon keys fall back to a plus. */
const SERVICE_ICON: Record<string, string> = {
  emergency: "🚑",
  stethoscope: "🩺",
  flask: "🧪",
  pill: "💊",
  bed: "🛏️",
  scalpel: "⚕️",
  heart: "❤️",
  baby: "🍼",
  eye: "👁️",
  tooth: "🦷",
  bone: "🦴",
  brain: "🧠",
};
function serviceIcon(key?: string): string {
  return (key && SERVICE_ICON[key]) || "➕";
}

function initialOf(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "H";
}

/* ── the page ────────────────────────────────────────────────────────────────── */

export function PublicSite({ site, isAuthed }: { site: Site; isAuthed: boolean }): JSX.Element {
  const accent = clampHex(site.accentColor);
  const accentDark = shift(accent, -28);
  const accentInk = ink(accent);
  const initial = initialOf(site.displayName);

  const signIn = isAuthed
    ? { href: "/dashboard", label: "Go to dashboard" }
    : { href: "/login", label: "Sign in" };

  const hasContact =
    site.contact.phone ||
    site.contact.email ||
    site.contact.address ||
    site.contact.emergencyPhone ||
    site.contact.hoursText;

  const social = Object.entries(site.social).filter(([, v]) => Boolean(v)) as [string, string][];

  return (
    <div
      className="min-h-screen scroll-smooth bg-[var(--color-bg)] text-[var(--color-fg)]"
      style={
        {
          "--accent": accent,
          "--accent-dark": accentDark,
          "--accent-ink": accentInk,
        } as CSSProperties
      }
    >
      {/* Announcement strip */}
      {site.announcement && (
        <div className="bg-[var(--accent)] text-[var(--accent-ink)]">
          <div className="mx-auto flex max-w-6xl items-center justify-center gap-2 px-4 py-2 text-center text-sm">
            <span>{site.announcement.text}</span>
            {site.announcement.link && (
              <a
                href={site.announcement.link}
                className="font-semibold underline underline-offset-2"
              >
                Learn more
              </a>
            )}
          </div>
        </div>
      )}

      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-[var(--color-border)] bg-[var(--color-bg)]/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <a href="#top" className="flex items-center gap-2.5">
            <span
              className="flex h-9 w-9 items-center justify-center rounded-xl text-base font-bold"
              style={{ background: accent, color: accentInk }}
            >
              {initial}
            </span>
            <span className="text-lg font-semibold tracking-tight">{site.displayName}</span>
          </a>

          <nav className="hidden items-center gap-6 text-sm text-[var(--color-fg-muted)] md:flex">
            <a href="#services" className="hover:text-[var(--color-fg)]">
              Services
            </a>
            {site.doctors.length > 0 && (
              <a href="#doctors" className="hover:text-[var(--color-fg)]">
                Doctors
              </a>
            )}
            <a href="#about" className="hover:text-[var(--color-fg)]">
              About
            </a>
            <a href="#contact" className="hover:text-[var(--color-fg)]">
              Contact
            </a>
          </nav>

          <div className="flex items-center gap-3">
            {site.contact.emergencyPhone && (
              <a
                href={`tel:${site.contact.emergencyPhone}`}
                className="hidden text-sm font-semibold text-[var(--color-fg)] sm:inline"
              >
                🚑 {site.contact.emergencyPhone}
              </a>
            )}
            <Link
              href={signIn.href}
              className="rounded-lg px-4 py-2 text-sm font-semibold"
              style={{ background: accent, color: accentInk }}
            >
              {signIn.label}
            </Link>
          </div>
        </div>
      </header>

      <main id="top">
        {/* Hero */}
        <section
          className="relative overflow-hidden"
          style={{
            background: `linear-gradient(135deg, ${accent}, ${accentDark})`,
            color: accentInk,
          }}
        >
          <div className="mx-auto max-w-6xl px-4 py-20 md:py-28">
            <div className="max-w-2xl">
              <p className="mb-3 text-sm font-semibold tracking-wide uppercase opacity-80">
                {site.hospitalName}
              </p>
              <h1 className="text-4xl leading-tight font-bold tracking-tight md:text-5xl">
                {site.tagline}
              </h1>
              <p className="mt-5 max-w-xl text-base/relaxed opacity-90">
                {site.about.split(/\n{2,}/)[0]}
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link
                  href={signIn.href}
                  className="rounded-lg bg-[var(--accent-ink)] px-5 py-3 text-sm font-semibold"
                  style={{ color: accent }}
                >
                  {isAuthed ? "Go to dashboard" : "Patient & staff sign-in"}
                </Link>
                <a
                  href="#contact"
                  className="rounded-lg border px-5 py-3 text-sm font-semibold"
                  style={{ borderColor: accentInk }}
                >
                  Contact us
                </a>
              </div>
            </div>
          </div>
        </section>

        {/* Stats */}
        {site.stats.length > 0 && (
          <section className="border-b border-[var(--color-border)] bg-[var(--color-bg-subtle)]">
            <div className="mx-auto grid max-w-6xl grid-cols-2 gap-6 px-4 py-10 sm:grid-cols-3 md:grid-cols-4">
              {site.stats.map((s) => (
                <div key={s.label} className="text-center">
                  <div className="text-3xl font-bold" style={{ color: accent }}>
                    {s.value}
                  </div>
                  <div className="mt-1 text-sm text-[var(--color-fg-muted)]">{s.label}</div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Services */}
        <section id="services" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-16">
          <SectionHeading eyebrow="What we offer" title="Our services" accent={accent} />
          <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {site.services.map((svc) => (
              <div
                key={svc.name}
                className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-6 transition hover:shadow-md"
              >
                <div
                  className="flex h-11 w-11 items-center justify-center rounded-xl text-xl"
                  style={{ background: `${accent}1a` }}
                >
                  {serviceIcon(svc.icon)}
                </div>
                <h3 className="mt-4 text-lg font-semibold">{svc.name}</h3>
                {svc.description && (
                  <p className="mt-1.5 text-sm text-[var(--color-fg-muted)]">{svc.description}</p>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* Doctors */}
        {site.doctors.length > 0 && (
          <section id="doctors" className="scroll-mt-20 bg-[var(--color-bg-subtle)]">
            <div className="mx-auto max-w-6xl px-4 py-16">
              <SectionHeading eyebrow="Meet the team" title="Our doctors" accent={accent} />
              <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
                {site.doctors.map((doc) => (
                  <div
                    key={doc.id}
                    className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-6 text-center"
                  >
                    <span
                      className="mx-auto flex h-16 w-16 items-center justify-center rounded-full text-xl font-semibold"
                      style={{ background: `${accent}1a`, color: accent }}
                    >
                      {initialOf(doc.name)}
                    </span>
                    <h3 className="mt-4 font-semibold">{doc.name}</h3>
                    {(doc.specialty || doc.designation) && (
                      <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
                        {doc.specialty ?? doc.designation}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* About */}
        <section id="about" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-16">
          <div className="grid gap-10 md:grid-cols-2 md:items-center">
            <div>
              <SectionHeading
                eyebrow="Who we are"
                title={`About ${site.displayName}`}
                accent={accent}
              />
              <div className="mt-6 space-y-4 text-[var(--color-fg-muted)]">
                {site.about.split(/\n{2,}/).map((para, i) => (
                  <p key={i}>{para}</p>
                ))}
              </div>
            </div>
            <div
              className="rounded-2xl p-8 text-[var(--accent-ink)]"
              style={{ background: `linear-gradient(135deg, ${accent}, ${accentDark})` }}
            >
              <p className="text-2xl font-semibold">{site.tagline}</p>
              {site.contact.hoursText && (
                <p className="mt-4 text-sm opacity-90">🕑 {site.contact.hoursText}</p>
              )}
              <Link
                href={signIn.href}
                className="mt-6 inline-block rounded-lg bg-[var(--accent-ink)] px-5 py-3 text-sm font-semibold"
                style={{ color: accent }}
              >
                {isAuthed ? "Go to dashboard" : "Access your account"}
              </Link>
            </div>
          </div>
        </section>

        {/* Contact */}
        {hasContact && (
          <section id="contact" className="scroll-mt-20 bg-[var(--color-bg-subtle)]">
            <div className="mx-auto max-w-6xl px-4 py-16">
              <SectionHeading eyebrow="Get in touch" title="Contact us" accent={accent} />
              <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
                {site.contact.address && (
                  <ContactCard label="Visit us" accent={accent}>
                    <p>{site.contact.address}</p>
                    <a
                      href={`https://maps.google.com/?q=${encodeURIComponent(site.contact.address)}`}
                      className="mt-2 inline-block font-medium"
                      style={{ color: accent }}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Get directions →
                    </a>
                  </ContactCard>
                )}
                {site.contact.phone && (
                  <ContactCard label="Call us" accent={accent}>
                    <a href={`tel:${site.contact.phone}`}>{site.contact.phone}</a>
                  </ContactCard>
                )}
                {site.contact.emergencyPhone && (
                  <ContactCard label="Emergency" accent={accent}>
                    <a href={`tel:${site.contact.emergencyPhone}`} className="font-semibold">
                      {site.contact.emergencyPhone}
                    </a>
                  </ContactCard>
                )}
                {site.contact.email && (
                  <ContactCard label="Email" accent={accent}>
                    <a href={`mailto:${site.contact.email}`} className="break-all">
                      {site.contact.email}
                    </a>
                  </ContactCard>
                )}
                {site.contact.hoursText && (
                  <ContactCard label="Opening hours" accent={accent}>
                    <p>{site.contact.hoursText}</p>
                  </ContactCard>
                )}
              </div>
            </div>
          </section>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-[var(--color-border)] bg-[var(--color-bg)]">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2.5">
            <span
              className="flex h-8 w-8 items-center justify-center rounded-lg text-sm font-bold"
              style={{ background: accent, color: accentInk }}
            >
              {initial}
            </span>
            <span className="font-semibold">{site.displayName}</span>
          </div>

          {social.length > 0 && (
            <div className="flex flex-wrap gap-4 text-sm text-[var(--color-fg-muted)]">
              {social.map(([name, url]) => (
                <a
                  key={name}
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="capitalize hover:text-[var(--color-fg)]"
                >
                  {name}
                </a>
              ))}
            </div>
          )}

          <div className="text-sm text-[var(--color-fg-muted)]">
            © {new Date().getFullYear()} {site.hospitalName} ·{" "}
            <Link href="/login" className="hover:text-[var(--color-fg)]">
              Staff sign-in
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

function SectionHeading({
  eyebrow,
  title,
  accent,
}: {
  eyebrow: string;
  title: string;
  accent: string;
}): JSX.Element {
  return (
    <div>
      <p className="text-sm font-semibold tracking-wide uppercase" style={{ color: accent }}>
        {eyebrow}
      </p>
      <h2 className="mt-2 text-3xl font-bold tracking-tight">{title}</h2>
    </div>
  );
}

function ContactCard({
  label,
  accent,
  children,
}: {
  label: string;
  accent: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-6">
      <p className="text-sm font-semibold" style={{ color: accent }}>
        {label}
      </p>
      <div className="mt-2 text-sm text-[var(--color-fg-muted)]">{children}</div>
    </div>
  );
}
