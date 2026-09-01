"use client";

/**
 * Decides whether the current route wears the application shell — and it lives in the ROOT layout,
 * which is the whole point.
 *
 * Next.js only persists `layout.tsx` across client navigations; a `page.tsx` is torn down and
 * rebuilt on every route change. When each page rendered its own `<Protected><AppShell>`, the shell
 * was part of that torn-down tree, so it REMOUNTED on every navigation — resetting the sidebar and
 * flashing the content like a full reload. Hoisting the shell here, into the root layout, mounts it
 * exactly once: React keeps this `<Protected>` node in place and only swaps the `children` beneath
 * it. The rail, its scroll, and the collapse state simply persist because they never unmount.
 *
 * Not every route wants the shell: the hospital's public home page (`/`), the sign-in flow, the
 * print/PDF views, and the standalone style guide render bare. Everything else is an authenticated
 * app screen and gets `Protected` (which supplies the shell and the session gate). The list is an
 * allow-list of BARE routes so a newly added app page is shell-wrapped by default — the safe bias.
 */
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Protected } from "./Protected";

/**
 * ── IT IS ALSO WHERE BRANCH SCOPE IS APPLIED ────────────────────────────────
 * For the same reason. The shell is hoisted here so it survives navigation; the PAGE beneath it is
 * exactly the thing that must not survive a branch change. Wrapping `children` — and only
 * `children` — in `BranchScope` discards the page on a switch while the rail, its scroll and the
 * session above it stay put. Bare routes are wrapped too: `/opd-slip` and `/ip-sheet` are printed
 * clinical documents, and they belong to a branch as much as any list does.
 */
import { BranchScope } from "./BranchScope";
import { useBranch } from "./BranchProvider";

/**
 * Routes that render WITHOUT the shell. Matched as exact-or-child (`/receipt` and `/receipt/…`), so
 * the singular print route never captures the plural `/receipts` billing list.
 */
const BARE_ROUTES = [
  "/", // the public marketing site (see app/page.tsx)
  "/login",
  "/forgot-password",
  "/reset-password",
  "/style-guide",
  "/receipt",
  "/opd-slip",
  "/ip-sheet",
  "/discharge-summary",
];

function isBare(pathname: string): boolean {
  return BARE_ROUTES.some(
    (route) =>
      pathname === route ||
      // "/" is exact-only; the rest also cover their detail children (`/receipt/123`).
      (route !== "/" && pathname.startsWith(`${route}/`)),
  );
}

export function AppFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const { scopeId } = useBranch();
  const scoped = <BranchScope scopeId={scopeId}>{children}</BranchScope>;
  if (isBare(pathname)) return scoped;
  return <Protected>{scoped}</Protected>;
}
