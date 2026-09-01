/**
 * THE PROBLEM LIST ON THE WEB.
 *
 * ── WHAT IS WORTH TESTING HERE ──────────────────────────────────────────────
 * Two things, and neither is "the markup renders".
 *
 *   1. WHICH REQUEST LEAVES THE BROWSER. Adding, promoting and resolving are three different
 *      endpoints with three different meanings, and promotion in particular carries an INDEX into
 *      the saved consultation note — an off-by-one there would put the wrong condition on a
 *      patient's standing record. So this drives the real `ApiClient` over a stub fetch and
 *      asserts the URL and the body, the standard `chartNote.test.tsx` set.
 *   2. THAT A RESOLVED PROBLEM IS NOT SHOWN AS ACTIVE. "This patient has pneumonia" and "this
 *      patient had pneumonia" are different clinical facts, and the panel's whole job is to keep
 *      them apart. Falsified by deleting the `status === "active"` filter in `ProblemList.tsx`:
 *      the resolved row appears in the active list and this suite goes red.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClient, type Diagnosis, type Problem } from "@medicore/api-client";
import { ProblemPanel } from "../components/ProblemList";

function problem(over: Partial<Problem> = {}): Problem {
  return {
    id: "prob-1",
    patientId: "p1",
    title: "Type 2 diabetes mellitus",
    code: "E11.9",
    status: "active",
    notedBy: "dr-1",
    notedAt: "2026-03-01T04:00:00.000Z",
    ...over,
  };
}

interface Sent {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
}

function makeServer(list: Problem[]) {
  const sent: Sent[] = [];

  const fetchImpl = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    sent.push({
      method,
      url: String(url),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    });
    const data = method === "GET" ? list : problem();
    return new Response(JSON.stringify({ success: true, data }), {
      status: method === "GET" ? 200 : 201,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  return {
    sent,
    writes: () => sent.filter((s) => s.method !== "GET"),
    client: new ApiClient({ baseUrl: "http://api.test", fetchImpl }),
  };
}

function mount(
  server: ReturnType<typeof makeServer>,
  options: {
    canWrite?: boolean;
    promoteFrom?: { encounterId: string; diagnoses: Diagnosis[] };
  } = {},
) {
  render(
    <ProblemPanel
      api={server.client}
      patientId="p1"
      canWrite={options.canWrite ?? true}
      {...(options.promoteFrom ? { promoteFrom: options.promoteFrom } : {})}
    />,
  );
}

afterEach(cleanup);

/* ── 1. what the clinician sees ────────────────────────────────────────────── */

describe("1. the active list", () => {
  it("shows an active problem with its code", async () => {
    mount(makeServer([problem()]));
    expect(await screen.findByText("Type 2 diabetes mellitus")).toBeTruthy();
    expect(screen.getByText("E11.9")).toBeTruthy();
  });

  it("says so plainly when there are none", async () => {
    mount(makeServer([]));
    expect(await screen.findByText(/No active problems recorded/i)).toBeTruthy();
  });

  /**
   * THE ONE THAT MATTERS. A resolved problem shown among the active ones tells a clinician the
   * patient still has a condition they recovered from — and the list is read precisely to decide
   * what to do next.
   */
  it("keeps a RESOLVED problem out of the active list", async () => {
    mount(
      makeServer([
        problem({ id: "a", title: "Essential hypertension", code: "I10" }),
        problem({
          id: "b",
          title: "Pneumonia",
          code: "J18.9",
          status: "resolved",
          resolvedAt: "2026-05-01T04:00:00.000Z",
        }),
      ]),
    );

    expect(await screen.findByText("Essential hypertension")).toBeTruthy();
    expect(
      screen.queryByText("Pneumonia"),
      "a resolved problem was rendered in the active list — has the status filter gone?",
    ).toBeNull();

    // It is not lost, only folded away: the disclosure names it and reveals it.
    fireEvent.click(screen.getByText(/Show 1 resolved/i));
    expect(await screen.findByText("Pneumonia")).toBeTruthy();
  });

  it("offers no controls at all to a reader without emr:write", async () => {
    mount(makeServer([problem()]), { canWrite: false });
    await screen.findByText("Type 2 diabetes mellitus");
    // Not a disabled button — nothing. There is no action a reader could complete.
    expect(screen.queryByText("+ Add problem")).toBeNull();
    expect(screen.queryByText("Resolve")).toBeNull();
  });
});

/* ── 2. the requests that leave the browser ────────────────────────────────── */

describe("2. adding a problem directly", () => {
  it("posts the title, the code and the onset date to the patient's list", async () => {
    const server = makeServer([]);
    mount(server);
    await screen.findByText(/No active problems recorded/i);

    fireEvent.click(screen.getByText("+ Add problem"));
    fireEvent.change(screen.getByLabelText("Problem"), {
      target: { value: "  Essential hypertension  " },
    });
    fireEvent.change(screen.getByLabelText("ICD code"), { target: { value: "i10" } });
    fireEvent.change(screen.getByLabelText("Onset date"), { target: { value: "2024-06-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(server.writes()).toHaveLength(1));
    const post = server.writes()[0];
    expect(post?.method).toBe("POST");
    expect(post?.url).toBe("http://api.test/api/v1/patients/p1/problems");
    expect(post?.body).toEqual({
      title: "Essential hypertension",
      // Upper-cased in the field, so what reaches the ICD master is what the master stores.
      code: "I10",
      onsetDate: "2024-06-01",
    });
  });

  it("sends no code and no onset when the clinician gave neither", async () => {
    const server = makeServer([]);
    mount(server);
    await screen.findByText(/No active problems recorded/i);

    fireEvent.click(screen.getByText("+ Add problem"));
    fireEvent.change(screen.getByLabelText("Problem"), {
      target: { value: "Chronic low back pain" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(server.writes()).toHaveLength(1));
    expect(server.writes()[0]?.body).toEqual({ title: "Chronic low back pain" });
  });

  it("writes nothing when the condition box is empty", async () => {
    const server = makeServer([]);
    mount(server);
    await screen.findByText(/No active problems recorded/i);

    fireEvent.click(screen.getByText("+ Add problem"));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(server.writes()).toHaveLength(0);
  });
});

describe("3. promoting a consultation diagnosis", () => {
  const diagnoses: Diagnosis[] = [
    { text: "Viral fever", type: "provisional" },
    { text: "Dengue fever", code: "A90", type: "final" },
  ];

  it("promotes by the diagnosis's INDEX in the saved note", async () => {
    const server = makeServer([]);
    mount(server, { promoteFrom: { encounterId: "enc-7", diagnoses } });
    await screen.findByText("Dengue fever");

    // The SECOND diagnosis. An off-by-one here puts the wrong condition on a standing record.
    fireEvent.click(screen.getAllByText("Add to problem list")[1] as HTMLElement);

    await waitFor(() => expect(server.writes()).toHaveLength(1));
    const post = server.writes()[0];
    expect(post?.url).toBe("http://api.test/api/v1/encounters/enc-7/problems/promote");
    expect(post?.body).toEqual({ diagnosisIndex: 1 });
  });

  it("offers nothing to promote when the note has no diagnoses saved yet", async () => {
    const server = makeServer([]);
    mount(server, { promoteFrom: { encounterId: "enc-7", diagnoses: [] } });
    await screen.findByText(/No active problems recorded/i);
    expect(screen.queryByText("Add to problem list")).toBeNull();
  });

  it("does not offer promotion on a chart with no visit in context", async () => {
    const server = makeServer([]);
    mount(server);
    await screen.findByText(/No active problems recorded/i);
    expect(screen.queryByText(/From this visit/i)).toBeNull();
  });
});

describe("4. resolving a problem", () => {
  it("posts to the resolve endpoint and reloads the list", async () => {
    const server = makeServer([problem({ id: "prob-9" })]);
    mount(server);
    await screen.findByText("Type 2 diabetes mellitus");

    fireEvent.click(screen.getByText("Resolve"));

    await waitFor(() => expect(server.writes()).toHaveLength(1));
    expect(server.writes()[0]?.url).toBe("http://api.test/api/v1/problems/prob-9/resolve");
    // There is no delete path anywhere in this component — resolving is the only way off the list.
    expect(server.sent.some((s) => s.method === "DELETE")).toBe(false);
    // And the panel re-reads rather than guessing what the server now holds.
    await waitFor(() => expect(server.sent.filter((s) => s.method === "GET")).toHaveLength(2));
  });
});
