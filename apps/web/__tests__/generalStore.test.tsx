/**
 * THE GENERAL STORE, IN THE BROWSER.
 *
 * ── WHAT IS WORTH TESTING HERE, AND WHAT IS NOT ─────────────────────────────
 * Not the arithmetic. `onHand`, `position` and the worst-first order are all the SERVER's, proved
 * against a real database in `inventory.int.test.ts`. A second calculation in the browser would be
 * a second answer to "how many are there", and the day the two disagreed the screen would be
 * confidently wrong. So this asserts the opposite of a calculation: that the page RENDERS WHAT IT
 * IS GIVEN, in the order it is given.
 *
 * What only a browser-side test can answer is the three things that are genuinely the client's:
 *
 *   1. A write that stamps a site is not OFFERED under "All branches" (D19). The server refuses it
 *      either way; the point is that nobody fills in a form to find that out.
 *   2. A hospital without the module gets a refusal instead of an empty store room (D20).
 *   3. Each of the four permissions actually gates the control it belongs to — this module split
 *      them deliberately, and a screen that shows every button to everybody would make the split
 *      decorative.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiClient, type StoreRow } from "@medicore/api-client";

const PERMISSIONS = new Set([
  "inventory:manage",
  "inventory:purchase",
  "inventory:issue",
  "inventory:audit",
  "vendor:manage",
]);

const AUTH = {
  user: { id: "keeper-1", name: "Mr Bose" },
  api: null as unknown as ApiClient,
  can: (p: string) => PERMISSIONS.has(p),
};

/**
 * The branch context, with the REAL predicate rather than a hand-set boolean (D19). Setting the
 * flag directly would make these tests pass against a guard that had been deleted from the
 * provider.
 */
const BRANCH: {
  branches: { id: string; name: string }[];
  active: { id: string; name: string } | null;
  timezone: string;
  mustChooseBranch: boolean;
  select: (id: string | null) => void;
} = {
  branches: [],
  active: null,
  timezone: "Asia/Kolkata",
  get mustChooseBranch() {
    return mustChooseBranchToWrite({ branches: this.branches, active: this.active });
  },
  select: (id) => {
    BRANCH.active = BRANCH.branches.find((b) => b.id === id) ?? null;
  },
};

vi.mock("../components/AuthProvider", () => ({ useAuth: () => AUTH }));
vi.mock("../components/BranchProvider", () => ({ useBranch: () => BRANCH }));

const { mustChooseBranchToWrite } = await import("../lib/branchScope");
const { default: StorePage } = await import("../app/inventory/page");

interface Sent {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
  /** Captured because the idempotency claim below is about a HEADER, not a body field. */
  headers: Record<string, string>;
}

function item(over: Partial<StoreRow> = {}): StoreRow {
  return {
    id: "i1",
    code: "GLOVE-M",
    name: "Examination gloves, medium",
    category: "consumable",
    unit: "box",
    reorderLevel: 20,
    active: true,
    onHand: 48,
    position: "ok",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

let sent: Sent[] = [];

/** `itemsStatus` lets a test answer the store list with a refusal while the pickers still work. */
function serve(rows: StoreRow[], itemsStatus = 200) {
  sent = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const href = String(url);
    sent.push({
      method,
      url: href,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
    });

    if (method === "GET" && href.includes("/inventory-items") && itemsStatus !== 200) {
      return new Response(
        JSON.stringify({
          success: false,
          error: { code: "HMS-PLAN-002", message: "Feature not in your edition" },
        }),
        { status: itemsStatus, headers: { "content-type": "application/json" } },
      );
    }

    const data =
      method !== "GET"
        ? { item: rows[0], onHand: 0, movement: { id: "m1" } }
        : href.includes("/suppliers")
          ? [{ id: "s1", code: "ACME", name: "Acme Surgical", active: true }]
          : href.includes("/inventory-destinations")
            ? [{ id: "d1", name: "General Ward" }]
            : rows;

    return new Response(JSON.stringify({ success: true, data }), {
      status: method === "GET" ? 200 : 201,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  AUTH.api = new ApiClient({ baseUrl: "http://api.test", fetchImpl });
}

beforeEach(() => {
  PERMISSIONS.clear();
  for (const p of [
    "inventory:manage",
    "inventory:purchase",
    "inventory:issue",
    "inventory:audit",
    "vendor:manage",
  ]) {
    PERMISSIONS.add(p);
  }
  // A single-site hospital by default: nothing to choose, so no guard applies.
  BRANCH.branches = [{ id: "b1", name: "Main Branch" }];
  BRANCH.active = BRANCH.branches[0] ?? null;
});
afterEach(cleanup);

describe("the store list shows the server's answer", () => {
  it("renders on hand, the unit and the position it was given — it does not recompute them", async () => {
    /**
     * Deliberately CONTRADICTORY: 48 on hand against a reorder level of 20 would be `ok` by any
     * rule the browser could apply, and the server says `low`. A page that derived the badge for
     * itself would disagree with the API, and the whole point of `position` is that one answer
     * exists. Rendering the server's "Running low" here is the assertion.
     */
    serve([item({ onHand: 48, reorderLevel: 20, position: "low" })]);
    render(<StorePage />);

    await waitFor(() => expect(screen.getByText("Examination gloves, medium")).toBeTruthy());
    expect(screen.getByText("48 box")).toBeTruthy();
    expect(screen.getByText("Running low")).toBeTruthy();
  });

  it("keeps the rows in the order it was given", async () => {
    serve([
      item({ id: "i1", name: "Zinc oxide tape", position: "out", onHand: 0 }),
      item({ id: "i2", name: "Alcohol swabs", position: "low", onHand: 4 }),
      item({ id: "i3", name: "Bed sheets", position: "ok", onHand: 90 }),
    ]);
    render(<StorePage />);

    await waitFor(() => expect(screen.getByText("Bed sheets")).toBeTruthy());
    const order = screen
      .getAllByRole("row")
      .map((r) => r.textContent ?? "")
      .filter((t) => /Zinc oxide tape|Alcohol swabs|Bed sheets/.test(t));
    expect(order[0]).toContain("Zinc oxide tape");
    expect(order[1]).toContain("Alcohol swabs");
    expect(order[2]).toContain("Bed sheets");
  });

  it("counts what needs attention from the rows, not from a second request", async () => {
    serve([
      item({ id: "i1", position: "out", onHand: 0 }),
      item({ id: "i2", position: "low", onHand: 4 }),
      item({ id: "i3", position: "ok", onHand: 90 }),
    ]);
    render(<StorePage />);

    await waitFor(() => expect(screen.getByText("out of stock")).toBeTruthy());
    expect(screen.getByText("running low")).toBeTruthy();
    expect(
      sent.filter((s) => s.url.includes("/inventory-items") && s.method === "GET"),
    ).toHaveLength(1);
  });
});

describe("a write that stamps a site is not offered until a site is chosen (D19)", () => {
  beforeEach(() => {
    // Two sites, none selected — the exact situation `writeBranchId()` refuses.
    BRANCH.branches = [
      { id: "b1", name: "Main Branch" },
      { id: "b2", name: "Riverside" },
    ];
    BRANCH.active = null;
  });

  it("disables Receive, Issue and Adjust, and says why", async () => {
    serve([item()]);
    render(<StorePage />);

    await waitFor(() => expect(screen.getByText("Examination gloves, medium")).toBeTruthy());

    for (const label of ["Receive", "Issue", "Adjust"]) {
      expect(
        (screen.getByRole("button", { name: label }) as HTMLButtonElement).disabled,
        `${label} was offered under "All branches"`,
      ).toBe(true);
    }
    expect(
      screen.getByText(/Choose a site before you receive, issue or correct stock/),
    ).toBeTruthy();
  });

  /**
   * History is a READ. It must stay reachable — the branch guard is about writes that have to
   * belong to a site, and disabling everything would be the D19 fix overshooting into a worse
   * screen than the defect.
   */
  it("leaves History alone, because reading is not a branch-stamping write", async () => {
    serve([item()]);
    render(<StorePage />);

    await waitFor(() => expect(screen.getByText("Examination gloves, medium")).toBeTruthy());
    expect((screen.getByRole("button", { name: "History" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("enables them again once a site is picked", async () => {
    serve([item()]);
    BRANCH.active = BRANCH.branches[0] ?? null;
    render(<StorePage />);

    await waitFor(() => expect(screen.getByText("Examination gloves, medium")).toBeTruthy());
    expect((screen.getByRole("button", { name: "Receive" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(screen.queryByText(/Choose a site before you/)).toBeNull();
  });
});

describe("a hospital that never bought the store (D20)", () => {
  it("says the module is not in the edition instead of drawing an empty store room", async () => {
    serve([], 403);
    render(<StorePage />);

    await waitFor(() =>
      expect(screen.getByText(/is not part of your hospital.s edition/i)).toBeTruthy(),
    );
    // The remedy is named, because the defect was people hunting for it in the role editor.
    expect(screen.getByText(/not a permissions problem/i)).toBeTruthy();
    // The empty-store message would be a lie: there is no store, not an empty one.
    expect(screen.queryByText("No items in the store list yet.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add item" })).toBeNull();
  });
});

describe("the four permissions gate the four controls", () => {
  it.each([
    ["inventory:purchase", "Receive"],
    ["inventory:issue", "Issue"],
    ["inventory:audit", "Adjust"],
  ])("without %s there is no %s control", async (permission, label) => {
    PERMISSIONS.delete(permission);
    serve([item()]);
    render(<StorePage />);

    await waitFor(() => expect(screen.getByText("Examination gloves, medium")).toBeTruthy());
    expect(screen.queryByRole("button", { name: label })).toBeNull();
    // …and the others are untouched, so this is a gate rather than a blanket.
    expect(screen.getByRole("button", { name: "History" })).toBeTruthy();
  });

  it("without vendor:manage there is no Suppliers panel", async () => {
    PERMISSIONS.delete("vendor:manage");
    serve([item()]);
    render(<StorePage />);

    await waitFor(() => expect(screen.getByText("Examination gloves, medium")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Suppliers" })).toBeNull();
  });
});

describe("what leaves the browser", () => {
  it("sends an idempotency key with an issue, so a double tap cannot double-issue", async () => {
    serve([item()]);
    render(<StorePage />);

    await waitFor(() => expect(screen.getByText("Examination gloves, medium")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Issue" }));

    // Scoped to the dialog: the row's "Issue" button has the same accessible name as the form's
    // submit, and `getByRole` over the whole document would be ambiguous — which is the failure
    // mode this locator exists to avoid rather than paper over with `.first()`.
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Quantity (box)"), { target: { value: "5" } });
    fireEvent.change(within(dialog).getByLabelText("To department"), { target: { value: "d1" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Issue" }));

    await waitFor(() => expect(sent.some((s) => s.method === "POST")).toBe(true));
    const post = sent.find((s) => s.method === "POST");
    expect(post?.url).toContain("/inventory-items/i1/issue");
    expect(post?.body).toEqual({ quantity: 5, departmentId: "d1" });
    /**
     * The route carries `idempotent()`, and middleware that is never given a key does nothing at
     * all — which is exactly how two clinical routes shipped their replay protection switched off
     * (`checkClientContract.ts` §6). Asserting the header is the only way to know it is armed.
     */
    expect(post?.headers["idempotency-key"]).toMatch(/[0-9a-f-]{36}/i);
  });
});
