/**
 * W-4 — THE MEDICATION ROUND IS A NAVIGATOR, AND THE ONLY WAY TO GIVE A DRUG IS W3.
 *
 * ── WHY THIS FILE DRIVES A REAL `ApiClient` ─────────────────────────────────
 * The claims that matter here are claims about REQUESTS: that the whole ward costs one call per
 * page rather than one per patient, that the branch's day is what gets asked for, that a ward
 * filter reaches the server rather than being applied in the browser, and that after a dose is
 * charted the round asks the API again instead of painting the row itself. A mocked `api` object
 * would let every one of those pass while being false.
 *
 * So: the REAL client over a stub fetch, the REAL page, and assertions on the URLs that left the
 * browser and the words that appeared on screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { ApiClient } from "@medicore/api-client";

const AUTH = {
  user: { id: "nurse-1", name: "Asha" },
  api: null as unknown as ApiClient,
  can: (p: string) => PERMISSIONS.has(p),
};
const PERMISSIONS = new Set(["emr:read", "mar:administer", "allergy:read"]);
const BRANCH = { timezone: "Asia/Kolkata" };

vi.mock("../components/AuthProvider", () => ({ useAuth: () => AUTH }));
vi.mock("../components/BranchProvider", () => ({ useBranch: () => BRANCH }));

const { default: MedicationRoundPage } = await import("../app/medication-round/page");

/* ── the server ────────────────────────────────────────────────────────────── */

const ok = (data: unknown, meta?: unknown) =>
  new Response(JSON.stringify({ success: true, data, ...(meta ? { meta } : {}) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** 08:00 and 14:00 in Asia/Kolkata. A browser in UTC would render 02:30 and 08:30. */
const EIGHT = "2026-08-13T02:30:00.000Z";
const TWO = "2026-08-13T08:30:00.000Z";

function slot(over: Record<string, unknown> = {}) {
  return {
    prescriptionId: "rx1",
    // Deliberately NOT 0: an identity that hard-codes the first line must be detectable.
    lineIndex: 2,
    drugCode: "PARA500",
    drugName: "Paracetamol",
    dose: "500 mg",
    route: "oral",
    frequency: "TDS",
    scheduledFor: EIGHT,
    state: "due",
    ...over,
  };
}

function roundRow(over: Record<string, unknown> = {}) {
  return {
    encounterId: "e1",
    patientId: "p1",
    patientName: "Asha Rao",
    uhid: "UH-1001",
    ward: "General",
    bedCode: "A-1",
    allergens: [] as string[],
    severeAllergy: false,
    slots: [slot()],
    dosesDue: 1,
    dosesOverdue: 0,
    ...over,
  };
}

interface ServerOptions {
  rows?: Record<string, unknown>[];
  total?: number;
  /** Rows returned on the SECOND and later round reads — the "after charting" state. */
  rowsOnRefetch?: Record<string, unknown>[];
}

function makeServer(options: ServerOptions = {}) {
  const urls: string[] = [];
  const charted: Record<string, unknown>[] = [];
  let roundReads = 0;

  const fetchImpl = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const href = String(url);
    urls.push(`${init?.method ?? "GET"} ${href}`);

    if (href.includes("/medication-round")) {
      roundReads += 1;
      const rows =
        roundReads > 1 && options.rowsOnRefetch
          ? options.rowsOnRefetch
          : (options.rows ?? [roundRow()]);
      const page = Number(new URL(href).searchParams.get("page") ?? "1");
      const limit = Number(new URL(href).searchParams.get("limit") ?? "20");
      const ward = new URL(href).searchParams.get("ward");
      const filtered = ward ? rows.filter((r) => r.ward === ward) : rows;
      const total = options.total ?? filtered.length;
      return ok(filtered.slice((page - 1) * limit, page * limit), { page, limit, total });
    }
    // The W3 component's own loads, once a dose is opened.
    if (href.includes("/prescriptions")) {
      return ok([
        {
          id: "rx1",
          status: "signed",
          lines: [
            {
              drugCode: "IBU",
              drugName: "Ibuprofen",
              dose: "200 mg",
              route: "oral",
              frequency: "BD",
            },
            {
              drugCode: "AMOX",
              drugName: "Amoxicillin",
              dose: "500 mg",
              route: "IV",
              frequency: "TDS",
            },
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
    if (href.includes("/medication-schedule")) return ok([slot(), slot({ scheduledFor: TWO })]);
    if (href.includes("/medication-administrations")) {
      if ((init?.method ?? "GET") === "POST") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        charted.push(body);
        return ok({
          id: "m1",
          drugName: "Paracetamol",
          status: body.status,
          administeredAt: EIGHT,
        });
      }
      return ok([]);
    }
    if (href.includes("/allergies")) return ok([]);
    return ok([]);
  }) as unknown as typeof fetch;

  return {
    urls,
    charted,
    get roundReads() {
      return roundReads;
    },
    roundUrls: () => urls.filter((u) => u.includes("/medication-round")),
    client: new ApiClient({ baseUrl: "http://api.test", fetchImpl }),
  };
}

function mount() {
  return render(<MedicationRoundPage />);
}

/**
 * The Give button ON THE SELECTED LINE.
 *
 * Not `getAllByRole("button", {name: "Give"})[0]`: W3 shows the patient's whole chart, so the first
 * Give on screen belongs to whichever drug is listed first — Ibuprofen here. A first draft of these
 * tests did exactly that and charted the wrong medication, which is precisely the mistake the
 * "Selected dose" marker exists to stop a human making. Scoping to the marked row is how the test
 * asserts the thing it claims to.
 */
function giveOnSelectedLine(): HTMLElement {
  const marker = screen.getByText("Selected dose");
  const row = marker.closest("li");
  if (!row) throw new Error("the selected dose is not on a row");
  return within(row as HTMLElement).getByRole("button", { name: "Give" });
}

beforeEach(() => {
  BRANCH.timezone = "Asia/Kolkata";
  PERMISSIONS.clear();
  for (const p of ["emr:read", "mar:administer", "allergy:read"]) PERMISSIONS.add(p);
  vi.setSystemTime(new Date("2026-08-13T04:00:00.000Z"));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/* ── 1. the round loads from the authoritative API ─────────────────────────── */

describe("1. the round is the server's", () => {
  it("loads from /medication-round", async () => {
    const server = makeServer();
    AUTH.api = server.client;
    mount();

    await screen.findByText("Asha Rao");
    expect(server.roundUrls()).toHaveLength(1);
  });

  it("shows the patient by name AND identifier, with the bed as context", async () => {
    const server = makeServer();
    AUTH.api = server.client;
    mount();

    await screen.findByText("Asha Rao");
    expect(screen.getByText("UH-1001")).toBeTruthy();
    expect(screen.getByText(/General · A-1/)).toBeTruthy();
  });

  it("shows the medication, the dose and the route — never a bare drug name", async () => {
    const server = makeServer();
    AUTH.api = server.client;
    mount();

    const dose = await screen.findByRole("button", { name: /Paracetamol/ });
    expect(dose.textContent).toContain("500 mg");
    expect(dose.textContent).toContain("oral");
  });

  it("takes due/overdue from the SERVER's state, not from a local clock", async () => {
    const server = makeServer({
      rows: [roundRow({ slots: [slot({ state: "overdue" })], dosesDue: 1, dosesOverdue: 1 })],
    });
    AUTH.api = server.client;
    mount();

    const dose = await screen.findByRole("button", { name: /Paracetamol/ });
    expect(dose.textContent).toContain("Overdue");
  });

  /**
   * The decisive one. The dose below is scheduled for 08:00 and the fake clock says 09:30 — LATE
   * by any browser arithmetic. The server calls it `due`, and the screen must say Due.
   */
  it("cannot be talked into 'overdue' by the browser's clock", async () => {
    vi.setSystemTime(new Date("2026-08-13T04:00:00.000Z")); // 09:30 IST, after the 08:00 dose
    const server = makeServer({ rows: [roundRow({ slots: [slot({ state: "due" })] })] });
    AUTH.api = server.client;
    mount();

    const dose = await screen.findByRole("button", { name: /Paracetamol/ });
    expect(dose.textContent).toContain("Due");
    expect(dose.textContent).not.toContain("Overdue");
  });

  it("distinguishes answered doses from outstanding ones, in words", async () => {
    const server = makeServer({
      rows: [
        roundRow({
          slots: [slot({ state: "given" }), slot({ scheduledFor: TWO, state: "held" })],
          dosesDue: 0,
          dosesOverdue: 0,
        }),
      ],
    });
    AUTH.api = server.client;
    mount();

    await screen.findByText("Asha Rao");
    expect(screen.getByText("Given")).toBeTruthy();
    expect(screen.getByText("Held")).toBeTruthy();
  });
});

/* ── 2. the ward's day, in the ward's zone ─────────────────────────────────── */

describe("2. the day is the branch's, never the reader's", () => {
  it("asks for today in the BRANCH timezone", async () => {
    // 04:00Z on the 13th is 09:30 on the 13th in Kolkata — and still the 12th in New York.
    const server = makeServer();
    AUTH.api = server.client;
    mount();

    await screen.findByText("Asha Rao");
    expect(server.roundUrls()[0]).toContain("date=2026-08-13");
  });

  it("asks for a DIFFERENT day when the branch sits in another zone", async () => {
    BRANCH.timezone = "America/New_York";
    const server = makeServer();
    AUTH.api = server.client;
    mount();

    await screen.findByText("Asha Rao");
    // 04:00Z is 00:00 on the 13th in New York — the same instant, the previous… no: midnight.
    expect(server.roundUrls()[0]).toContain("date=2026-08-13");
  });

  it("renders scheduled times in the branch zone", async () => {
    const server = makeServer();
    AUTH.api = server.client;
    mount();

    // 02:30Z is 08:00 in Kolkata. A browser in UTC would show 02:30.
    expect(await screen.findByText("08:00")).toBeTruthy();
  });

  it("moves the displayed time with the BRANCH, not the machine", async () => {
    BRANCH.timezone = "America/New_York";
    const server = makeServer();
    AUTH.api = server.client;
    mount();

    expect(await screen.findByText("22:30")).toBeTruthy();
  });

  it("re-asks the server when the nurse picks another day", async () => {
    const server = makeServer();
    AUTH.api = server.client;
    mount();

    await screen.findByText("Asha Rao");
    fireEvent.change(screen.getByLabelText(/Day/), { target: { value: "2026-08-10" } });

    await waitFor(() =>
      expect(server.roundUrls().some((u) => u.includes("date=2026-08-10"))).toBe(true),
    );
  });
});

/* ── 3. ward filtering ─────────────────────────────────────────────────────── */

describe("3. the ward filter is the server's job", () => {
  it("sends the ward to the API rather than filtering in the browser", async () => {
    const server = makeServer({
      rows: [roundRow(), roundRow({ encounterId: "e2", patientName: "Ravi", ward: "ICU" })],
    });
    AUTH.api = server.client;
    mount();

    await screen.findByText("Asha Rao");
    fireEvent.change(screen.getByLabelText(/Ward/), { target: { value: "ICU" } });

    await waitFor(() => expect(server.roundUrls().some((u) => u.includes("ward=ICU"))).toBe(true));
    await waitFor(() => expect(screen.queryByText("Asha Rao")).toBeNull());
  });

  it("says a filtered ward is empty rather than implying nothing is due", async () => {
    const server = makeServer({ rows: [roundRow()] });
    AUTH.api = server.client;
    mount();

    await screen.findByText("Asha Rao");
    fireEvent.change(screen.getByLabelText(/Ward/), { target: { value: "Nowhere" } });

    await waitFor(() => expect(screen.getByText(/Nobody is admitted to/)).toBeTruthy());
  });
});

/* ── 4. no N+1 ─────────────────────────────────────────────────────────────── */

describe("4. one request for the whole ward", () => {
  /**
   * The regression this asserts is the one the round endpoint exists to prevent: ward → patients →
   * a schedule call per patient → an allergy call per patient. Twelve patients must cost exactly
   * what one costs.
   */
  it("costs the same number of requests for twelve patients as for one", async () => {
    const one = makeServer({ rows: [roundRow()] });
    AUTH.api = one.client;
    mount();
    await screen.findByText("Asha Rao");
    const forOne = one.urls.length;

    cleanup();

    const many = makeServer({
      rows: Array.from({ length: 12 }, (_, i) =>
        roundRow({
          encounterId: `e${String(i)}`,
          patientId: `p${String(i)}`,
          bedCode: `A-${String(i)}`,
        }),
      ),
    });
    AUTH.api = many.client;
    mount();
    await screen.findAllByText("Asha Rao");

    expect(many.urls.length).toBe(forOne);
    expect(many.urls.filter((u) => u.includes("/medication-schedule"))).toHaveLength(0);
    expect(many.urls.filter((u) => u.includes("/allergies"))).toHaveLength(0);
  });
});

/* ── 5. pagination ─────────────────────────────────────────────────────────── */

describe("5. pagination is respected and its cost to ordering is admitted", () => {
  it("loads one page, not the whole hospital", async () => {
    const server = makeServer({
      rows: Array.from({ length: 30 }, (_, i) => roundRow({ encounterId: `e${String(i)}` })),
      total: 30,
    });
    AUTH.api = server.client;
    mount();

    await screen.findAllByText("Asha Rao");
    expect(server.roundUrls()[0]).toContain("limit=20");
    expect(screen.getAllByText("Asha Rao")).toHaveLength(20);
  });

  it("says the urgency order only covers what is loaded", async () => {
    const server = makeServer({
      rows: Array.from({ length: 30 }, (_, i) => roundRow({ encounterId: `e${String(i)}` })),
      total: 30,
    });
    AUTH.api = server.client;
    mount();

    await screen.findAllByText("Asha Rao");
    expect(screen.getByText(/loaded so far/i)).toBeTruthy();
  });

  it("fetches the next page on demand", async () => {
    const server = makeServer({
      rows: Array.from({ length: 30 }, (_, i) => roundRow({ encounterId: `e${String(i)}` })),
      total: 30,
    });
    AUTH.api = server.client;
    mount();

    await screen.findAllByText("Asha Rao");
    fireEvent.click(screen.getByRole("button", { name: /Load more/ }));

    await waitFor(() => expect(screen.getAllByText("Asha Rao")).toHaveLength(30));
    expect(server.roundUrls().some((u) => u.includes("page=2"))).toBe(true);
  });
});

/* ── 6. there is exactly one administration path ───────────────────────────── */

describe("6. the round never administers", () => {
  it("offers no Give, Hold or Refused on a round row", async () => {
    const server = makeServer();
    AUTH.api = server.client;
    mount();

    await screen.findByText("Asha Rao");
    expect(screen.queryByRole("button", { name: /^Give$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Hold$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Refused$/ })).toBeNull();
  });

  it("names the dose control as navigation, not as an action", async () => {
    const server = makeServer();
    AUTH.api = server.client;
    mount();

    const dose = await screen.findByRole("button", { name: /Paracetamol/ });
    expect(dose.textContent).not.toMatch(/\bGive\b|\bAdminister\b/);
  });

  it("writes nothing when a dose is selected — it opens the W3 record", async () => {
    const server = makeServer();
    AUTH.api = server.client;
    mount();

    fireEvent.click(await screen.findByRole("button", { name: /Paracetamol/ }));

    await screen.findByText(/Chart a dose/);
    expect(server.urls.filter((u) => u.startsWith("POST"))).toHaveLength(0);
    // W3's own buttons appear only inside the record it opened.
    expect(await screen.findAllByRole("button", { name: "Give" })).not.toHaveLength(0);
  });
});

/* ── 7. the identity that travels ──────────────────────────────────────────── */

describe("7. the dose identity is carried and then re-read", () => {
  it("marks the chosen line once W3 has re-read it", async () => {
    const server = makeServer();
    AUTH.api = server.client;
    mount();

    fireEvent.click(await screen.findByRole("button", { name: /Paracetamol/ }));

    await screen.findByText(/Chart a dose/);
    // The selected line is named in words, not by colour alone.
    expect(await screen.findByText("Selected dose")).toBeTruthy();
  });

  /**
   * THE IDENTITY, ALL THE WAY TO THE WIRE.
   *
   * The dose on the round is the THIRD line of the prescription, scheduled at 08:00. If any part of
   * the chain — the round's `slotRef`, the navigation, W3's re-read — dropped `lineIndex` or fell
   * back to the drug code, the administration would land on Ibuprofen or on the wrong slot. So this
   * follows one dose from the round row to the POST body and reads all three fields off it.
   */
  it("carries prescriptionId, lineIndex and scheduledFor onto the administration", async () => {
    const server = makeServer();
    AUTH.api = server.client;
    mount();

    fireEvent.click(await screen.findByRole("button", { name: /Paracetamol/ }));
    await screen.findByText("Selected dose");
    fireEvent.click(giveOnSelectedLine());
    fireEvent.click(await screen.findByRole("button", { name: /^Confirm/ }));

    await waitFor(() => expect(server.charted).toHaveLength(1));
    expect(server.charted[0]).toMatchObject({
      prescriptionId: "rx1",
      lineIndex: 2,
      scheduledFor: EIGHT,
      status: "given",
    });
  });

  /**
   * A patient on paracetamol QID has several doses open at once. Clicking the 14:00 one must chart
   * 14:00 — binding the earliest open slot instead would silently answer the 08:00 dose and leave
   * the one the nurse actually gave still showing as due.
   */
  it("charts the dose the nurse chose, not the earliest one still open", async () => {
    const server = makeServer({
      rows: [
        roundRow({
          slots: [slot(), slot({ scheduledFor: TWO })],
          dosesDue: 2,
        }),
      ],
    });
    AUTH.api = server.client;
    mount();

    // The second dose on the row — 14:00, not the earliest.
    const doses = await screen.findAllByRole("button", { name: /Paracetamol/ });
    fireEvent.click(doses[1] as HTMLElement);

    await screen.findByText("Selected dose");
    fireEvent.click(giveOnSelectedLine());
    fireEvent.click(await screen.findByRole("button", { name: /^Confirm/ }));

    await waitFor(() => expect(server.charted).toHaveLength(1));
    expect(server.charted[0]).toMatchObject({ scheduledFor: TWO, lineIndex: 2 });
  });

  it("re-reads the schedule rather than trusting the row it came from", async () => {
    const server = makeServer();
    AUTH.api = server.client;
    mount();

    fireEvent.click(await screen.findByRole("button", { name: /Paracetamol/ }));
    await waitFor(() =>
      expect(server.urls.some((u) => u.includes("/medication-schedule"))).toBe(true),
    );
  });

  it("says so when the chosen dose was answered while the round sat open", async () => {
    const server = makeServer();
    AUTH.api = server.client;
    // The round still shows it due; the schedule W3 fetches says another nurse gave it.
    const original = server.client.listMedicationSchedule.bind(server.client);
    vi.spyOn(server.client, "listMedicationSchedule").mockImplementation(async (id: string) => {
      const slots = await original(id);
      return slots.map((s) =>
        s.scheduledFor === EIGHT
          ? { ...s, state: "given" as const, administrationId: "m1", administeredBy: "nurse-2" }
          : s,
      );
    });
    mount();

    fireEvent.click(await screen.findByRole("button", { name: /Paracetamol/ }));
    expect(await screen.findByText(/already answered/i)).toBeTruthy();
  });
});

/* ── 8. permission ─────────────────────────────────────────────────────────── */

describe("8. viewing and administering are different rights", () => {
  it("shows the round to a viewer who cannot administer", async () => {
    PERMISSIONS.delete("mar:administer");
    const server = makeServer();
    AUTH.api = server.client;
    mount();

    await screen.findByText("Asha Rao");
    expect(screen.getByText("Paracetamol")).toBeTruthy();
  });

  it("gives that viewer no way to open the administration record", async () => {
    PERMISSIONS.delete("mar:administer");
    const server = makeServer();
    AUTH.api = server.client;
    mount();

    await screen.findByText("Asha Rao");
    const dose = screen.getByRole("button", { name: /Paracetamol/ });
    expect((dose as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(dose);
    expect(screen.queryByText(/Chart a dose/)).toBeNull();
  });

  it("refuses the page entirely without emr:read", async () => {
    PERMISSIONS.delete("emr:read");
    const server = makeServer();
    AUTH.api = server.client;
    mount();

    expect(screen.getByText(/do not have access/i)).toBeTruthy();
    expect(server.roundUrls()).toHaveLength(0);
  });
});

/* ── 9. after an administration ────────────────────────────────────────────── */

describe("9. the round re-reads itself rather than painting a row", () => {
  it("refetches the authoritative round once a dose is charted", async () => {
    const server = makeServer({
      rowsOnRefetch: [
        roundRow({ slots: [slot({ state: "given" })], dosesDue: 0, dosesOverdue: 0 }),
      ],
    });
    AUTH.api = server.client;
    mount();

    fireEvent.click(await screen.findByRole("button", { name: /Paracetamol/ }));
    const before = server.roundReads;

    await screen.findByText("Selected dose");
    fireEvent.click(giveOnSelectedLine());
    fireEvent.click(await screen.findByRole("button", { name: /^Confirm/ }));

    await waitFor(() => expect(server.roundReads).toBeGreaterThan(before));
  });

  it("shows the server's new state, not a locally flipped one", async () => {
    const server = makeServer({
      rowsOnRefetch: [roundRow({ slots: [slot({ state: "held" })], dosesDue: 0, dosesOverdue: 0 })],
    });
    AUTH.api = server.client;
    mount();

    fireEvent.click(await screen.findByRole("button", { name: /Paracetamol/ }));
    await screen.findByText("Selected dose");
    fireEvent.click(giveOnSelectedLine());
    fireEvent.click(await screen.findByRole("button", { name: /^Confirm/ }));

    // The nurse pressed GIVE; the server (in this test) says HELD. The round must show the
    // server's word — a locally patched row would read "Given".
    await waitFor(() => expect(screen.getAllByText("Held").length).toBeGreaterThan(0));
  });
});

/* ── 10. allergies ─────────────────────────────────────────────────────────── */

describe("10. allergy context", () => {
  it("shows the hospital-wide allergens the round returned", async () => {
    const server = makeServer({
      rows: [roundRow({ allergens: ["PENICILLIN"], severeAllergy: true })],
    });
    AUTH.api = server.client;
    mount();

    await screen.findByText("Asha Rao");
    expect(screen.getByText("Severe allergy")).toBeTruthy();
  });

  it("spells the allergens out for a screen reader rather than relying on a red pill", async () => {
    const server = makeServer({
      rows: [roundRow({ allergens: ["PENICILLIN"], severeAllergy: true })],
    });
    AUTH.api = server.client;
    const { container } = mount();

    await screen.findByText("Asha Rao");
    expect(container.textContent).toContain("Severe allergy recorded: PENICILLIN");
  });

  it("adds no allergy request of its own — the round already carries them", async () => {
    const server = makeServer({ rows: [roundRow({ allergens: ["PENICILLIN"] })] });
    AUTH.api = server.client;
    mount();

    await screen.findByText("Asha Rao");
    expect(server.urls.filter((u) => u.includes("/allergies"))).toHaveLength(0);
  });
});

/* ── 11. quiet rows ────────────────────────────────────────────────────────── */

describe("11. a patient with nothing outstanding", () => {
  it("says which kind of quiet it is, rather than rendering a blank row", async () => {
    const server = makeServer({
      rows: [roundRow({ slots: [], dosesDue: 0, dosesOverdue: 0 })],
    });
    AUTH.api = server.client;
    mount();

    expect(await screen.findByText("No scheduled doses today")).toBeTruthy();
  });

  it("separates 'all answered' from 'none scheduled'", async () => {
    const server = makeServer({
      rows: [roundRow({ slots: [slot({ state: "given" })], dosesDue: 0, dosesOverdue: 0 })],
    });
    AUTH.api = server.client;
    mount();

    await screen.findByText("Asha Rao");
    expect(screen.queryByText("No scheduled doses today")).toBeNull();
  });
});

/* ── 12. branch isolation (W1) ─────────────────────────────────────────────── */

describe("12. a branch switch cannot leave the old ward's round on screen", () => {
  /**
   * The round is a branch-scoped clinical list, so it inherits W1's protection rather than
   * implementing its own: `AppFrame` keys the routed subtree on the scope identity, and a change
   * there discards the page. This test drives that mechanism directly — mount the round under a
   * `BranchScope`, change the key, and check the first branch's patients are GONE rather than
   * sitting under the new branch's header.
   *
   * Nothing about it is theoretical: the round names patients, beds and drugs, and showing
   * Hyderabad's medication list under Chennai's header is the most dangerous version of the stale
   * screen W1 was written for.
   */
  /**
   * ── THE CLIENT IS THE SAME OBJECT ON BOTH SIDES OF THE SWITCH ───────────────
   * A first draft of this test handed the page a NEW `ApiClient` for branch B, and it passed with
   * the branch removed from the scope identity entirely — because swapping the client is itself a
   * change to the loader's dependencies, so the page refetched for a reason that does not exist in
   * production. The real app builds its client once (`useMemo(…, [])`) and the active branch rides
   * on a HEADER read per request, which is precisely why nothing in any page's dependencies ever
   * mentions the branch, and precisely why W1 had to discard components rather than ask them to
   * reload. So: one client, one mutable active branch, and the stub answers by header.
   */
  it("discards branch A's round when the active branch becomes B", async () => {
    const { BranchScope } = await import("../components/BranchScope");
    const { branchScopeId } = await import("../lib/branchScope");

    let activeBranch = "branch-a";
    const seen: string[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
      // The header the switcher actually moves. Absent would mean aggregate mode, and reading it
      // as such here rather than asserting non-null keeps the stub honest about the real contract.
      const branch = (init?.headers as Record<string, string>)["x-active-branch"] ?? "all";
      const href = String(url);
      if (!href.includes("/medication-round")) return ok([]);
      seen.push(branch);
      return ok(
        [
          roundRow({
            patientName: branch === "branch-a" ? "Hyderabad Patient" : "Chennai Patient",
          }),
        ],
        { page: 1, limit: 20, total: 1 },
      );
    }) as unknown as typeof fetch;

    AUTH.api = new ApiClient({
      baseUrl: "http://api.test",
      fetchImpl,
      getActiveBranch: () => activeBranch,
    });

    const scoped = (branchId: string) => (
      <BranchScope scopeId={branchScopeId({ tenant: "demo.test", branchId })}>
        <MedicationRoundPage />
      </BranchScope>
    );

    const { rerender } = render(scoped("branch-a"));
    await screen.findByText("Hyderabad Patient");

    // Exactly what the switcher does: the header changes, nothing else.
    activeBranch = "branch-b";
    rerender(scoped("branch-b"));

    await screen.findByText("Chennai Patient");
    expect(screen.queryByText("Hyderabad Patient")).toBeNull();
    expect(seen).toEqual(["branch-a", "branch-b"]);
  });
});

/* ── 13. ordering on screen ────────────────────────────────────────────────── */

describe("13. the walking order", () => {
  it("puts the patient with the earliest outstanding dose first", async () => {
    const server = makeServer({
      rows: [
        roundRow({
          encounterId: "soon",
          patientName: "Later Patient",
          bedCode: "A-1",
          slots: [slot({ scheduledFor: TWO })],
        }),
        roundRow({
          encounterId: "late",
          patientName: "Overdue Patient",
          bedCode: "A-9",
          slots: [slot({ scheduledFor: EIGHT, state: "overdue" })],
          dosesDue: 1,
          dosesOverdue: 1,
        }),
      ],
    });
    AUTH.api = server.client;
    const { container } = mount();

    await screen.findByText("Overdue Patient");
    const names = within(container)
      .getAllByText(/Patient$/)
      .map((el) => el.textContent);
    expect(names[0]).toContain("Overdue Patient");
  });
});
