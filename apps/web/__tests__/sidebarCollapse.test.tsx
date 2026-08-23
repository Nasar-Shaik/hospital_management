/**
 * THE RAIL COULD BE COLLAPSED AND NEVER EXPANDED AGAIN.
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
 * The only control that expanded the sidebar was the last row INSIDE it, underneath a nav pane
 * marked `flex-1 overflow-y-auto`. A flex child defaults to `min-height: auto`, so that pane
 * would not shrink below its own content whatever the overflow rule said: with enough sections —
 * a tenant admin sees every one — it grew taller than the rail, pushed the branch footer and the
 * collapse row past the bottom of a `h-screen overflow-hidden` shell, and they were clipped out
 * of existence. Collapse the rail once and the preference persisted to `localStorage`, so the
 * hospital came back the next morning to a sixteen-pixel strip with no way to open it.
 *
 * Two independent things had to be true for that to happen, so both are pinned here:
 *
 *   1. the scrolling pane must be allowed to shrink (`min-h-0`), and
 *   2. the handle must not live inside the thing it opens — it floats on the rail's seam, so its
 *      reachability does not depend on how many modules the hospital bought.
 *
 * ── WHAT THIS TEST CANNOT PROVE ─────────────────────────────────────────────
 * jsdom has no layout: it will not tell you that a pane overflowed, because nothing here has a
 * height. It can only assert the class that prevents it and the button's existence in both
 * states. Whether the control is FINDABLE — 24px on a seam, at a glance, by a tired clerk — is a
 * judgement no test layer makes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * jsdom is configured for `.test.tsx` here, but this project's jsdom has no `localStorage` — the
 * document is on an opaque origin, so the Storage API is absent rather than empty. The rail reads
 * the preference through a `try/catch` precisely because a browser may refuse storage, so a stub
 * is the honest fixture: it exercises the path a real browser takes, and §4's last case removes it
 * again to exercise the path a locked-down one takes.
 */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

const AUTH = {
  // A tenant admin holds every code, which is the account with the longest rail and therefore the
  // only one the clipping reliably reproduced on.
  user: { id: "admin-1", name: "Hospital Admin", roles: ["TENANT_ADMIN"], branchIds: [] },
  api: null,
  can: () => true,
  hasFeature: () => true,
  logout: () => undefined,
};

vi.mock("../components/AuthProvider", () => ({ useAuth: () => AUTH }));
vi.mock("../components/BranchProvider", () => ({
  useBranch: () => ({ branches: [], active: null, hasChoice: false, canAggregate: false }),
}));
vi.mock("../components/BrandingProvider", () => ({ useBranding: () => ({ branding: null }) }));
vi.mock("../components/AlertBell", () => ({ AlertBell: () => null }));
vi.mock("../components/LicenseBanner", () => ({ LicenseBanner: () => null }));
vi.mock("../components/BranchSwitcher", () => ({ BranchSwitcher: () => null }));
vi.mock("@medicore/ui", () => ({ ThemeToggle: () => null }));
vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard" }));

const { AppShell } = await import("../components/AppShell");

const COLLAPSE_KEY = "medicore.sidebar.collapsed";

function shell(): void {
  render(
    <AppShell>
      <div />
    </AppShell>,
  );
}

/** The handle, whichever way it currently reads. */
function handle(): HTMLElement {
  return screen.getByRole("button", { name: /(Expand|Collapse) sidebar/ });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

describe("1. the handle is reachable in both states", () => {
  it("an expanded rail offers to collapse", () => {
    shell();
    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeTruthy();
  });

  it("a COLLAPSED rail still offers to expand — the whole defect in one assertion", () => {
    localStorage.setItem(COLLAPSE_KEY, "1");
    shell();
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeTruthy();
  });

  it("collapsing does not take the handle away with it", () => {
    shell();
    fireEvent.click(handle());
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeTruthy();
  });

  it("expands again, so the state is genuinely round-trippable by hand", () => {
    localStorage.setItem(COLLAPSE_KEY, "1");
    shell();
    fireEvent.click(handle());
    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeTruthy();
  });
});

describe("2. the handle floats on the seam rather than sitting in the nav", () => {
  it("is positioned against the rail, not laid out inside the scrolling pane", () => {
    shell();
    const button = handle();
    expect(button.className).toContain("absolute");
    // Anchored to the aside, which owns the width animation — no second source of truth.
    expect(button.closest("aside")?.className).toContain("relative");
  });

  it("is not a descendant of the pane that scrolls", () => {
    shell();
    const nav = document.getElementById("app-sidebar-nav");
    expect(nav).toBeTruthy();
    expect(nav?.contains(handle())).toBe(false);
  });

  it("says which state it is in, for a screen reader and not only a chevron", () => {
    shell();
    expect(handle().getAttribute("aria-expanded")).toBe("true");
    expect(handle().getAttribute("aria-controls")).toBe("app-sidebar-nav");
    fireEvent.click(handle());
    expect(handle().getAttribute("aria-expanded")).toBe("false");
  });
});

describe("3. the pane is allowed to shrink", () => {
  it("the scrolling nav carries min-h-0 — without it the footer is clipped away", () => {
    shell();
    const nav = document.getElementById("app-sidebar-nav");
    expect(nav?.className).toContain("min-h-0");
    expect(nav?.className).toContain("overflow-y-auto");
  });
});

describe("4. the preference survives the session", () => {
  it("collapsing writes it, expanding clears it", () => {
    shell();
    fireEvent.click(handle());
    expect(localStorage.getItem(COLLAPSE_KEY)).toBe("1");
    fireEvent.click(handle());
    expect(localStorage.getItem(COLLAPSE_KEY)).toBe("0");
  });

  it("a rail that cannot reach storage opens expanded rather than stuck shut", () => {
    // No Storage at all — the private-browsing / blocked-cookies case, and the one where being
    // wrong means a rail nobody can open.
    vi.stubGlobal("localStorage", undefined);
    shell();
    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeTruthy();
  });
});
