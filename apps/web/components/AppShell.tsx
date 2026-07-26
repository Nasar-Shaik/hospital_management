"use client";

/**
 * The application shell (Doc 04 §3.2 `(app)` route group, Doc 08).
 *
 * The navigation is permission-gated: a receptionist never sees "Roles &
 * Permissions" because she cannot use it, and showing a door that is locked is
 * just a worse way of saying no. But the hiding is COSMETIC — the server refuses
 * the route independently, so a user who un-hides the link gets a 403 and no data
 * (Constitution §3.6).
 *
 * Items whose modules do not exist yet are listed as `soon`, greyed out. That is a
 * deliberate honesty: the alternative is a menu that lies, and a hospital
 * evaluating us deserves to see the shape of the product without being tricked by
 * links that 404.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { ThemeToggle } from "@medicore/ui";
import { BranchSwitcher } from "./BranchSwitcher";
import { LicenseBanner } from "./LicenseBanner";
import { useAuth } from "./AuthProvider";
import { Badge, Button } from "./ui";

interface NavItem {
  label: string;
  href: string;
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
    items: [{ label: "Dashboard", href: "/dashboard" }],
  },
  {
    title: "Administration",
    items: [
      { label: "Staff", href: "/staff", permission: "user:read" },
      { label: "Roles & permissions", href: "/roles", permission: "role:manage" },
      { label: "Subscription & usage", href: "/subscription", permission: "subscription:manage" },
      { label: "Service tariff", href: "/tariff", permission: "tariff:manage" },
      { label: "Public website", href: "/settings/site", permission: "branding:manage" },
      { label: "Reports", href: "/reports", permission: "report:view" },
      { label: "Activity trail", href: "/audit", permission: "audit:view" },
      { label: "Hospital profile", href: "/settings", permission: "hospital:manage", soon: true },
      { label: "Branches", href: "/branches", permission: "branch:manage" },
    ],
  },
  /**
   * The clinical day, in the order it happens: the desk, the doctor, the lab.
   *
   * Each is gated on the permission that role actually holds, so the nav IS the job
   * description — a receptionist sees "Reception", a pathologist sees "Worklist", and
   * neither is offered a screen that would 403 on arrival.
   */
  {
    title: "Clinical",
    items: [
      { label: "Reception", href: "/reception", permission: "encounter:create" },
      { label: "My patients", href: "/my-patients", permission: "order:create" },
      { label: "Worklist", href: "/worklist", permission: "order:read" },
      /**
       * `pharmacy:dispense`, not `order:read` — the pharmacist holds both, but this screen
       * is for the person who HANDS THE DRUGS OVER. Gating it on the read permission would
       * show a dispensing counter to every nurse and pathologist in the building.
       */
      { label: "Pharmacy", href: "/pharmacy", permission: "pharmacy:dispense" },
      /**
       * `pharmacy:stock`, not `pharmacy:dispense`: the MASTER is inventory — what the pharmacy
       * stocks and its stock ledger — which is the person who keeps the shelf, not the one
       * handing a drug over. A clinic that bought only dispensing never sees it.
       */
      { label: "Medicine master", href: "/medicines", permission: "pharmacy:stock" },
      /**
       * `emr:read`, not `bed:allocate`: the ward round is a doctor's list of PATIENTS,
       * not a bed-allocation tool. Gating it on the bed permission would hide the chart
       * from the doctor who writes it and show it to whoever moves people between beds.
       */
      { label: "Ward", href: "/ward", permission: "emr:read" },
      { label: "Patients", href: "/patients", permission: "patient:read" },
      { label: "Appointments", href: "/appointments", permission: "appointment:read" },
      // The BED BOARD (which beds are free) is still `soon` — there is no bed inventory.
      // `/ward` shows who is admitted; it cannot tell you where there is space.
      { label: "Bed board", href: "/beds", permission: "bed:allocate", soon: true },
    ],
  },
  {
    title: "Finance",
    items: [
      { label: "Billing", href: "/billing", permission: "billing:read" },
      { label: "Receipts", href: "/receipts", permission: "billing:read" },
    ],
  },
];

function initials(name: string): string {
  return name
    .split(" ")
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { user, can, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);

  if (!user) return null;

  const sections = NAVIGATION.map((section) => ({
    ...section,
    items: section.items.filter((item) => !item.permission || can(item.permission)),
  })).filter((section) => section.items.length > 0);

  return (
    <div className="flex min-h-screen bg-[var(--color-bg-subtle)]">
      <aside className="hidden w-64 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-bg-elevated)] lg:block">
        <div className="flex h-16 items-center gap-2.5 border-b border-[var(--color-border)] px-6">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--color-brand-600)] text-sm font-bold text-[var(--color-on-accent)]">
            M
          </div>
          <span className="font-semibold text-[var(--color-fg)]">MediCore</span>
        </div>

        <nav className="space-y-6 p-4">
          {sections.map((section) => (
            <div key={section.title}>
              <p className="mb-2 px-3 text-xs font-semibold tracking-wide text-[var(--color-fg-subtle)] uppercase">
                {section.title}
              </p>
              <ul className="space-y-0.5">
                {section.items.map((item) => {
                  const active = pathname === item.href || pathname.startsWith(`${item.href}/`);

                  if (item.soon) {
                    return (
                      <li key={item.href}>
                        <span
                          className="flex cursor-not-allowed items-center justify-between rounded-lg px-3 py-2 text-sm text-[var(--color-fg-subtle)]"
                          title="Not built yet"
                        >
                          {item.label}
                          <span className="text-[10px] tracking-wide uppercase">soon</span>
                        </span>
                      </li>
                    );
                  }

                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={active ? "page" : undefined}
                        className={`block rounded-lg px-3 py-2 text-sm transition-colors ${
                          active
                            ? "bg-[var(--color-brand-50)] font-medium text-[var(--color-brand-700)]"
                            : "text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-subtle)]"
                        }`}
                      >
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-6">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-[var(--color-fg)]">
              {typeof window !== "undefined" ? window.location.hostname : ""}
            </p>
          </div>

          <div className="flex items-center gap-3">
            <BranchSwitcher />
            <ThemeToggle />

            <div className="relative">
              <button
                onClick={() => setMenuOpen((o) => !o)}
                className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-[var(--color-bg-subtle)]"
              >
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--color-brand-100)] text-xs font-semibold text-[var(--color-brand-700)]">
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
              </button>

              {menuOpen && (
                <div className="absolute right-0 z-10 mt-2 w-56 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-1.5 shadow-lg">
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
                    className="block rounded-lg px-3 py-2 text-sm text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-subtle)]"
                  >
                    Change password
                  </Link>
                  <Link
                    href="/sessions"
                    onClick={() => setMenuOpen(false)}
                    className="block rounded-lg px-3 py-2 text-sm text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-subtle)]"
                  >
                    Active sessions
                  </Link>
                  <div className="mt-1 border-t border-[var(--color-border)] pt-1">
                    <Button variant="ghost" onClick={() => void logout()} className="w-full">
                      Sign out
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </header>

        <LicenseBanner />

        <main className="flex-1 overflow-x-auto p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
