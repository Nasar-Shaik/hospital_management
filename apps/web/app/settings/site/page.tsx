"use client";

/**
 * Public website editor (needs `branding:manage`).
 *
 * Where a hospital's own administrator controls the site the world sees at the hospital's
 * address — its name, colour, the services it advertises, how to reach it. Self-service: no
 * support ticket to rebrand. The doctors shown on the site are NOT edited here — they are opted
 * in per person from the staff screen, so this page never becomes a place to type a colleague's
 * name onto the internet.
 *
 * Everything the server accepts is optional; this form always sends the full set, so a blank box
 * genuinely clears a field rather than leaving a stale value behind.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ApiClientError, type EditableSite } from "@medicore/api-client";
import { useAuth } from "../../../components/AuthProvider";
import { Protected } from "../../../components/Protected";
import { Alert, Button, Card, Field } from "../../../components/ui";

const DEFAULT_ACCENT = "#0d9488";

export default function SiteSettingsPage() {
  return (
    <Protected>
      <Editor />
    </Protected>
  );
}

function Editor() {
  const { can, api } = useAuth();
  const allowed = can("branding:manage");

  const [form, setForm] = useState<EditableSite | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!allowed) return;
    let live = true;
    api
      .getSiteSettings()
      .then((data) => {
        if (live) setForm(data);
      })
      .catch(() => {
        if (live) setLoadError("Could not load the site settings. Please try again.");
      });
    return () => {
      live = false;
    };
  }, [allowed, api]);

  function patch(next: Partial<EditableSite>) {
    setForm((f) => (f ? { ...f, ...next } : f));
    setSaved(false);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    setSaveError(null);
    setSaved(false);
    try {
      const result = await api.updateSiteSettings({
        displayName: form.displayName.trim(),
        accentColor: form.accentColor,
        tagline: form.tagline.trim(),
        about: form.about.trim(),
        metaDescription: form.metaDescription.trim(),
        services: form.services.filter((s) => s.name.trim()),
        stats: form.stats.filter((s) => s.label.trim() && s.value.trim()),
        contact: form.contact,
        social: form.social,
        // An empty strip means "no announcement" — send null to clear it server-side.
        announcement: form.announcement?.text.trim() ? form.announcement : null,
        published: form.published,
      });
      setForm(result);
      setSaved(true);
    } catch (err) {
      if (err instanceof ApiClientError && err.code === "HMS-VAL-001") {
        setSaveError(
          "Some fields could not be saved — check the accent colour is a hex like #0d9488.",
        );
      } else {
        setSaveError("Could not save. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  if (!allowed) {
    return (
      <Page>
        <Alert tone="warning" title="No access">
          You need the <strong>branding:manage</strong> permission to edit the public website.
        </Alert>
      </Page>
    );
  }

  if (loadError) {
    return (
      <Page>
        <Alert tone="danger">{loadError}</Alert>
      </Page>
    );
  }

  if (!form) {
    return (
      <Page>
        <div className="flex justify-center py-20">
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--color-brand-600)] border-t-transparent" />
        </div>
      </Page>
    );
  }

  return (
    <Page>
      <form onSubmit={submit} className="space-y-6">
        {saveError && <Alert tone="danger">{saveError}</Alert>}
        {saved && <Alert tone="success">Saved. Your public website is updated.</Alert>}

        {/* Brand */}
        <Section title="Brand" hint="What visitors see in the header and hero.">
          <Field
            label="Display name"
            name="displayName"
            value={form.displayName}
            onChange={(e) => patch({ displayName: e.target.value })}
            placeholder={form.hospitalName}
            hint={`Defaults to "${form.hospitalName}" if left blank.`}
          />
          <div>
            <span className="mb-1.5 block text-sm font-medium text-[var(--color-fg)]">
              Accent colour
            </span>
            <div className="flex items-center gap-3">
              <input
                type="color"
                aria-label="Accent colour"
                value={
                  /^#[0-9a-fA-F]{6}$/.test(form.accentColor) ? form.accentColor : DEFAULT_ACCENT
                }
                onChange={(e) => patch({ accentColor: e.target.value })}
                className="h-10 w-14 cursor-pointer rounded-lg border border-[var(--color-border-strong)] bg-transparent"
              />
              <input
                value={form.accentColor}
                onChange={(e) => patch({ accentColor: e.target.value })}
                placeholder={DEFAULT_ACCENT}
                className="w-32 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm outline-none focus:border-[var(--color-brand-500)]"
              />
              <span
                className="h-10 flex-1 rounded-lg"
                style={{ background: form.accentColor || DEFAULT_ACCENT }}
              />
            </div>
          </div>
          <Field
            label="Tagline"
            name="tagline"
            value={form.tagline}
            onChange={(e) => patch({ tagline: e.target.value })}
            placeholder="Compassionate, expert care — close to home."
          />
        </Section>

        {/* About */}
        <Section
          title="About"
          hint="Shown in the About section. Blank lines start a new paragraph."
        >
          <Textarea
            label="About us"
            value={form.about}
            onChange={(v) => patch({ about: v })}
            rows={5}
          />
          <Field
            label="SEO description"
            name="metaDescription"
            value={form.metaDescription}
            onChange={(e) => patch({ metaDescription: e.target.value })}
            hint="The text search engines show under your title. Defaults to the tagline."
          />
        </Section>

        {/* Services */}
        <Section title="Services" hint="The cards in the Services grid.">
          <Repeatable
            rows={form.services}
            onChange={(services) => patch({ services })}
            empty={{ name: "", description: "" }}
            addLabel="Add a service"
            render={(row, update) => (
              <>
                <input
                  value={row.name}
                  onChange={(e) => update({ ...row, name: e.target.value })}
                  placeholder="Service name"
                  className={rowInput}
                />
                <input
                  value={row.description ?? ""}
                  onChange={(e) => update({ ...row, description: e.target.value })}
                  placeholder="Short description"
                  className={rowInput}
                />
              </>
            )}
          />
        </Section>

        {/* Stats */}
        <Section title="Highlights" hint="The numbers strip ('24/7', 'Emergency care').">
          <Repeatable
            rows={form.stats}
            onChange={(stats) => patch({ stats })}
            empty={{ value: "", label: "" }}
            addLabel="Add a highlight"
            render={(row, update) => (
              <>
                <input
                  value={row.value}
                  onChange={(e) => update({ ...row, value: e.target.value })}
                  placeholder="Value (24/7)"
                  className={`${rowInput} sm:max-w-[10rem]`}
                />
                <input
                  value={row.label}
                  onChange={(e) => update({ ...row, label: e.target.value })}
                  placeholder="Label (Emergency care)"
                  className={rowInput}
                />
              </>
            )}
          />
        </Section>

        {/* Contact */}
        <Section title="Contact">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Phone"
              name="phone"
              value={form.contact.phone ?? ""}
              onChange={(e) => patch({ contact: { ...form.contact, phone: e.target.value } })}
            />
            <Field
              label="Emergency phone"
              name="emergencyPhone"
              value={form.contact.emergencyPhone ?? ""}
              onChange={(e) =>
                patch({ contact: { ...form.contact, emergencyPhone: e.target.value } })
              }
            />
            <Field
              label="Email"
              name="email"
              value={form.contact.email ?? ""}
              onChange={(e) => patch({ contact: { ...form.contact, email: e.target.value } })}
            />
            <Field
              label="Opening hours"
              name="hoursText"
              value={form.contact.hoursText ?? ""}
              onChange={(e) => patch({ contact: { ...form.contact, hoursText: e.target.value } })}
              placeholder="OPD 8am–8pm · Emergency 24/7"
            />
          </div>
          <Textarea
            label="Address"
            value={form.contact.address ?? ""}
            onChange={(v) => patch({ contact: { ...form.contact, address: v } })}
            rows={2}
          />
        </Section>

        {/* Announcement */}
        <Section
          title="Announcement"
          hint="An optional strip across the top of the site. Leave blank for none."
        >
          <Field
            label="Message"
            name="announcementText"
            value={form.announcement?.text ?? ""}
            onChange={(e) =>
              patch({ announcement: { text: e.target.value, link: form.announcement?.link } })
            }
            placeholder="Flu vaccination now available"
          />
          <Field
            label="Link (optional)"
            name="announcementLink"
            value={form.announcement?.link ?? ""}
            onChange={(e) =>
              patch({ announcement: { text: form.announcement?.text ?? "", link: e.target.value } })
            }
            placeholder="#contact or https://…"
          />
        </Section>

        {/* Visibility */}
        <Section title="Visibility">
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={form.published}
              onChange={(e) => patch({ published: e.target.checked })}
              className="h-4 w-4"
            />
            <span className="text-sm text-[var(--color-fg)]">
              Publish the website. When off, visitors go straight to sign-in.
            </span>
          </label>
        </Section>

        <div className="flex items-center gap-3">
          <Button type="submit" loading={busy}>
            Save changes
          </Button>
          <a
            href="/"
            target="_blank"
            rel="noreferrer"
            className="text-sm text-[var(--color-brand-600)] hover:underline"
          >
            View public site →
          </a>
        </div>
      </form>
    </Page>
  );
}

/* ── small building blocks ──────────────────────────────────────────────────── */

const rowInput =
  "w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm outline-none focus:border-[var(--color-brand-500)]";

function Page({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-[var(--color-fg)]">Public website</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Control what visitors see at your hospital&apos;s address.
        </p>
      </div>
      {children}
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <Card className="p-6">
      <h2 className="text-sm font-semibold text-[var(--color-fg)]">{title}</h2>
      {hint && <p className="mt-0.5 mb-4 text-xs text-[var(--color-fg-muted)]">{hint}</p>}
      <div className={hint ? "space-y-4" : "mt-4 space-y-4"}>{children}</div>
    </Card>
  );
}

function Textarea({
  label,
  value,
  onChange,
  rows,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows: number;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-[var(--color-fg)]">{label}</span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        className="w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3.5 py-2.5 text-sm outline-none focus:border-[var(--color-brand-500)]"
      />
    </label>
  );
}

/** A list the admin can grow and shrink — services and highlights share this. */
function Repeatable<T>({
  rows,
  onChange,
  empty,
  addLabel,
  render,
}: {
  rows: T[];
  onChange: (rows: T[]) => void;
  empty: T;
  addLabel: string;
  render: (row: T, update: (next: T) => void) => ReactNode;
}) {
  return (
    <div className="space-y-3">
      {rows.map((row, i) => (
        <div key={i} className="flex items-start gap-2">
          <div className="flex flex-1 flex-col gap-2 sm:flex-row">
            {render(row, (next) => onChange(rows.map((r, j) => (j === i ? next : r))))}
          </div>
          <button
            type="button"
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
            aria-label="Remove"
            className="mt-1 px-2 text-[var(--color-fg-subtle)] hover:text-[var(--color-danger)]"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...rows, empty])}
        className="text-sm font-medium text-[var(--color-brand-600)] hover:underline"
      >
        + {addLabel}
      </button>
    </div>
  );
}
