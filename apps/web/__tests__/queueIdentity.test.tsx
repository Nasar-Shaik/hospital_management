/**
 * D18 — THE DOCTOR'S QUEUE MUST NAME THE PEOPLE ON IT.
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
 * `/my-patients` loaded two independently capped lists — `listEncounters({ queued: true, limit:
 * 100 })` and `listPatients({ limit: 100 })` — and joined them in the browser:
 *
 *     const nameOf = (id: string): string => patients.find((p) => p.id === id)?.name ?? "—";
 *
 * They are different populations. The queue is everyone waiting for this doctor; the patient page
 * is the hundred most recent REGISTRATIONS. Any queued patient outside that page reduced to a
 * dash, with no error and no empty state. Measured on the demo hospital: 15 of 99 rows.
 *
 * The identical join was on `/reception`, so both screens are covered here.
 *
 * ── WHY THE FIXTURE IS BUILT THE WAY IT IS ──────────────────────────────────
 * The queued patient is DELIBERATELY ABSENT from `/patients`, which answers with a hundred other
 * people. Any implementation that resolves identity from that list renders "—" and fails. A
 * fixture where the same patient appears in both lists would pass against the defect, which is
 * exactly how a suite of 2,060 tests stayed green while the screen was wrong.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { ApiClient } from "@medicore/api-client";

const AUTH = {
  user: { id: "doctor-1", name: "Dr Rao" },
  api: null as unknown as ApiClient,
  can: (p: string) => PERMISSIONS.has(p),
};
const PERMISSIONS = new Set<string>();
const BRANCH = { timezone: "Asia/Kolkata", branches: [], active: null, select: () => undefined };

vi.mock("../components/AuthProvider", () => ({ useAuth: () => AUTH }));
vi.mock("../components/BranchProvider", () => ({ useBranch: () => BRANCH }));

const { default: MyPatientsPage } = await import("../app/my-patients/page");
const { default: ReceptionPage } = await import("../app/reception/page");

const ok = (data: unknown, meta?: unknown) =>
  new Response(JSON.stringify({ success: true, data, ...(meta ? { meta } : {}) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/**
 * The patient in the queue. Registered long ago, so NOT a recent registration — the case the old
 * join could not reach. The identity fields are the ones the server now sends (`EncounterRow`).
 */
const QUEUED = {
  id: "enc-1",
  patientId: "p-long-registered",
  patientName: "Kamala Devi",
  uhid: "UH-000042",
  episodeId: "ep-1",
  origin: "walk_in",
  class: "OP",
  status: "in_queue",
  doctorId: "doctor-1",
  token: 7,
  arrivedAt: "2026-08-19T03:30:00.000Z",
  activeOrderCount: 0,
  history: [],
  createdAt: "2026-08-19T03:30:00.000Z",
};

/**
 * A hundred OTHER patients — the page the old implementation searched.
 *
 * The control built into the fixture: the queued patient is not among them.
 */
const RECENT_HUNDRED = Array.from({ length: 100 }, (_, i) => ({
  id: `p-recent-${String(i)}`,
  uhid: `UH-9${String(i).padStart(5, "0")}`,
  name: `Recent Patient ${String(i)}`,
  gender: "female",
  status: "active",
}));

function makeServer(options: { queuedTotal?: number } = {}) {
  const urls: string[] = [];

  const fetchImpl = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const href = String(url);
    urls.push(`${init?.method ?? "GET"} ${href}`);

    if (href.includes("/api/v1/encounters")) {
      return ok([QUEUED], { page: 1, limit: 100, total: options.queuedTotal ?? 1 });
    }
    if (href.includes("/api/v1/patients")) {
      return ok(RECENT_HUNDRED, { page: 1, limit: 100, total: 4000 });
    }
    if (href.includes("/consultation-payments")) return ok({});
    return ok([]);
  }) as unknown as typeof fetch;

  return { urls, client: new ApiClient({ baseUrl: "http://api.test", fetchImpl }) };
}

beforeEach(() => {
  PERMISSIONS.clear();
  for (const p of [
    "order:create",
    "order:read",
    "emr:read",
    "encounter:read",
    "encounter:create",
  ]) {
    PERMISSIONS.add(p);
  }
});
afterEach(cleanup);

describe("1. the doctor's queue", () => {
  it("names a patient registered before the client's patient page reaches back", async () => {
    const server = makeServer();
    AUTH.api = server.client;
    render(<MyPatientsPage />);

    expect(await screen.findByText("Kamala Devi")).toBeTruthy();
  });

  it("never renders a dash where a person should be", async () => {
    const server = makeServer();
    AUTH.api = server.client;
    const { container } = render(<MyPatientsPage />);

    await screen.findByText("Kamala Devi");
    // The exact symptom, asserted as an absence: a dash in the waiting list.
    const list = container.querySelector("ul");
    expect(list?.textContent).not.toContain("—");
  });

  it("shows the UHID on the consultation header, from the row rather than a lookup", async () => {
    const server = makeServer();
    AUTH.api = server.client;
    render(<MyPatientsPage />);

    fireEvent.click(await screen.findByRole("button", { name: /Kamala Devi/ }));
    expect(await screen.findByText("UH-000042")).toBeTruthy();
  });

  /**
   * The fix REMOVES a request rather than adding one. This is also the assertion that fails if
   * anybody reintroduces the join "just for the name" — it cannot be satisfied by a bigger limit.
   */
  it("does not fetch a patient list at all", async () => {
    const server = makeServer();
    AUTH.api = server.client;
    render(<MyPatientsPage />);

    await screen.findByText("Kamala Devi");
    expect(server.urls.filter((u) => /\/api\/v1\/patients(\?|$)/.test(u))).toHaveLength(0);
  });
});

describe("2. the reception register — the same join, the other screen", () => {
  it("names today's visitor even though they are not on the registration picker's page", async () => {
    const server = makeServer();
    AUTH.api = server.client;
    render(<ReceptionPage />);

    expect(await screen.findByText("Kamala Devi")).toBeTruthy();
    expect(await screen.findByText("UH-000042")).toBeTruthy();
  });

  /**
   * Reception legitimately still loads a patient page — it is the REGISTRATION PICKER, a list of
   * people you might be about to register. What it must not do is use it to label the register.
   * So this asserts the picker is intact while the identity comes from the row.
   */
  it("keeps the registration picker, and does not label the register from it", async () => {
    const server = makeServer();
    AUTH.api = server.client;
    render(<ReceptionPage />);

    await screen.findByText("Kamala Devi");
    expect(server.urls.filter((u) => /\/api\/v1\/patients\?/.test(u)).length).toBeGreaterThan(0);
    // A name that exists ONLY in the picker's page must never appear as a register row.
    expect(screen.queryAllByText("Recent Patient 0").length).toBeLessThanOrEqual(1);
  });
});

describe("3. identity the server itself could not resolve", () => {
  it("says `Unknown patient` rather than rendering a blank", async () => {
    const server = makeServer();
    const original = server.client.listEncounters.bind(server.client);
    vi.spyOn(server.client, "listEncounters").mockImplementation(async (params) => {
      const page = await original(params);
      return {
        ...page,
        items: page.items.map((row) => ({ ...row, patientName: "Unknown patient", uhid: "" })),
      };
    });
    AUTH.api = server.client;
    render(<MyPatientsPage />);

    expect(await screen.findByText("Unknown patient")).toBeTruthy();
    vi.restoreAllMocks();
  });
});

/**
 * ── THE OTHER HALF OF THE SAME CAP ──────────────────────────────────────────
 * D18 was a capped JOIN. The list itself is capped too — one page of 100, the server's ceiling —
 * and that truncation was equally silent: the tail of the waiting room was simply absent.
 *
 * Found the hard way. An E2E patient standing at position 104 in a queue of 107 could not be found
 * on the page, and the browser test looking for them failed while the patient was really there.
 * Not a bigger limit: the rows are in TOKEN order, so the hundred shown are the hundred who
 * arrived first — which is the right hundred. What was missing was the sentence saying so.
 */
describe("4. a queue longer than the page it was asked for", () => {
  it("says how many patients are beyond it, rather than truncating in silence", async () => {
    const server = makeServer({ queuedTotal: 107 });
    AUTH.api = server.client;
    render(<MyPatientsPage />);

    await screen.findByText("Kamala Devi");
    expect(await screen.findByText(/106 more patients are queued beyond this page/)).toBeTruthy();
  });

  it("says nothing at all when the whole queue fits", async () => {
    const server = makeServer();
    AUTH.api = server.client;
    render(<MyPatientsPage />);

    await screen.findByText("Kamala Devi");
    expect(screen.queryByText(/queued beyond this page/)).toBeNull();
  });
});
