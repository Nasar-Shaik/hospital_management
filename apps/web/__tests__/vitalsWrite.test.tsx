/**
 * D-2 — CHARTING OBSERVATIONS ON THE WEB MUST SURVIVE A LOST RESPONSE.
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
 * `VitalsForm` called `recordVitals` with no idempotency key and no reconciliation. The route has
 * carried `idempotent()` since it shipped, so the protection existed and the browser simply never
 * asked for it. A lost reply on ward wifi therefore left the nurse with an error, no way to find
 * out whether the observation had landed, and one obvious course of action — press save again,
 * which wrote a second reading.
 *
 * Mobile solved this in M3-S4. The fix here is NOT a web copy of that: `attemptVitals` moved into
 * `@medicore/api-client`, and this form consumes it. So what is worth testing here is the wiring
 * and the words — the classifier itself is proven by mobile's own S4 suite, unchanged.
 *
 * The real `ApiClient` over a stub fetch, because the header assertion is about what actually
 * leaves the browser.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { ApiClient, type VitalsReading } from "@medicore/api-client";
import { VitalsForm } from "../components/Vitals";

const ok = (data: unknown) =>
  new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const fail = (status: number, code: string) =>
  new Response(JSON.stringify({ success: false, error: { code, message: "refused" } }), {
    status,
    headers: { "content-type": "application/json" },
  });

function reading(over: Partial<VitalsReading> = {}): VitalsReading {
  return {
    id: "v-new",
    encounterId: "e1",
    patientId: "p1",
    recordedBy: "nurse-1",
    recordedAt: "2026-08-14T05:00:00.000Z",
    pulse: 88,
    flags: {},
    abnormal: false,
    ...over,
  } as VitalsReading;
}

/** The visit's chart as the screen already had it — the reconciliation baseline. */
const BEFORE: VitalsReading[] = [reading({ id: "v-old", recordedAt: "2026-08-14T04:00:00.000Z" })];

interface Sent {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

interface ServerOptions {
  /** What POST …/vitals does. Default: succeeds. */
  onRecord?: (sent: Sent, attempt: number) => Response | Promise<Response> | Promise<never>;
  /** What the chart reload returns — the oracle. */
  reload?: VitalsReading[];
}

function makeServer(options: ServerOptions = {}) {
  const sent: Sent[] = [];
  let attempts = 0;

  const fetchImpl = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const record: Sent = {
      method,
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    };
    sent.push(record);

    if (method === "POST") {
      attempts += 1;
      if (options.onRecord) return options.onRecord(record, attempts);
      return ok(reading());
    }
    return ok(options.reload ?? BEFORE);
  }) as unknown as typeof fetch;

  return {
    sent,
    posts: () => sent.filter((s) => s.method === "POST"),
    get attempts() {
      return attempts;
    },
    client: new ApiClient({ baseUrl: "http://api.test", fetchImpl }),
  };
}

function mount(server: ReturnType<typeof makeServer>, onSaved = vi.fn()) {
  render(
    <VitalsForm
      api={server.client}
      encounterId="e1"
      onSaved={onSaved}
      readings={BEFORE}
      recordedBy="nurse-1"
    />,
  );
  return onSaved;
}

const pulseBox = () => screen.getByRole("spinbutton", { name: /Pulse/i });
const saveButton = () => screen.getByRole("button", { name: /Save/i });

function enterPulse(value: string) {
  fireEvent.change(pulseBox(), { target: { value } });
}

afterEach(cleanup);

/* ── 1. idempotency, on the real request ───────────────────────────────────── */

describe("1. the request that leaves the browser", () => {
  it("carries an Idempotency-Key", async () => {
    const server = makeServer();
    mount(server);

    enterPulse("88");
    fireEvent.click(saveButton());

    await waitFor(() => expect(server.posts()).toHaveLength(1));
    const key = server.posts()[0]?.headers["idempotency-key"];
    expect(key).toBeTruthy();
    expect(String(key).length).toBeGreaterThanOrEqual(8);
  });

  it("sends no client timestamp — `recordedAt` is the server's", async () => {
    const server = makeServer();
    mount(server);

    enterPulse("88");
    fireEvent.click(saveButton());

    await waitFor(() => expect(server.posts()).toHaveLength(1));
    expect(server.posts()[0]?.body).not.toHaveProperty("recordedAt");
    expect(server.posts()[0]?.body).not.toHaveProperty("abnormal");
    expect(server.posts()[0]?.body).not.toHaveProperty("flags");
  });

  /**
   * The key must survive a RETRY of the same submission — that is the whole mechanism. Re-sending
   * under the same key is a replay, not a second observation.
   */
  it("reuses the same key when an unresolved save is retried unchanged", async () => {
    const server = makeServer({
      onRecord: () => Promise.reject(new TypeError("Failed to fetch")),
      reload: BEFORE,
    });
    mount(server);

    enterPulse("88");
    fireEvent.click(saveButton());
    await waitFor(() => expect(server.attempts).toBe(1));
    await screen.findByRole("alert");

    fireEvent.click(saveButton());
    await waitFor(() => expect(server.attempts).toBe(2));

    const [first, second] = server.posts();
    expect(first?.headers["idempotency-key"]).toBe(second?.headers["idempotency-key"]);
  });

  /**
   * ── AND IT MUST NOT SURVIVE AN EDIT ────────────────────────────────────────
   * The server refuses a reused key carrying a different body (`HMS-REQ-002`). A nurse who
   * corrects a mistyped pulse after a failure would otherwise be locked out of charting entirely.
   */
  it("renews the key once the figures change", async () => {
    const server = makeServer({
      onRecord: (_s, attempt) =>
        attempt === 1
          ? Promise.reject(new TypeError("Failed to fetch"))
          : Promise.resolve(ok(reading())),
      reload: BEFORE,
    });
    mount(server);

    enterPulse("88");
    fireEvent.click(saveButton());
    await screen.findByRole("alert");

    enterPulse("92");
    fireEvent.click(saveButton());
    await waitFor(() => expect(server.posts()).toHaveLength(2));

    const [first, second] = server.posts();
    expect(first?.headers["idempotency-key"]).not.toBe(second?.headers["idempotency-key"]);
  });
});

/* ── 2. the lost response ──────────────────────────────────────────────────── */

describe("2. a reply that never arrives", () => {
  /**
   * THE MANDATORY SCENARIO. The server committed; the response was lost. The chart is the only
   * thing that can answer "did it land?", and it says yes.
   */
  it("finds the observation on the chart and reports it as saved", async () => {
    const landed = reading({ id: "v-landed", recordedBy: "nurse-1" });
    const server = makeServer({
      onRecord: () => Promise.reject(new TypeError("Failed to fetch")),
      reload: [...BEFORE, landed],
    });
    const onSaved = mount(server);

    enterPulse("88");
    fireEvent.click(saveButton());

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(landed));
    // Told plainly, and told that nothing was written twice.
    expect(await screen.findByText(/checked the chart/i)).toBeTruthy();
    expect(server.attempts).toBe(1);
  });

  it("hands on the SERVER's reading, never a locally assembled one", async () => {
    const landed = reading({ id: "v-landed", pulse: 88, abnormal: true, flags: { pulse: "high" } });
    const server = makeServer({
      onRecord: () => Promise.reject(new TypeError("Failed to fetch")),
      reload: [...BEFORE, landed],
    });
    const onSaved = mount(server);

    enterPulse("88");
    fireEvent.click(saveButton());

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    // The server's assessment travels with it — the form never decides `abnormal`.
    expect(onSaved.mock.calls[0]?.[0]).toMatchObject({ abnormal: true, flags: { pulse: "high" } });
  });

  it("says it did NOT save when the chart shows nothing new", async () => {
    const server = makeServer({
      onRecord: () => Promise.reject(new TypeError("Failed to fetch")),
      reload: BEFORE,
    });
    const onSaved = mount(server);

    enterPulse("88");
    fireEvent.click(saveButton());

    await screen.findByRole("alert");
    expect(onSaved).not.toHaveBeenCalled();
    // The figures stay on screen so the nurse can simply press save again — which replays.
    expect((pulseBox() as HTMLInputElement).value).toBe("88");
  });

  it("does not claim a colleague's reading as ours", async () => {
    const theirs = reading({ id: "v-theirs", recordedBy: "nurse-2" });
    const server = makeServer({
      onRecord: () => Promise.reject(new TypeError("Failed to fetch")),
      reload: [...BEFORE, theirs],
    });
    const onSaved = mount(server);

    enterPulse("88");
    fireEvent.click(saveButton());

    await screen.findByRole("alert");
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("does not reconcile a refusal decided before anything could be written", async () => {
    const server = makeServer({ onRecord: () => fail(403, "HMS-AUTH-005") });
    const onSaved = mount(server);

    enterPulse("88");
    fireEvent.click(saveButton());

    await screen.findByRole("alert");
    expect(onSaved).not.toHaveBeenCalled();
    // No chart reload: nothing was written, so there is nothing to look for.
    expect(server.sent.filter((s) => s.method === "GET")).toHaveLength(0);
  });
});

/* ── 3. no optimistic clinical state ───────────────────────────────────────── */

describe("3. nothing is shown as charted before the server says so", () => {
  it("does not announce a save while the request is in flight", async () => {
    let release!: (r: Response) => void;
    const server = makeServer({
      onRecord: () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    });
    const onSaved = mount(server);

    enterPulse("88");
    fireEvent.click(saveButton());

    await waitFor(() => expect(server.attempts).toBe(1));
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.queryByText(/checked the chart/i)).toBeNull();

    release(ok(reading()));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it("does not say 'we checked the chart' when the server answered directly", async () => {
    const server = makeServer();
    mount(server);

    enterPulse("88");
    fireEvent.click(saveButton());

    await waitFor(() => expect(server.posts()).toHaveLength(1));
    expect(screen.queryByText(/checked the chart/i)).toBeNull();
  });
});

/* ── 4. legitimate repeat observations ─────────────────────────────────────── */

describe("4. a second observation is not a duplicate", () => {
  /**
   * Two readings a minute apart on the same patient are medicine, not a mistake. The key must be
   * renewed after a save lands, or the second genuine observation would be replayed away as a
   * repeat of the first.
   */
  it("charts a genuine second reading under a NEW key", async () => {
    const server = makeServer({
      onRecord: (_s, attempt) => ok(reading({ id: `v-${String(attempt)}` })),
    });
    mount(server);

    enterPulse("88");
    fireEvent.click(saveButton());
    await waitFor(() => expect(server.posts()).toHaveLength(1));

    enterPulse("94");
    fireEvent.click(saveButton());
    await waitFor(() => expect(server.posts()).toHaveLength(2));

    const [first, second] = server.posts();
    expect(first?.headers["idempotency-key"]).not.toBe(second?.headers["idempotency-key"]);
    expect(second?.body).toMatchObject({ pulse: 94 });
  });
});

/* ── 5. guards ─────────────────────────────────────────────────────────────── */

describe("5. the form decides nothing clinical", () => {
  const read = async (relative: string): Promise<string> => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    return (await readFile(join(process.cwd(), relative), "utf8"))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  };

  it("never re-derives an assessment or a reference range", async () => {
    const source = await read("components/Vitals.tsx");
    expect(source).not.toMatch(/\b(RANGES|REFERENCE|NORMAL_RANGE)\b/);
    expect(source).not.toMatch(/low:\s*\d/);
    // `abnormal` and `flags` may only be READ off the server's reading, never assigned.
    expect(source).not.toMatch(/abnormal\s*[:=]\s*(true|false)/);
  });

  it("sends no client clock", async () => {
    const source = await read("components/Vitals.tsx");
    expect(source).not.toMatch(/recordedAt:/);
    expect(source).not.toMatch(/Date\.now\(\)/);
  });

  it("does not implement its own reconciliation", async () => {
    const source = await read("components/Vitals.tsx");
    expect(source).toMatch(/attemptVitals/);
    // A second copy of the set-difference is exactly what the shared primitive exists to prevent.
    expect(source).not.toMatch(/newReadingsSince|matchingReading/);
  });
});
