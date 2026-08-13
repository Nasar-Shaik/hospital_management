/**
 * D-1 — THE MEDICATION CONFIRMATION MUST NAME THE PATIENT IT IS ABOUT.
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
 * The ward page resolved every name and UHID by matching `patientId` against
 * `listPatients({ limit: 100 })` — the hundred most recently REGISTERED patients. A patient
 * admitted longer ago than that simply was not in the list, so `nameOf` returned "—" and `uhidOf`
 * returned "". W3 had by then made both of them the first two lines of the medication
 * confirmation, which is the check that catches the right drug given to the wrong person. It
 * degraded silently: nothing on screen said the identity was missing rather than unknown.
 *
 * ── WHY THIS TEST RENDERS THE WARD PAGE AND NOT `MedicationRecord` ──────────
 * Because `MedicationRecord` never had the bug. It takes `patientName` and `uhid` as props and
 * renders exactly what it is given, and every W3 test handed it correct values — which is
 * precisely why the suite stayed green while the screen was wrong. The only honest evidence is to
 * mount the REAL page, let it resolve identity the way it does in production, and read the
 * confirmation.
 *
 * The stub below is built so the OLD implementation cannot pass: the admitted patient is
 * deliberately absent from `/patients`, which returns a hundred other people.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, within } from "@testing-library/react";
import { ApiClient } from "@medicore/api-client";

const AUTH = {
  user: { id: "nurse-1", name: "Asha" },
  api: null as unknown as ApiClient,
  can: (p: string) => PERMISSIONS.has(p),
};
const PERMISSIONS = new Set(["emr:read", "mar:administer", "allergy:read", "encounter:read"]);
const BRANCH = { timezone: "Asia/Kolkata" };

vi.mock("../components/AuthProvider", () => ({ useAuth: () => AUTH }));
vi.mock("../components/BranchProvider", () => ({ useBranch: () => BRANCH }));

const { default: WardPage } = await import("../app/ward/page");

const ok = (data: unknown, meta?: unknown) =>
  new Response(JSON.stringify({ success: true, data, ...(meta ? { meta } : {}) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** The patient on the ward. Long-stay, and therefore NOT a recent registration. */
const LONG_STAY = {
  id: "enc-1",
  patientId: "p-long-stay",
  patientName: "Kamala Devi",
  uhid: "UH-000042",
  episodeId: "ep-1",
  origin: "walk_in",
  class: "IP",
  status: "in_progress",
  arrivedAt: "2026-07-01T04:00:00.000Z",
  admittedAt: "2026-07-01T04:00:00.000Z",
  activeOrderCount: 0,
  history: [],
  createdAt: "2026-07-01T04:00:00.000Z",
  bed: { ward: "General", bedCode: "A-1", tariffCode: "BED_GEN" },
};

/**
 * A hundred OTHER patients — the page the old implementation searched.
 *
 * This is the control built into the fixture: the admitted patient is not among them, so any
 * implementation that resolves identity from this list renders "—" and fails the assertions below.
 */
const RECENT_HUNDRED = Array.from({ length: 100 }, (_, i) => ({
  id: `p-recent-${String(i)}`,
  uhid: `UH-9${String(i).padStart(5, "0")}`,
  name: `Recent Patient ${String(i)}`,
  gender: "female",
  status: "active",
}));

function makeServer() {
  const urls: string[] = [];

  const fetchImpl = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const href = String(url);
    urls.push(`${init?.method ?? "GET"} ${href}`);

    if (href.includes("/inpatients")) {
      return ok([LONG_STAY], { page: 1, limit: 100, total: 1 });
    }
    if (href.includes("/api/v1/patients")) {
      return ok(RECENT_HUNDRED, { page: 1, limit: 100, total: 4000 });
    }
    if (href.includes("/prescriptions")) {
      return ok([
        {
          id: "rx1",
          status: "signed",
          lines: [
            {
              drugCode: "PARA500",
              drugName: "Paracetamol",
              dose: "500 mg",
              route: "oral",
              frequency: "TDS",
            },
          ],
        },
      ]);
    }
    if (href.includes("/medication-schedule")) {
      return ok([
        {
          prescriptionId: "rx1",
          lineIndex: 0,
          drugCode: "PARA500",
          drugName: "Paracetamol",
          dose: "500 mg",
          route: "oral",
          frequency: "TDS",
          scheduledFor: "2026-08-14T02:30:00.000Z",
          state: "due",
        },
      ]);
    }
    if (href.includes("/medication-administrations")) return ok([]);
    if (href.includes("/allergies")) return ok([]);
    if (href.includes("/notes")) return ok([]);
    return ok([]);
  }) as unknown as typeof fetch;

  return {
    urls,
    client: new ApiClient({ baseUrl: "http://api.test", fetchImpl }),
  };
}

/** Selects the admitted patient and opens the confirmation for their due dose. */
async function openConfirmation() {
  fireEvent.click(await screen.findByRole("button", { name: /Kamala Devi/ }));
  const give = await screen.findByRole("button", { name: "Give" });
  fireEvent.click(give);
  return screen.findByRole("dialog");
}

beforeEach(() => {
  PERMISSIONS.clear();
  for (const p of ["emr:read", "mar:administer", "allergy:read", "encounter:read"]) {
    PERMISSIONS.add(p);
  }
});
afterEach(cleanup);

describe("1. a patient beyond the recent-registration window", () => {
  it("is named on the ward list", async () => {
    const server = makeServer();
    AUTH.api = server.client;
    render(<WardPage />);

    expect(await screen.findByText("Kamala Devi")).toBeTruthy();
  });

  /** THE ONE THAT MATTERS. The five rights, on the screen that gives the drug. */
  it("is named on the medication confirmation, with the correct UHID", async () => {
    const server = makeServer();
    AUTH.api = server.client;
    render(<WardPage />);

    const dialog = await openConfirmation();
    const rows = within(dialog);

    expect(rows.getByText("Kamala Devi")).toBeTruthy();
    expect(rows.getByText("UH-000042")).toBeTruthy();
    // The two failure shapes the old implementation produced, named explicitly.
    expect(dialog.textContent).not.toContain("Not loaded");
    expect(dialog.textContent).not.toMatch(/Patient\s*—/);
  });

  it("resolves identity WITHOUT searching a patient list", async () => {
    const server = makeServer();
    AUTH.api = server.client;
    render(<WardPage />);

    await screen.findByText("Kamala Devi");
    // The fix removes a request rather than adding one: identity arrives with the stay.
    expect(server.urls.filter((u) => /\/api\/v1\/patients(\?|$)/.test(u))).toHaveLength(0);
  });

  it("shows the UHID beside the patient on the ward header too", async () => {
    const server = makeServer();
    AUTH.api = server.client;
    render(<WardPage />);

    fireEvent.click(await screen.findByRole("button", { name: /Kamala Devi/ }));
    // The header prints the UHID and the bed in one line — match the substring, not the node.
    expect(await screen.findByText(/UH-000042/)).toBeTruthy();
  });
});

describe("2. identity the server itself could not resolve", () => {
  it("says so rather than rendering a blank", async () => {
    const server = makeServer();
    // The API's own fallback when the patient record cannot be read.
    const original = server.client.listInpatients.bind(server.client);
    vi.spyOn(server.client, "listInpatients").mockImplementation(async (params) => {
      const page = await original(params);
      return {
        ...page,
        items: page.items.map((row) => ({ ...row, patientName: "Unknown patient", uhid: "" })),
      };
    });
    AUTH.api = server.client;
    render(<WardPage />);

    // Visible and honest: a nurse sees that the lookup failed, not an empty space.
    expect(await screen.findByText("Unknown patient")).toBeTruthy();
    vi.restoreAllMocks();
  });
});
