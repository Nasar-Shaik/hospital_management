/**
 * THE STAFF COUNT MUST SAY WHAT IT COUNTED.
 *
 * The directory is filtered by three things at once — the search box, the status chips, and the
 * branch in the header. Before the branch scope existed the number would have been a harmless
 * convenience; now it is the only thing on the screen that explains why the list is shorter here
 * than it was a moment ago at the other site.
 *
 * So two properties are pinned, and the second is the one that would rot quietly:
 *
 *   1. The number is the SERVER's total, not the length of the page it happened to send. Those
 *      agree today only because the fetch asks for a hundred and the seed has twelve.
 *   2. It NAMES the scope. A count that silently ignored the branch — or claimed a branch when the
 *      switcher was in All-branches mode — would be worse than no count at all, because it reads
 *      as a complete answer to a question it did not ask.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ApiClient } from "@medicore/api-client";

const PERMISSIONS = new Set(["user:read", "user:create", "user:update", "user:deactivate"]);
const AUTH = {
  user: { id: "admin-1", name: "Hospital Administrator" },
  api: null as unknown as ApiClient,
  can: (p: string) => PERMISSIONS.has(p),
};
/** Swapped per test — the header's active site is the thing under test. */
const BRANCH: { active: { id: string; name: string } | null } = { active: null };

vi.mock("../components/AuthProvider", () => ({ useAuth: () => AUTH }));
vi.mock("../components/BranchProvider", () => ({ useBranch: () => BRANCH }));

const { default: StaffPage } = await import("../app/staff/page");

const ok = (data: unknown, meta?: unknown) =>
  new Response(JSON.stringify({ success: true, data, ...(meta ? { meta } : {}) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/**
 * The count row's own text, whitespace-normalised.
 *
 * Read as one string rather than by `findByText`, because the row is deliberately several
 * elements — the number is emphasised inside the sentence — and a matcher that needed it to be a
 * single text node would be testing the markup rather than what a reader sees.
 */
async function countRow(): Promise<string> {
  const row = await screen.findByText(/branches$|Annexe$|Branch$/);
  return (row.textContent ?? "").replace(/\s+/g, " ").trim();
}

function staffRow(email: string, branchIds: string[] = []) {
  return {
    id: email,
    email,
    name: email,
    status: "active",
    roles: ["NURSE"],
    branchIds,
    mfaEnabled: false,
    mustChangePassword: false,
  };
}

/** `total` is deliberately NOT the number of rows sent, so a count reading `items.length` fails. */
function stubApi(rows: ReturnType<typeof staffRow>[], total: number) {
  const fetchImpl = vi.fn((input: RequestInfo | URL) => {
    const href = String(input);
    if (href.includes("/api/v1/users")) {
      return Promise.resolve(ok(rows, { page: 1, limit: 100, total }));
    }
    if (href.includes("/api/v1/roles")) return Promise.resolve(ok([]));
    if (href.includes("branches")) {
      return Promise.resolve(
        ok([
          { id: "b-main", name: "Main Branch", code: "MAIN", status: "active" },
          { id: "b-annexe", name: "Riverside Annexe", code: "RIV", status: "active" },
        ]),
      );
    }
    return Promise.resolve(ok([]));
  }) as unknown as typeof fetch;

  AUTH.api = new ApiClient({ baseUrl: "http://api.test", fetchImpl });
}

beforeEach(() => {
  BRANCH.active = null;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the staff directory says how many it found, and where", () => {
  it("names the site when the header is pointing at one", async () => {
    BRANCH.active = { id: "b-annexe", name: "Riverside Annexe" };
    stubApi([staffRow("a@x.test"), staffRow("b@x.test")], 2);

    render(<StaffPage />);

    expect(await countRow()).toMatch(/\b2\b/);
    expect(await countRow()).toMatch(/at Riverside Annexe/);
  });

  it("says so plainly when no single site is selected", async () => {
    BRANCH.active = null;
    stubApi([staffRow("a@x.test")], 1);

    render(<StaffPage />);

    // Singular, because "1 people at …" is the tell of a count nobody read back.
    expect(await countRow()).toMatch(/\b1 person\b/);
    expect(await countRow()).toMatch(/across all branches/);
  });

  it("reports the server's total, not the rows it happened to receive", async () => {
    BRANCH.active = { id: "b-main", name: "Main Branch" };
    // A hospital past the fetch ceiling: 100 rows sent, 137 counted.
    stubApi(
      Array.from({ length: 100 }, (_, i) => staffRow(`p${String(i)}@x.test`)),
      137,
    );

    render(<StaffPage />);

    // Both numbers, because "100 staff" and "100 of 137 staff" are different facts.
    expect(await countRow()).toMatch(/Showing\s*100\s*of\s*137/);
  });
});
