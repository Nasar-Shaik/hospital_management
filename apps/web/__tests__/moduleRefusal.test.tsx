/**
 * D20 — A REFUSAL IS NOT AN EMPTY MODULE.
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
 * Hiding a nav entry is a courtesy; the URL is still typeable, a bookmark still exists, and the
 * server still answers `HMS-PLAN-002 Feature not in your edition`. What the pages then DID with
 * that answer was the second half of D20: `/emergency` printed the refusal and, directly below it,
 * **"Nobody in the emergency department."**; `/theatres` offered "Book a procedure" and "Add
 * theatre" over "No theatres yet."
 *
 * Read together those say "you have this module and it happens to be empty" — the opposite of the
 * truth, and what sent a clinic administrator into the role editor after a permission that could
 * never have helped.
 *
 * ── WHY THIS TEST DRIVES THE REAL PAGES ─────────────────────────────────────
 * The contradiction was never in a component; it was in what a page renders when its list read
 * fails. Only mounting the page and answering its request with the real refusal can show it — and
 * that is also the assertion that proves the server refusal still ARRIVES, which is the thing that
 * must never be traded away for a tidier menu.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ApiClient } from "@medicore/api-client";

const AUTH = {
  user: { id: "admin-1", name: "Clinic Admin" },
  api: null as unknown as ApiClient,
  // The account the defect was found on: a clinic TENANT_ADMIN holds every permission there is.
  can: () => true,
  hasFeature: () => false,
};
const BRANCH = {
  branches: [{ id: "b1", name: "Main Branch" }],
  active: { id: "b1", name: "Main Branch" },
  timezone: "Asia/Kolkata",
  mustChooseBranch: false,
  select: () => undefined,
};

vi.mock("../components/AuthProvider", () => ({ useAuth: () => AUTH }));
vi.mock("../components/BranchProvider", () => ({ useBranch: () => BRANCH }));

const { default: EmergencyBoardPage } = await import("../app/emergency/page");
const { default: TheatresPage } = await import("../app/theatres/page");

/** The API's real answer for a module the hospital never bought. */
function refuseEverything() {
  const fetchImpl = (async (): Promise<Response> =>
    new Response(
      JSON.stringify({
        success: false,
        error: {
          code: "HMS-PLAN-002",
          message: "Feature not in your edition",
          details: { feature: "module.clinical.emergency" },
        },
      }),
      { status: 403, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
  AUTH.api = new ApiClient({ baseUrl: "http://api.test", fetchImpl });
}

beforeEach(refuseEverything);
afterEach(cleanup);

describe("1. the emergency board, reached by typing the URL", () => {
  it("says the module is not in the edition", async () => {
    render(<EmergencyBoardPage />);
    expect(await screen.findByText(/not part of your hospital/)).toBeTruthy();
  });

  /** The exact contradiction, asserted as an absence. */
  it("does not also claim the department is empty", async () => {
    render(<EmergencyBoardPage />);
    await screen.findByText(/not part of your hospital/);
    expect(screen.queryByText("Nobody in the emergency department.")).toBeNull();
  });

  it("offers no action that could only be refused", async () => {
    render(<EmergencyBoardPage />);
    await screen.findByText(/not part of your hospital/);
    expect(screen.queryByRole("button", { name: "Triage" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
  });

  /**
   * The one sentence that stops the search that cost the most. An administrator who is told
   * "insufficient permission" goes to the role editor; the whole point of `HMS-PLAN-002` being a
   * distinct code is that this one must not.
   */
  it("says plainly that no permission change will open it", async () => {
    render(<EmergencyBoardPage />);
    expect(await screen.findByText(/not a permissions problem/i)).toBeTruthy();
  });
});

describe("2. the theatre board, reached the same way", () => {
  it("says the module is not in the edition, and offers no theatre to book", async () => {
    render(<TheatresPage />);

    expect(await screen.findByText(/not part of your hospital/)).toBeTruthy();
    expect(screen.queryByText("No theatres yet.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Book a procedure" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add theatre" })).toBeNull();
  });
});

describe("3. an ordinary failure is still an ordinary failure", () => {
  /**
   * The guard must key on the CODE, not on "the list read failed". A network blip or a genuine
   * 403 for a missing permission has a different remedy, and telling a hospital that pays for
   * emergency care that it does not own the module would be a worse lie than the one being fixed.
   */
  it("does not claim a module is unowned when the server merely erred", async () => {
    const fetchImpl = (async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          success: false,
          error: { code: "HMS-GEN-500", message: "Something went wrong" },
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    AUTH.api = new ApiClient({ baseUrl: "http://api.test", fetchImpl });

    render(<EmergencyBoardPage />);

    expect(await screen.findByText("Nobody in the emergency department.")).toBeTruthy();
    expect(screen.queryByText(/not part of your hospital/)).toBeNull();
  });
});
