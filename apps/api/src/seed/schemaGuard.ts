/**
 * Can this database ENFORCE the rules the validation is about to test?
 *
 * ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────
 * `seed:validation --verify` checked nineteen facts about the DATA — a nurse exists, 42 patients
 * are admitted, a dose is due — and nothing at all about the SCHEMA. On 2026-08-14 it reported
 * READY against a database with no unique index on `medicationAdministrations`: migrations 0048 and
 * 0049 had never been applied to any of the four local tenants, because migrations run inside
 * `provisionTenant` and `seed:demo` skips provisioning for a hospital that already exists.
 *
 * A safety probe against that "READY" environment reported two nurses both charting the same dose,
 * duplicate second attempts, and every idempotency replay writing a new row. **All of it was the
 * absence of the mechanism, not a fault in it.** A person meeting that on a handset would have
 * raised duplicate administration as a P0 and been wrong.
 *
 * Hence the rule this module exists to enforce: **a validation environment must not report READY if
 * the database cannot enforce the safety mechanisms the validation depends on.** (Risk register T2.)
 *
 * ── TWO CHECKS, BECAUSE THEY ANSWER DIFFERENT QUESTIONS ─────────────────────
 * 1. `pendingCount()` — the CANONICAL convergence answer, already owned by the migration runner and
 *    already feeding `hms_migration_pending`. It covers every migration, not a hand-picked few, and
 *    this module deliberately does not invent a second version system to sit beside it.
 *
 * 2. A direct look at the INDEXES themselves. A migration record is weaker evidence than the
 *    constraint: the runner writes the record only after `up()` succeeds, so a failed migration
 *    leaves no record and check 1 catches it — but an index dropped afterwards, by hand or by a
 *    restore from an older backup, leaves the record behind and check 1 goes on saying "converged".
 *    Only the database can answer whether the rule is actually armed.
 *
 * ── WHY THE CHECK IS ON THE KEY AND NOT THE NAME ────────────────────────────
 * Matching `name: "one_administration_per_dose_slot"` would fail if somebody renamed the index while
 * keeping the rule, and pass if somebody kept the name while changing the key — both backwards. The
 * check below asserts the SHAPE the clinical invariant requires: these fields, unique, and (where it
 * matters) this partial filter. That is what "the same dose cannot be charted twice" means in
 * storage terms, and it is what has to be true regardless of what the index is called.
 *
 * ── SCOPE, STATED PLAINLY ───────────────────────────────────────────────────
 * **This checks ONE tenant — the one being validated — and claims nothing about any other.** It is
 * not a fleet convergence metric and must not be described as one; T2 asks for that and T2 stays
 * open. `pnpm seed:migrate --all` remains the way to converge the fleet, and this is the gate that
 * refuses to certify an environment where somebody forgot.
 */
import type { Connection } from "mongoose";
import { pendingCount, type Migration } from "../core/db/migrations/runner.js";

/**
 * A storage constraint that a clinical rule rests on.
 *
 * `why` is not decoration: when this fires, the reader needs to know what stops working, not which
 * index is absent.
 */
export interface SafetyInvariant {
  /** The clinical rule, in the words a nurse would use. */
  rule: string;
  collection: string;
  /** The key the rule requires. Field order matters — an index is only usable in its own order. */
  key: Record<string, 1>;
  unique: true;
  /** Present when the rule deliberately covers only some rows (PRN doses have no slot). */
  partialFilterExpression?: Record<string, unknown>;
  /** What goes wrong, silently, when it is missing. */
  why: string;
  /** The migration that installs it — quoted in the remediation message. */
  migration: string;
}

/**
 * The invariants the M2/M3 manual validation actually rests on.
 *
 * Deliberately NOT "every unique index in the product". These two are here because their absence is
 * what produced the seven false safety failures on 2026-08-14 — that is the evidence for the list,
 * and a list that grows past its evidence becomes a thing people stop reading. `pendingCount()`
 * already covers everything else.
 */
export const CLINICAL_SAFETY_INVARIANTS: readonly SafetyInvariant[] = [
  {
    rule: "the same scheduled dose cannot be charted twice",
    collection: "medicationAdministrations",
    key: { tenantId: 1, prescriptionId: 1, lineIndex: 1, scheduledFor: 1 },
    unique: true,
    // PRN doses carry no slot and may legitimately be given many times — constraining them would
    // refuse a real second dose. The filter is part of the rule, not an optimisation.
    partialFilterExpression: { scheduledFor: { $exists: true } },
    why: "two nurses charting the same round both succeed, and the chart reads as a double dose",
    migration: "0049-one-administration-per-dose-slot",
  },
  {
    rule: "one Idempotency-Key claim survives, so a retry replays instead of repeating",
    collection: "idempotencyKeys",
    key: { tenantId: 1, userId: 1, key: 1 },
    unique: true,
    why: "a lost response retried with the held key writes a SECOND administration or observation",
    migration: "0048-idempotency-key-claims",
  },
] as const;

export interface MissingInvariant {
  invariant: SafetyInvariant;
  /** What was actually found — so the reader can tell "absent" from "present but wrong". */
  found: string;
}

export interface SchemaVerdict {
  ok: boolean;
  /** Migration ids the canonical runner still considers outstanding. */
  pending: string[];
  missing: MissingInvariant[];
}

/** Mongo reports index keys in definition order; compare as ordered pairs, not as a set. */
function sameKey(actual: Record<string, unknown>, expected: Record<string, 1>): boolean {
  const a = Object.entries(actual);
  const b = Object.entries(expected);
  if (a.length !== b.length) return false;
  return a.every(([field, dir], i) => b[i]?.[0] === field && Number(dir) === b[i]?.[1]);
}

function samePartial(actual: unknown, expected: Record<string, unknown> | undefined): boolean {
  if (expected === undefined) return actual === undefined;
  if (actual === undefined) return false;
  return JSON.stringify(actual) === JSON.stringify(expected);
}

/**
 * Reads the schema. Writes nothing — it is safe to run against an environment somebody is testing.
 */
export async function verifyTenantSchema(
  db: Connection,
  migrations: Migration[],
  invariants: readonly SafetyInvariant[] = CLINICAL_SAFETY_INVARIANTS,
): Promise<SchemaVerdict> {
  const outstanding = await pendingCount(db, migrations);
  const pending: string[] = [];
  if (outstanding > 0) {
    // Name them rather than counting them: "2 pending" sends the reader to the runner, and the
    // whole point of this check is to hand over an answer instead of a next investigation.
    const applied = new Set(
      (
        await db
          .collection<{ _id: string }>("migrations")
          .find({}, { projection: { _id: 1 } })
          .toArray()
      ).map((r) => r._id),
    );
    pending.push(...migrations.filter((m) => !applied.has(m.id)).map((m) => m.id));
  }

  const missing: MissingInvariant[] = [];
  for (const invariant of invariants) {
    // `indexes()` throws when the collection does not exist yet — which IS the finding, not an error.
    let indexes: {
      key: Record<string, unknown>;
      unique?: boolean;
      partialFilterExpression?: unknown;
    }[];
    try {
      indexes = (await db.collection(invariant.collection).indexes()) as typeof indexes;
    } catch {
      missing.push({ invariant, found: `collection \`${invariant.collection}\` does not exist` });
      continue;
    }

    const match = indexes.find(
      (ix) =>
        sameKey(ix.key, invariant.key) &&
        ix.unique === true &&
        samePartial(ix.partialFilterExpression, invariant.partialFilterExpression),
    );
    if (match) continue;

    // Distinguish "no such index" from "an index on those fields that does not enforce the rule" —
    // the second is the more alarming finding and the more confusing one to debug.
    const sameFields = indexes.find((ix) => sameKey(ix.key, invariant.key));
    missing.push({
      invariant,
      found: sameFields
        ? `an index on those fields exists but does not enforce the rule (unique=${String(sameFields.unique === true)}, partial=${JSON.stringify(sameFields.partialFilterExpression ?? null)})`
        : "no index on those fields",
    });
  }

  return { ok: pending.length === 0 && missing.length === 0, pending, missing };
}

/** The refusal, written for somebody who has to fix it and does not want to read this file. */
export function schemaBlockedMessage(slug: string, verdict: SchemaVerdict): string {
  const lines = [
    "",
    "  VALIDATION BLOCKED — this database cannot enforce the rules the validation tests.",
    `${"─".repeat(78)}`,
    `  Tenant: ${slug}`,
    "",
  ];

  if (verdict.pending.length > 0) {
    lines.push(
      `  Not schema-converged — ${String(verdict.pending.length)} migration(s) outstanding:`,
    );
    for (const id of verdict.pending) lines.push(`    · ${id}`);
    lines.push("");
  }

  for (const { invariant, found } of verdict.missing) {
    lines.push(`  Missing safety invariant: ${invariant.rule}`);
    lines.push(`    collection  ${invariant.collection}`);
    lines.push(
      `    required    unique index on {${Object.keys(invariant.key).join(", ")}}` +
        (invariant.partialFilterExpression
          ? ` where ${JSON.stringify(invariant.partialFilterExpression)}`
          : ""),
    );
    lines.push(`    found       ${found}`);
    lines.push(`    installed by ${invariant.migration}`);
    lines.push(`    without it  ${invariant.why}`);
    lines.push("");
  }

  /**
   * ── TWO FAILURE MODES, TWO DIFFERENT REMEDIES ───────────────────────────────
   * They must not share one instruction, because the obvious instruction is wrong for one of them.
   *
   * `migrateTenantDb` skips any migration already listed in `migrations`. So when a constraint is
   * gone but its record remains — dropped by hand, or restored from a backup taken before it —
   * `seed:migrate` re-runs NOTHING, prints "tenant converged", and leaves the database exactly as
   * unsafe as it found it. Verified on 2026-08-14: `migrationsApplied: []`, index still absent.
   * Telling somebody to run it would send them away believing they had fixed this.
   */
  const drifted = verdict.missing.length > 0 && verdict.pending.length === 0;

  lines.push("  Remediation:", "");
  if (drifted) {
    lines.push(
      "  The migration is RECORDED as applied but the constraint is not in the database, so",
      "  `seed:migrate` will skip it and report success without changing anything. Clear the",
      "  record first, then converge:",
      "",
      ...verdict.missing.map(
        (m) =>
          `      db.migrations.deleteOne({ _id: "${m.invariant.migration}" })   # in hms_${slug}`,
      ),
      `      pnpm seed:migrate --slug ${slug}`,
      "",
      "  A dropped index on a live tenant is worth understanding before it is simply replaced —",
      "  something removed it, and a re-created index will not say what.",
    );
  } else {
    lines.push(
      `      pnpm seed:migrate --slug ${slug}        # this tenant`,
      "      pnpm seed:migrate --all                # every tenant in this database",
      "",
      "  Migrations run inside hospital PROVISIONING, and `seed:demo` skips provisioning for a",
      "  hospital that already exists — so a database created before this release keeps its old",
      "  schema and nothing says so.",
    );
  }
  lines.push(
    "",
    "  Re-run `pnpm seed:validation -- --verify` afterwards.",
    "  Any manual-validation result taken against this tenant before it converges is void.",
    `${"─".repeat(78)}`,
    "",
  );
  return lines.join("\n");
}
