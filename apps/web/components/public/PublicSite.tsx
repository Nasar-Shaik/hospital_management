/**
 * The hospital's public website — a single, server-rendered landing page.
 *
 * Every hospital gets this the moment it is provisioned; the CONTENT is the tenant's own (name,
 * accent colour, services, doctors, stats, contact), fetched server-side so the page is crawlable
 * and fast. There is no client JavaScript here on purpose: a marketing page that a search engine
 * and a slow phone both render instantly beats one that waits for hydration to show a hospital's
 * name. Interactivity that a marketing page needs (smooth-scroll nav, hover states, a back-to-top)
 * is done in pure CSS.
 *
 * The visual language is a polished, medical-industry landing page (topbar → branded header → hero
 * with a "why choose us" panel → stats → services → doctors → about → contact → footer). It is
 * deliberately a LIGHT design regardless of the app's dark theme: a hospital's public site should
 * look the same to every visitor, not flip to dark because a staff member once toggled it. Every
 * accent is derived from the tenant's own brand colour, so the same layout renders in teal for one
 * hospital and blue for another.
 *
 * The one thing that varies per viewer is where "Sign in" points once they already have a
 * session — that decision is made by the page (from the cookie) and passed in as `isAuthed`.
 */
import Link from "next/link";
import { Poppins } from "next/font/google";
import type { CSSProperties, JSX, ReactNode } from "react";
import type { PublicSite as Site } from "@medicore/api-client";

/** Headings use Poppins (self-hosted at build time — no runtime request). Body stays system-native. */
const poppins = Poppins({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-poppins",
  display: "swap",
});

/* ── colour helpers (run once, server-side) ─────────────────────────────────── */

function clampHex(hex: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : "#0d9488";
}

/** Lighten (+) or darken (−) a hex by a flat RGB amount. */
function shift(hex: string, amount: number): string {
  const n = parseInt(clampHex(hex).slice(1), 16);
  const ch = (bits: number) => {
    const c = (n >> bits) & 0xff;
    return Math.max(0, Math.min(255, Math.round(c + amount)));
  };
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, "0")}`;
}

/** Blend a colour toward white; `keep` is how much of the colour survives (0 → white). */
function wash(hex: string, keep: number): string {
  const n = parseInt(clampHex(hex).slice(1), 16);
  const ch = (bits: number) => {
    const c = (n >> bits) & 0xff;
    return Math.round(c * keep + 255 * (1 - keep));
  };
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, "0")}`;
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

function initialOf(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "H";
}

/* ── icon set (stroke line icons, currentColor) ─────────────────────────────── */

/** Line-icon path data. One consistent style beats a bag of mismatched emoji on a medical site. */
const GLYPH: Record<string, string[]> = {
  plus: ["M12 5v14", "M5 12h14"],
  pulse: ["M22 12h-4l-3 9L9 3l-3 9H2"],
  heart: [
    "M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 1 0-7.8 7.8L12 21.2l8.8-8.8a5.5 5.5 0 0 0 0-7.8Z",
  ],
  flask: ["M9 3h6", "M10 3v6l-5.2 8.4A2 2 0 0 0 6.5 20h11a2 2 0 0 0 1.7-2.6L14 9V3", "M7.5 14h9"],
  pill: ["M10.5 20.5 3.5 13.5a5 5 0 0 1 7-7l7 7a5 5 0 0 1-7 7Z", "M8.5 8.5l7 7"],
  bed: [
    "M3 7v13",
    "M3 13h18v6",
    "M21 19v-4a2 2 0 0 0-2-2",
    "M7 13V9a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v4",
  ],
  shield: ["M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z", "M9 12l2 2 4-4"],
  clock: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z", "M12 7v5l3 2"],
  eye: ["M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z", "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"],
  baby: [
    "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z",
    "M9 12a4.5 4.5 0 0 0 6 0",
    "M9 9h.01",
    "M15 9h.01",
  ],
  tooth: [
    "M9 3c1.2 0 1.8.9 3 .9S13.8 3 15 3a4 4 0 0 1 4 4c0 3-1 4-1.6 7S17 21 16 21s-1.4-3-1.8-5S13 14 12 14s-1.8 0-2.2 2S9 21 8 21s-1.8-4-2.4-7S5 10 5 7a4 4 0 0 1 4-4Z",
  ],
  brain: [
    "M9.5 4a2.5 2.5 0 0 0-2.5 2.5 2.5 2.5 0 0 0-2 4A2.5 2.5 0 0 0 5 15a2.5 2.5 0 0 0 4.5 1.5V4Z",
    "M14.5 4A2.5 2.5 0 0 1 17 6.5a2.5 2.5 0 0 1 2 4A2.5 2.5 0 0 1 19 15a2.5 2.5 0 0 1-4.5 1.5V4Z",
  ],
  microscope: ["M6 18h8", "M3 22h18", "M14 22a7 7 0 0 0 0-14", "M9 13V7a2 2 0 0 1 2-2h1"],
  pin: ["M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z", "M12 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"],
  phone: [
    "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z",
  ],
  mail: [
    "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z",
    "M22 6l-10 7L2 6",
  ],
  arrow: ["M5 12h14", "M13 6l6 6-6 6"],
  check: ["M20 6 9 17l-5-5"],
  ambulance: [
    "M8 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
    "M18 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
    "M10 17h4",
    "M2 6h11v11",
    "M13 9h4l4 4v4h-3",
    "M6 6V4M5 5h2",
  ],
};

/** Maps a service's free-form icon key to a glyph; unknown keys fall back to a plus. */
const SERVICE_GLYPH: Record<string, string> = {
  emergency: "ambulance",
  stethoscope: "pulse",
  flask: "flask",
  pill: "pill",
  bed: "bed",
  scalpel: "pulse",
  heart: "heart",
  baby: "baby",
  eye: "eye",
  tooth: "tooth",
  bone: "pulse",
  brain: "brain",
};

function Icon({
  name,
  size = 22,
  stroke = 1.7,
  className,
}: {
  name: string;
  size?: number;
  stroke?: number;
  className?: string;
}): JSX.Element {
  const paths = GLYPH[name] ?? GLYPH.plus ?? ["M12 5v14", "M5 12h14"];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}

/** Filled brand glyphs for social links. */
const SOCIAL_GLYPH: Record<string, string> = {
  website:
    "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 2c1.7 0 3.7 2.6 4.3 6.5H7.7C8.3 6.6 10.3 4 12 4Zm-6.9 6.5h2.3A20 20 0 0 0 7.2 13H4.6a8 8 0 0 1 .5-2.5ZM4.6 15h2.6a20 20 0 0 0 .2 2.5H5.1a8 8 0 0 1-.5-2.5Zm2.6-4.5H9.3c0 .8-.1 1.6-.1 2.5H7.1a18 18 0 0 1 .1-2.5Zm0 4.5h2c0 .9.1 1.7.2 2.5H7.4a18 18 0 0 1-.2-2.5Zm4.8 6c-1.1 0-2.4-1.6-3.2-4h6.4c-.8 2.4-2.1 4-3.2 4Zm.9-6h-1.8c0-.9-.1-1.7-.1-2.5h2c0 .8 0 1.6-.1 2.5Zm0-4.5h-1.8V6.6c.9.9 1.5 2.5 1.8 3.9Zm3.9 0h2.3a8 8 0 0 1 .5 2.5h-2.6a20 20 0 0 0-.2-2.5Zm0 7a20 20 0 0 0 .2-2.5h2.6a8 8 0 0 1-.5 2.5h-2.3Z",
  facebook:
    "M13 22v-8h2.5l.5-3H13V9c0-.9.3-1.5 1.6-1.5H16V4.9c-.3 0-1.3-.1-2.4-.1-2.4 0-4 1.4-4 4.1V11H7v3h2.6v8H13Z",
  instagram:
    "M12 7.3A4.7 4.7 0 1 0 12 16.7 4.7 4.7 0 0 0 12 7.3Zm0 7.7a3 3 0 1 1 0-6 3 3 0 0 1 0 6Zm4.9-7.9a1.1 1.1 0 1 1-2.2 0 1.1 1.1 0 0 1 2.2 0ZM20 6.9c-.1-1.5-.4-2.8-1.5-3.9S16.6 1.6 15.1 1.5C13.6 1.4 8.4 1.4 6.9 1.5c-1.5.1-2.8.4-3.9 1.5S1.6 5.4 1.5 6.9c-.1 1.5-.1 6.7 0 8.2.1 1.5.4 2.8 1.5 3.9s2.4 1.4 3.9 1.5c1.5.1 6.7.1 8.2 0 1.5-.1 2.8-.4 3.9-1.5s1.4-2.4 1.5-3.9c.1-1.5.1-6.7 0-8.2Zm-2 9.8a3 3 0 0 1-1.7 1.7c-1.2.5-4 .4-5.3.4s-4.1.1-5.3-.4a3 3 0 0 1-1.7-1.7c-.5-1.2-.4-4-.4-5.3s-.1-4.1.4-5.3a3 3 0 0 1 1.7-1.7c1.2-.5 4-.4 5.3-.4s4.1-.1 5.3.4a3 3 0 0 1 1.7 1.7c.5 1.2.4 4 .4 5.3s.1 4.1-.4 5.3Z",
  twitter:
    "M18.9 2H22l-7 8 8.2 11h-6.4l-5-6.6L6 21H2.9l7.5-8.6L2.5 2h6.6l4.5 6 5.3-6Zm-1.1 17h1.7L7.3 3.8H5.5L17.8 19Z",
  youtube:
    "M23 8.2a3 3 0 0 0-2.1-2.1C19 5.6 12 5.6 12 5.6s-7 0-8.9.5A3 3 0 0 0 1 8.2 31 31 0 0 0 .5 12 31 31 0 0 0 1 15.8a3 3 0 0 0 2.1 2.1c1.9.5 8.9.5 8.9.5s7 0 8.9-.5a3 3 0 0 0 2.1-2.1c.4-1.9.5-3.8.5-3.8s0-1.9-.5-3.8ZM9.8 15.3V8.7l5.7 3.3-5.7 3.3Z",
  linkedin:
    "M6.9 8.8H3.7V21h3.2V8.8ZM5.3 3.4a1.9 1.9 0 1 0 0 3.8 1.9 1.9 0 0 0 0-3.8ZM21 21v-6.7c0-3.2-1.7-4.7-4-4.7-1.8 0-2.6 1-3.1 1.7V8.8H10.7c.05.9 0 12.2 0 12.2h3.2v-6.8c0-.3 0-.6.1-.8.3-.6.8-1.3 1.8-1.3 1.3 0 1.8 1 1.8 2.4V21H21Z",
};

function socialLabel(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

function SocialLink({
  name,
  url,
  className,
}: {
  name: string;
  url: string;
  className?: string;
}): JSX.Element {
  const d = SOCIAL_GLYPH[name] ?? SOCIAL_GLYPH.website;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      aria-label={socialLabel(name)}
      title={socialLabel(name)}
      className={className}
    >
      <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d={d} />
      </svg>
    </a>
  );
}

/* ── the page ────────────────────────────────────────────────────────────────── */

export function PublicSite({ site, isAuthed }: { site: Site; isAuthed: boolean }): JSX.Element {
  const accent = clampHex(site.accentColor);
  const accentDark = shift(accent, -34);
  const accentInk = ink(accent);
  const initial = initialOf(site.displayName);

  const signIn = isAuthed
    ? { href: "/dashboard", label: "Go to dashboard" }
    : { href: "/login", label: "Sign in" };

  const aboutParas = site.about.split(/\n{2,}/).filter(Boolean);
  const lead = aboutParas[0] ?? site.tagline;

  const social = (Object.entries(site.social) as [string, string][]).filter(([, v]) => Boolean(v));

  const hasContact =
    site.contact.phone ||
    site.contact.email ||
    site.contact.address ||
    site.contact.emergencyPhone ||
    site.contact.hoursText;

  // The hero "why choose" panel highlights the first three services — real content, no invented copy.
  const highlights = site.services.slice(0, 3);
  // The about checklist reuses service names as concrete proof points.
  const proofPoints = site.services.slice(0, 4);

  const cssVars = {
    "--accent": accent,
    "--accent-dark": accentDark,
    "--accent-ink": accentInk,
    "--navy": "#152238",
    "--body": "#5b6b84",
    "--muted": "#8a97ab",
    "--line": "#e7edf5",
    "--tint": wash(accent, 0.06),
    "--soft": `${accent}14`,
    "--softer": `${accent}0d`,
  } as CSSProperties;

  return (
    <div className={`psite ${poppins.variable}`} style={cssVars} id="top">
      <style>{PSITE_CSS}</style>

      {/* Announcement strip */}
      {site.announcement && (
        <div className="psite-ann">
          <div className="psite-wrap psite-ann-in">
            <span>{site.announcement.text}</span>
            {site.announcement.link && (
              <a href={site.announcement.link} className="psite-ann-link">
                Learn more →
              </a>
            )}
          </div>
        </div>
      )}

      {/* Top bar — contact + social */}
      {(site.contact.email || site.contact.phone || social.length > 0) && (
        <div className="psite-topbar">
          <div className="psite-wrap psite-topbar-in">
            <div className="psite-topbar-contact">
              {site.contact.email && (
                <a href={`mailto:${site.contact.email}`} className="psite-topbar-item">
                  <Icon name="mail" size={15} /> {site.contact.email}
                </a>
              )}
              {site.contact.phone && (
                <a href={`tel:${site.contact.phone}`} className="psite-topbar-item">
                  <Icon name="phone" size={15} /> {site.contact.phone}
                </a>
              )}
            </div>
            {social.length > 0 && (
              <div className="psite-topbar-social">
                {social.map(([name, url]) => (
                  <SocialLink key={name} name={name} url={url} className="psite-topbar-soc" />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Header */}
      <header className="psite-header">
        <div className="psite-wrap psite-header-in">
          <a href="#top" className="psite-logo">
            <span className="psite-logo-badge">{initial}</span>
            <span className="psite-logo-name">{site.displayName}</span>
          </a>

          <nav className="psite-nav">
            <a href="#services">Services</a>
            {site.doctors.length > 0 && <a href="#doctors">Doctors</a>}
            <a href="#about">About</a>
            {hasContact && <a href="#contact">Contact</a>}
          </nav>

          <div className="psite-header-cta">
            {site.contact.emergencyPhone && (
              <a href={`tel:${site.contact.emergencyPhone}`} className="psite-emergency">
                <Icon name="ambulance" size={18} />
                <span>
                  <em>Emergency</em>
                  {site.contact.emergencyPhone}
                </span>
              </a>
            )}
            <Link href={signIn.href} className="psite-btn psite-btn-solid">
              {signIn.label}
            </Link>
          </div>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className="psite-hero">
          <div className="psite-wrap psite-hero-in">
            <div className="psite-hero-copy">
              <p className="psite-eyebrow">{site.hospitalName}</p>
              <h1 className="psite-hero-title">{site.tagline}</h1>
              <p className="psite-hero-lead">{lead}</p>
              <div className="psite-hero-actions">
                <Link href={signIn.href} className="psite-btn psite-btn-solid psite-btn-lg">
                  {isAuthed ? "Go to dashboard" : "Patient & staff sign-in"}
                  <Icon name="arrow" size={18} />
                </Link>
                {hasContact && (
                  <a href="#contact" className="psite-btn psite-btn-ghost psite-btn-lg">
                    Contact us
                  </a>
                )}
              </div>
              {(site.contact.hoursText || site.contact.emergencyPhone) && (
                <div className="psite-hero-trust">
                  {site.contact.emergencyPhone && (
                    <span>
                      <Icon name="ambulance" size={16} /> 24/7 emergency
                    </span>
                  )}
                  {site.contact.hoursText && (
                    <span>
                      <Icon name="clock" size={16} /> {site.contact.hoursText}
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Why-choose card */}
            <aside className="psite-why">
              <h2 className="psite-why-title">Why choose {site.displayName}?</h2>
              <p className="psite-why-sub">
                Everything you need under one roof — from first consult to full recovery.
              </p>
              <ul className="psite-why-list">
                {highlights.map((svc) => (
                  <li key={svc.name}>
                    <span className="psite-why-ic">
                      <Icon name={SERVICE_GLYPH[svc.icon ?? ""] ?? "plus"} size={20} />
                    </span>
                    <span>
                      <strong>{svc.name}</strong>
                      {svc.description && <em>{svc.description}</em>}
                    </span>
                  </li>
                ))}
              </ul>
            </aside>
          </div>
        </section>

        {/* Stats */}
        {site.stats.length > 0 && (
          <section className="psite-stats">
            <div className="psite-wrap psite-stats-in">
              {site.stats.map((s) => (
                <div key={s.label} className="psite-stat">
                  <div className="psite-stat-val">{s.value}</div>
                  <div className="psite-stat-label">{s.label}</div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Services */}
        <section id="services" className="psite-section">
          <div className="psite-wrap">
            <SectionTitle eyebrow="What we offer" title="Our services" />
            <div className="psite-svc-grid">
              {site.services.map((svc) => (
                <article key={svc.name} className="psite-svc">
                  <span className="psite-svc-ic">
                    <Icon name={SERVICE_GLYPH[svc.icon ?? ""] ?? "plus"} size={26} />
                  </span>
                  <h3>{svc.name}</h3>
                  {svc.description && <p>{svc.description}</p>}
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* Doctors */}
        {site.doctors.length > 0 && (
          <section id="doctors" className="psite-section psite-section-tint">
            <div className="psite-wrap">
              <SectionTitle eyebrow="Meet the team" title="Our specialists" />
              <div className="psite-doc-grid">
                {site.doctors.map((doc) => (
                  <article key={doc.id} className="psite-doc">
                    <span className="psite-doc-avatar">{initialOf(doc.name)}</span>
                    <div className="psite-doc-info">
                      <h4>{doc.name}</h4>
                      {(doc.specialty || doc.designation) && (
                        <span className="psite-doc-role">{doc.specialty ?? doc.designation}</span>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* About */}
        <section id="about" className="psite-section">
          <div className="psite-wrap psite-about">
            <div className="psite-about-panel">
              <p className="psite-about-panel-tag">{site.hospitalName}</p>
              <p className="psite-about-panel-line">{site.tagline}</p>
              {site.contact.hoursText && (
                <p className="psite-about-panel-hours">
                  <Icon name="clock" size={16} /> {site.contact.hoursText}
                </p>
              )}
              <Link href={signIn.href} className="psite-btn psite-about-panel-btn">
                {isAuthed ? "Go to dashboard" : "Access your account"}
                <Icon name="arrow" size={17} />
              </Link>
            </div>
            <div className="psite-about-copy">
              <SectionTitle eyebrow="Who we are" title={`About ${site.displayName}`} left />
              <div className="psite-about-text">
                {aboutParas.map((p, i) => (
                  <p key={i}>{p}</p>
                ))}
              </div>
              {proofPoints.length > 0 && (
                <ul className="psite-about-checks">
                  {proofPoints.map((p) => (
                    <li key={p.name}>
                      <Icon name="check" size={16} /> {p.name}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>

        {/* Contact */}
        {hasContact && (
          <section id="contact" className="psite-section psite-section-tint">
            <div className="psite-wrap">
              <SectionTitle eyebrow="Get in touch" title="Contact us" />
              <div className="psite-contact">
                <div className="psite-contact-cards">
                  {site.contact.address && (
                    <ContactCard icon="pin" label="Visit us">
                      <p>{site.contact.address}</p>
                      <a
                        href={`https://maps.google.com/?q=${encodeURIComponent(site.contact.address)}`}
                        target="_blank"
                        rel="noreferrer"
                        className="psite-contact-link"
                      >
                        Get directions →
                      </a>
                    </ContactCard>
                  )}
                  {site.contact.phone && (
                    <ContactCard icon="phone" label="Call us">
                      <a href={`tel:${site.contact.phone}`}>{site.contact.phone}</a>
                    </ContactCard>
                  )}
                  {site.contact.emergencyPhone && (
                    <ContactCard icon="ambulance" label="Emergency">
                      <a href={`tel:${site.contact.emergencyPhone}`} className="psite-strong">
                        {site.contact.emergencyPhone}
                      </a>
                    </ContactCard>
                  )}
                  {site.contact.email && (
                    <ContactCard icon="mail" label="Email us">
                      <a href={`mailto:${site.contact.email}`} className="psite-break">
                        {site.contact.email}
                      </a>
                    </ContactCard>
                  )}
                  {site.contact.hoursText && (
                    <ContactCard icon="clock" label="Opening hours">
                      <p>{site.contact.hoursText}</p>
                    </ContactCard>
                  )}
                </div>
                {site.contact.address && (
                  <div className="psite-map">
                    <iframe
                      title={`Map to ${site.displayName}`}
                      src={`https://www.google.com/maps?q=${encodeURIComponent(site.contact.address)}&output=embed`}
                      loading="lazy"
                      referrerPolicy="no-referrer-when-downgrade"
                    />
                  </div>
                )}
              </div>
            </div>
          </section>
        )}
      </main>

      {/* Footer */}
      <footer className="psite-footer">
        <div className="psite-wrap psite-footer-in">
          <div className="psite-footer-brand">
            <div className="psite-footer-logo">
              <span className="psite-logo-badge">{initial}</span>
              <span>{site.displayName}</span>
            </div>
            <p className="psite-footer-blurb">{site.tagline}</p>
            {social.length > 0 && (
              <div className="psite-footer-social">
                {social.map(([name, url]) => (
                  <SocialLink key={name} name={name} url={url} className="psite-footer-soc" />
                ))}
              </div>
            )}
          </div>

          <div className="psite-footer-col">
            <h5>Explore</h5>
            <a href="#services">Services</a>
            {site.doctors.length > 0 && <a href="#doctors">Doctors</a>}
            <a href="#about">About us</a>
            {hasContact && <a href="#contact">Contact</a>}
          </div>

          {hasContact && (
            <div className="psite-footer-col">
              <h5>Reach us</h5>
              {site.contact.address && <p>{site.contact.address}</p>}
              {site.contact.phone && <a href={`tel:${site.contact.phone}`}>{site.contact.phone}</a>}
              {site.contact.email && (
                <a href={`mailto:${site.contact.email}`}>{site.contact.email}</a>
              )}
              {site.contact.hoursText && <p>{site.contact.hoursText}</p>}
            </div>
          )}

          <div className="psite-footer-col psite-footer-signin">
            <h5>Staff & patients</h5>
            <p>Access records, appointments and billing.</p>
            <Link href={signIn.href} className="psite-btn psite-btn-solid">
              {signIn.label}
            </Link>
          </div>
        </div>
        <div className="psite-footer-bar">
          <div className="psite-wrap psite-footer-bar-in">
            <span>
              © {new Date().getFullYear()} {site.hospitalName}. All rights reserved.
            </span>
            <Link href="/login">Staff sign-in</Link>
          </div>
        </div>
      </footer>

      {/* Back to top (CSS-only) */}
      <a href="#top" className="psite-totop" aria-label="Back to top">
        <Icon name="arrow" size={20} className="psite-totop-ic" />
      </a>
    </div>
  );
}

/* ── small building blocks ───────────────────────────────────────────────────── */

function SectionTitle({
  eyebrow,
  title,
  left = false,
}: {
  eyebrow: string;
  title: string;
  left?: boolean;
}): JSX.Element {
  return (
    <div className={`psite-title ${left ? "psite-title-left" : ""}`}>
      <p className="psite-title-eyebrow">{eyebrow}</p>
      <h2 className="psite-title-h">{title}</h2>
      <span className="psite-title-rule" />
    </div>
  );
}

function ContactCard({
  icon,
  label,
  children,
}: {
  icon: string;
  label: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="psite-cc">
      <span className="psite-cc-ic">
        <Icon name={icon} size={20} />
      </span>
      <div className="psite-cc-body">
        <p className="psite-cc-label">{label}</p>
        <div className="psite-cc-val">{children}</div>
      </div>
    </div>
  );
}

/* ── styles (static; accent injected via CSS variables) ──────────────────────── */

const PSITE_CSS = `
.psite{
  --font: ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  font-family:var(--font); color:var(--body); background:#fff; min-height:100vh;
  -webkit-font-smoothing:antialiased; line-height:1.6; scroll-behavior:smooth;
}
.psite h1,.psite h2,.psite h3,.psite h4,.psite h5{
  font-family:var(--font-poppins),var(--font); color:var(--navy); margin:0; line-height:1.2;
}
.psite p{margin:0}
.psite a{color:inherit; text-decoration:none}
.psite ::selection{background:var(--accent); color:var(--accent-ink)}
.psite-wrap{max-width:1160px; margin:0 auto; padding:0 24px}
.psite-btn{display:inline-flex; align-items:center; gap:8px; border-radius:9999px;
  font-weight:600; font-size:14px; padding:11px 22px; transition:.2s ease; cursor:pointer;
  font-family:var(--font-poppins),var(--font)}
.psite-btn-solid{background:var(--accent); color:var(--accent-ink)}
.psite-btn-solid:hover{background:var(--accent-dark)}
.psite-btn-ghost{background:transparent; color:var(--navy); border:1.5px solid var(--line)}
.psite-btn-ghost:hover{border-color:var(--accent); color:var(--accent)}
.psite-btn-lg{padding:14px 26px; font-size:15px}

/* Announcement */
.psite-ann{background:var(--accent); color:var(--accent-ink)}
.psite-ann-in{display:flex; gap:10px; align-items:center; justify-content:center;
  padding:9px 24px; font-size:13.5px; text-align:center}
.psite-ann-link{font-weight:700; text-decoration:underline; text-underline-offset:2px}

/* Topbar */
.psite-topbar{background:var(--navy); color:#c9d3e2; font-size:13px}
.psite-topbar-in{display:flex; align-items:center; justify-content:space-between; gap:12px;
  min-height:40px; flex-wrap:wrap}
.psite-topbar-contact{display:flex; gap:22px; flex-wrap:wrap}
.psite-topbar-item{display:inline-flex; align-items:center; gap:7px; color:#c9d3e2}
.psite-topbar-item:hover{color:#fff}
.psite-topbar-item svg{opacity:.75}
.psite-topbar-social{display:flex; gap:6px}
.psite-topbar-soc{display:inline-flex; align-items:center; justify-content:center;
  width:28px; height:28px; border-radius:9999px; color:#c9d3e2;
  background:rgba(255,255,255,.08); transition:.2s ease}
.psite-topbar-soc:hover{background:var(--accent); color:var(--accent-ink)}

/* Header */
.psite-header{position:sticky; top:0; z-index:40; background:rgba(255,255,255,.92);
  backdrop-filter:saturate(180%) blur(8px); border-bottom:1px solid var(--line)}
.psite-header-in{display:flex; align-items:center; justify-content:space-between; gap:20px;
  min-height:72px}
.psite-logo{display:inline-flex; align-items:center; gap:11px}
.psite-logo-badge{display:inline-flex; align-items:center; justify-content:center;
  width:38px; height:38px; border-radius:11px; background:var(--accent); color:var(--accent-ink);
  font-weight:700; font-size:17px; font-family:var(--font-poppins),var(--font);
  box-shadow:0 6px 16px -6px var(--accent)}
.psite-logo-name{font-family:var(--font-poppins),var(--font); font-weight:600; font-size:20px;
  color:var(--navy); letter-spacing:-.01em}
.psite-nav{display:none; gap:30px; font-size:14.5px; font-weight:500}
.psite-nav a{color:var(--navy); position:relative; padding:4px 0}
.psite-nav a::after{content:""; position:absolute; left:0; bottom:-2px; height:2px; width:0;
  background:var(--accent); transition:width .2s ease}
.psite-nav a:hover{color:var(--accent)}
.psite-nav a:hover::after{width:100%}
.psite-header-cta{display:flex; align-items:center; gap:16px}
.psite-emergency{display:none; align-items:center; gap:9px; color:var(--navy)}
.psite-emergency svg{color:var(--accent)}
.psite-emergency em{display:block; font-style:normal; font-size:11px; color:var(--muted);
  text-transform:uppercase; letter-spacing:.06em; font-weight:600}
.psite-emergency span{font-weight:700; font-size:14.5px; line-height:1.25}

/* Hero */
.psite-hero{background:
  radial-gradient(1200px 480px at 85% -10%, var(--soft), transparent 60%),
  linear-gradient(180deg, var(--tint), #fff)}
.psite-hero-in{display:grid; grid-template-columns:1fr; gap:44px; padding:64px 24px 72px}
.psite-eyebrow{color:var(--accent); font-weight:700; font-size:13px; letter-spacing:.12em;
  text-transform:uppercase; margin-bottom:14px}
.psite-hero-title{font-size:38px; font-weight:700; letter-spacing:-.02em; max-width:16ch}
.psite-hero-lead{margin-top:18px; font-size:17px; max-width:52ch; color:var(--body)}
.psite-hero-actions{margin-top:30px; display:flex; flex-wrap:wrap; gap:14px}
.psite-hero-trust{margin-top:26px; display:flex; flex-wrap:wrap; gap:22px; font-size:14px;
  color:var(--navy); font-weight:500}
.psite-hero-trust span{display:inline-flex; align-items:center; gap:8px}
.psite-hero-trust svg{color:var(--accent)}
.psite-why{background:linear-gradient(160deg, var(--accent), var(--accent-dark));
  color:var(--accent-ink); border-radius:22px; padding:32px;
  box-shadow:0 30px 60px -28px var(--accent-dark)}
.psite-why-title{color:var(--accent-ink); font-size:22px; font-weight:700}
.psite-why-sub{margin-top:8px; opacity:.86; font-size:14.5px}
.psite-why-list{list-style:none; margin:22px 0 0; padding:0; display:flex; flex-direction:column; gap:16px}
.psite-why-list li{display:flex; gap:14px; align-items:flex-start}
.psite-why-ic{flex-shrink:0; display:inline-flex; align-items:center; justify-content:center;
  width:42px; height:42px; border-radius:12px; background:rgba(255,255,255,.16); color:var(--accent-ink)}
.psite-why-list strong{display:block; font-weight:600; font-size:15px}
.psite-why-list em{display:block; font-style:normal; opacity:.82; font-size:13px; margin-top:2px}

/* Stats */
.psite-stats{border-bottom:1px solid var(--line)}
.psite-stats-in{display:grid; grid-template-columns:repeat(2,1fr); gap:24px; padding:40px 24px}
.psite-stat{text-align:center}
.psite-stat-val{font-family:var(--font-poppins),var(--font); font-weight:700; font-size:38px;
  color:var(--accent); line-height:1}
.psite-stat-label{margin-top:8px; font-size:14px; color:var(--muted); font-weight:500}

/* Section shell */
.psite-section{padding:76px 0}
.psite-section-tint{background:var(--tint)}
.psite-title{text-align:center; max-width:640px; margin:0 auto 44px}
.psite-title-left{text-align:left; margin-left:0}
.psite-title-eyebrow{color:var(--accent); font-weight:700; font-size:13px; letter-spacing:.12em;
  text-transform:uppercase}
.psite-title-h{margin-top:10px; font-size:30px; font-weight:700; letter-spacing:-.02em}
.psite-title-rule{display:block; width:60px; height:3px; border-radius:3px; background:var(--accent);
  margin:16px auto 0}
.psite-title-left .psite-title-rule{margin-left:0}

/* Services */
.psite-svc-grid{display:grid; grid-template-columns:1fr; gap:22px}
.psite-svc{background:#fff; border:1px solid var(--line); border-radius:18px; padding:30px 26px;
  transition:.22s ease}
.psite-svc:hover{transform:translateY(-6px); box-shadow:0 24px 48px -24px rgba(21,34,56,.32);
  border-color:transparent}
.psite-svc-ic{display:inline-flex; align-items:center; justify-content:center; width:56px; height:56px;
  border-radius:15px; background:var(--soft); color:var(--accent); transition:.22s ease}
.psite-svc:hover .psite-svc-ic{background:var(--accent); color:var(--accent-ink)}
.psite-svc h3{margin-top:20px; font-size:18px; font-weight:600}
.psite-svc p{margin-top:9px; font-size:14.5px; color:var(--body)}

/* Doctors */
.psite-doc-grid{display:grid; grid-template-columns:1fr; gap:20px}
.psite-doc{display:flex; align-items:center; gap:18px; background:#fff; border:1px solid var(--line);
  border-radius:16px; padding:20px 22px; border-top:3px solid var(--accent); transition:.22s ease}
.psite-doc:hover{box-shadow:0 20px 40px -22px rgba(21,34,56,.3); transform:translateY(-3px)}
.psite-doc-avatar{flex-shrink:0; display:inline-flex; align-items:center; justify-content:center;
  width:60px; height:60px; border-radius:9999px; background:var(--soft); color:var(--accent);
  font-family:var(--font-poppins),var(--font); font-weight:700; font-size:22px}
.psite-doc-info h4{font-size:17px; font-weight:600}
.psite-doc-role{color:var(--accent); font-size:13.5px; font-weight:600}

/* About */
.psite-about{display:grid; grid-template-columns:1fr; gap:40px; align-items:center}
.psite-about-panel{background:linear-gradient(160deg, var(--accent), var(--accent-dark));
  color:var(--accent-ink); border-radius:22px; padding:40px 34px;
  box-shadow:0 30px 60px -30px var(--accent-dark)}
.psite-about-panel-tag{font-size:12.5px; font-weight:700; letter-spacing:.12em; text-transform:uppercase;
  opacity:.82}
.psite-about-panel-line{margin-top:14px; font-family:var(--font-poppins),var(--font);
  font-size:25px; font-weight:600; line-height:1.3}
.psite-about-panel-hours{margin-top:20px; display:inline-flex; align-items:center; gap:9px;
  font-size:14px; opacity:.92}
.psite-about-panel-btn{margin-top:26px; background:var(--accent-ink); color:var(--accent)}
.psite-about-panel-btn:hover{opacity:.9}
.psite-about-text{margin-top:24px; display:flex; flex-direction:column; gap:14px; font-size:15.5px}
.psite-about-checks{list-style:none; margin:26px 0 0; padding:0; display:grid;
  grid-template-columns:repeat(2,1fr); gap:12px}
.psite-about-checks li{display:flex; align-items:center; gap:10px; font-size:14.5px;
  font-weight:500; color:var(--navy)}
.psite-about-checks svg{flex-shrink:0; color:var(--accent)}

/* Contact */
.psite-contact{display:grid; grid-template-columns:1fr; gap:26px}
.psite-contact-cards{display:grid; grid-template-columns:1fr; gap:16px}
.psite-cc{display:flex; gap:16px; background:#fff; border:1px solid var(--line); border-radius:16px;
  padding:22px}
.psite-cc-ic{flex-shrink:0; display:inline-flex; align-items:center; justify-content:center;
  width:46px; height:46px; border-radius:13px; background:var(--soft); color:var(--accent)}
.psite-cc-label{font-weight:600; color:var(--navy); font-size:15px}
.psite-cc-val{margin-top:4px; font-size:14.5px; color:var(--body)}
.psite-contact-link{color:var(--accent); font-weight:600; display:inline-block; margin-top:6px}
.psite-strong{font-weight:700; color:var(--navy)}
.psite-break{word-break:break-all}
.psite-map{border-radius:18px; overflow:hidden; border:1px solid var(--line); min-height:280px}
.psite-map iframe{width:100%; height:100%; min-height:280px; border:0; display:block}

/* Footer */
.psite-footer{background:var(--navy); color:#aeb9cb}
.psite-footer-in{display:grid; grid-template-columns:1fr; gap:36px; padding:60px 24px 46px}
.psite-footer-logo{display:flex; align-items:center; gap:11px; color:#fff; font-weight:600;
  font-size:19px; font-family:var(--font-poppins),var(--font)}
.psite-footer-blurb{margin-top:16px; font-size:14px; max-width:32ch; color:#93a0b6}
.psite-footer-social{margin-top:20px; display:flex; gap:9px}
.psite-footer-soc{display:inline-flex; align-items:center; justify-content:center; width:34px;
  height:34px; border-radius:9999px; background:rgba(255,255,255,.08); color:#c9d3e2; transition:.2s ease}
.psite-footer-soc:hover{background:var(--accent); color:var(--accent-ink)}
.psite-footer-col h5{color:#fff; font-size:14px; font-weight:600; letter-spacing:.02em;
  margin-bottom:16px; text-transform:uppercase}
.psite-footer-col a,.psite-footer-col p{display:block; font-size:14px; color:#93a0b6; margin-bottom:11px}
.psite-footer-col a:hover{color:#fff}
.psite-footer-signin p{max-width:26ch; margin-bottom:18px}
.psite-footer-bar{border-top:1px solid rgba(255,255,255,.09)}
.psite-footer-bar-in{display:flex; flex-wrap:wrap; gap:10px; align-items:center;
  justify-content:space-between; padding:20px 24px; font-size:13px; color:#8593a8}
.psite-footer-bar-in a:hover{color:#fff}

/* Back to top */
.psite-totop{position:fixed; right:22px; bottom:22px; z-index:50; width:44px; height:44px;
  border-radius:13px; background:var(--accent); color:var(--accent-ink);
  display:inline-flex; align-items:center; justify-content:center;
  box-shadow:0 14px 30px -12px var(--accent-dark); opacity:.92; transition:.2s ease}
.psite-totop:hover{opacity:1; transform:translateY(-2px)}
.psite-totop-ic{transform:rotate(-90deg)}

/* Responsive */
@media (min-width:640px){
  .psite-stats-in{grid-template-columns:repeat(3,1fr); padding:44px 24px}
  .psite-svc-grid{grid-template-columns:repeat(2,1fr)}
  .psite-doc-grid{grid-template-columns:repeat(2,1fr)}
  .psite-contact-cards{grid-template-columns:repeat(2,1fr)}
}
@media (min-width:900px){
  .psite-nav{display:flex}
  .psite-emergency{display:inline-flex}
  .psite-hero-in{grid-template-columns:1.15fr .85fr; align-items:center; padding:84px 24px 92px}
  .psite-hero-title{font-size:46px}
  .psite-svc-grid{grid-template-columns:repeat(3,1fr)}
  .psite-about{grid-template-columns:.9fr 1.1fr; gap:56px}
  .psite-contact{grid-template-columns:1.05fr .95fr; align-items:stretch}
  .psite-footer-in{grid-template-columns:1.6fr 1fr 1.2fr 1.2fr}
}
@media (min-width:1024px){
  .psite-title-h{font-size:33px}
}
`;
