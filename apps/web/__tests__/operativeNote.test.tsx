/**
 * THE OPERATION RECORD, ON THE WEB.
 *
 * ── WHAT IS WORTH TESTING HERE, AND WHAT IS NOT ─────────────────────────────
 * Not the rules. Whether a note may be written at all — the status it needs, the write-once
 * guarantee, the permission — is decided by the API and proved in `theatres.int.test.ts` against a
 * real database. Asserting any of it here would be asserting a stub.
 *
 * What only a browser-side test can answer is WHICH REQUEST LEAVES THE BROWSER and what the doctor
 * is shown when there is nothing to leave with. Both have a history in this repository: a form that
 * posted the booked procedure instead of the performed one would silently file a record saying
 * something that did not happen, and a control rendered for a user who cannot use it promises a
 * write whose only possible ending is a 403.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClient, type OperativeNote, type OtBooking } from "@medicore/api-client";
import { OperativeNoteDetail, OperativeNoteModal } from "../components/OperativeNote";

interface Sent {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
}

function booking(over: Partial<OtBooking> = {}): OtBooking {
  return {
    id: "b1",
    theatreId: "t1",
    theatreName: "OT One",
    theatreCode: "OT1",
    patientId: "p1",
    patientName: "Ramesh Kumar",
    uhid: "UH000105",
    surgeonId: "d1",
    procedureName: "Appendectomy",
    scheduledStart: "2026-08-19T03:00:00.000Z",
    scheduledEnd: "2026-08-19T04:00:00.000Z",
    status: "in_progress",
    ...over,
  };
}

const RECORD: OperativeNote = {
  procedurePerformed: "Laparoscopic appendectomy",
  surgeonId: "d1",
  performedAt: "2026-08-19T03:10:00.000Z",
  findings: "Inflamed appendix, no perforation.",
  notes: "Nil by mouth 6 hours.",
  recordedBy: "d1",
  recordedAt: "2026-08-19T04:30:00.000Z",
};

const SURGEONS = [
  { id: "d1", name: "Dr Rao (General Medicine)" },
  { id: "d2", name: "Dr Khan (Surgery)" },
];

function makeServer() {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    sent.push({
      method: init?.method ?? "GET",
      url: String(url),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    });
    return new Response(
      JSON.stringify({ success: true, data: booking({ operativeNote: RECORD }) }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  return {
    posts: () => sent.filter((s) => s.method === "POST"),
    client: new ApiClient({ baseUrl: "http://api.test", fetchImpl }),
  };
}

function mount(over: Partial<Parameters<typeof OperativeNoteModal>[0]> = {}) {
  const server = makeServer();
  const onRecorded = vi.fn();
  render(
    <OperativeNoteModal
      api={server.client}
      booking={booking()}
      surgeons={SURGEONS}
      canRecord
      onClose={vi.fn()}
      onRecorded={onRecorded}
      {...over}
    />,
  );
  return { server, onRecorded };
}

afterEach(cleanup);

describe("writing the record", () => {
  /**
   * The field is PRE-FILLED with what was booked, because in most operations the two agree and
   * retyping it is how a surgeon ends up with a blank note. What must never happen is the form
   * posting the booked name when the surgeon has replaced it — so the assertion is on the edited
   * value reaching the wire, not on the default.
   */
  it("posts what was PERFORMED, to the booking's own route", async () => {
    const { server, onRecorded } = mount();

    expect((screen.getByLabelText(/Procedure performed/i) as HTMLInputElement).value).toBe(
      "Appendectomy",
    );
    fireEvent.change(screen.getByLabelText(/Procedure performed/i), {
      target: { value: "Laparoscopic appendectomy" },
    });
    fireEvent.change(screen.getByLabelText(/Findings/i), {
      target: { value: "Inflamed appendix, no perforation." },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save operation record/i }));

    await waitFor(() => expect(onRecorded).toHaveBeenCalled());
    const post = server.posts()[0];
    expect(post?.url).toBe("http://api.test/api/v1/ot-bookings/b1/operative-note");
    expect(post?.body?.procedurePerformed).toBe("Laparoscopic appendectomy");
    expect(post?.body?.findings).toBe("Inflamed appendix, no perforation.");
    // The surgeon defaults to whoever was booked — an id, never the label the dropdown shows.
    expect(post?.body?.surgeonId).toBe("d1");
  });

  /** Empty optional fields are OMITTED, not sent as "". A blank line is not a finding. */
  it("does not file empty findings as a finding", async () => {
    const { server, onRecorded } = mount();
    fireEvent.click(screen.getByRole("button", { name: /Save operation record/i }));

    await waitFor(() => expect(onRecorded).toHaveBeenCalled());
    const post = server.posts()[0];
    expect(post?.body).not.toHaveProperty("findings");
    expect(post?.body).not.toHaveProperty("notes");
  });

  it("warns that the record cannot be edited BEFORE it is written", () => {
    mount();
    expect(screen.getByText(/written once/i)).toBeTruthy();
  });
});

describe("reading it back", () => {
  it("shows the record instead of the form once one exists", () => {
    mount({ booking: booking({ status: "completed", operativeNote: RECORD }) });

    expect(screen.getByText("Laparoscopic appendectomy")).toBeTruthy();
    expect(screen.getByText("Inflamed appendix, no perforation.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Save operation record/i })).toBeNull();
  });

  /**
   * A reader without `ot:record` gets the truth — "not written yet" — and no form. Rendering a
   * disabled form would suggest the record is theirs to write once something unblocks; nothing
   * they can do from this screen ever will.
   */
  it("offers a reader without ot:record no form at all", () => {
    mount({ canRecord: false });

    expect(screen.queryByRole("button", { name: /Save operation record/i })).toBeNull();
    expect(screen.getByText(/not recorded yet/i)).toBeTruthy();
  });

  it("renders every part of the record the chart shows", () => {
    render(<OperativeNoteDetail note={RECORD} />);
    expect(screen.getByText("Laparoscopic appendectomy")).toBeTruthy();
    expect(screen.getByText("Inflamed appendix, no perforation.")).toBeTruthy();
    expect(screen.getByText("Nil by mouth 6 hours.")).toBeTruthy();
  });
});
