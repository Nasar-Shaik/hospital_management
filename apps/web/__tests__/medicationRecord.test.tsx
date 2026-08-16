/**
 * W-3 — CHARTING A DOSE FROM THE WEB WARD SCREEN MUST BE AS SAFE AS FROM THE PHONE.
 *
 * ── WHY THIS FILE DRIVES A REAL `ApiClient` ─────────────────────────────────
 * Half of what W3 fixed is invisible above the client: whether `Idempotency-Key` actually leaves
 * the browser, and whether a 409 carrying `details.existing` is read as an answer or thrown up as
 * a generic red error. A test that mocked `api.recordMedicationAdministration` would assert its
 * own mock and prove neither.
 *
 * So these tests build the REAL client over a stub `fetch`, mount the REAL component, click the
 * buttons a nurse clicks, and then look at two things: what the browser sent, and what the screen
 * says. Everything in between — the client, the shared classifier, the decision module — runs for
 * real.
 *
 * Only the two context hooks are stubbed, because a session and a branch list are not what is
 * under test and standing them up would need a server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { ApiClient } from "@medicore/api-client";

const AUTH = { user: { id: "nurse-1", name: "Asha" }, api: null as unknown as ApiClient };
const BRANCH = { timezone: "Asia/Kolkata" };

vi.mock("../components/AuthProvider", () => ({ useAuth: () => AUTH }));
vi.mock("../components/BranchProvider", () => ({ useBranch: () => BRANCH }));

const { MedicationRecord } = await import("../components/MedicationRecord");

/* ── the server, as a stub fetch ───────────────────────────────────────────── */

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

const ok = (data: unknown) =>
  new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const fail = (status: number, code: string, details?: unknown) =>
  new Response(JSON.stringify({ success: false, error: { code, message: "refused", details } }), {
    status,
    headers: { "content-type": "application/json" },
  });

const RX = [
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
      { drugCode: "MORPH", drugName: "Morphine", dose: "5 mg", route: "IV", frequency: "SOS" },
    ],
  },
];

/** 08:00 in Asia/Kolkata is 02:30Z — the whole point of rendering in the ward's zone. */
const SLOT_ISO = "2026-08-13T02:30:00.000Z";

const SLOTS = [
  {
    prescriptionId: "rx1",
    lineIndex: 0,
    drugCode: "PARA500",
    drugName: "Paracetamol",
    dose: "500 mg",
    route: "oral",
    frequency: "TDS",
    scheduledFor: SLOT_ISO,
    state: "due",
  },
];

const ALLERGIES = [
  {
    id: "a1",
    patientId: "p1",
    allergen: "PENICILLIN",
    label: "Penicillin",
    severity: "severe",
    status: "active",
    notedBy: "u",
    notedAt: "2026-01-01T00:00:00.000Z",
  },
];

interface ServerOptions {
  /** What POST …/medication-administrations does. Default: succeeds. */
  onChart?: (sent: Sent, attempt: number) => Response | Promise<Response> | Promise<never>;
  /** What the schedule returns on a RELOAD (the oracle). Default: unchanged. */
  scheduleOnReload?: unknown[];
}

function makeServer(options: ServerOptions = {}) {
  const sent: Sent[] = [];
  let scheduleReads = 0;
  let chartAttempts = 0;

  const fetchImpl = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const href = String(url);
    const method = init?.method ?? "GET";
    const record: Sent = {
      url: href,
      method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    };
    sent.push(record);

    if (href.includes("/prescriptions")) return ok(RX);
    if (href.includes("/allergies")) return ok(ALLERGIES);
    if (href.includes("/medication-schedule")) {
      scheduleReads += 1;
      const body = scheduleReads > 1 && options.scheduleOnReload ? options.scheduleOnReload : SLOTS;
      return ok(body);
    }
    if (href.includes("/medication-administrations")) {
      if (method === "GET") return ok([]);
      chartAttempts += 1;
      if (options.onChart) return options.onChart(record, chartAttempts);
      return ok({
        id: `mar${String(chartAttempts)}`,
        encounterId: "e1",
        patientId: "p1",
        prescriptionId: "rx1",
        lineIndex: 0,
        drugCode: "PARA500",
        drugName: "Paracetamol",
        dose: "500 mg",
        route: "oral",
        status: (record.body?.status as string) ?? "given",
        administeredAt: "2026-08-13T02:34:00.000Z",
        administeredBy: "nurse-1",
      });
    }
    return ok([]);
  }) as unknown as typeof fetch;

  return {
    sent,
    get chartAttempts() {
      return chartAttempts;
    },
    charts: () => sent.filter((s) => s.method === "POST"),
    client: new ApiClient({ baseUrl: "http://api.test", fetchImpl }),
  };
}

function mount(over: Partial<Parameters<typeof MedicationRecord>[0]> = {}) {
  return render(
    <MedicationRecord
      encounterId="e1"
      patientId="p1"
      patientName="Asha Rao"
      uhid="UH-1001"
      canAdminister
      canReadAllergies
      {...over}
    />,
  );
}

/** Opens the confirmation for the scheduled Paracetamol line. */
async function openConfirm(label = "Give") {
  const buttons = await screen.findAllByRole("button", { name: label });
  fireEvent.click(buttons[0] as HTMLElement);
  return screen.findByRole("dialog");
}

const confirmButton = () => screen.getByRole("button", { name: /^Confirm/ });

beforeEach(() => {
  BRANCH.timezone = "Asia/Kolkata";
});
afterEach(cleanup);

/* ── 1. idempotency ────────────────────────────────────────────────────────── */

describe("1. the request that leaves the browser", () => {
  it("carries an Idempotency-Key on the administration", async () => {
    const server = makeServer();
    AUTH.api = server.client;
    mount();

    await openConfirm();
    fireEvent.click(confirmButton());

    await waitFor(() => expect(server.charts()).toHaveLength(1));
    const key = server.charts()[0]?.headers["idempotency-key"];
    expect(key).toBeTruthy();
    expect(String(key).length).toBeGreaterThanOrEqual(8);
  });

  it("names the LINE, not just the drug code", async () => {
    const server = makeServer();
    AUTH.api = server.client;
    mount();

    await openConfirm();
    fireEvent.click(confirmButton());

    await waitFor(() => expect(server.charts()).toHaveLength(1));
    expect(server.charts()[0]?.body).toMatchObject({
      prescriptionId: "rx1",
      lineIndex: 0,
      scheduledFor: SLOT_ISO,
    });
  });

  /**
   * Give and Hold against the same dose are two different clinical decisions. Sharing a key would
   * make the server replay the first as the answer to the second, and the chart would say the
   * wrong thing about a patient.
   */
  it("gives Give and Hold DIFFERENT keys for the same dose", async () => {
    const server = makeServer();
    AUTH.api = server.client;
    mount();

    await openConfirm("Give");
    fireEvent.click(confirmButton());
    await waitFor(() => expect(server.charts()).toHaveLength(1));

    await openConfirm("Hold");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "systolic 84" } });
    fireEvent.click(confirmButton());
    await waitFor(() => expect(server.charts()).toHaveLength(2));

    const [a, b] = server.charts();
    expect(a?.headers["idempotency-key"]).not.toBe(b?.headers["idempotency-key"]);
  });

  /**
   * The dangerous version of the test above, and the one that actually pins the rule.
   *
   * After a SUCCESS the key is dropped, so a component that keyed on `(prescription, line)` alone
   * would still mint a fresh key for the next outcome and look correct. The collision only bites
   * while a key is HELD: a Give that ended `unknown` keeps its key, and if Hold reuses it the
   * server replays the Give — charting "given" for a dose the nurse decided to hold, on a patient
   * whose systolic was 84.
   */
  it("does not reuse a HELD key when the nurse changes their decision", async () => {
    const server = makeServer({
      onChart: (_sent, attempt) =>
        attempt === 1
          ? Promise.reject(new TypeError("Failed to fetch"))
          : Promise.resolve(
              ok({ id: "m2", drugName: "Paracetamol", status: "held", administeredAt: SLOT_ISO }),
            ),
    });
    AUTH.api = server.client;
    mount();

    // Give ends unresolved — its key is deliberately retained for a retry OF THE GIVE.
    await openConfirm("Give");
    fireEvent.click(confirmButton());
    await screen.findByRole("alert");

    // The nurse now decides to hold instead. That is a different decision.
    await openConfirm("Hold");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "systolic 84" } });
    fireEvent.click(confirmButton());
    await waitFor(() => expect(server.charts()).toHaveLength(2));

    const [give, hold] = server.charts();
    expect(give?.body).toMatchObject({ status: "given" });
    expect(hold?.body).toMatchObject({ status: "held" });
    expect(give?.headers["idempotency-key"]).not.toBe(hold?.headers["idempotency-key"]);
  });

  it("reuses the SAME key when an unresolved attempt is retried", async () => {
    // Every attempt fails ambiguously and the slot stays open — the true "we do not know" case.
    const server = makeServer({ onChart: () => Promise.reject(new TypeError("Failed to fetch")) });
    AUTH.api = server.client;
    mount();

    await openConfirm();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(server.chartAttempts).toBe(1));

    await screen.findByText(/could not confirm/i);
    await openConfirm();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(server.chartAttempts).toBe(2));

    const [first, second] = server.charts();
    expect(first?.headers["idempotency-key"]).toBe(second?.headers["idempotency-key"]);
  });
});

/* ── 2. the confirmation ───────────────────────────────────────────────────── */

describe("2. nothing is charted without a confirmation", () => {
  it("writes nothing when the action button is pressed", async () => {
    const server = makeServer();
    AUTH.api = server.client;
    mount();

    await openConfirm();
    expect(server.charts()).toHaveLength(0);
  });

  it("shows the patient, the drug, the dose, the route and the time", async () => {
    const server = makeServer();
    AUTH.api = server.client;
    mount();

    const dialog = await openConfirm();
    for (const fact of ["Asha Rao", "UH-1001", "Paracetamol", "500 mg", "oral", "08:00"]) {
      expect(dialog.textContent).toContain(fact);
    }
  });

  it("writes nothing when the confirmation is cancelled", async () => {
    const server = makeServer();
    AUTH.api = server.client;
    mount();

    await openConfirm();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.charts()).toHaveLength(0);
  });

  it("shows the allergies on record before an irreversible act", async () => {
    const server = makeServer();
    AUTH.api = server.client;
    mount();

    const dialog = await openConfirm();
    await waitFor(() => expect(dialog.textContent).toContain("Penicillin"));
    expect(dialog.textContent).toMatch(/severe/i);
  });

  it("says an empty allergy list means none RECORDED, not none", async () => {
    const server = makeServer();
    AUTH.api = server.client;
    // A role without `allergy:read` is not told "no allergies" — it is told nothing at all.
    mount({ canReadAllergies: false });

    const dialog = await openConfirm();
    expect(dialog.textContent).not.toMatch(/No allergies recorded/);
    expect(dialog.textContent).not.toContain("Penicillin");
  });
});

/* ── 3. the hold reason ────────────────────────────────────────────────────── */

describe("3. a held dose", () => {
  it("captures the reason in the application, never through window.prompt", async () => {
    const promptSpy = vi.fn();
    vi.stubGlobal("prompt", promptSpy);
    const server = makeServer();
    AUTH.api = server.client;
    mount();

    await openConfirm("Hold");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "systolic 84" } });
    fireEvent.click(confirmButton());

    await waitFor(() => expect(server.charts()).toHaveLength(1));
    expect(promptSpy).not.toHaveBeenCalled();
    expect(server.charts()[0]?.body).toMatchObject({ status: "held", reason: "systolic 84" });
    vi.unstubAllGlobals();
  });

  it("cannot be confirmed without one", async () => {
    const server = makeServer();
    AUTH.api = server.client;
    mount();

    await openConfirm("Hold");
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "systolic 84" } });
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(false);
  });
});

/* ── 3b. the drug that was not on the ward ─────────────────────────────────── */

/**
 * ── A SUPPLY FAILURE IS NOT A CLINICAL DECISION ─────────────────────────────
 * `not_available` has been a valid, persisted, audited `MAR_STATUS` since D5 and no client offered
 * it, so the only way to chart a stock-out was HOLD with a reason — which files it in the
 * clinical-decision column, where the next nurse reads `held` as "somebody decided to withhold
 * this". These prove the outcome now reaches the server as itself.
 */
describe("3b. a dose that was not available", () => {
  it("sends status not_available — not held, not refused", async () => {
    const server = makeServer();
    AUTH.api = server.client;
    mount();

    await openConfirm("Unavailable");
    fireEvent.click(confirmButton());

    await waitFor(() => expect(server.charts()).toHaveLength(1));
    const body = server.charts()[0]?.body;
    expect(body).toMatchObject({ status: "not_available" });
    expect(body?.status).not.toBe("held");
    expect(body?.status).not.toBe("refused");
    // Same endpoint as every other outcome — this is an existing door, not a new one.
    expect(server.charts()[0]?.url).toContain("/encounters/e1/medication-administrations");
  });

  /** The server demands a reason for `held` and for nothing else. The button must agree. */
  it("can be confirmed with no reason typed", async () => {
    const server = makeServer();
    AUTH.api = server.client;
    mount();

    await openConfirm("Unavailable");
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(false);
  });

  /** Five rights, unchanged: the identity block is shown before this outcome as before any other. */
  it("still goes through the confirmation, with the patient and drug named", async () => {
    const server = makeServer();
    AUTH.api = server.client;
    mount();

    const dialog = await openConfirm("Unavailable");
    expect(dialog.textContent).toMatch(/Asha Rao/);
    expect(dialog.textContent).toMatch(/UH-1001/);
    expect(dialog.textContent).toMatch(/Paracetamol/);
    expect(dialog.textContent).toMatch(/Not available/);
    // Nothing has been written by opening it.
    expect(server.charts()).toHaveLength(0);
  });

  /**
   * ── THE HAZARD, AND WHY THE FIRST ATTEMPT MUST NOT RESOLVE ──────────────────
   * A nurse presses Unavailable, the reply is lost, they find the drug after all and press Give.
   * If the two shared a key the server would REPLAY the stock-out and the chart would say the drug
   * was never given — the record saying the opposite of what the nurse chose.
   *
   * The first attempt is made to fail ambiguously on purpose: a SETTLED intent has its key retired
   * anyway, so a version of this test that let Unavailable succeed passes even when the outcome is
   * dropped from the key. It did, when first written — the falsification pass caught it.
   */
  it("carries its own idempotency key, distinct from a Give on the same slot", async () => {
    const server = makeServer({
      onChart: (_sent, attempt) =>
        attempt === 1
          ? Promise.reject(new TypeError("Failed to fetch"))
          : Promise.resolve(
              ok({ id: "m2", drugName: "Paracetamol", status: "given", administeredAt: SLOT_ISO }),
            ),
    });
    AUTH.api = server.client;
    mount();

    // Unavailable ends unresolved — its key is deliberately retained for a retry OF THAT.
    await openConfirm("Unavailable");
    fireEvent.click(confirmButton());
    await screen.findByRole("alert");

    // The drug turns up. Giving it is a different decision and needs a different key.
    await openConfirm("Give");
    fireEvent.click(confirmButton());
    await waitFor(() => expect(server.charts()).toHaveLength(2));

    const [unavailable, give] = server.charts();
    expect(unavailable?.body).toMatchObject({ status: "not_available" });
    expect(give?.body).toMatchObject({ status: "given" });
    expect(unavailable?.headers["idempotency-key"]).toBeTruthy();
    expect(unavailable?.headers["idempotency-key"]).not.toBe(give?.headers["idempotency-key"]);
  });

  /**
   * What the nurse reads back. The words are the outcome's own — never "held" or "given", and
   * never the raw `not_available` enum.
   */
  it("confirms it in words, as not available and nothing else", async () => {
    const server = makeServer();
    AUTH.api = server.client;
    mount();

    await openConfirm("Unavailable");
    fireEvent.click(confirmButton());

    await waitFor(() => expect(document.body.textContent).toMatch(/Recorded:/));
    const notice = screen.getByText(/^Recorded:/);
    expect(notice.textContent).toMatch(/not available/i);
    expect(notice.textContent).not.toMatch(/not_available/);
    expect(notice.textContent).not.toMatch(/\bheld\b/i);
    expect(notice.textContent).not.toMatch(/\bgiven\b/i);
  });
});

/* ── 4. reconciliation ─────────────────────────────────────────────────────── */

describe("4. a dose another nurse already charted", () => {
  it("reads HMS-MAR-001 as an answer, naming who and when — not a red error", async () => {
    const server = makeServer({
      onChart: () =>
        fail(409, "HMS-MAR-001", {
          scheduledFor: SLOT_ISO,
          drugName: "Paracetamol",
          existing: {
            id: "mar-other",
            status: "given",
            drugName: "Paracetamol",
            administeredAt: SLOT_ISO,
            administeredBy: "nurse-2",
          },
        }),
    });
    AUTH.api = server.client;
    mount();

    await openConfirm();
    fireEvent.click(confirmButton());

    const notice = await screen.findByRole("alert");
    expect(notice.textContent).toMatch(/already given/i);
    expect(notice.textContent).toMatch(/another member of staff/);
    expect(notice.textContent).toMatch(/Nothing was charted again/);
    // The ward's clock: 02:30Z is 08:00 in Kolkata.
    expect(notice.textContent).toContain("08:00");
  });

  it("does not offer a retry after the slot is taken", async () => {
    const server = makeServer({
      onChart: () => fail(409, "HMS-MAR-001", { scheduledFor: SLOT_ISO, drugName: "Paracetamol" }),
    });
    AUTH.api = server.client;
    mount();

    await openConfirm();
    fireEvent.click(confirmButton());

    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: /Check the chart/i })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  /**
   * THE LOST RESPONSE, END TO END. The server committed; the answer never arrived. The screen must
   * discover that from the slot and must NOT tell the nurse the dose was not given.
   */
  it("discovers a lost response from the schedule instead of inviting a second dose", async () => {
    const server = makeServer({
      onChart: () => Promise.reject(new TypeError("Failed to fetch")),
      scheduleOnReload: [
        {
          ...SLOTS[0],
          state: "given",
          administrationId: "mar-lost",
          administeredBy: "nurse-1",
          administeredAt: SLOT_ISO,
        },
      ],
    });
    AUTH.api = server.client;
    mount();

    await openConfirm();
    fireEvent.click(confirmButton());

    const notice = await screen.findByRole("alert");
    expect(notice.textContent).toMatch(/by you/);
    expect(notice.textContent).not.toMatch(/not saved/i);
    expect(server.chartAttempts).toBe(1);
  });

  it("says it could not confirm — never 'not saved' — when the slot is still open", async () => {
    const server = makeServer({ onChart: () => Promise.reject(new TypeError("Failed to fetch")) });
    AUTH.api = server.client;
    mount();

    await openConfirm();
    fireEvent.click(confirmButton());

    const notice = await screen.findByRole("alert");
    expect(notice.textContent).toMatch(/could not confirm/i);
    expect(notice.textContent).not.toMatch(/not saved/i);
    expect(screen.getByRole("button", { name: /Check the chart/i })).toBeTruthy();
  });
});

/* ── 5. no optimistic clinical state ───────────────────────────────────────── */

describe("5. the screen never claims a dose before the server does", () => {
  it("shows a working state, not 'Given', while the request is in flight", async () => {
    let release!: (r: Response) => void;
    const server = makeServer({
      onChart: () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    });
    AUTH.api = server.client;
    const { container } = mount();

    await openConfirm();
    fireEvent.click(confirmButton());

    await waitFor(() => expect(screen.getByText(/Recording…/)).toBeTruthy());
    // Nothing in the record claims the dose landed. (The button's own spinner is also a
    // `role="status"` live region, so this asserts on the TEXT rather than counting regions.)
    expect(container.textContent).not.toMatch(/Recorded:/);
    expect(container.textContent).not.toMatch(/Given\b/);

    release(ok({ id: "m1", drugName: "Paracetamol", status: "given", administeredAt: SLOT_ISO }));
    await waitFor(() => expect(container.textContent).toMatch(/Recorded:/));
  });

  it("shows nothing as charted when the write was refused outright", async () => {
    const server = makeServer({ onChart: () => fail(403, "HMS-AUTH-005") });
    AUTH.api = server.client;
    const { container } = mount();

    await openConfirm();
    fireEvent.click(confirmButton());

    await waitFor(() => expect(container.textContent).toMatch(/refused/i));
    expect(container.textContent).not.toMatch(/Recorded:/);
  });

  it("does not send twice when the confirm button is double-clicked", async () => {
    let release!: (r: Response) => void;
    const server = makeServer({
      onChart: () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    });
    AUTH.api = server.client;
    mount();

    await openConfirm();
    const button = confirmButton();
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(server.chartAttempts).toBe(1));
    release(ok({ id: "m1", drugName: "Paracetamol", status: "given", administeredAt: SLOT_ISO }));
    await waitFor(() => expect(document.body.textContent).toMatch(/Recorded:/));
    expect(server.chartAttempts).toBe(1);
  });
});

/* ── 6. permission ─────────────────────────────────────────────────────────── */

describe("6. mar:administer", () => {
  it("offers no way to chart a dose without it", async () => {
    const server = makeServer();
    AUTH.api = server.client;
    mount({ canAdminister: false });

    await screen.findByText("Paracetamol");
    expect(screen.queryByRole("button", { name: "Give" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Hold" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Refused" })).toBeNull();
    expect(server.charts()).toHaveLength(0);
  });

  /**
   * Hiding the button is not the protection and this test says so out loud: the same component
   * with the permission returns the buttons, and the BACKEND is what refuses the write. The
   * integration suite proves that half (`mar.int.test.ts` — a doctor holds `emr:read`, is refused
   * `mar:administer`, and the refusal is a 403 not a hidden button).
   */
  it("still lets a permitted user chart — the gate is the server's, not the render's", async () => {
    const server = makeServer();
    AUTH.api = server.client;
    mount({ canAdminister: true });
    expect(await screen.findAllByRole("button", { name: "Give" })).not.toHaveLength(0);
  });

  it("does not request allergies a role may not read", async () => {
    const server = makeServer();
    AUTH.api = server.client;
    mount({ canReadAllergies: false });

    await screen.findByText("Paracetamol");
    expect(server.sent.some((s) => s.url.includes("/allergies"))).toBe(false);
  });
});

/* ── 7. the ward's clock ───────────────────────────────────────────────────── */

describe("7. scheduled times are the ward's, never the reader's", () => {
  it("renders the due time in the branch timezone", async () => {
    const server = makeServer();
    AUTH.api = server.client;
    mount();
    // 02:30Z is 08:00 in Kolkata. A browser in UTC would render 02:30.
    expect(await screen.findByText(/due 08:00/)).toBeTruthy();
  });

  it("moves with the BRANCH, not with the machine", async () => {
    BRANCH.timezone = "America/New_York";
    const server = makeServer();
    AUTH.api = server.client;
    mount();
    // The same instant, in New York: 22:30 the previous evening.
    expect(await screen.findByText(/due 22:30/)).toBeTruthy();
  });

  it("falls back to the platform zone rather than the browser for an unusable one", async () => {
    BRANCH.timezone = "IST";
    const server = makeServer();
    AUTH.api = server.client;
    mount();
    expect(await screen.findByText(/due 08:00/)).toBeTruthy();
  });
});
