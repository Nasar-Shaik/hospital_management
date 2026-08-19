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
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClient, type EdBoardRow } from "@medicore/api-client";

const AUTH = {
  user: { id: "nurse-1", name: "Asha" },
  api: null as unknown as ApiClient,
  can: (p: string) => PERMISSIONS.has(p),
};
const PERMISSIONS = new Set(["encounter:read", "triage:perform", "encounter:update"]);

vi.mock("../components/AuthProvider", () => ({ useAuth: () => AUTH }));

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
    const data = method === "GET" ? rows : { encounterId: "e1", patientId: "p1" };
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
