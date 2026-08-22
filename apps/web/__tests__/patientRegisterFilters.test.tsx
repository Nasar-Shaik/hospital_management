/**
 * THE REGISTER'S FILTERS MUST REACH THE SERVER.
 *
 * ── WHERE THIS CAME FROM ────────────────────────────────────────────────────
 * Manual testing reported "the patients page shows every patient — can we paginate it". It already
 * paginated, and had since it was written; the demo hospital simply had six patients, so one page
 * WAS the register and the screen looked identical to a broken one. The real gaps were narrower: a
 * page of fifty is a search rather than a glance, and there was no way to ask "who did we register
 * last month" at all.
 *
 * ── WHAT THIS FILE DEFENDS ──────────────────────────────────────────────────
 * That the controls are WIRED — that typing a date actually narrows the request, resets to page
 * one, and clears again. A filter that renders but never reaches the query is the defect class
 * this repository keeps finding, and it is invisible on a small dataset in exactly the way the
 * original report was.
 *
 * The DAY arithmetic is not tested here and must not be: it belongs to the hospital's timezone,
 * the server owns it, and `appointments.tz.int.test.ts` proves it against a branch nine and a half
 * hours from the process clock. A browser-side assertion about days would only re-encode the bug.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ApiClient } from "@medicore/api-client";

const PERMISSIONS = new Set<string>(["patient:read", "patient:create"]);
const AUTH = {
  user: { id: "clerk-1", name: "Reception" },
  api: null as unknown as ApiClient,
  can: (p: string) => PERMISSIONS.has(p),
};
const BRANCH = { timezone: "Asia/Kolkata", branches: [], active: null, select: () => undefined };

/** The page pushes to a patient on row click; nothing here clicks a row, but the hook must exist. */
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../components/AuthProvider", () => ({ useAuth: () => AUTH }));
vi.mock("../components/BranchProvider", () => ({ useBranch: () => BRANCH }));

const { default: PatientsPage } = await import("../app/patients/page");

const ok = (data: unknown, meta?: unknown) =>
  new Response(JSON.stringify({ success: true, data, ...(meta ? { meta } : {}) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** More than one page of them, so the pager is real and `total` is not the page length. */
const REGISTER = Array.from({ length: 25 }, (_, i) => ({
  id: `p-${String(i)}`,
  uhid: `UH-${String(i).padStart(6, "0")}`,
  name: `Patient ${String(i)}`,
  gender: "female",
  status: "active",
  contact: {},
}));

function makeServer() {
  const urls: string[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const href = String(url);
    urls.push(`${init?.method ?? "GET"} ${href}`);
    if (href.includes("/api/v1/patients")) {
      return ok(REGISTER, { page: 1, limit: 25, total: 312 });
    }
    return ok([]);
  }) as unknown as typeof fetch;

  AUTH.api = new ApiClient({ baseUrl: "http://sunrise.test", fetchImpl });
  return {
    urls,
    /** The most recent request to the register — the one the screen is actually showing. */
    last: () => urls.filter((u) => u.includes("/api/v1/patients?")).at(-1) ?? "",
  };
}

let server: ReturnType<typeof makeServer>;

beforeEach(() => {
  server = makeServer();
});
afterEach(cleanup);

describe("the patient register asks the server for what the controls say", () => {
  it("asks for 25 rows, not 50 — a page a clerk can scan", async () => {
    render(<PatientsPage />);
    await waitFor(() => expect(server.last()).toContain("limit=25"));
  });

  it("sends a date range as `from` and `to`, in YYYY-MM-DD", async () => {
    render(<PatientsPage />);
    await waitFor(() => expect(server.last()).toContain("limit=25"));

    fireEvent.change(screen.getByLabelText("Registered on or after"), {
      target: { value: "2026-07-01" },
    });
    fireEvent.change(screen.getByLabelText("Registered on or before"), {
      target: { value: "2026-07-31" },
    });

    await waitFor(() => {
      expect(server.last()).toContain("from=2026-07-01");
      expect(server.last()).toContain("to=2026-07-31");
    });
  });

  /** Either end alone is a legitimate question — "everyone since March". */
  it("sends one bound without inventing the other", async () => {
    render(<PatientsPage />);
    await waitFor(() => expect(server.last()).toContain("limit=25"));

    fireEvent.change(screen.getByLabelText("Registered on or after"), {
      target: { value: "2026-03-01" },
    });

    await waitFor(() => expect(server.last()).toContain("from=2026-03-01"));
    expect(server.last()).not.toContain("to=");
  });

  /**
   * A new filter is a new register. Page 4 of the unfiltered list is meaningless against it, and
   * landing on an empty page 4 reads as "nobody registered that month" — the same wrong conclusion
   * the missing count used to invite.
   */
  it("returns to page one when the range changes", async () => {
    render(<PatientsPage />);
    await waitFor(() => expect(server.last()).toContain("limit=25"));

    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    await waitFor(() => expect(server.last()).toContain("page=2"));

    fireEvent.change(screen.getByLabelText("Registered on or after"), {
      target: { value: "2026-07-01" },
    });

    await waitFor(() => expect(server.last()).toContain("from=2026-07-01"));
    expect(server.last()).not.toContain("page=2");
  });

  it("clears back to the whole register", async () => {
    render(<PatientsPage />);
    await waitFor(() => expect(server.last()).toContain("limit=25"));

    fireEvent.change(screen.getByLabelText("Registered on or after"), {
      target: { value: "2026-07-01" },
    });
    await waitFor(() => expect(server.last()).toContain("from=2026-07-01"));

    fireEvent.click(screen.getByRole("button", { name: /clear filters/i }));
    await waitFor(() => expect(server.last()).not.toContain("from="));
  });

  /** The control must not exist until it would do something. */
  it("offers no Clear until something is filtered", () => {
    render(<PatientsPage />);
    expect(screen.queryByRole("button", { name: /clear filters/i })).toBeNull();
  });
});
