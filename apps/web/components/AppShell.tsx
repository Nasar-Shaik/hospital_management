"use client";

/**
 * The application shell (Doc 04 §3.2 `(app)` route group, Doc 08).
 *
 * The navigation is permission-gated: a receptionist never sees "Roles & Permissions" because she
 * cannot use it, and showing a door that is locked is just a worse way of saying no. But the hiding
 * is COSMETIC — the server refuses the route independently, so a user who un-hides the link gets a
 * 403 and no data (Constitution §3.6).
 *
 * Items whose modules do not exist yet are listed as `soon`, greyed out — a deliberate honesty: the
 * alternative is a menu that lies, and a hospital evaluating us deserves to see the shape of the
 * product without being tricked by links that 404.
 *
 * ── THE SHELL'S JOB IS TO DISAPPEAR ─────────────────────────────────────────
 * A person here to run a hospital should feel the WORK, not the chrome. So the shell is quiet: a
 * collapsible icon rail, a frosted top bar that stays out of the way, an active state you can find
 * without reading. On a phone the rail becomes a drawer — the same navigation, not a lesser one.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { ThemeToggle } from "@medicore/ui";
import { BranchSwitcher } from "./BranchSwitcher";
import { LicenseBanner } from "./LicenseBanner";
import { useAuth } from "./AuthProvider";
import { useBranch } from "./BranchProvider";
import { useBranding } from "./BrandingProvider";
import { Badge, Button } from "./ui";
import { Icon, type IconName } from "./icons";

interface NavItem {
  label: string;
  href: string;
  icon: IconName;
  /** Permission required to see it. Omit for items everyone may use. */
  permission?: string;
  /** Not built yet — shown disabled rather than pretended into existence. */
  soon?: boolean;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

const NAVIGATION: NavSection[] = [
  {
    title: "Overview",
    items: [{ label: "Dashboard", href: "/dashboard", icon: "dashboard" }],
  },
  {
    title: "Administration",
    items: [
      { label: "Staff", href: "/staff", icon: "staff", permission: "user:read" },
      { label: "Roles & permissions", href: "/roles", icon: "roles", permission: "role:manage" },
      {
        label: "Subscription & usage",
        href: "/subscription",
        icon: "subscription",
        permission: "subscription:manage",
      },
      { label: "Service tariff", href: "/tariff", icon: "tariff", permission: "tariff:manage" },
      { label: "Care packages", href: "/packages", icon: "tariff", permission: "tariff:manage" },
      { label: "Medical records", href: "/mrd", icon: "reports", permission: "mrd:register:view" },
      {
        label: "Public website",
        href: "/settings/site",
        icon: "website",
        permission: "branding:manage",
      },
      { label: "Reports", href: "/reports", icon: "reports", permission: "report:view" },
      { label: "Activity trail", href: "/audit", icon: "audit", permission: "audit:view" },
      {
        label: "Hospital profile",
        href: "/settings/profile",
        icon: "hospital",
        permission: "hospital:manage",
      },
      { label: "Branches", href: "/branches", icon: "branches", permission: "branch:manage" },
      {
        label: "Departments",
        href: "/departments",
        icon: "departments",
        permission: "department:manage",
      },
      // The estate register — equipment + its service history (B7). Facilities/biomedical work.
      { label: "Assets", href: "/assets", icon: "assets", permission: "asset:manage" },
      // The feedback & complaint register (B10) — the quality desk. `feedback:manage` logs + reads.
      { label: "Feedback", href: "/feedback", icon: "feedback", permission: "feedback:manage" },
      {
        label: "API keys",
        href: "/settings/api-keys",
        icon: "apikeys",
        permission: "apikey:manage",
      },
    ],
  },
  /**
   * The clinical day, in the order it happens: the desk, the doctor, the lab. Each is gated on the
   * permission that role actually holds, so the nav IS the job description — a receptionist sees
   * "Reception", a pathologist sees "Worklist", and neither is offered a screen that would 403.
   */
  {
    title: "Clinical",
    items: [
      { label: "Reception", href: "/reception", icon: "reception", permission: "encounter:create" },
      {
        label: "My patients",
        href: "/my-patients",
        icon: "myPatients",
        permission: "order:create",
      },
      { label: "Worklist", href: "/worklist", icon: "worklist", permission: "order:read" },
      // The lab's test master — analytes + reference ranges (D6). The pathologist owns it.
      { label: "Lab catalogue", href: "/lab-catalogue", icon: "lab", permission: "lab:approve" },
      // `pharmacy:dispense`, not `order:read` — this screen is for the person who HANDS THE DRUGS
      // OVER; the read permission would show a dispensing counter to every nurse and pathologist.
      { label: "Pharmacy", href: "/pharmacy", icon: "pharmacy", permission: "pharmacy:dispense" },
      // `pharmacy:stock`: the MASTER is inventory — the person who keeps the shelf, not the one
      // handing a drug over.
      {
        label: "Medicine master",
        href: "/medicines",
        icon: "medicines",
        permission: "pharmacy:stock",
      },
      // `emr:read`: the ward round is a doctor's list of PATIENTS, not a bed-allocation tool.
      { label: "Ward", href: "/ward", icon: "ward", permission: "emr:read" },
      { label: "Patients", href: "/patients", icon: "patients", permission: "patient:read" },
      {
        label: "Appointments",
        href: "/appointments",
        icon: "appointments",
        permission: "appointment:read",
      },
      // The doctor ROSTER — weekly sessions + leave (D2). `doctor:manage`: roster administration,
      // not front-desk work; the same permission that guards setting a doctor's hours.
      { label: "Doctors", href: "/doctors", icon: "staff", permission: "doctor:manage" },
      // The BED BOARD (which beds are free) and the inventory behind it (B4). `/ward` shows who is
      // admitted; this shows where there is space.
      { label: "Bed board", href: "/beds", icon: "beds", permission: "bed:allocate" },
      { label: "Theatres", href: "/theatres", icon: "theatres", permission: "ot:schedule" },
      {
        label: "Ambulance",
        href: "/ambulance",
        icon: "ambulance",
        permission: "ambulance:dispatch",
      },
      // The body custody register (support.mortuary) — receive and release. `mortuary:manage` is the
      // ward/mortuary staff who run it; release refuses a medico-legal body without clearance.
      { label: "Mortuary", href: "/mortuary", icon: "ward", permission: "mortuary:manage" },
    ],
  },
  {
    title: "Finance",
    items: [
      { label: "Billing", href: "/billing", icon: "billing", permission: "billing:read" },
      { label: "Receipts", href: "/receipts", icon: "receipts", permission: "billing:read" },
    ],
  },
];

const COLLAPSE_KEY = "medicore.sidebar.collapsed";

function initials(name: string): string {
  return name
    .split(" ")
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The breadcrumb for the current route, derived from the navigation (single source of truth). */
function crumbFor(pathname: string): { section?: string; label: string; leaf: boolean } {
  let best: { section: string; item: NavItem } | undefined;
  for (const section of NAVIGATION) {
    for (const item of section.items) {
      if (isActive(pathname, item.href)) {
        if (!best || item.href.length > best.item.href.length)
          best = { section: section.title, item };
      }
    }
  }
  if (!best) {
    const seg = pathname.split("/").filter(Boolean)[0] ?? "";
    return { label: seg ? seg.charAt(0).toUpperCase() + seg.slice(1) : "MediCore", leaf: false };
  }
  return {
    section: best.section,
    label: best.item.label,
    // A path deeper than the nav item's own href is a detail view of it (e.g. /patients/123).
    leaf: pathname !== best.item.href,
  };
}

/* ── the nav list, shared by the desktop rail and the mobile drawer ──────────── */

function SidebarNav({
  sections,
  pathname,
  collapsed,
  onNavigate,
}: {
  sections: NavSection[];
  pathname: string;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  return (
    <nav className="space-y-6 p-3">
      {sections.map((section) => (
        <div key={section.title}>
          {collapsed ? (
            <div className="mx-3 mb-2 h-px bg-[var(--color-border)]" aria-hidden />
          ) : (
            <p className="mb-1.5 px-3 text-[11px] font-semibold tracking-wider text-[var(--color-fg-subtle)] uppercase">
              {section.title}
            </p>
          )}
          <ul className="space-y-0.5">
            {section.items.map((item) => {
              const active = isActive(pathname, item.href);

              if (item.soon) {
                return (
                  <li key={item.href}>
                    <span
                      className={`flex cursor-not-allowed items-center gap-3 rounded-lg px-3 py-2 text-sm text-[var(--color-fg-subtle)] ${
                        collapsed ? "justify-center" : ""
                      }`}
                      title={collapsed ? `${item.label} — not built yet` : "Not built yet"}
                    >
                      <Icon name={item.icon} className="h-[18px] w-[18px] shrink-0" />
                      {!collapsed && (
                        <>
                          <span className="flex-1 truncate">{item.label}</span>
                          <span className="text-[10px] tracking-wide uppercase">soon</span>
                        </>
                      )}
                    </span>
                  </li>
                );
              }

              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    title={collapsed ? item.label : undefined}
                    className={`group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors duration-[var(--dur-fast)] ${
                      collapsed ? "justify-center" : ""
                    } ${
                      active
                        ? "bg-[var(--color-brand-50)] font-medium text-[var(--color-brand-700)]"
                        : "text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-fg)]"
                    }`}
                  >
                    {/* the active accent bar */}
                    <span
                      aria-hidden
                      className={`absolute top-1/2 left-0 h-5 w-0.5 -translate-y-1/2 rounded-r-full bg-[var(--color-brand-600)] transition-opacity ${
                        active ? "opacity-100" : "opacity-0"
                      }`}
                    />
                    <Icon
                      name={item.icon}
                      className={`h-[18px] w-[18px] shrink-0 transition-transform duration-[var(--dur-fast)] ${
                        active ? "" : "group-hover:scale-110"
                      }`}
                    />
                    {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function Brandmark({ collapsed }: { collapsed: boolean }) {
  const branding = useBranding();
  if (branding.logoUrl && !collapsed) {
    return (
      <img
        src={branding.logoUrl}
        alt={branding.displayName || "Hospital"}
        className="h-8 w-auto max-w-[150px] object-contain"
      />
    );
  }
  return (
    <div className="flex items-center gap-2.5">
      <div
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm font-bold text-[var(--color-on-accent)] shadow-[var(--shadow-xs)]"
        style={{ background: "var(--gradient-brand)" }}
      >
        {(branding.displayName || "M").charAt(0).toUpperCase()}
      </div>
      {!collapsed && (
        <span className="truncate font-semibold text-[var(--color-fg)]">
          {branding.displayName || "MediCore"}
        </span>
      )}
    </div>
  );
}

function BranchFooter({ collapsed }: { collapsed: boolean }) {
  const { active, hasChoice } = useBranch();
  if (!hasChoice || collapsed || !active) return null;
  return (
    <div className="border-t border-[var(--color-border)] px-4 py-3">
      <p className="text-[11px] tracking-wide text-[var(--color-fg-subtle)] uppercase">
        Working in
      </p>
      <p className="mt-0.5 flex items-center gap-1.5 truncate text-sm font-medium text-[var(--color-fg)]">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-brand-600)]" aria-hidden />
        {active.name}
      </p>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { user, can, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // The shell is mounted once by the root layout (see components/AppFrame.tsx) and never remounts on
  // navigation, so plain state holds: the rail keeps its collapse and scroll without any cache.
  const [collapsed, setCollapsed] = useState(false);

  // Read the persisted collapse preference once, on the session's first mount.
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {
      /* storage disabled — default expanded */
    }
  }, []);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  if (!user) return null;

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const sections = NAVIGATION.map((section) => ({
    ...section,
    items: section.items.filter((item) => !item.permission || can(item.permission)),
  })).filter((section) => section.items.length > 0);

  const crumb = crumbFor(pathname);

  return (
    // The shell OWNS the viewport height and never scrolls; only <main> does. This keeps the rail
    // and top bar fixed, so a long page can never scroll the sidebar (and the item you just picked)
    // out of view — the whole shell used to move with the window on `min-h-screen`.
    <div className="flex h-screen overflow-hidden bg-[var(--color-bg-subtle)]">
      {/* ── Desktop rail ─────────────────────────────────────────────────────── */}
      <aside
        className={`hidden shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-bg-elevated)] transition-[width] duration-[var(--dur)] ease-[var(--ease-standard)] lg:flex ${
          collapsed ? "w-16" : "w-64"
        }`}
      >
        <div
          className={`flex h-16 items-center border-b border-[var(--color-border)] ${
            collapsed ? "justify-center px-2" : "px-6"
          }`}
        >
          <Brandmark collapsed={collapsed} />
        </div>

        <div className="flex-1 overflow-y-auto">
          <SidebarNav sections={sections} pathname={pathname} collapsed={collapsed} />
        </div>

        <BranchFooter collapsed={collapsed} />

        <button
          type="button"
          onClick={toggleCollapsed}
          className={`flex items-center gap-2 border-t border-[var(--color-border)] px-4 py-2.5 text-xs font-medium text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-fg)] ${
            collapsed ? "justify-center" : ""
          }`}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <Icon
            name="chevron"
            className={`h-4 w-4 transition-transform ${collapsed ? "" : "rotate-180"}`}
          />
          {!collapsed && <span>Collapse</span>}
        </button>
      </aside>

      {/* ── Mobile drawer ────────────────────────────────────────────────────── */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="mc-fade-in absolute inset-0 bg-black/40"
            onClick={() => setDrawerOpen(false)}
            aria-hidden
          />
          <div className="mc-drawer-in absolute inset-y-0 left-0 flex w-72 flex-col border-r border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-[var(--shadow-xl)]">
            <div className="flex h-16 items-center justify-between border-b border-[var(--color-border)] px-5">
              <Brandmark collapsed={false} />
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="rounded-lg p-1.5 text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-subtle)]"
                aria-label="Close menu"
              >
                <Icon name="close" className="h-5 w-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              <SidebarNav
                sections={sections}
                pathname={pathname}
                collapsed={false}
                onNavigate={() => setDrawerOpen(false)}
              />
            </div>
            <BranchFooter collapsed={false} />
          </div>
        </div>
      )}

      {/* ── Main column ──────────────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header
          className="z-30 flex h-16 shrink-0 items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 lg:px-6"
          style={{ background: "var(--surface-glass)", backdropFilter: "blur(12px)" }}
        >
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              className="rounded-lg p-1.5 text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-subtle)] lg:hidden"
              aria-label="Open menu"
            >
              <Icon name="menu" className="h-5 w-5" />
            </button>

            {/* Breadcrumb — where you are, derived from the nav. */}
            <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
              {crumb.section && (
                <>
                  <span className="hidden truncate text-[var(--color-fg-muted)] sm:inline">
                    {crumb.section}
                  </span>
                  <Icon
                    name="chevron"
                    className="hidden h-3.5 w-3.5 text-[var(--color-fg-subtle)] sm:inline"
                  />
                </>
              )}
              <span className="truncate font-medium text-[var(--color-fg)]">{crumb.label}</span>
              {crumb.leaf && (
                <>
                  <Icon name="chevron" className="h-3.5 w-3.5 text-[var(--color-fg-subtle)]" />
                  <span className="truncate text-[var(--color-fg-muted)]">Details</span>
                </>
              )}
            </nav>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            <BranchSwitcher />
            <ThemeToggle />

            <div className="relative">
              <button
                onClick={() => setMenuOpen((o) => !o)}
                className="flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 transition-colors hover:bg-[var(--color-bg-subtle)] sm:px-2"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-brand-100)] text-xs font-semibold text-[var(--color-brand-700)]">
                  {initials(user.name)}
                </span>
                <span className="hidden text-left sm:block">
                  <span className="block text-sm font-medium text-[var(--color-fg)]">
                    {user.name}
                  </span>
                  <span className="block text-xs text-[var(--color-fg-muted)]">
                    {user.roles[0] ?? "No role"}
                  </span>
                </span>
                <Icon
                  name="chevron"
                  className="hidden h-4 w-4 rotate-90 text-[var(--color-fg-subtle)] sm:block"
                />
              </button>

              {menuOpen && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setMenuOpen(false)}
                    aria-hidden
                  />
                  <div className="mc-scale-in absolute right-0 z-20 mt-2 w-60 origin-top-right rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-1.5 shadow-[var(--shadow-lg)]">
                    <div className="border-b border-[var(--color-border)] px-3 py-2.5">
                      <p className="truncate text-sm font-medium">{user.email}</p>
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {user.roles.map((role) => (
                          <Badge key={role} tone="brand">
                            {role}
                          </Badge>
                        ))}
                      </div>
                    </div>
                    <Link
                      href="/change-password"
                      onClick={() => setMenuOpen(false)}
                      className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-fg)]"
                    >
                      <Icon name="lock" className="h-4 w-4" />
                      Change password
                    </Link>
                    <Link
                      href="/sessions"
                      onClick={() => setMenuOpen(false)}
                      className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-fg)]"
                    >
                      <Icon name="monitor" className="h-4 w-4" />
                      Active sessions
                    </Link>
                    <div className="mt-1 border-t border-[var(--color-border)] pt-1">
                      <Button
                        variant="ghost"
                        onClick={() => void logout()}
                        className="w-full justify-start"
                      >
                        <Icon name="logout" className="h-4 w-4" />
                        Sign out
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        <LicenseBanner />

        {/* The ONLY scroll container. `overflow-x-auto` keeps wide tables from bleeding the page. */}
        <main className="flex-1 overflow-y-auto overflow-x-auto p-4 sm:p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
