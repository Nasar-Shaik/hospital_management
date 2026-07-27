"use client";

/**
 * /style-guide — the living design reference (UI enhancement, Phase 0).
 *
 * Renders the enhanced tokens and every upgraded primitive in one place, so the team can approve
 * the "calm premium" direction on the REAL components (not a mockup) before it rolls out across the
 * app. Standalone by design — no auth, no shell — with its own theme switch so light and dark can
 * be compared side by side on the same screen.
 */
import { useState } from "react";
import { ThemeToggle } from "@medicore/ui";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Skeleton,
  Spinner,
  StatCard,
  Tabs,
} from "../../components/ui";

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold tracking-wide text-[var(--color-fg-subtle)] uppercase">
          {title}
        </h2>
        {subtitle && <p className="mt-1 text-sm text-[var(--color-fg-muted)]">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

const SURFACE_TOKENS = [
  ["--color-bg", "Page"],
  ["--color-bg-subtle", "Subtle"],
  ["--color-bg-elevated", "Elevated"],
  ["--color-border", "Border"],
  ["--color-border-strong", "Border strong"],
];
const BRAND_TOKENS = [
  "--color-brand-50",
  "--color-brand-100",
  "--color-brand-500",
  "--color-brand-600",
  "--color-brand-700",
  "--color-brand-900",
];
const SEMANTIC_TOKENS = [
  ["--color-success", "Success"],
  ["--color-warning", "Warning"],
  ["--color-danger", "Danger"],
  ["--color-info", "Info"],
];
const SHADOWS = ["--shadow-xs", "--shadow-sm", "--shadow-md", "--shadow-lg", "--shadow-xl"];
const RADII = ["--radius-sm", "--radius-md", "--radius-lg", "--radius-xl", "--radius-2xl"];

export default function StyleGuidePage() {
  const [tab, setTab] = useState("board");

  return (
    <div className="min-h-screen bg-[var(--color-bg-subtle)] text-[var(--color-fg)]">
      {/* Frosted top bar — the one glass surface, used with restraint. */}
      <header
        className="sticky top-0 z-10 border-b border-[var(--color-border)]"
        style={{ background: "var(--surface-glass)", backdropFilter: "blur(12px)" }}
      >
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3.5">
          <div className="flex items-center gap-2.5">
            <div
              className="flex h-8 w-8 items-center justify-center rounded-lg text-sm font-bold text-[var(--color-on-accent)]"
              style={{ background: "var(--gradient-brand)" }}
            >
              M
            </div>
            <div>
              <p className="text-sm font-semibold">MediCore Design System</p>
              <p className="text-xs text-[var(--color-fg-muted)]">
                Calm premium · light &amp; dark
              </p>
            </div>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-12 px-6 py-10">
        {/* Typography */}
        <Section title="Typography" subtitle="Inter for the UI, JetBrains Mono for identifiers.">
          <Card className="space-y-3 p-6">
            <p className="text-4xl font-semibold tracking-tight">Display · Aa Bb Cc 0123</p>
            <p className="text-2xl font-semibold tracking-tight">
              Heading · The clinical day, at a glance
            </p>
            <p className="text-base">
              Body · A patient arrives, is registered, and is seen. The record follows them.
            </p>
            <p className="text-sm text-[var(--color-fg-muted)]">
              Muted body · secondary information sits here.
            </p>
            <p className="text-xs font-medium tracking-wide text-[var(--color-fg-subtle)] uppercase">
              Label · Overline
            </p>
            <p className="font-mono text-sm">Mono · UHID SUN-2026-004821 · trace 8ca70b99</p>
          </Card>
        </Section>

        {/* Colour */}
        <Section
          title="Colour"
          subtitle="Semantic tokens only — the brand ramp re-tints per tenant."
        >
          <div className="space-y-4">
            <div>
              <p className="mb-2 text-xs font-medium text-[var(--color-fg-muted)]">Surfaces</p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                {SURFACE_TOKENS.map(([v, label]) => (
                  <Swatch key={v} varName={v!} label={label!} bordered />
                ))}
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs font-medium text-[var(--color-fg-muted)]">Brand ramp</p>
              <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
                {BRAND_TOKENS.map((v) => (
                  <Swatch key={v} varName={v} label={v.replace("--color-brand-", "")} />
                ))}
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs font-medium text-[var(--color-fg-muted)]">
                Semantic — sacred, never decorative
              </p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {SEMANTIC_TOKENS.map(([v, label]) => (
                  <Swatch key={v} varName={v!} label={label!} />
                ))}
              </div>
            </div>
          </div>
        </Section>

        {/* Buttons */}
        <Section title="Buttons" subtitle="2px hover lift, 2% press, shared focus ring.">
          <Card className="space-y-4 p-6">
            <div className="flex flex-wrap items-center gap-3">
              <Button>Primary</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="danger">Danger</Button>
              <Button variant="ghost">Ghost</Button>
              <Button loading>Saving</Button>
              <Button disabled>Disabled</Button>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button size="sm">Small</Button>
              <Button size="md">Medium</Button>
              <Button size="lg">Large</Button>
            </div>
          </Card>
        </Section>

        {/* Badges */}
        <Section title="Badges">
          <Card className="flex flex-wrap items-center gap-2.5 p-6">
            <Badge>Neutral</Badge>
            <Badge tone="brand">Brand</Badge>
            <Badge tone="success" dot>
              Active
            </Badge>
            <Badge tone="warning" dot>
              Pending
            </Badge>
            <Badge tone="danger" dot>
              Critical
            </Badge>
            <Badge tone="info" dot>
              Info
            </Badge>
          </Card>
        </Section>

        {/* Alerts */}
        <Section
          title="Alerts"
          subtitle="Iconed, tone-coloured, with the right screen-reader role per tone."
        >
          <div className="space-y-3">
            <Alert tone="info" title="Two-step verification is off">
              Adding a second factor is the biggest security improvement you can make.
            </Alert>
            <Alert tone="success" title="Saved">
              The department was updated.
            </Alert>
            <Alert tone="warning" title="Temporary password">
              Set your own password now.
            </Alert>
            <Alert tone="danger" title="Could not book">
              That theatre is already booked for this window.
            </Alert>
          </div>
        </Section>

        {/* Cards + stats */}
        <Section title="Cards &amp; metrics">
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard
              label="Patients today"
              value="128"
              icon={<Dot />}
              trend={{ direction: "up", label: "12% vs last week" }}
            />
            <StatCard
              label="Collected"
              value="₹2.4L"
              tone="success"
              icon={<Dot />}
              trend={{ direction: "up", label: "on target" }}
            />
            <StatCard
              label="Outstanding dues"
              value="₹68k"
              tone="warning"
              icon={<Dot />}
              trend={{ direction: "down", label: "down 4%" }}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Card className="p-5">
              <p className="text-sm font-medium">Plain card</p>
              <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
                Elevated surface, hairline border, xs shadow.
              </p>
            </Card>
            <Card interactive className="p-5">
              <p className="text-sm font-medium">Interactive card</p>
              <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
                Hover me — lifts on hover for clickable cards.
              </p>
            </Card>
          </div>
        </Section>

        {/* Forms */}
        <Section title="Forms">
          <Card className="grid gap-4 p-6 sm:grid-cols-2">
            <Field label="Full name" name="name" placeholder="Aarav Sharma" />
            <Field
              label="UHID"
              name="uhid"
              leading={<span className="text-xs">#</span>}
              placeholder="SUN-2026-…"
            />
            <Field
              label="Email"
              name="email"
              defaultValue="not-an-email"
              error="Enter a valid email address."
            />
            <Field
              label="Phone"
              name="phone"
              hint="Used for appointment reminders."
              placeholder="+91…"
            />
          </Card>
        </Section>

        {/* Tabs */}
        <Section title="Tabs">
          <Card className="p-6">
            <Tabs
              active={tab}
              onChange={setTab}
              tabs={[
                { key: "board", label: "Board", count: 6 },
                { key: "registry", label: "Registry", count: 12 },
                { key: "history", label: "History" },
              ]}
            />
            <p className="mt-4 text-sm text-[var(--color-fg-muted)]">Active tab: {tab}</p>
          </Card>
        </Section>

        {/* Loading + empty */}
        <Section title="Loading &amp; empty states">
          <div className="grid gap-4 sm:grid-cols-2">
            <Card className="space-y-3 p-6">
              <div className="flex items-center gap-2 text-sm text-[var(--color-fg-muted)]">
                <Spinner /> Loading…
              </div>
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-2/3" />
            </Card>
            <Card>
              <EmptyState
                icon={<Dot />}
                title="No procedures booked"
                description="Bookings for this day will appear here as they are scheduled."
                action={<Button size="sm">Book a procedure</Button>}
              />
            </Card>
          </div>
        </Section>

        {/* Elevation + radius */}
        <Section title="Elevation &amp; radius">
          <div className="grid gap-4 sm:grid-cols-2">
            <Card className="p-6">
              <p className="mb-4 text-xs font-medium text-[var(--color-fg-muted)]">Shadow scale</p>
              <div className="flex flex-wrap gap-4">
                {SHADOWS.map((s) => (
                  <div key={s} className="flex flex-col items-center gap-2">
                    <div
                      className="h-14 w-14 rounded-xl bg-[var(--color-bg-elevated)]"
                      style={{ boxShadow: `var(${s})` }}
                    />
                    <span className="text-[10px] text-[var(--color-fg-subtle)]">
                      {s.replace("--shadow-", "")}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
            <Card className="p-6">
              <p className="mb-4 text-xs font-medium text-[var(--color-fg-muted)]">Radius scale</p>
              <div className="flex flex-wrap gap-4">
                {RADII.map((r) => (
                  <div key={r} className="flex flex-col items-center gap-2">
                    <div
                      className="h-14 w-14 border border-[var(--color-border-strong)] bg-[var(--color-bg-subtle)]"
                      style={{ borderRadius: `var(${r})` }}
                    />
                    <span className="text-[10px] text-[var(--color-fg-subtle)]">
                      {r.replace("--radius-", "")}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </Section>
      </main>
    </div>
  );
}

function Swatch({
  varName,
  label,
  bordered = false,
}: {
  varName: string;
  label: string;
  bordered?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <div
        className={`h-14 w-full rounded-lg ${bordered ? "border border-[var(--color-border)]" : ""}`}
        style={{ background: `var(${varName})` }}
      />
      <p className="text-xs font-medium">{label}</p>
    </div>
  );
}

/** A neutral placeholder glyph for the showcase (real screens use domain icons). */
function Dot() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}
