/**
 * THE RUNTIME SCHEMA GUARD — is the rule still armed, and what does the answer cost?
 *
 * ── WHAT THIS SUITE IS FOR ──────────────────────────────────────────────────
 * The physical question ("is the index really in MongoDB") is proved against a real database in
 * `schemaGuard.int.test.ts`. Everything here is the judgement built on top of that answer, and all
 * of it is decided in memory: which capability a missing constraint blocks, whether an unknown
 * state may be treated as safe, how long a verdict is trusted, and — the one that would be a
 * genuine incident — whether one hospital's verdict can ever answer for another.
 *
 * The connection is a stub, deliberately. Testing "an unrelated migration does not block MAR" or
 * "the inspection threw" against real Mongo would mean manufacturing those states in a database
 * instead of simply stating them, and the assertions would be about the fixture rather than the
 * rule.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Connection } from "mongoose";
import {
  CLINICAL_SAFETY_INVARIANTS,
  invariantsFor,
  type SafetyInvariant,
} from "./core/db/clinicalInvariants.js";
import {
  READINESS_TTL_MS,
  forgetSchemaReadiness,
  tenantSchemaReadiness,
} from "./core/db/schemaReadiness.js";

/**
 * A database whose index listing we control, and which COUNTS what was asked of it — the cache
 * assertions are about the number of round trips, so the count has to be real.
 */
function fakeDb(indexesByCollection: Record<string, unknown[]>): {
  db: Connection;
  calls: () => number;
  writes: () => string[];
} {
  let calls = 0;
  const writes: string[] = [];
  const db = {
    collection(name: string) {
      return {
        indexes: () => {
          calls += 1;
          const found = indexesByCollection[name];
          // Shaped like the real thing, because the inspector tells the two errors apart by CODE:
          // MongoDB 7 answers `NamespaceNotFound` (26) for a collection that was never created,
          // and an unreachable server throws with no code at all. A stub that rejected with a bare
          // Error would make "absent" and "unreachable" indistinguishable here, which is precisely
          // the distinction these tests exist to hold.
          if (!found)
            return Promise.reject(Object.assign(new Error(`ns not found: ${name}`), { code: 26 }));
          return Promise.resolve(found);
        },
        // Any of these being reached is a failure of the read-only claim, so they record it.
        insertOne: () => {
          writes.push(`insertOne:${name}`);
          return Promise.resolve({});
        },
        updateOne: () => {
          writes.push(`updateOne:${name}`);
          return Promise.resolve({});
        },
        createIndex: () => {
          writes.push(`createIndex:${name}`);
          return Promise.resolve("");
        },
        deleteMany: () => {
          writes.push(`deleteMany:${name}`);
          return Promise.resolve({});
        },
      };
    },
  } as unknown as Connection;
  return { db, calls: () => calls, writes: () => writes };
}

/** The index Mongo would report for a declared invariant — i.e. the constraint actually armed. */
const armed = (i: SafetyInvariant): Record<string, unknown> => ({
  key: i.key,
  unique: true,
  ...(i.partialFilterExpression ? { partialFilterExpression: i.partialFilterExpression } : {}),
});

/** A fully converged tenant: every declared invariant armed, in its own collection. */
function healthy(): Record<string, unknown[]> {
  const byCollection: Record<string, unknown[]> = {};
  for (const invariant of CLINICAL_SAFETY_INVARIANTS) {
    byCollection[invariant.collection] = [
      ...(byCollection[invariant.collection] ?? []),
      armed(invariant),
    ];
  }
  return byCollection;
}

const withoutRule = (rule: string): Record<string, unknown[]> => {
  const byCollection: Record<string, unknown[]> = {};
  for (const invariant of CLINICAL_SAFETY_INVARIANTS) {
    if (invariant.rule === rule) {
      byCollection[invariant.collection] ??= [];
      continue;
    }
    byCollection[invariant.collection] = [
      ...(byCollection[invariant.collection] ?? []),
      armed(invariant),
    ];
  }
  return byCollection;
};

const DOSE_SLOT = "the same scheduled dose cannot be charted twice";
const CLAIM = "one Idempotency-Key claim survives, so a retry replays instead of repeating";
const MAR = ["medication-administration", "idempotent-replay"] as const;

beforeEach(() => {
  forgetSchemaReadiness();
});

/* ── 1. the verdict ─────────────────────────────────────────────────────────── */

describe("what the running application is allowed to assume", () => {
  it("is safe when every constraint MAR rests on is armed", async () => {
    const { db } = fakeDb(healthy());

    const readiness = await tenantSchemaReadiness("t-1", db, MAR);

    expect(readiness.safe).toBe(true);
    expect(readiness.missing).toEqual([]);
  });

  /**
   * ── THE ONE THAT MATTERS ──────────────────────────────────────────────────
   * Without this index `repo.record` inserts unconditionally and both nurses are told "recorded".
   */
  it("is NOT safe when the dose-slot index is gone", async () => {
    const { db } = fakeDb(withoutRule(DOSE_SLOT));

    const readiness = await tenantSchemaReadiness("t-1", db, MAR);

    expect(readiness.safe).toBe(false);
    expect(readiness.missing.map((m) => m.invariant.rule)).toEqual([DOSE_SLOT]);
    // The remedy has to reach whoever is paged, so the migration travels with the finding.
    expect(readiness.missing[0]?.invariant.migration).toBe("0049-one-administration-per-dose-slot");
  });

  /**
   * A PRN dose carries no `scheduledFor`, so the dose-slot index deliberately does not cover it.
   * The Idempotency-Key claim is then the ONLY thing between a retried request and a second dose —
   * which is why MAR asks for both and not just its own.
   */
  it("is NOT safe when the idempotency claim index is gone, even though MAR's own is armed", async () => {
    const { db } = fakeDb(withoutRule(CLAIM));

    const readiness = await tenantSchemaReadiness("t-1", db, MAR);

    expect(readiness.safe).toBe(false);
    expect(readiness.missing.map((m) => m.invariant.rule)).toEqual([CLAIM]);
  });

  it("reports an index that exists on the right fields but does not enforce the rule", async () => {
    const slot = CLINICAL_SAFETY_INVARIANTS.find((i) => i.rule === DOSE_SLOT)!;
    const state = withoutRule(DOSE_SLOT);
    state[slot.collection] = [{ key: slot.key, unique: false }]; // the dangerous impostor

    const readiness = await tenantSchemaReadiness("t-1", fakeDb(state).db, MAR);

    expect(readiness.safe).toBe(false);
    expect(readiness.missing[0]?.found).toContain("does not enforce the rule");
  });
});

/* ── 2. proportionality — what must NOT be blocked ──────────────────────────── */

describe("a refusal is scoped to the capability that actually lost its arbiter", () => {
  /**
   * Measured on 2026-08-16: with `labTests` absent entirely, MAR still arbitrates correctly. MAR's
   * safety rests on its own constraints and nothing else, so a pending migration elsewhere — or a
   * missing constraint belonging to another capability — must not stop a nurse charting a dose.
   */
  it("a constraint belonging to ANOTHER capability does not block MAR", async () => {
    for (const rule of CLINICAL_SAFETY_INVARIANTS.filter(
      (i) => !MAR.includes(i.capability as (typeof MAR)[number]),
    )) {
      const readiness = await tenantSchemaReadiness("t-1", fakeDb(withoutRule(rule.rule)).db, MAR);

      expect(readiness.safe, `${rule.capability} must not block charting`).toBe(true);
      forgetSchemaReadiness();
    }
  });

  it("dispensing is unaffected by a missing MAR index, and vice versa", async () => {
    const { db } = fakeDb(withoutRule(DOSE_SLOT));

    expect((await tenantSchemaReadiness("t-1", db, ["dispensing"])).safe).toBe(true);
    expect((await tenantSchemaReadiness("t-1", db, MAR)).safe).toBe(false);
  });

  /**
   * Vitals (migration 0025) creates NO unique index, and nursing notes' only uniqueness is partial
   * on `type: "discharge_summary"`. Neither has a correctness dependency on uniqueness, so neither
   * appears in the declaration — and asking about a capability with no invariants is vacuously
   * safe. If somebody ever adds a vitals invariant, this test is where they will notice.
   */
  it("declares no invariant for vitals or nursing notes, so nothing can block them", () => {
    const collections = CLINICAL_SAFETY_INVARIANTS.map((i) => i.collection);

    expect(collections).not.toContain("vitals");
    const wardNoteRules = CLINICAL_SAFETY_INVARIANTS.filter((i) => i.collection === "wardNotes");
    expect(wardNoteRules).toHaveLength(1);
    expect(wardNoteRules[0]?.partialFilterExpression).toEqual({ type: "discharge_summary" });
  });
});

/* ── 3. failing closed, and only as far as necessary ────────────────────────── */

describe("an unknown state is never treated as a safe one", () => {
  it("refuses when the database cannot be inspected at all", async () => {
    const exploding = {
      collection: () => ({
        indexes: () => Promise.reject(new Error("connection timed out")),
      }),
    } as unknown as Connection;

    const readiness = await tenantSchemaReadiness("t-1", exploding, MAR);

    expect(readiness.safe).toBe(false);
    // NOT presented as a schema finding — nothing was learned about the schema.
    expect(readiness.unknown).toContain("connection timed out");
    expect(readiness.missing).toEqual([]);
  });

  /**
   * A cached failure would keep refusing for a full TTL after the database recovered, turning a
   * two-second blip into a minute of refused medication charting. That is a clinical cost paid for
   * nothing, so failures are never cached.
   */
  it("does not cache a failed inspection — recovery is immediate", async () => {
    let broken = true;
    const flaky = {
      collection: (name: string) => ({
        indexes: () =>
          broken
            ? Promise.reject(new Error("connection timed out"))
            : Promise.resolve(healthy()[name] ?? []),
      }),
    } as unknown as Connection;

    expect((await tenantSchemaReadiness("t-1", flaky, MAR)).safe).toBe(false);
    broken = false;
    expect((await tenantSchemaReadiness("t-1", flaky, MAR)).safe).toBe(true);
  });
});

/* ── 4. the cache ───────────────────────────────────────────────────────────── */

describe("the cache — one inspection a minute, and never the wrong tenant's", () => {
  it("inspects once and reuses the verdict inside the TTL", async () => {
    const { db, calls } = fakeDb(healthy());

    await tenantSchemaReadiness("t-1", db, MAR, { now: 1_000 });
    const afterFirst = calls();
    await tenantSchemaReadiness("t-1", db, MAR, { now: 1_000 + READINESS_TTL_MS - 1 });

    expect(afterFirst).toBeGreaterThan(0);
    expect(calls()).toBe(afterFirst);
  });

  it("re-inspects once the TTL has passed", async () => {
    const { db, calls } = fakeDb(healthy());

    await tenantSchemaReadiness("t-1", db, MAR, { now: 1_000 });
    const afterFirst = calls();
    await tenantSchemaReadiness("t-1", db, MAR, { now: 1_000 + READINESS_TTL_MS });

    expect(calls()).toBe(afterFirst * 2);
  });

  /**
   * ── THE INCIDENT THIS PREVENTS ────────────────────────────────────────────
   * A verdict keyed on anything but the tenant would let a healthy hospital's "safe" answer
   * authorise charting in a drifted one. The databases are physically separate (ADR-0005) and so
   * are their schemas; the cache must say so too.
   */
  it("never lets one tenant's verdict answer for another", async () => {
    const healthyTenant = fakeDb(healthy());
    const driftedTenant = fakeDb(withoutRule(DOSE_SLOT));

    expect((await tenantSchemaReadiness("t-healthy", healthyTenant.db, MAR)).safe).toBe(true);
    expect((await tenantSchemaReadiness("t-drifted", driftedTenant.db, MAR)).safe).toBe(false);
    // And back again — a later read of the healthy tenant is not poisoned by the drifted one.
    expect((await tenantSchemaReadiness("t-healthy", healthyTenant.db, MAR)).safe).toBe(true);
  });

  it("a stale verdict expires rather than surviving a schema change for ever", async () => {
    let indexes = healthy();
    const shifting = {
      collection: (name: string) => ({ indexes: () => Promise.resolve(indexes[name] ?? []) }),
    } as unknown as Connection;

    expect((await tenantSchemaReadiness("t-1", shifting, MAR, { now: 0 })).safe).toBe(true);
    indexes = withoutRule(DOSE_SLOT); // somebody drops the index
    expect((await tenantSchemaReadiness("t-1", shifting, MAR, { now: 1 })).safe).toBe(true); // cached
    expect(
      (await tenantSchemaReadiness("t-1", shifting, MAR, { now: READINESS_TTL_MS })).safe,
    ).toBe(false);
  });

  /** The TTL is a safety parameter — the window in which drift goes unnoticed. */
  it("trusts a verdict for no longer than a minute", () => {
    expect(READINESS_TTL_MS).toBe(60_000);
  });
});

/* ── 5. the check itself must not write ─────────────────────────────────────── */

describe("checking is a read", () => {
  it("performs no write of any kind while inspecting", async () => {
    const { db, writes } = fakeDb(healthy());

    await tenantSchemaReadiness("t-1", db, MAR, { now: 0 });
    await tenantSchemaReadiness("t-1", db, MAR, { now: READINESS_TTL_MS * 2 });

    expect(writes()).toEqual([]);
  });

  it("does not try to create the index it finds missing", async () => {
    const { db, writes } = fakeDb(withoutRule(DOSE_SLOT));

    await tenantSchemaReadiness("t-1", db, MAR);

    // Repair is a reviewable operator step, never a side effect of a clinical request — the same
    // reason every model sets `autoIndex: false`.
    expect(writes()).toEqual([]);
  });
});

/* ── 6. the declaration ─────────────────────────────────────────────────────── */

describe("the declared invariants", () => {
  it("names the capability each one protects, and a migration that installs it", () => {
    for (const invariant of CLINICAL_SAFETY_INVARIANTS) {
      expect(invariant.capability, invariant.rule).toBeTruthy();
      expect(invariant.migration, invariant.rule).toMatch(/^\d{4}-/);
      expect(invariant.why.length, invariant.rule).toBeGreaterThan(20);
      expect(invariant.unique).toBe(true);
    }
  });

  it("resolves the invariants a capability rests on, and nothing else", () => {
    const marOnly = invariantsFor(["medication-administration"]);

    expect(marOnly).toHaveLength(1);
    expect(marOnly[0]?.collection).toBe("medicationAdministrations");
    expect(invariantsFor([])).toEqual([]);
  });

  it("covers the eight sole-arbiter constraints found by reading each write path", () => {
    expect(new Set(CLINICAL_SAFETY_INVARIANTS.map((i) => i.capability))).toEqual(
      new Set([
        "medication-administration",
        "idempotent-replay",
        "dispensing",
        "ordering",
        "bed-occupancy",
        "open-encounter",
        "discharge-summary",
        "patient-identity",
      ]),
    );
  });
});
