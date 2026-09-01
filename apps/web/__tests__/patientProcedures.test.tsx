/**
 * C2 — THE OPERATION MUST REACH THE PATIENT'S CHART.
 *
 * ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────
 * The operative note — what was done inside this patient, and what the surgeon found — was
 * written, stored, and reachable from exactly one screen: `/my-patients`, which lists the doctor's
 * LIVE QUEUE. The moment the visit closed, the record left the product's reach. The API had
 * returned the whole surgical history all along (`GET /ot-bookings?patientId=`, proved in
 * `theatres.int.test.ts` §"the operation reaches the patient's chart"); nothing asked it here.
 *
 * The same shape as D15 — required, stored, never displayed — one screen further on, and the
 * reason the Theatre workflow's final step ("→ patient chart") had never been exercised: there was
 * nothing to exercise.
 *
 * ── WHY THE ENTITLEMENT CASE IS HERE TOO ────────────────────────────────────
 * A "Procedures" tab that is empty because the hospital has no theatres reads as "this patient has
 * never been operated on" — a refusal rendered as emptiness, the exact class D20 closed. So the
 * tab is not offered at all without `module.clinical.ot`, and that is asserted rather than assumed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ApiClient } from "@medicore/api-client";

const AUTH = {
  user: { id: "doctor-1", name: "Dr Rao" },
  api: null as unknown as ApiClient,
  can: (p: string) => PERMISSIONS.has(p),
  hasFeature: (f: string) => FEATURES.has(f),
};
const PERMISSIONS = new Set<string>();
const FEATURES = new Set<string>();

vi.mock("../components/AuthProvider", () => ({ useAuth: () => AUTH }));
vi.mock("../components/BranchProvider", () => ({
  useBranch: () => ({
    timezone: "Asia/Kolkata",
    branches: [],
    active: null,
    mustChooseBranch: false,
  }),
}));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: "p-1" }) }));

const { default: PatientPage } = await import("../app/patients/[id]/page");

const ok = (data: unknown, meta?: unknown) =>
  new Response(JSON.stringify({ success: true, data, ...(meta ? { meta } : {}) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const PATIENT = {
  id: "p-1",
  uhid: "UH-000042",
  name: "Kamala Devi",
  gender: "female",
  status: "active",
  contact: { phone: "9000000001" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

/** Operated on and written up — the record a chart exists to carry. */
const WRITTEN_UP = {
  id: "ot-1",
  theatreId: "t-1",
  theatreName: "OT One",
  patientId: "p-1",
  patientName: "Kamala Devi",
  uhid: "UH-000042",
  surgeonId: "doctor-1",
  procedureName: "Appendectomy",
  scheduledStart: "2026-06-01T04:00:00.000Z",
  scheduledEnd: "2026-06-01T05:00:00.000Z",
  status: "completed",
  statusHistory: [],
  createdAt: "2026-06-01T03:00:00.000Z",
  operativeNote: {
    procedurePerformed: "Laparoscopic appendectomy",
    surgeonId: "doctor-1",
    performedAt: "2026-06-01T04:10:00.000Z",
    findings: "Inflamed appendix, no perforation.",
    recordedAt: "2026-06-01T05:20:00.000Z",
  },
};

/** Completed and NOT written up — a different fact, and the one somebody has to chase. */
const NOT_WRITTEN_UP = {
  ...WRITTEN_UP,
  id: "ot-2",
  procedureName: "Hernia repair",
  scheduledStart: "2026-07-02T04:00:00.000Z",
  scheduledEnd: "2026-07-02T05:00:00.000Z",
  operativeNote: undefined,
};

/** What `GET /packages` answers. §1–2 never look at it; §3 makes it the plan refusal. */
let packagesAnswer: () => Response = () => ok([]);

function serve(bookings: unknown[]) {
  const urls: string[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const href = String(url);
    urls.push(`${init?.method ?? "GET"} ${href}`);

    if (/\/patients\/p-1(\?|$)/.test(href)) return ok(PATIENT);
    if (href.includes("/ot-bookings")) return ok(bookings);
    // Care packages are a module a hospital buys; §3 drives this branch.
    if (href.includes("/packages")) return packagesAnswer();
    if (href.includes("/doctors")) return ok([{ id: "doctor-1", name: "Rao" }]);
    if (href.includes("/encounters") || href.includes("/orders") || href.includes("/invoices")) {
      return ok([], { page: 1, limit: 100, total: 0 });
    }
    return ok([]);
  }) as unknown as typeof fetch;

  AUTH.api = new ApiClient({ baseUrl: "http://api.test", fetchImpl });
  return urls;
}

beforeEach(() => {
  PERMISSIONS.clear();
  FEATURES.clear();
  for (const p of ["patient:read", "emr:read"]) PERMISSIONS.add(p);
  FEATURES.add("module.clinical.ot");
  packagesAnswer = () => ok([]);
});
afterEach(cleanup);

/** Opens the tab by its label, which is also how a person reaches it. */
async function openProcedures() {
  fireEvent.click(await screen.findByRole("button", { name: /Procedures/ }));
}

describe("1. a hospital with theatres", () => {
  it("offers a Procedures tab counting the patient's surgical history", async () => {
    serve([WRITTEN_UP, NOT_WRITTEN_UP]);
    render(<PatientPage />);

    expect(await screen.findByRole("button", { name: /Procedures\s*2/ })).toBeTruthy();
  });

  /** THE ONE THAT MATTERS: the record is readable from the durable chart, not just a live queue. */
  it("shows the operation record — what was performed, by whom, and what was found", async () => {
    serve([WRITTEN_UP]);
    render(<PatientPage />);
    await openProcedures();

    expect(await screen.findByText("Laparoscopic appendectomy")).toBeTruthy();
    expect(screen.getByText("Inflamed appendix, no perforation.")).toBeTruthy();
    // D15's fix, reused: the surgeon is a NAME, resolved from the doctor list, not an id.
    expect(screen.getByText("Rao")).toBeTruthy();
    expect(screen.queryByText("doctor-1")).toBeNull();
  });

  /**
   * "Booked", "operated on and written up" and "operated on and NOT written up" are three
   * different facts about a patient. The third is the one worth chasing, so it must not read as
   * either of the others.
   */
  it("says when a completed procedure has no record, rather than showing nothing", async () => {
    serve([NOT_WRITTEN_UP]);
    render(<PatientPage />);
    await openProcedures();

    expect(await screen.findByText(/No operation record has been written/)).toBeTruthy();
  });

  it("puts the most recent procedure first", async () => {
    serve([WRITTEN_UP, NOT_WRITTEN_UP]);
    render(<PatientPage />);
    await openProcedures();

    const text = document.body.textContent ?? "";
    expect(text.indexOf("Hernia repair")).toBeLessThan(text.indexOf("Appendectomy"));
  });

  it("says so plainly when the patient has never had a procedure", async () => {
    serve([]);
    render(<PatientPage />);
    await openProcedures();

    expect(await screen.findByText(/No procedures booked or performed/)).toBeTruthy();
  });
});

describe("2. a hospital without theatres", () => {
  it("is offered no Procedures tab at all", async () => {
    FEATURES.clear();
    serve([WRITTEN_UP]);
    render(<PatientPage />);

    await screen.findByText("Kamala Devi");
    expect(screen.queryByRole("button", { name: /Procedures/ })).toBeNull();
  });

  /**
   * And is not asked for either. An empty tab would be bad; a REFUSAL silently turned into an
   * empty tab by `soft()` would be worse — that is a plan refusal rendered as "this patient has
   * never been operated on" (D20).
   */
  it("does not even ask the theatre module for a history", async () => {
    FEATURES.clear();
    const urls = serve([WRITTEN_UP]);
    render(<PatientPage />);

    await screen.findByText("Kamala Devi");
    expect(urls.filter((u) => u.includes("/ot-bookings"))).toHaveLength(0);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3. THE BILLS TAB, FOR A HOSPITAL THAT NEVER BOUGHT CARE PACKAGES.
 *
 * The same class as §2, on the tab next door, and newly reachable: until 2026-08-20 the package
 * routes gated on `module.ops.opd`, so this refusal could not happen. Now it can, and the panel
 * swallowed the error — leaving a hospital that does not have the module looking at "No packages
 * defined. Create one under Care packages first.", an instruction pointing at a page that will
 * refuse them too.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("3. the bills tab, for a hospital without care packages", () => {
  const refusePackages = () =>
    new Response(
      JSON.stringify({
        success: false,
        error: {
          code: "HMS-PLAN-002",
          message: "Feature not in your edition",
          details: { feature: "module.finance.packages" },
        },
      }),
      { status: 403, headers: { "content-type": "application/json" } },
    );

  async function openBills() {
    fireEvent.click(await screen.findByRole("button", { name: /Bills/ }));
  }

  it("shows no care package panel at all, rather than an empty one", async () => {
    PERMISSIONS.add("billing:read");
    PERMISSIONS.add("package:enroll");
    packagesAnswer = refusePackages;
    serve([]);
    render(<PatientPage />);
    await openBills();

    expect(await screen.findByText("No bills.")).toBeTruthy();
    expect(screen.queryByText("Care packages")).toBeNull();
    expect(screen.queryByText(/No packages defined/)).toBeNull();
  });

  /** And the panel is still there for a hospital that DID buy them — the guard must key on the code. */
  it("still shows it to a hospital that has the module", async () => {
    PERMISSIONS.add("billing:read");
    PERMISSIONS.add("package:enroll");
    serve([]);
    render(<PatientPage />);
    await openBills();

    expect(await screen.findByText("Care packages")).toBeTruthy();
  });
});
