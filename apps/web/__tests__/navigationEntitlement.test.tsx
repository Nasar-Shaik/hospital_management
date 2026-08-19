/**
 * D20 — THE SIDEBAR MUST NOT SELL WHAT THE EDITION DOES NOT INCLUDE.
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
 * The navigation gated on PERMISSION and never on ENTITLEMENT. A `PLAN_CLINIC` administrator holds
 * every code in the catalogue, so the sidebar offered Theatres, Emergency, Ward, Bed board,
 * Medication round, Ambulance, Mortuary, Medicine master and more — and each opened onto
 * `HMS-PLAN-002 Feature not in your edition`. Editing a role could never have fixed any of it,
 * which is exactly the confusion the two error codes exist to prevent (ADR-0010).
 *
 * ── WHY THE EDITIONS ARE THE REAL ONES ──────────────────────────────────────
 * The flag sets below come from `EDITIONS` in `@medicore/permissions` — the same data the server
 * resolves an entitlement from — rather than from a list typed into this file. A hand-written flag
 * set would let the test agree with a nav that had drifted from what the product actually sells.
 *
 * ── WHAT IS DELIBERATELY NOT ASSERTED HERE ──────────────────────────────────
 * That hiding a link protects anything. It does not, and must not be relied on: the server refuses
 * the route independently, which `emergency.int.test.ts` and `theatres.int.test.ts` prove, and
 * which `moduleRefusal.test.tsx` shows a person still meets by typing the URL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ALL_PERMISSION_CODES, EDITIONS } from "@medicore/permissions";

const AUTH = {
  user: { id: "admin-1", name: "Hospital Admin", roles: ["TENANT_ADMIN"], branchIds: [] },
  api: null,
  // A TENANT_ADMIN holds everything — the account the defect was found on, and the only one on
  // which permission-gating alone hides nothing at all.
  can: () => true,
  hasFeature: (flag: string) => FEATURES.has(flag),
  logout: () => undefined,
};
const FEATURES = new Set<string>();

vi.mock("../components/AuthProvider", () => ({ useAuth: () => AUTH }));
vi.mock("../components/BranchProvider", () => ({
  useBranch: () => ({ branches: [], active: null, hasChoice: false, canAggregate: false }),
}));
vi.mock("../components/BrandingProvider", () => ({ useBranding: () => ({ branding: null }) }));
vi.mock("../components/AlertBell", () => ({ AlertBell: () => null }));
vi.mock("../components/LicenseBanner", () => ({ LicenseBanner: () => null }));
vi.mock("../components/BranchSwitcher", () => ({ BranchSwitcher: () => null }));
vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard" }));
// The theme toggle needs a provider this test has no interest in standing up.
vi.mock("@medicore/ui", () => ({ ThemeToggle: () => null }));

const { AppShell } = await import("../components/AppShell");

/** The links the rail actually renders, by their visible label. */
function navLabels(): string[] {
  return screen
    .getAllByRole("link")
    .map((a) => a.textContent?.trim() ?? "")
    .filter((t) => t.length > 0);
}

function renderWith(flags: readonly string[]) {
  FEATURES.clear();
  for (const f of flags) FEATURES.add(f);
  render(
    <AppShell>
      <div />
    </AppShell>,
  );
}

/** Modules a clinic does not buy, by the label their nav entry carries. */
const HOSPITAL_ONLY = [
  "Theatres",
  "Emergency",
  "Ward",
  "Bed board",
  "Medication round",
  "Ambulance",
  "Medicine master",
  "Lab catalogue",
  "Medical records",
  "Assets",
];

afterEach(cleanup);
beforeEach(() => {
  FEATURES.clear();
});

describe("1. a clinic-plan hospital", () => {
  it("is not offered a single module its edition does not include", () => {
    renderWith(EDITIONS.PLAN_CLINIC.flags);

    const labels = navLabels();
    for (const module of HOSPITAL_ONLY) {
      expect(labels, `${module} was advertised to a clinic`).not.toContain(module);
    }
  });

  it("still gets everything a clinic actually runs on", () => {
    renderWith(EDITIONS.PLAN_CLINIC.flags);

    const labels = navLabels();
    // The clinical day a clinic really has: the desk, the doctor, the book, the bill.
    for (const kept of ["Reception", "My patients", "Patients", "Appointments", "Billing"]) {
      expect(labels, `${kept} was hidden from a clinic that has it`).toContain(kept);
    }
  });
});

describe("2. a hospital-plan hospital", () => {
  it("is offered every module its edition includes", () => {
    renderWith(EDITIONS.PLAN_HOSPITAL.flags);

    const labels = navLabels();
    for (const module of HOSPITAL_ONLY) {
      // Mortuary is Hospital PLUS — see the edition table; everything else here is Hospital.
      expect(labels, `${module} was hidden from a hospital that bought it`).toContain(module);
    }
    expect(labels).not.toContain("Mortuary");
  });

  it("gets the mortuary once the edition that includes it is in force", () => {
    renderWith(EDITIONS.PLAN_HOSPITAL_PLUS.flags);
    expect(navLabels()).toContain("Mortuary");
  });
});

/**
 * ── THE ASSERTION THAT CATCHES A WRONG FLAG, NOT JUST A MISSING GATE ────────
 * Every gated entry is checked against ITS OWN flag: with the full hospital edition minus exactly
 * one flag, exactly the entries that depend on that flag disappear. An entry tagged with the wrong
 * (but real) flag fails here, because it vanishes when somebody else's module is withdrawn.
 */
describe("3. each entry answers to its own flag", () => {
  const CASES: [string, string[]][] = [
    ["module.clinical.ot", ["Theatres"]],
    ["module.clinical.emergency", ["Emergency"]],
    ["module.ops.ipd", ["Ward", "Bed board"]],
    ["module.clinical.nursing", ["Medication round"]],
    ["module.support.ambulance", ["Ambulance"]],
    ["module.pharmacy.full", ["Medicine master"]],
    ["module.pharmacy.dispensing", ["Pharmacy"]],
    ["module.clinical.lis", ["Lab catalogue"]],
    ["module.support.mrd", ["Medical records"]],
    ["module.support.assets", ["Assets"]],
    ["module.ops.appointments", ["Appointments"]],
  ];

  for (const [flag, labels] of CASES) {
    it(`hides exactly ${labels.join(" + ")} when ${flag} is withdrawn`, () => {
      const full = EDITIONS.PLAN_HOSPITAL_PLUS.flags as readonly string[];
      expect(full, `${flag} is not in the edition this case withdraws it from`).toContain(flag);

      renderWith(full);
      const before = navLabels();
      cleanup();

      renderWith(full.filter((f) => f !== flag));
      const after = navLabels();

      const vanished = before.filter((label) => !after.includes(label));
      expect(vanished.sort()).toEqual([...labels].sort());
    });
  }
});

/** A guard on the catalogue itself: the labels above must name entries that exist. */
describe("4. the fixture describes the real product", () => {
  it("names permissions and flags that are in the catalogue", () => {
    expect(ALL_PERMISSION_CODES.length).toBeGreaterThan(0);
    renderWith(EDITIONS.PLAN_HOSPITAL_PLUS.flags);
    const labels = navLabels();
    for (const module of [...HOSPITAL_ONLY, "Mortuary"]) {
      expect(labels, `${module} is not a nav entry any more — this fixture is stale`).toContain(
        module,
      );
    }
  });
});
