/**
 * THE EMERGENCY BOARD, IN THE BROWSER.
 *
 * ── WHAT IS WORTH TESTING HERE, AND WHAT IS NOT ─────────────────────────────
 * Not the ranking. The order rows arrive in is the SERVER's — `PRIORITY_RANK` in
 * `emergency.model.ts`, proved against a real database in `emergency.int.test.ts`. A second sort in
 * the browser would be a second answer to "who is sickest", and the day the two disagreed the wall
 * board and the nurse's phone would show different patients at the top. So this asserts the
 * opposite of a sort: that the page RENDERS WHAT IT IS GIVEN, in the order it is given.
 *
 * What only a browser-side test can answer is what a row LOOKS like — specifically that an
 * unassessed patient reads as something wrong rather than as an empty cell — and which request
 * leaves the browser when the nurse presses Save. Both run the REAL `ApiClient` over a stub fetch,
 * the same standard `medicationRound.test.tsx` set.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiClient, type EdBoardRow } from "@medicore/api-client";

const AUTH = {
  user: { id: "nurse-1", name: "Asha" },
  api: null as unknown as ApiClient,
  can: (p: string) => PERMISSIONS.has(p),
};
const PERMISSIONS = new Set(["encounter:read", "triage:perform", "encounter:update"]);

/**
 * The branch context, with the REAL predicate rather than a hand-set boolean (D19).
 *
 * `mustChooseBranch` is computed by `mustChooseBranchToWrite` here exactly as `BranchProvider`
 * computes it, so a test that sets up "two sites, none chosen" is exercising the rule the
 * application uses and not a second copy of it. Setting the flag directly would make these tests
 * pass against a guard that had been deleted from the provider.
 */
const BRANCH: {
  branches: { id: string; name: string }[];
  active: { id: string; name: string } | null;
  timezone: string;
  mustChooseBranch: boolean;
  select: (id: string | null) => void;
} = {
  branches: [],
  active: null,
  timezone: "Asia/Kolkata",
  get mustChooseBranch() {
    return mustChooseBranchToWrite({ branches: this.branches, active: this.active });
  },
  select: (id) => {
    BRANCH.active = BRANCH.branches.find((b) => b.id === id) ?? null;
  },
};

vi.mock("../components/AuthProvider", () => ({ useAuth: () => AUTH }));
vi.mock("../components/BranchProvider", () => ({ useBranch: () => BRANCH }));

const { mustChooseBranchToWrite } = await import("../lib/branchScope");
const { default: EmergencyBoardPage } = await import("../app/emergency/page");

interface Sent {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
}

function row(over: Partial<EdBoardRow> = {}): EdBoardRow {
  return {
    encounterId: "e1",
    patientId: "p1",
    patientName: "Meera Nair",
    uhid: "UH000105",
    arrivedAt: "2026-08-19T03:00:00.000Z",
    waitingMinutes: 12,
    status: "arrived",
    ...over,
  };
}

let sent: Sent[] = [];

function serve(rows: EdBoardRow[]) {
  sent = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    sent.push({
      method,
      url: String(url),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    });
    const data =
      method === "GET"
        ? String(url).includes("/doctors")
          ? [{ id: "doc-7", name: "Dr Ivy Menon" }]
          : rows
        : { encounterId: "e1", patientId: "p1" };
    return new Response(JSON.stringify({ success: true, data }), {
      status: method === "GET" ? 200 : 201,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  AUTH.api = new ApiClient({ baseUrl: "http://api.test", fetchImpl });
}

const posts = () => sent.filter((s) => s.method === "POST");

beforeEach(() => {
  vi.useRealTimers();
  // A single-site hospital by default: nothing to choose, so no guard applies and the existing
  // tests below describe the ordinary case.
  BRANCH.branches = [{ id: "b1", name: "Main Branch" }];
  BRANCH.active = BRANCH.branches[0] ?? null;
});
afterEach(cleanup);

describe("the board shows the server's answer", () => {
  it("keeps the rows in the order it was given", async () => {
    /**
     * Given DELIBERATELY out of any order the page could derive for itself: the untriaged row has
     * waited the LEAST and comes FIRST. A page that re-sorted by priority, by wait or by name would
     * move it, and would be wrong — the server already ranked them, and unknown outranks known.
     */
    serve([
      row({ encounterId: "e3", patientName: "Just Arrived", waitingMinutes: 1 }),
      row({
        encounterId: "e1",
        patientName: "Known Critical",
        priority: "critical",
        waitingMinutes: 40,
      }),
      row({
        encounterId: "e2",
        patientName: "Can Wait",
        priority: "non_urgent",
        waitingMinutes: 90,
      }),
    ]);
    render(<EmergencyBoardPage />);

    await waitFor(() => expect(screen.getByText("Known Critical")).toBeTruthy());
    const order = screen
      .getAllByRole("row")
      .map((r) => r.textContent ?? "")
      .filter((t) => /Just Arrived|Known Critical|Can Wait/.test(t));
    expect(order[0]).toContain("Just Arrived");
    expect(order[1]).toContain("Known Critical");
    expect(order[2]).toContain("Can Wait");
  });

  /**
   * An empty cell reads as "nothing to worry about here". The one thing this board must never do
   * is let a patient nobody has looked at appear calm.
   */
  it("says NOT TRIAGED rather than leaving the cell blank", async () => {
    serve([row({ patientName: "Nobody Looked" })]);
    render(<EmergencyBoardPage />);

    await waitFor(() => expect(screen.getByText("Nobody Looked")).toBeTruthy());
    expect(screen.getAllByText(/not triaged/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/has not been assessed/i)).toBeTruthy();
  });

  it("renders the wait the SERVER measured, in hours a tired reader can use", async () => {
    serve([row({ waitingMinutes: 95, priority: "urgent" })]);
    render(<EmergencyBoardPage />);

    // "1h 35m", not "95" — and not the browser's own subtraction of `arrivedAt`, which would
    // report the wait as this device's clock happens to see it.
    await waitFor(() => expect(screen.getByText("1h 35m")).toBeTruthy());
  });
});

describe("what leaves the browser", () => {
  it("posts the triage to the emergency route, with the priority the nurse chose", async () => {
    serve([row({ encounterId: "enc-7" })]);
    render(<EmergencyBoardPage />);

    await waitFor(() => expect(screen.getByText("Meera Nair")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Triage" }));
    fireEvent.click(screen.getByRole("button", { name: "Critical" }));
    fireEvent.change(screen.getByLabelText(/Chief complaint/i), {
      target: { value: "Chest pain" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save triage" }));

    await waitFor(() => expect(posts().length).toBeGreaterThan(0));
    expect(posts()[0]?.url).toBe("http://api.test/api/v1/emergency/triage");
    expect(posts()[0]?.body).toMatchObject({
      encounterId: "enc-7",
      priority: "critical",
      chiefComplaint: "Chest pain",
    });
  });

  /**
   * "Send to doctor" is the ENCOUNTER route every other screen uses. If it ever became an
   * emergency-specific endpoint, this is what would notice.
   */
  it("queues a patient through the ordinary encounter route, not an emergency one", async () => {
    serve([row({ encounterId: "enc-9", priority: "urgent", status: "arrived" })]);
    render(<EmergencyBoardPage />);

    await waitFor(() => expect(screen.getByText("Meera Nair")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Send to doctor" }));

    await waitFor(() => expect(posts().length).toBeGreaterThan(0));
    expect(posts()[0]?.url).toBe("http://api.test/api/v1/encounters/enc-9/queue");
  });

  it("offers no triage control to somebody who may not assess a patient", async () => {
    PERMISSIONS.delete("triage:perform");
    try {
      serve([row()]);
      render(<EmergencyBoardPage />);
      await waitFor(() => expect(screen.getByText("Meera Nair")).toBeTruthy());
      expect(screen.queryByRole("button", { name: "Triage" })).toBeNull();
    } finally {
      PERMISSIONS.add("triage:perform");
    }
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * D19 — THE SITE IS CHOSEN BEFORE THE WORK, NOT AFTER IT
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
 * With the header on "All branches" the board loaded, every action was enabled, and a nurse could
 * pick a priority, type a chief complaint and press Save — and only then get `HMS-BRANCH-001 No
 * active branch selected`. Switching branch to fix it closed the modal and discarded what she had
 * typed, so the product asked for the work twice and explained itself neither time.
 *
 * ── WHAT THESE ASSERT, AND WHY IT IS NOT COSMETIC ───────────────────────────
 * Not "a message appeared". The load-bearing claim is that the form CANNOT BE OPENED while the
 * write is impossible, and can be immediately afterwards — so no work is ever typed into a form
 * that is going to be thrown away. The server's refusal is untouched and is pinned separately in
 * `emergency.int.test.ts`; this is the courtesy, not the boundary.
 */
describe("a branch-stamping write under All branches", () => {
  /** Two sites and none chosen — exactly the state `writeBranchId()` refuses. */
  function allBranches() {
    BRANCH.branches = [
      { id: "b1", name: "Main Branch" },
      { id: "b2", name: "Riverside Annexe" },
    ];
    BRANCH.active = null;
  }

  it("does not let the nurse begin a triage she cannot finish", async () => {
    allBranches();
    serve([row()]);
    render(<EmergencyBoardPage />);

    const triage = await screen.findByRole("button", { name: "Triage" });
    expect((triage as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(triage);
    // No modal, and — the point — nothing was posted, so nothing was typed and lost.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(posts()).toHaveLength(0);
  });

  it("disables transfer-out too — both writes create the record that carries the site", async () => {
    allBranches();
    PERMISSIONS.add("encounter:close"); // the permission the transfer control is gated on
    serve([row()]);
    try {
      render(<EmergencyBoardPage />);

      const transfer = await screen.findByRole("button", { name: "Transfer out" });
      expect((transfer as HTMLButtonElement).disabled).toBe(true);
    } finally {
      PERMISSIONS.delete("encounter:close");
    }
  });

  /**
   * "Send to doctor" is a state transition on a visit that already exists and already carries a
   * branch. It succeeds in aggregate mode, so disabling it would be a guard applied by superstition
   * rather than by the rule — and it would strand a triaged patient on the board.
   */
  it("leaves the action that stamps nothing alone", async () => {
    allBranches();
    serve([row({ status: "arrived" })]);
    render(<EmergencyBoardPage />);

    const send = await screen.findByRole("button", { name: "Send to doctor" });
    expect((send as HTMLButtonElement).disabled).toBe(false);
  });

  it("says WHY, and offers the sites — rather than pointing at a corner of the screen", async () => {
    allBranches();
    serve([row()]);
    render(<EmergencyBoardPage />);

    expect(await screen.findByText(/Choose a site before you/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Main Branch" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Riverside Annexe" })).toBeTruthy();
  });

  it("becomes usable the moment a site is chosen", async () => {
    allBranches();
    serve([row()]);
    const view = render(<EmergencyBoardPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Riverside Annexe" }));
    // The app re-keys the routed subtree on a real switch; here the re-render is enough to show
    // that the same board, in a chosen site, offers the write.
    view.rerender(<EmergencyBoardPage />);

    await waitFor(() => {
      const triage = screen.getAllByRole("button", { name: "Triage" }).at(-1);
      expect((triage as HTMLButtonElement).disabled).toBe(false);
    });
    expect(screen.queryByText(/Choose a site before you/)).toBeNull();
  });

  /** A single-site hospital must never meet any of this. */
  it("is invisible to a hospital with one site", async () => {
    serve([row()]);
    render(<EmergencyBoardPage />);

    const triage = await screen.findByRole("button", { name: "Triage" });
    expect((triage as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/Choose a site before you/)).toBeNull();
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * C2 — THE BOARD SAYS WHO IS LOOKING AFTER THE PATIENT
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * `doctorId` has always been on the wire (`edBoardRow` in the contract) and the board dropped it,
 * so a row read "With doctor" without saying WHICH. On a shift with three doctors on the floor
 * that is the question the nurse is actually being asked — by the relative at the desk, and by the
 * lab ringing with a result.
 *
 * The board is a WORKLIST, so this is the whole of the addition: no ownership rules, no assignment
 * control. Handing a patient to a doctor already happens through "Send to doctor", which is the
 * ordinary encounter route.
 */
describe("the board names the doctor and the arrival", () => {
  it("shows the doctor a patient has been handed to", async () => {
    serve([row({ status: "in_progress", doctorId: "doc-7" })]);
    render(<EmergencyBoardPage />);

    expect(await screen.findByText("Dr Ivy Menon")).toBeTruthy();
    // The id itself is never what a person reads — the D15/D18 rule, on a third screen.
    expect(screen.queryByText("doc-7")).toBeNull();
  });

  /** Nobody has taken them yet. A real state, and it must not read as a failed lookup. */
  it("shows a dash for a patient nobody has been handed", async () => {
    serve([row({ status: "arrived" })]);
    render(<EmergencyBoardPage />);

    const table = await screen.findByRole("table");
    expect(within(table).getAllByText("—").length).toBeGreaterThan(0);
  });

  it("keeps the wait AND says what time they were brought in", async () => {
    serve([row({ arrivedAt: "2026-08-19T03:00:00.000Z", waitingMinutes: 95 })]);
    render(<EmergencyBoardPage />);

    // The wait is the server's number, unchanged — the arrival is the handover line beside it.
    expect(await screen.findByText("1h 35m")).toBeTruthy();
    expect(screen.getByText(new RegExp(fmtTime("2026-08-19T03:00:00.000Z")))).toBeTruthy();
  });
});

/** The same formatting the page uses, so the assertion is locale-independent. */
function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
