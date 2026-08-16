/**
 * F-2 — THE NURSE'S NOTE ON THE WEB.
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
 * The ward screen's note box was wrapped in `<PermissionGate permission="emr:write">` and called
 * `api.addWardNote`. `emr:write` is the DOCTOR's permission and NURSE deliberately does not hold
 * it — granting it would also open `discharge_summary` and `outcome_note`, a doctor's record and
 * the statutory account of a death. So a nurse with the ward screen open saw NO note box at all,
 * while `nursing:manage`, which they do hold, gated a route (`POST …/nursing-notes`, shipped in
 * M3-S2) that no browser had ever called. The nurse's own record of the shift existed on the
 * server and had no door in the building.
 *
 * ── WHAT IS WORTH TESTING, AND WHAT IS NOT ──────────────────────────────────
 * Not "the button appears". The question is WHICH REQUEST LEAVES THE BROWSER, so this runs the
 * real `ApiClient` over a stub fetch and asserts the URL, the body and the headers — the same
 * standard `vitalsWrite.test.tsx` set. The permission→capability rule itself lives in
 * `@medicore/api-client` because mobile had the identical bug; it is asserted here as the web app
 * consumes it, and again in mobile's own suite.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  ApiClient,
  NURSING_NOTE,
  PROGRESS_NOTE,
  chartNoteCapability,
  type ChartNoteCapability,
  type WardNote,
} from "@medicore/api-client";
import { AddChartNote } from "../components/ChartNote";

/** As the shipped catalogue grants them. NURSE has no `emr:write`; DOCTOR has no `nursing:manage`. */
const NURSE = ["patient:read", "emr:read", "nursing:manage", "vitals:record", "mar:administer"];
const DOCTOR = ["patient:read", "emr:read", "emr:write", "order:create"];
const RECEPTIONIST = ["patient:read", "patient:register", "encounter:read", "appointment:manage"];

const held = (permissions: string[]) => (permission: string) => permissions.includes(permission);

function note(over: Partial<WardNote> = {}): WardNote {
  return {
    id: "note-1",
    encounterId: "e1",
    patientId: "p1",
    episodeId: "ep1",
    type: "nursing",
    text: "Settled, obs stable.",
    authorId: "nurse-1",
    at: "2026-08-16T05:00:00.000Z",
    ...over,
  };
}

interface Sent {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

function makeServer(options: { onPost?: (sent: Sent, attempt: number) => Response } = {}) {
  const sent: Sent[] = [];
  let attempts = 0;

  const fetchImpl = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const record: Sent = {
      method: init?.method ?? "GET",
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    };
    sent.push(record);
    attempts += 1;
    if (options.onPost) return options.onPost(record, attempts);
    return new Response(JSON.stringify({ success: true, data: note() }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  return {
    sent,
    posts: () => sent.filter((s) => s.method === "POST"),
    client: new ApiClient({ baseUrl: "http://api.test", fetchImpl }),
  };
}

function mount(
  server: ReturnType<typeof makeServer>,
  capability: ChartNoteCapability,
  onAdded = vi.fn(),
) {
  render(
    <AddChartNote api={server.client} capability={capability} encounterId="e1" onAdded={onAdded} />,
  );
  return onAdded;
}

const box = (capability: ChartNoteCapability) =>
  screen.getByRole("textbox", { name: capability.label });
const saveButton = () => screen.getByRole("button", { name: /^Add /i });

function write(capability: ChartNoteCapability, text: string) {
  fireEvent.change(box(capability), { target: { value: text } });
  fireEvent.click(saveButton());
}

afterEach(cleanup);

/* ── 1. who may write what ─────────────────────────────────────────────────── */

describe("1. the note this user may write", () => {
  it("gives a nurse the nursing note and a doctor the progress note", () => {
    expect(chartNoteCapability(held(NURSE))).toEqual(NURSING_NOTE);
    expect(chartNoteCapability(held(DOCTOR))).toEqual(PROGRESS_NOTE);
  });

  /**
   * `undefined`, so the ward screen renders no box at all — not a disabled one. There is nothing
   * a receptionist could do from that screen to enable it, and offering the field would promise a
   * write whose only possible ending is a 403.
   */
  it("gives a receptionist nothing", () => {
    expect(chartNoteCapability(held(RECEPTIONIST))).toBeUndefined();
  });

  /**
   * The order rule, pinned. In the shipped catalogue the two permissions are disjoint, so this
   * only bites on a custom role holding both — and there the answer must be the DOCTOR's note,
   * because that is what such a user got before F-2 and a silent demotion to a nursing entry
   * would change what lands on a medico-legal record without anybody asking for it.
   */
  it("prefers the doctor's note when a custom role somehow holds both", () => {
    expect(chartNoteCapability(held([...NURSE, "emr:write"]))).toEqual(PROGRESS_NOTE);
  });
});

/* ── 2. the request that leaves the browser ────────────────────────────────── */

describe("2. the nurse's note goes through the nursing route", () => {
  it("POSTs to /nursing-notes, never to /notes", async () => {
    const server = makeServer();
    mount(server, NURSING_NOTE);

    write(NURSING_NOTE, "Settled, obs stable, family updated.");

    await waitFor(() => expect(server.posts()).toHaveLength(1));
    expect(server.posts()[0]?.url).toBe("http://api.test/api/v1/encounters/e1/nursing-notes");
  });

  /**
   * The body carries text and NOTHING else. The nursing DTO is `.strict()` with no `type` field,
   * so a client that helpfully named the type would get a 400 — which is the structure that makes
   * the route un-repurposable, and is worth proving the client respects rather than trips over.
   */
  it("sends only the text — the type and the timestamp are the server's", async () => {
    const server = makeServer();
    mount(server, NURSING_NOTE);

    write(NURSING_NOTE, "  Pressure areas checked, no redness.  ");

    await waitFor(() => expect(server.posts()).toHaveLength(1));
    expect(server.posts()[0]?.body).toEqual({ text: "Pressure areas checked, no redness." });
  });

  it("still sends a doctor to the generic EMR route, unchanged", async () => {
    const server = makeServer();
    mount(server, PROGRESS_NOTE);

    write(PROGRESS_NOTE, "Chest clear. Continue same.");

    await waitFor(() => expect(server.posts()).toHaveLength(1));
    expect(server.posts()[0]?.url).toBe("http://api.test/api/v1/encounters/e1/notes");
  });
});

/* ── 3. a note is permanent, so the retry must be safe ─────────────────────── */

describe("3. the idempotency key this form never used to send", () => {
  it("carries one", async () => {
    const server = makeServer();
    mount(server, NURSING_NOTE);

    write(NURSING_NOTE, "Handover written.");

    await waitFor(() => expect(server.posts()).toHaveLength(1));
    const key = server.posts()[0]?.headers["idempotency-key"];
    expect(key).toBeTruthy();
    expect(String(key).length).toBeGreaterThanOrEqual(8);
  });

  /**
   * ── THE CASE THE KEY EXISTS FOR ─────────────────────────────────────────────
   * The reply is lost on ward wifi. The nurse presses save again with the SAME words. Both
   * requests must carry the same key, so the server replays its original 201 and the chart does
   * not end up with two identical contemporaneous entries — permanently, since a note has no
   * update path and no delete path.
   */
  it("reuses the SAME key when the same words are submitted again after a failure", async () => {
    const server = makeServer({
      onPost: (_sent, attempt) =>
        attempt === 1
          ? new Response(JSON.stringify({ success: false, error: { code: "HMS-GEN-500" } }), {
              status: 500,
              headers: { "content-type": "application/json" },
            })
          : new Response(JSON.stringify({ success: true, data: note() }), {
              status: 201,
              headers: { "content-type": "application/json" },
            }),
    });
    mount(server, NURSING_NOTE);

    write(NURSING_NOTE, "Analgesia given, pain now 3/10.");
    await waitFor(() => expect(server.posts()).toHaveLength(1));

    fireEvent.click(saveButton());
    await waitFor(() => expect(server.posts()).toHaveLength(2));

    const [first, second] = server.posts();
    // Asserted present BEFORE asserted equal: with no key at all, `undefined === undefined` and
    // the interesting half of this test would pass on a form that had regressed to sending none.
    expect(first?.headers["idempotency-key"]).toBeTruthy();
    expect(first?.headers["idempotency-key"]).toBe(second?.headers["idempotency-key"]);
  });

  /**
   * ── AND THE CASE A NAIVE KEY WOULD BREAK ────────────────────────────────────
   * The server refuses a spent key carrying a DIFFERENT body (`HMS-REQ-002`). A nurse who mistypes,
   * fails, corrects the wording and saves again is making a genuinely different request — so it
   * needs a new key, or they are locked out of the chart entirely.
   */
  it("mints a NEW key once the words change after a failure", async () => {
    const server = makeServer({
      onPost: (_sent, attempt) =>
        attempt === 1
          ? new Response(JSON.stringify({ success: false, error: { code: "HMS-GEN-500" } }), {
              status: 500,
              headers: { "content-type": "application/json" },
            })
          : new Response(JSON.stringify({ success: true, data: note() }), {
              status: 201,
              headers: { "content-type": "application/json" },
            }),
    });
    mount(server, NURSING_NOTE);

    write(NURSING_NOTE, "Analgesia given.");
    await waitFor(() => expect(server.posts()).toHaveLength(1));

    write(NURSING_NOTE, "Analgesia given, pain now 3/10.");
    await waitFor(() => expect(server.posts()).toHaveLength(2));

    const [first, second] = server.posts();
    expect(first?.headers["idempotency-key"]).not.toBe(second?.headers["idempotency-key"]);
  });

  /** A landed note is a finished intent: the NEXT note must not replay this one. */
  it("mints a new key after a note lands", async () => {
    const server = makeServer();
    const onAdded = mount(server, NURSING_NOTE);

    write(NURSING_NOTE, "First entry.");
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));

    write(NURSING_NOTE, "Second entry, an hour later.");
    await waitFor(() => expect(server.posts()).toHaveLength(2));

    const [first, second] = server.posts();
    expect(first?.headers["idempotency-key"]).not.toBe(second?.headers["idempotency-key"]);
  });
});

/* ── 4. what the nurse is told ─────────────────────────────────────────────── */

describe("4. the words on screen", () => {
  it("names the nurse's entry as a nursing note, not a progress note", () => {
    const server = makeServer();
    mount(server, NURSING_NOTE);

    expect(box(NURSING_NOTE)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add nursing note" })).toBeTruthy();
  });

  it("says a note cannot be taken back, before it is written", () => {
    const server = makeServer();
    mount(server, NURSING_NOTE);

    expect(screen.getByText(/cannot be edited or deleted once saved/i)).toBeTruthy();
  });

  it("refuses to submit an empty note rather than sending whitespace", () => {
    const server = makeServer();
    mount(server, NURSING_NOTE);

    fireEvent.change(box(NURSING_NOTE), { target: { value: "   " } });
    expect(saveButton().hasAttribute("disabled")).toBe(true);
    expect(server.posts()).toHaveLength(0);
  });

  /**
   * A refusal must never read as a save. The words stay in the box — the nurse has to be able to
   * try again, or copy them somewhere, without retyping a clinical observation from memory.
   */
  it("reports a refusal and keeps the words", async () => {
    const server = makeServer({
      onPost: () =>
        new Response(
          JSON.stringify({
            success: false,
            error: { code: "HMS-AUTH-005", message: "Insufficient permission" },
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
    });
    const onAdded = mount(server, NURSING_NOTE);

    write(NURSING_NOTE, "Settled, obs stable.");

    await waitFor(() => expect(screen.getByText(/Insufficient permission/i)).toBeTruthy());
    expect(onAdded).not.toHaveBeenCalled();
    expect((box(NURSING_NOTE) as HTMLTextAreaElement).value).toBe("Settled, obs stable.");
  });

  /**
   * `HMS-REQ-002` means it already went through under this key. "Duplicate request (idempotency)"
   * names the mechanism; a nurse needs to be told not to write it again.
   */
  it("turns an idempotency conflict into an instruction, not a code", async () => {
    const server = makeServer({
      onPost: () =>
        new Response(
          JSON.stringify({
            success: false,
            error: { code: "HMS-REQ-002", message: "Duplicate request (idempotency)" },
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
    });
    mount(server, NURSING_NOTE);

    write(NURSING_NOTE, "Settled, obs stable.");

    await waitFor(() => expect(screen.getByText(/already submitted/i)).toBeTruthy());
    expect(screen.getByText(/do not enter it again/i)).toBeTruthy();
  });

  it("clears the box only once the note is on the chart", async () => {
    const server = makeServer();
    const onAdded = mount(server, NURSING_NOTE);

    write(NURSING_NOTE, "Settled, obs stable.");

    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    expect((box(NURSING_NOTE) as HTMLTextAreaElement).value).toBe("");
  });
});
