/**
 * THE RELEASE GATE — may this build roll out to this fleet?
 *
 * ── WHAT THIS SUITE IS FOR ──────────────────────────────────────────────────
 * `migrate --check` decides whether a release ships. Every judgement it makes is therefore worth a
 * test, and almost none of those judgements need a database: whether a history is impossible,
 * whether an unreachable tenant is a schema finding, and what a deploy script's exit code should
 * be are all decisions about VALUES. They live in `deploymentGate.ts` and `runner.ts` as pure
 * functions precisely so they can be tested here, in milliseconds, instead of behind Docker.
 *
 * The physical half — is the index actually in the database — cannot be faked and is proved
 * against real MongoDB in `schemaGuard.int.test.ts`. The two suites are deliberately disjoint.
 *
 * ── THE INVARIANT UNDER TEST ────────────────────────────────────────────────
 * **A migration record is not evidence that the schema is right, and an exit code of zero must
 * mean a database was actually inspected and found correct.** Every case below is a way that
 * sentence can be false.
 */
import { describe, expect, it } from "vitest";
import { analyseHistory, migrationSequence, type Migration } from "./core/db/migrations/runner.js";
import {
  EXIT_CODE,
  checkTenant,
  classify,
  fleetVerdict,
  malformed,
  report,
  validateTarget,
  type TenantReadiness,
} from "./seed/deploymentGate.js";
import type { SchemaVerdict } from "./seed/schemaGuard.js";
import { CLINICAL_SAFETY_INVARIANTS } from "./seed/schemaGuard.js";

/** A miniature release. Real ids, real shape, small enough to reason about exactly. */
const migration = (id: string, preflight?: Migration["preflight"]): Migration => ({
  id,
  description: `test ${id}`,
  ...(preflight ? { preflight } : {}),
  up: async () => undefined,
  down: async () => undefined,
});

const RELEASE = [
  migration("0001-counters"),
  migration("0002-outbox-events"),
  migration("0003-audit-logs"),
];
const records = (...ids: string[]): { _id: string }[] => ids.map((_id) => ({ _id }));

/* ── 1. what the tenant's history says ──────────────────────────────────────── */

describe("migration history, judged against the release being deployed", () => {
  it("1. every migration recorded → nothing pending, nothing wrong", () => {
    const history = analyseHistory(
      records("0001-counters", "0002-outbox-events", "0003-audit-logs"),
      RELEASE,
    );

    expect(history.pending).toEqual([]);
    expect(history.inconsistent).toEqual([]);
    expect(history.ahead).toEqual([]);
    expect(history.applied).toHaveLength(3);
  });

  it("2. one behind → that one id, named rather than counted", () => {
    const history = analyseHistory(records("0001-counters", "0002-outbox-events"), RELEASE);

    expect(history.pending).toEqual(["0003-audit-logs"]);
    expect(history.inconsistent).toEqual([]);
  });

  it("3. several behind → all of them, in the order they must be applied", () => {
    const history = analyseHistory(records("0001-counters"), RELEASE);

    expect(history.pending).toEqual(["0002-outbox-events", "0003-audit-logs"]);
    expect(history.inconsistent).toEqual([]);
  });

  it("a tenant with NO history at all is behind by the whole release, not corrupt", () => {
    const history = analyseHistory([], RELEASE);

    expect(history.pending).toHaveLength(3);
    expect(history.inconsistent).toEqual([]);
  });

  /**
   * ── THE CASE `pendingCount` COULD NOT SEE AT ALL ──────────────────────────
   * Measured on 2026-08-16 before this existed: a database holding every known id PLUS an unknown
   * one returned `ok: true`, silently. It is not a fault — expand→migrate→contract means the older
   * build can serve the newer schema, and RELEASE_MANAGEMENT §6 defines rollback as exactly this.
   * But an operator deploying a build older than the fleet's schema should be TOLD.
   */
  it("a tenant migrated by a NEWER release is `ahead` — reported, and deliberately not a failure", () => {
    const history = analyseHistory(
      records("0001-counters", "0002-outbox-events", "0003-audit-logs", "0004-idempotency-keys"),
      RELEASE,
    );

    expect(history.ahead).toEqual(["0004-idempotency-keys"]);
    expect(history.inconsistent).toEqual([]);
    expect(history.pending).toEqual([]);
  });

  it("and `ahead` does not become an excuse — a tenant can be ahead AND behind at once", () => {
    // Rolled forward to 0004, but 0002 was never recorded. Being ahead says nothing about the gap.
    const history = analyseHistory(
      records("0001-counters", "0003-audit-logs", "0004-idempotency-keys"),
      RELEASE,
    );

    expect(history.ahead).toEqual(["0004-idempotency-keys"]);
    expect(history.pending).toEqual(["0002-outbox-events"]);
    expect(history.inconsistent.join(" ")).toMatch(/gap/);
  });

  /* ── histories that running these migrations in order cannot produce ──────── */

  it("a GAP is not lag: an outstanding migration below one already applied", () => {
    const history = analyseHistory(records("0001-counters", "0003-audit-logs"), RELEASE);

    expect(history.pending).toEqual(["0002-outbox-events"]);
    // The distinction that matters: `migrateTenantDb` would apply 0002 now, AFTER 0003 already ran.
    expect(history.inconsistent).toHaveLength(1);
    expect(history.inconsistent[0]).toMatch(/0002-outbox-events/);
    expect(history.inconsistent[0]).toMatch(/out of order/);
  });

  it("a RENUMBERED id is caught by its number, not by its name", () => {
    const history = analyseHistory(
      records("0001-counters", "0002-renamed-in-a-refactor", "0003-audit-logs"),
      RELEASE,
    );

    // TWO true findings, and both are worth printing: the id was renumbered, AND the migration
    // this release actually ships under that number is now outstanding beneath a recorded 0003.
    // Collapsing them would mean deciding which caused which, and a wrong guess hides a real gap.
    const renumbered = history.inconsistent.find((f) => /renumbered or renamed/.test(f));
    expect(renumbered).toBeDefined();
    // It must name BOTH sides, or the reader cannot tell which is theirs and which is ours.
    expect(renumbered).toMatch(/0002-renamed-in-a-refactor/);
    expect(renumbered).toMatch(/0002-outbox-events/);
    expect(history.inconsistent.some((f) => /out of order/.test(f))).toBe(true);
  });

  it("a record that is not a migration id at all is inconsistent, not silently ignored", () => {
    const history = analyseHistory(
      records("0001-counters", "0002-outbox-events", "0003-audit-logs", "manual-hotfix-tuesday"),
      RELEASE,
    );

    expect(history.inconsistent).toHaveLength(1);
    expect(history.inconsistent[0]).toMatch(/not a migration id/);
  });

  it("a DELETED migration — a record below the head with no counterpart in this release", () => {
    const shortened = [RELEASE[0]!, RELEASE[2]!]; // 0002 removed from the code
    const history = analyseHistory(
      records("0001-counters", "0002-outbox-events", "0003-audit-logs"),
      shortened,
    );

    expect(history.inconsistent).toHaveLength(1);
    expect(history.inconsistent[0]).toMatch(/no such migration exists in this release/);
  });

  it("parses the sequence from an id, and refuses to guess at one that has none", () => {
    expect(migrationSequence("0049-one-administration-per-dose-slot")).toBe(49);
    expect(migrationSequence("0001-counters")).toBe(1);
    expect(migrationSequence("nonsense")).toBeNull();
    expect(migrationSequence("49-short")).toBeNull();
  });
});

/* ── 2. from a verdict to an instruction ────────────────────────────────────── */

const verdictOf = (over: Partial<SchemaVerdict> = {}): SchemaVerdict => ({
  ok: false,
  pending: [],
  missing: [],
  history: { applied: [], pending: [], ahead: [], inconsistent: [] },
  ...over,
});

const driftOf = (): SchemaVerdict["missing"] => [
  { invariant: CLINICAL_SAFETY_INVARIANTS[0]!, found: "no index on those fields" },
];

describe("classifying a tenant, and what the reader is told to do", () => {
  it("converged and armed → ready, with no instruction to follow", () => {
    const result = classify(verdictOf({ ok: true }), "apollo");

    expect(result.code).toBe("ready");
    expect(result.ready).toBe(true);
    expect(result.remedy).toBe("");
  });

  it("behind → `behind`, and the remedy is to converge THIS tenant", () => {
    const result = classify(
      verdictOf({ pending: ["0049-one-administration-per-dose-slot"] }),
      "apollo",
    );

    expect(result.code).toBe("behind");
    expect(result.detail).toEqual(["0049-one-administration-per-dose-slot"]);
    expect(result.remedy).toMatch(/seed:migrate --slug apollo/);
  });

  /**
   * ── THE CASE THE WHOLE MODULE EXISTS FOR ──────────────────────────────────
   * Migration recorded, constraint gone. `pendingCount` says converged and `seed:migrate` will
   * skip it while printing success — so the ONE thing the remedy must not say is "run migrate".
   */
  it("recorded but the constraint is gone → `schema_drift`, and NOT told to simply converge", () => {
    const result = classify(verdictOf({ missing: driftOf() }), "apollo");

    expect(result.code).toBe("schema_drift");
    expect(result.remedy).toMatch(/skip it and report success/);
    expect(result.remedy).toMatch(/Clear the record/);
    expect(result.detail[0]).toMatch(/the same scheduled dose cannot be charted twice/);
  });

  it("behind AND missing indexes is `behind`, not drift — the migrations install them", () => {
    // Getting this backwards sends the reader to "clear the record", which is wrong and confusing.
    const result = classify(
      verdictOf({ pending: ["0049-one-administration-per-dose-slot"], missing: driftOf() }),
      "apollo",
    );

    expect(result.code).toBe("behind");
  });

  it("an impossible history outranks everything, because converging it is unsafe", () => {
    const result = classify(
      verdictOf({
        pending: ["0002-outbox-events"],
        missing: driftOf(),
        history: {
          applied: [],
          pending: [],
          ahead: [],
          inconsistent: ["`0002-outbox-events` is outstanding while migration 3 is recorded"],
        },
      }),
      "apollo",
    );

    expect(result.code).toBe("history_inconsistent");
    expect(result.remedy).toMatch(/Do NOT converge/);
  });

  it("a blocked preflight outranks `behind` — the obvious next step would fail", () => {
    const result = classify(
      verdictOf({
        pending: ["0048-idempotency-key-claims"],
        blockedBy: { migration: "0048-idempotency-key-claims", reason: "3 group(s) hold >1 claim" },
      }),
      "apollo",
    );

    expect(result.code).toBe("preflight_blocked");
    expect(result.remedy).toMatch(/Converging will fail/);
    expect(result.detail.join(" ")).toMatch(/3 group\(s\)/);
  });

  it("`ahead` rides along as a NOTE on a ready tenant, so a rollback is never blocked", () => {
    const result = classify(
      verdictOf({
        ok: true,
        history: {
          applied: [],
          pending: [],
          ahead: ["0050-from-the-next-release"],
          inconsistent: [],
        },
      }),
      "apollo",
    );

    expect(result.code).toBe("ready");
    expect(result.ready).toBe(true);
    expect(result.notes.join(" ")).toMatch(/NEWER schema/);
  });
});

/* ── 3. a registry row, before anything is opened ───────────────────────────── */

describe("the registry row is validated, never coerced", () => {
  it("accepts a well-formed row", () => {
    const result = validateTarget({ id: "t1", slug: "apollo", databaseName: "hms_apollo" });

    expect(result.ok).toBe(true);
    expect(result.ok && result.target.databaseName).toBe("hms_apollo");
  });

  /**
   * ── MEASURED, NOT IMAGINED (2026-08-16) ───────────────────────────────────
   * The old loop built these with `String(doc.databaseName)`. With the field missing that yields
   * the literal `"undefined"`; mongoose opens a real database of that name; the check finds it
   * empty and reports every migration pending and both invariants missing. The operator is told a
   * live hospital has drifted — and the remedy printed beside it would have run 49 migrations into
   * the junk database and created it.
   */
  it('refuses a row with no databaseName — the string "undefined" is a real database', () => {
    const result = validateTarget({ id: "t1", slug: "apollo" });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problems.join(" ")).toMatch(/databaseName/);
  });

  it("refuses a BLANK databaseName — mongoose resolves it to `test`, a different database", () => {
    const result = validateTarget({ id: "t1", slug: "apollo", databaseName: "   " });

    expect(result.ok).toBe(false);
  });

  it("refuses a database name that is not one — an allow-list, so nothing has to be foreseen", () => {
    for (const name of ["hms/apollo", "hms apollo", 'hms"apollo', "hms.apollo", "hms$apollo"]) {
      expect(validateTarget({ id: "t1", slug: "a", databaseName: name }).ok).toBe(false);
    }
  });

  it("accepts the names this repository actually uses, hyphens included", () => {
    // `hms_test-schemaguard` is a real database here. An allow-list is only safe if it is right.
    for (const name of ["hms_apollo", "hms_test-schemaguard", "paperlesstech_master", "hms_a1"]) {
      expect(validateTarget({ id: "t1", slug: "a", databaseName: name }).ok).toBe(true);
    }
  });

  it("names the row it cannot read, even when the slug is the missing field", () => {
    const result = validateTarget({ id: "t1", databaseName: "hms_x" });

    expect(result.ok === false && result.slug).toBe("(unnamed row)");
  });

  it("keeps a dedicated dbUri, and refuses a blank one rather than falling back silently", () => {
    expect(
      validateTarget({ id: "t", slug: "a", databaseName: "hms_a", dbUri: "mongodb://x" }).ok,
    ).toBe(true);
    expect(validateTarget({ id: "t", slug: "a", databaseName: "hms_a", dbUri: "" }).ok).toBe(false);
  });
});

/* ── 4. a tenant that cannot be inspected ───────────────────────────────────── */

/**
 * A connection whose migration history reads fine and whose index listing behaves as given.
 *
 * The history has to work, or `readHistory` throws first and the test passes on the WRONG error —
 * which is exactly what my first version of the two tests below did.
 */
function dbWhere(indexes: (collection: string) => Promise<unknown[]>): Connection {
  return {
    collection: (name: string) => ({
      find: () => ({ toArray: () => Promise.resolve([]) }),
      indexes: () => indexes(name),
    }),
  } as unknown as Connection;
}

describe("failing to look is not a finding about the schema", () => {
  it("an unreachable tenant is `unreachable`, and says so instead of implying drift", async () => {
    const result = await checkTenant(
      { id: "t1", slug: "apollo", databaseName: "hms_apollo" },
      () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:37018")),
      [],
    );

    expect(result.code).toBe("unreachable");
    expect(result.ready).toBe(false);
    expect(result.detail[0]).toMatch(/ECONNREFUSED/);
    expect(result.remedy).toMatch(/NOTHING about the tenant's schema/);
  });

  /**
   * ── REGRESSION: A DATABASE THAT DIES MID-INSPECTION ───────────────────────
   * The test above kills the CONNECT. This kills the inspection AFTER a connection is handed over,
   * which is a different path and was genuinely broken: `inspectInvariants` used to swallow every
   * error per invariant and record it as "collection does not exist". A tenant that went away
   * mid-check therefore came back as eight missing constraints — reported as `schema_drift`,
   * NOT_READY, exit 1 — telling an operator that eight indexes had been dropped when in truth
   * nothing had been learned. It now absorbs only MongoDB's `NamespaceNotFound` (code 26) and lets
   * everything else through to be reported as what it is.
   */
  it("a database that fails DURING inspection is `unreachable`, never `schema_drift`", async () => {
    const result = await checkTenant(
      { id: "t1", slug: "apollo", databaseName: "hms_apollo" },
      () =>
        Promise.resolve(
          dbWhere(() =>
            Promise.reject(
              // No `code` — exactly what a server-selection failure looks like.
              new Error("connection <monitor> to 127.0.0.1 closed"),
            ),
          ),
        ),
      [],
    );

    expect(result.code).toBe("unreachable");
    expect(fleetVerdict([result])).toBe("ERROR");
    expect(EXIT_CODE[fleetVerdict([result])]).toBe(2);
  });

  /**
   * The other half of the same rule: a collection that genuinely has never been created IS a schema
   * finding, and must keep being reported as one. Absorbing too little would be as wrong as
   * absorbing too much — every un-migrated tenant would read as unreachable.
   */
  it("but a collection that was never created is still a schema finding", async () => {
    const result = await checkTenant(
      { id: "t1", slug: "apollo", databaseName: "hms_apollo" },
      () =>
        Promise.resolve(
          dbWhere((name) =>
            Promise.reject(Object.assign(new Error(`ns not found: ${name}`), { code: 26 })),
          ),
        ),
      [],
    );

    expect(result.code).toBe("schema_drift");
    expect(EXIT_CODE[fleetVerdict([result])]).toBe(1);
  });

  it("does not throw — one dead tenant must not hide the state of the other thirty", async () => {
    await expect(
      checkTenant(
        { id: "t1", slug: "apollo", databaseName: "hms_apollo" },
        () => {
          throw new Error("thrown synchronously, not rejected");
        },
        [],
      ),
    ).resolves.toMatchObject({ code: "unreachable" });
  });
});

/* ── 5. the fleet verdict and the exit contract ─────────────────────────────── */

const tenant = (slug: string, code: TenantReadiness["code"]): TenantReadiness => ({
  slug,
  code,
  ready: code === "ready",
  detail: [],
  notes: [],
  remedy: "",
});

describe("the fleet verdict, and the number a deploy step reads", () => {
  it("every tenant ready → READY → exit 0", () => {
    const verdict = fleetVerdict([tenant("a", "ready"), tenant("b", "ready")]);

    expect(verdict).toBe("READY");
    expect(EXIT_CODE[verdict]).toBe(0);
  });

  it("one behind → NOT_READY → exit 1", () => {
    const verdict = fleetVerdict([tenant("a", "ready"), tenant("b", "behind")]);

    expect(verdict).toBe("NOT_READY");
    expect(EXIT_CODE[verdict]).toBe(1);
  });

  it.each(["schema_drift", "history_inconsistent", "preflight_blocked"] as const)(
    "%s is a schema finding → NOT_READY → exit 1",
    (code) => {
      expect(EXIT_CODE[fleetVerdict([tenant("a", "ready"), tenant("b", code)])]).toBe(1);
    },
  );

  it.each(["unreachable", "malformed"] as const)(
    "%s means we could not look → ERROR → exit 2",
    (code) => {
      expect(EXIT_CODE[fleetVerdict([tenant("a", "ready"), tenant("b", code)])]).toBe(2);
    },
  );

  /**
   * If one tenant is behind and another was never reached, "the fleet is behind" is a claim about
   * a database nobody opened. ERROR wins because it is the honest headline: this check did not
   * complete. Both stop the release; only one of them is a reason to page about a migration.
   */
  it("ERROR outranks NOT_READY — an incomplete answer is not a schema answer", () => {
    expect(fleetVerdict([tenant("a", "behind"), tenant("b", "unreachable")])).toBe("ERROR");
  });

  it("the three exit codes are distinct, or a deploy script cannot branch on them", () => {
    expect(new Set(Object.values(EXIT_CODE)).size).toBe(3);
  });

  it("counts each tenant exactly once, in the right column", () => {
    const result = report(
      [
        tenant("a", "ready"),
        tenant("b", "behind"),
        tenant("c", "schema_drift"),
        tenant("d", "unreachable"),
        tenant("e", "malformed"),
      ],
      RELEASE,
    );

    expect(result).toMatchObject({ verdict: "ERROR", total: 5, ready: 1, notReady: 2, errored: 2 });
    expect(result.ready + result.notReady + result.errored).toBe(result.total);
  });

  /**
   * An answer is only true of one release. Without this, a report copied into a ticket cannot be
   * matched to the build it was taken against — and "the fleet was green" is the sentence people
   * quote after an incident.
   */
  it("stamps which release it was computed against", () => {
    const result = report([tenant("a", "ready")], RELEASE);

    expect(result.release).toEqual({ migrations: 3, head: "0003-audit-logs" });
    expect(Date.parse(result.checkedAt)).not.toBeNaN();
  });

  it("a malformed row is an ERROR that names what is wrong with it", () => {
    const result = malformed("apollo", ["`databaseName` is missing or blank"]);

    expect(result.ready).toBe(false);
    expect(fleetVerdict([result])).toBe("ERROR");
    expect(result.remedy).toMatch(/must not be migrated/);
  });
});
