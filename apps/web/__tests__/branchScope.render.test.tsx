/**
 * W-1 — SWITCHING BRANCH MUST NOT LEAVE THE PREVIOUS BRANCH'S DATA ON SCREEN.
 *
 * ── WHY THIS FILE RENDERS, WHEN ALMOST NOTHING ELSE HERE DOES ───────────────
 * The defect is not a wrong value; it is a component that should have gone away and did not. The
 * only honest evidence for that is mounting one, switching, and looking. A test that asserted
 * "`AppFrame` passes a key" would restate the implementation and prove nothing about what a nurse
 * sees — and it would still pass on the day someone keys it on something that never changes.
 *
 * So these tests do what the bug report does: put Hyderabad's rows on screen, switch to Chennai,
 * and check that Hyderabad's rows are gone.
 *
 * ── THE STAND-IN PAGE IS THE REAL SHAPE ────────────────────────────────────
 * `BranchPage` below is not a simplification of how this app loads data — it IS the shape, copied
 * from `apps/web/app/patients/page.tsx`: a client component with `loading` initialised true, a
 * `useCallback` load whose dependencies deliberately do NOT mention the branch (because no page's
 * do — that is the entire defect), and a `useEffect` that runs it. If the fix works for this, it
 * works for the 44 real ones, because they differ only in what they render.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor, act } from "@testing-library/react";
import { useCallback, useEffect, useState } from "react";
import { BranchScope } from "../components/BranchScope";
import { branchScopeId } from "../lib/branchScope";

afterEach(cleanup);

/** Records every fetch so "did it reload?" and "how many times?" are both answerable. */
function makeApi() {
  const calls: string[] = [];
  let resolveNext: ((rows: string[]) => void) | null = null;

  return {
    calls,
    /** Resolves immediately with rows named for the branch that asked. */
    load: (branch: string): Promise<string[]> => {
      calls.push(branch);
      return Promise.resolve([`${branch} patient`]);
    },
    /** A load that hangs until the test releases it — for the in-flight case. */
    loadDeferred: (branch: string): Promise<string[]> => {
      calls.push(branch);
      return new Promise<string[]>((resolve) => {
        resolveNext = resolve;
      });
    },
    release: (rows: string[]) => {
      resolveNext?.(rows);
      resolveNext = null;
    },
  };
}

/**
 * A page exactly as this app writes them: branch-scoped data, and an effect that has no idea the
 * branch exists. `branch` is read from a ref-like closure rather than a prop, mirroring how the
 * real API client reads `getActiveBranchId()` per request rather than receiving it.
 */
function BranchPage({
  read,
  currentBranch,
}: {
  read: (branch: string) => Promise<string[]>;
  currentBranch: () => string;
}) {
  const [rows, setRows] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const data = await read(currentBranch());
    setRows(data);
    setLoading(false);
    // Deliberately no branch in the dependency list — this is what every real page does.
  }, [read, currentBranch]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <p>Loading…</p>;
  return (
    <ul>
      {rows.map((r) => (
        <li key={r}>{r}</li>
      ))}
    </ul>
  );
}

const HYD = branchScopeId({ tenant: "apollo.medicore.test", branchId: "branch-hyderabad" });
const CHE = branchScopeId({ tenant: "apollo.medicore.test", branchId: "branch-chennai" });

describe("switching branch discards the previous branch's data", () => {
  it("replaces Hyderabad's rows with Chennai's, and shows neither in between", async () => {
    const api = makeApi();
    let branch = "Hyderabad";
    const currentBranch = () => branch;

    const { rerender } = render(
      <BranchScope scopeId={HYD}>
        <BranchPage read={api.load} currentBranch={currentBranch} />
      </BranchScope>,
    );

    await waitFor(() => expect(screen.getByText("Hyderabad patient")).toBeDefined());

    // The switch: the API client would now send X-Active-Branch: Chennai.
    branch = "Chennai";
    rerender(
      <BranchScope scopeId={CHE}>
        <BranchPage read={api.load} currentBranch={currentBranch} />
      </BranchScope>,
    );

    /**
     * The moment that matters. Before anything has come back, the screen must be the page's own
     * loading state — NOT Hyderabad's rows sitting under a header that now says Chennai, which is
     * exactly what `router.refresh()` used to leave behind.
     */
    expect(screen.queryByText("Hyderabad patient")).toBeNull();
    expect(screen.getByText("Loading…")).toBeDefined();

    await waitFor(() => expect(screen.getByText("Chennai patient")).toBeDefined());
    expect(screen.queryByText("Hyderabad patient")).toBeNull();
    expect(api.calls).toEqual(["Hyderabad", "Chennai"]);
  });

  it("comes back correctly on A → B → A", async () => {
    const api = makeApi();
    let branch = "Hyderabad";
    const currentBranch = () => branch;
    const tree = (scope: string) => (
      <BranchScope scopeId={scope}>
        <BranchPage read={api.load} currentBranch={currentBranch} />
      </BranchScope>
    );

    const { rerender } = render(tree(HYD));
    await waitFor(() => expect(screen.getByText("Hyderabad patient")).toBeDefined());

    branch = "Chennai";
    rerender(tree(CHE));
    await waitFor(() => expect(screen.getByText("Chennai patient")).toBeDefined());

    // Back again. A cache keyed only on the page would serve Chennai's rows here.
    branch = "Hyderabad";
    rerender(tree(HYD));
    await waitFor(() => expect(screen.getByText("Hyderabad patient")).toBeDefined());
    expect(screen.queryByText("Chennai patient")).toBeNull();
    expect(api.calls).toEqual(["Hyderabad", "Chennai", "Hyderabad"]);
  });

  /**
   * The race the audit called out: a request issued for A that comes back AFTER the switch to B.
   * Its `setState` must never reach the screen. React drops it because the component that asked
   * no longer exists — this test is what proves the discard actually happens rather than the
   * response being applied to a still-mounted page.
   */
  it("never shows branch A's response after switching to branch B", async () => {
    const api = makeApi();
    let branch = "Hyderabad";
    const currentBranch = () => branch;

    const { rerender } = render(
      <BranchScope scopeId={HYD}>
        <BranchPage read={api.loadDeferred} currentBranch={currentBranch} />
      </BranchScope>,
    );
    expect(screen.getByText("Loading…")).toBeDefined();

    // Switch while Hyderabad's request is still in flight.
    branch = "Chennai";
    rerender(
      <BranchScope scopeId={CHE}>
        <BranchPage read={api.load} currentBranch={currentBranch} />
      </BranchScope>,
    );

    // Hyderabad's answer arrives late, addressed to a component that is gone.
    await act(async () => {
      api.release(["Hyderabad patient"]);
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByText("Chennai patient")).toBeDefined());
    expect(screen.queryByText("Hyderabad patient")).toBeNull();
  });

  it("does not churn the page when the branch has not changed", async () => {
    const api = makeApi();
    const currentBranch = () => "Hyderabad";
    const tree = (
      <BranchScope scopeId={HYD}>
        <BranchPage read={api.load} currentBranch={currentBranch} />
      </BranchScope>
    );

    const { rerender } = render(tree);
    await waitFor(() => expect(screen.getByText("Hyderabad patient")).toBeDefined());

    // An unrelated re-render (a theme change, a nav highlight) must not refetch the ward.
    rerender(tree);
    rerender(tree);
    await waitFor(() => expect(screen.getByText("Hyderabad patient")).toBeDefined());
    expect(api.calls).toEqual(["Hyderabad"]);
  });

  /**
   * Aggregate mode is a scope of its own, not "no scope". Moving between a named branch and
   * All-branches changes what the server returns, so it must discard the screen exactly as a
   * branch-to-branch move does.
   */
  it("treats All-branches as its own scope", async () => {
    const api = makeApi();
    let branch = "Hyderabad";
    const currentBranch = () => branch;
    const all = branchScopeId({ tenant: "apollo.medicore.test", branchId: null });

    const { rerender } = render(
      <BranchScope scopeId={HYD}>
        <BranchPage read={api.load} currentBranch={currentBranch} />
      </BranchScope>,
    );
    await waitFor(() => expect(screen.getByText("Hyderabad patient")).toBeDefined());

    branch = "All";
    rerender(
      <BranchScope scopeId={all}>
        <BranchPage read={api.load} currentBranch={currentBranch} />
      </BranchScope>,
    );
    await waitFor(() => expect(screen.getByText("All patient")).toBeDefined());
    expect(screen.queryByText("Hyderabad patient")).toBeNull();
  });

  /**
   * Tenant isolation is the browser origin's job — a different hospital is a different hostname,
   * so its React tree never existed in this document. This asserts the second lock anyway: even
   * within one document, a tenant change is a scope change and discards the screen.
   */
  it("discards the screen if the tenant identity ever changes", async () => {
    const api = makeApi();
    let branch = "Apollo-Hyderabad";
    const currentBranch = () => branch;

    const { rerender } = render(
      <BranchScope scopeId={branchScopeId({ tenant: "apollo.test", branchId: "b1" })}>
        <BranchPage read={api.load} currentBranch={currentBranch} />
      </BranchScope>,
    );
    await waitFor(() => expect(screen.getByText("Apollo-Hyderabad patient")).toBeDefined());

    branch = "Sunrise-Hyderabad";
    rerender(
      <BranchScope scopeId={branchScopeId({ tenant: "sunrise.test", branchId: "b1" })}>
        <BranchPage read={api.load} currentBranch={currentBranch} />
      </BranchScope>,
    );
    await waitFor(() => expect(screen.getByText("Sunrise-Hyderabad patient")).toBeDefined());
    expect(screen.queryByText("Apollo-Hyderabad patient")).toBeNull();
  });

  /**
   * Rapid switching — a user clicking through three sites faster than the network answers. Every
   * intermediate screen is discarded and only the last one's data may survive.
   */
  it("survives rapid switching and shows only the final branch", async () => {
    const api = makeApi();
    let branch = "A";
    const currentBranch = () => branch;
    const scopeOf = (b: string) => branchScopeId({ tenant: "t", branchId: b });
    const tree = (b: string) => (
      <BranchScope scopeId={scopeOf(b)}>
        <BranchPage read={api.load} currentBranch={currentBranch} />
      </BranchScope>
    );

    const { rerender } = render(tree("A"));
    branch = "B";
    rerender(tree("B"));
    branch = "C";
    rerender(tree("C"));

    await waitFor(() => expect(screen.getByText("C patient")).toBeDefined());
    expect(screen.queryByText("A patient")).toBeNull();
    expect(screen.queryByText("B patient")).toBeNull();
  });

  /**
   * Hospital-wide screens (staff, roles, tariff, subscription) are not branch-filtered by the
   * server, so a switch must not change what they show. They still remount — the mechanism is
   * blunt on purpose — and must come back with the same data rather than something narrower.
   */
  it("leaves hospital-wide data unchanged across a switch", async () => {
    const calls: string[] = [];
    const readHospitalWide = async (): Promise<string[]> => {
      calls.push("tenant-wide");
      return Promise.resolve(["Dr Rao", "Nurse Priya"]);
    };

    const currentBranch = () => "ignored";
    const { rerender } = render(
      <BranchScope scopeId={HYD}>
        <BranchPage read={readHospitalWide} currentBranch={currentBranch} />
      </BranchScope>,
    );
    await waitFor(() => expect(screen.getByText("Dr Rao")).toBeDefined());

    rerender(
      <BranchScope scopeId={CHE}>
        <BranchPage read={readHospitalWide} currentBranch={currentBranch} />
      </BranchScope>,
    );

    await waitFor(() => expect(screen.getByText("Dr Rao")).toBeDefined());
    expect(screen.getByText("Nurse Priya")).toBeDefined();
    expect(calls).toEqual(["tenant-wide", "tenant-wide"]);
  });
});

/**
 * The mechanism is only as good as its reach. `AppFrame` is the single place that applies it, and
 * a page added tomorrow inherits the protection only because it renders through there — so this
 * asserts the wiring is present and, more importantly, that it is keyed on something that MOVES.
 * A `scopeId` accidentally hardcoded, or keyed on the pathname, would pass every test above.
 */
/** Reads a component's source from the web app root — jsdom gives no usable `import.meta.url`. */
async function readComponent(name: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  return readFile(join(process.cwd(), "components", name), "utf8");
}

describe("the scope is applied where every page passes through it", () => {
  it("AppFrame wraps its children in BranchScope, keyed on the branch scope", async () => {
    const source = await readComponent("AppFrame.tsx");
    expect(source).toContain("useBranch()");
    expect(source).toMatch(/<BranchScope\s+scopeId=\{scopeId\}>/);
  });

  it("the scope id changes with the branch and is stable without it", () => {
    const a = branchScopeId({ tenant: "t", branchId: "a" });
    expect(branchScopeId({ tenant: "t", branchId: "a" })).toBe(a);
    expect(branchScopeId({ tenant: "t", branchId: "b" })).not.toBe(a);
    expect(branchScopeId({ tenant: "t", branchId: null })).not.toBe(a);
    expect(branchScopeId({ tenant: "other", branchId: "a" })).not.toBe(a);
  });

  /**
   * Asserted as an ABSENT IMPORT rather than an absent call. The provider's header explains at
   * length why `router.refresh()` was removed, so a regex for the call matches the documentation
   * that exists to stop it coming back — the test would fail because the reasoning was written
   * down. The router cannot be used without being imported, and prose cannot import anything.
   */
  it("the provider no longer reaches for the router, whose refresh preserved the state it had to drop", async () => {
    const source = await readComponent("BranchProvider.tsx");
    expect(source).not.toMatch(/^import\s.*\bnext\/navigation\b/m);
  });
});
