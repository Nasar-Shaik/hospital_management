/**
 * BARE `findById` IN A REPOSITORY IS A DECISION, SO IT HAS TO BE WRITTEN DOWN.
 *
 * ── WHY THIS CONTROL EXISTS ─────────────────────────────────────────────────
 * The security audit of 2026-08-17 found the same bug three times in three modules, and it
 * looked identical every time: a collection whose LIST read carried `scopeFilter()` and whose
 * BY-ID read did not.
 *
 *   `reports.getBytes`        — the metadata list stopped at the branch, the PDF did not;
 *   `appointments.findById`   — the read paths used the scoped twin, the STATE MACHINE did not;
 *   `wallet.findEntryById`    — the patient ledger was scoped, the receipt link was not.
 *
 * Each was a one-line omission that reviewed cleanly, because a bare `findById` looks like the
 * most ordinary line of code in a repository. None of them could be caught by reading the file
 * they were in — the tell was always the OTHER read in the same module doing it properly.
 *
 * ── WHAT THIS ASSERTS, AND WHY IT IS NOT A STYLE RULE ───────────────────────
 * `tenantScopePlugin` forces `tenantId` onto every query, so no bare read can ever cross a
 * HOSPITAL. That wall is not what this is about. Inside one hospital, `scopeFilter()` is the
 * only thing that applies the caller's branch and `own` scope, and the permission catalogue
 * declares most clinical and money permissions `"branch"` — so a by-id read without it
 * contradicts the catalogue rather than merely differing in style.
 *
 * So every `findById` left in a repository must be listed here with a reason. The list is the
 * point: adding a new bare read means writing down why it is safe, in a file whose whole
 * subject is that question. Deleting an entry to make the test pass is a visible act.
 *
 * This is a SOURCE test on purpose. An integration test proves the paths it happens to walk;
 * three of these lived for months behind paths nobody walked with two branches configured.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MODULES = join(__dirname, "modules");

/**
 * Why each surviving bare `findById` is safe.
 *
 * Three kinds of answer, and only three:
 *   TENANT-WIDE  — the entity is deliberately not branch-owned (ADR-0015 §5). Narrowing it
 *                  would be the bug, and there is a test asserting the opposite.
 *   NOT A TENANT COLLECTION — master/registry data, which `scopeFilter` does not describe.
 *   SERVER-DERIVED ID — the id comes from a document the caller already resolved, not from
 *                  the request. There is no id for an attacker to substitute.
 */
const EXEMPT: Record<string, { lines: number; why: string }> = {
  "patients/patient.repository.ts": {
    lines: 1,
    why: "TENANT-WIDE: `findByIdentity` — ADR-0015 §5 makes patient identity hospital-wide on purpose. The branch-isolation suite asserts it resolves ACROSS branches; scoping it would break the ADR.",
  },
  "allergies/allergy.repository.ts": {
    lines: 1,
    why: "TENANT-WIDE: an allergy follows the person, not the site. Same ADR-0015 §5 reasoning, asserted in the branch-isolation suite ('carries allergies across branches').",
  },
  "medicines/medicine.repository.ts": {
    lines: 1,
    why: "TENANT-WIDE: the drug catalogue is one hospital-wide price/stock list, like `serviceItems`. Scoping it hides the formulary from anyone with a branch selected.",
  },
  "billing/billing.repository.ts": {
    lines: 1,
    why: "TENANT-WIDE: `findServiceById` reads the tariff — hospital-wide config, not a patient record. Section 19 of the branch-isolation suite is the falsification for exactly this.",
  },
  "departments/department.repository.ts": {
    lines: 4,
    why: "TENANT-WIDE: departments are hospital structure. Two of the four resolve `doc.parentId`, which is SERVER-DERIVED from a department already read.",
  },
  "branches/branch.repository.ts": {
    lines: 1,
    why: "TENANT-WIDE: a branch is the thing scope is defined IN TERMS OF. `isActiveBranch` carries its own explicit tenant filter.",
  },
  "users/user.repository.ts": {
    lines: 1,
    why: "TENANT-WIDE: a user account belongs to the hospital, not a site — a user's branch bindings are what confine them, and those are read from the account itself.",
  },
  "rbac/rbac.repository.ts": {
    lines: 1,
    why: "TENANT-WIDE: a role is hospital-wide by definition; branch confinement lives on the BINDING, not the role.",
  },
  "tenants/tenant.repository.ts": {
    lines: 2,
    why: "NOT A TENANT COLLECTION: the master registry. `scopeFilter` has no meaning there and `tenantScopePlugin` is not applied.",
  },
  "platform/platform.repository.ts": {
    lines: 1,
    why: "NOT A TENANT COLLECTION: operator-console data in the master database.",
  },
  "theatres/theatre.repository.ts": {
    lines: 2,
    why: "SERVER-DERIVED ID: both resolve `clash.theatreId` / `doc.theatreId` to name a theatre in a booking-clash message. The id comes from a booking already resolved through a scoped read, never from the request.",
  },
  "ambulance/ambulance.repository.ts": {
    lines: 2,
    why: "SERVER-DERIVED ID: both resolve `clash.ambulanceId` / `doc.ambulanceId` for a dispatch-clash message. Same shape as theatres.",
  },
};

/** Every `*.repository.ts` under `modules/`, as module-relative paths. */
function repositories(): string[] {
  const out: string[] = [];
  for (const dir of readdirSync(MODULES, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const file of readdirSync(join(MODULES, dir.name))) {
      if (file.endsWith(".repository.ts")) out.push(`${dir.name}/${file}`);
    }
  }
  return out.sort();
}

/**
 * Counts real `.findById(` calls, ignoring the ones inside comments — the fixed modules now
 * carry long headers that NAME `findById` while explaining why they no longer call it, and a
 * naive count would read those as violations.
 */
function bareFindByIdCount(source: string): number {
  const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const withoutLineComments = withoutBlockComments.replace(/^\s*\/\/.*$/gm, "");
  return (withoutLineComments.match(/\.findById\(/g) ?? []).length;
}

describe("every by-id repository read is scoped, or is exempt for a written reason", () => {
  const found = new Map<string, number>();
  for (const rel of repositories()) {
    const count = bareFindByIdCount(readFileSync(join(MODULES, rel), "utf8"));
    if (count > 0) found.set(rel, count);
  }

  it("no repository has gained an unexplained bare findById", () => {
    const unexplained = [...found.keys()].filter((rel) => !(rel in EXEMPT));
    expect(
      unexplained,
      `these repositories read by id without \`scopeFilter()\` and without an entry in EXEMPT.\n` +
        `Inside one hospital that ignores the caller's branch, and most clinical and money\n` +
        `permissions are declared "branch". Either add \`...scopeFilter()\` to the read, or add\n` +
        `an entry saying why the entity is tenant-wide, is not a tenant collection, or takes a\n` +
        `server-derived id.`,
    ).toEqual([]);
  });

  /**
   * The count matters as much as the presence: a module already exempt for ONE tenant-wide read
   * must not quietly acquire a second, differently-motivated one under the same reason.
   */
  it("no exempt repository has gained an extra one beyond what its reason covers", () => {
    const grown = [...found.entries()]
      .filter(([rel, count]) => rel in EXEMPT && count > (EXEMPT[rel]?.lines ?? 0))
      .map(
        ([rel, count]) => `${rel}: ${String(EXEMPT[rel]?.lines)} explained, ${String(count)} found`,
      );
    expect(grown, "a new bare read is hiding behind an existing exemption").toEqual([]);
  });

  /** And the list must not rot in the other direction: an exemption for a read that is gone. */
  it("no exemption outlives the read it explains", () => {
    const stale = Object.keys(EXEMPT).filter((rel) => !found.has(rel));
    expect(
      stale,
      "these are listed as exempt but no longer read by id — delete the entry so the list keeps meaning something",
    ).toEqual([]);
  });

  /** A reason that says nothing is worse than no reason: it makes the list look maintained. */
  it("every exemption names one of the three permitted kinds", () => {
    const vague = Object.entries(EXEMPT)
      .filter(
        ([, e]) =>
          !e.why.startsWith("TENANT-WIDE:") &&
          !e.why.startsWith("NOT A TENANT COLLECTION:") &&
          !e.why.startsWith("SERVER-DERIVED ID:"),
      )
      .map(([rel]) => rel);
    expect(vague).toEqual([]);
  });

  /** The premise. If the scan found nothing at all, every assertion above is vacuous. */
  it("actually scanned the repositories", () => {
    expect(repositories().length).toBeGreaterThan(20);
    expect(found.size).toBeGreaterThan(5);
  });
});

/**
 * The three modules the audit fixed, pinned by name.
 *
 * The list above would go green again if someone re-introduced a bare read AND added an
 * exemption for it. These three are the ones we know were wrong, so they are asserted
 * positively rather than by absence.
 */
describe("the three reads the audit fixed stay scoped", () => {
  const FIXED = [
    { file: "reports/report.repository.ts", fn: "getBytes" },
    { file: "appointments/appointment.repository.ts", fn: "findById" },
    { file: "wallet/wallet.repository.ts", fn: "findEntryById" },
  ] as const;

  for (const { file, fn } of FIXED) {
    it(`${file} — ${fn} still passes scopeFilter`, () => {
      const source = readFileSync(join(MODULES, file), "utf8");
      const at = source.indexOf(`export async function ${fn}(`);
      expect(at, `${fn} is gone from ${file}`).toBeGreaterThan(-1);
      // The body runs to the next top-level `export`, which is enough to contain one read.
      const next = source.indexOf("\nexport ", at + 1);
      const body = source.slice(at, next === -1 ? undefined : next);
      expect(body, `${fn} lost its scope filter`).toContain("scopeFilter(");
    });
  }
});
