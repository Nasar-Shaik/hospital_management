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
import {
  CLINICAL_SAFETY_INVARIANTS,
  inspectInvariants,
  type MissingInvariant,
  type SafetyInvariant,
} from "../core/db/clinicalInvariants.js";
import {
  analyseHistory,
  readHistory,
  type HistoryAnalysis,
  type Migration,
} from "../core/db/migrations/runner.js";

/**
 * The invariant declaration moved to `core/db/clinicalInvariants.ts` when the running application
 * became a second consumer of it. It is re-exported here unchanged so every existing importer — the
 * deployment gate, `seed:validation`, the tests — keeps working, and so there remains exactly ONE
 * list of what the database must be able to enforce.
 */
export {
  CLINICAL_SAFETY_INVARIANTS,
  invariantsFor,
  type ClinicalCapability,
  type MissingInvariant,
  type SafetyInvariant,
} from "../core/db/clinicalInvariants.js";

export interface SchemaVerdict {
  ok: boolean;
  /** Migration ids the canonical runner still considers outstanding. */
  pending: string[];
  missing: MissingInvariant[];
  /**
   * The rest of what the tenant's history says — records this release does not recognise, and
   * records that cannot have arisen from running these migrations in order. `pending` alone cannot
   * express either. See `analyseHistory`.
   */
  history: HistoryAnalysis;
  /**
   * The outstanding migration that would REFUSE to run, and why. Populated only when a pending
   * migration declares a `preflight` and that preflight is currently unsatisfied — so a caller can
   * say "behind, and converging will fail" before the deploy window rather than during it.
   */
  blockedBy?: { migration: string; reason: string };
}

/**
 * Reads the schema. Writes nothing — it is safe to run against an environment somebody is testing.
 */
export async function verifyTenantSchema(
  db: Connection,
  migrations: Migration[],
  invariants: readonly SafetyInvariant[] = CLINICAL_SAFETY_INVARIANTS,
): Promise<SchemaVerdict> {
  // One read of the history, judged completely. `pendingCount` asked the same database the same
  // question and answered only part of it; `analyseHistory` names the pending ids rather than
  // counting them (the whole point of a check is to hand over an answer, not the next
  // investigation) and additionally reports what the set difference cannot see.
  const history = analyseHistory(await readHistory(db), migrations);
  const pending = history.pending;

  /**
   * Ask the FIRST outstanding migration whether it could actually run. Only the first: they apply
   * in order, so a later one's preflight would be answering about a database state that does not
   * exist yet, and a confident wrong prediction is worse than no prediction.
   */
  let blockedBy: SchemaVerdict["blockedBy"];
  const next = migrations.find((m) => m.id === pending[0]);
  if (next?.preflight) {
    const reason = await next.preflight(db);
    if (reason !== null) blockedBy = { migration: next.id, reason };
  }

  const missing = await inspectInvariants(db, invariants);

  return {
    // `ahead` is deliberately absent from this condition. A tenant carrying migrations from a NEWER
    // release is on an EXPANDED schema, which expand→migrate→contract guarantees the older code can
    // serve (RELEASE_MANAGEMENT §6 — rollback is redeploying the previous image against exactly
    // this state). Failing it would make every rollback impossible, which is the opposite of safe.
    ok:
      pending.length === 0 &&
      missing.length === 0 &&
      history.inconsistent.length === 0 &&
      blockedBy === undefined,
    pending,
    missing,
    history,
    ...(blockedBy ? { blockedBy } : {}),
  };
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

  if (verdict.history.inconsistent.length > 0) {
    lines.push("  Migration history is INCONSISTENT — this state cannot arise from a normal run:");
    for (const finding of verdict.history.inconsistent) lines.push(`    · ${finding}`);
    lines.push("");
  }

  if (verdict.pending.length > 0) {
    lines.push(
      `  Not schema-converged — ${String(verdict.pending.length)} migration(s) outstanding:`,
    );
    for (const id of verdict.pending) lines.push(`    · ${id}`);
    lines.push("");
  }

  if (verdict.blockedBy) {
    lines.push(
      `  And converging will FAIL — \`${verdict.blockedBy.migration}\` refuses on the data ` +
        "already here:",
      "",
      ...verdict.blockedBy.reason.split("\n").map((line) => `    ${line}`),
      "",
    );
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
   * ── FOUR FAILURE MODES, FOUR DIFFERENT REMEDIES ─────────────────────────────
   * They must not share one instruction, because the obvious instruction — "run `seed:migrate`" —
   * is wrong for three of them.
   *
   * `migrateTenantDb` skips any migration already listed in `migrations`. So when a constraint is
   * gone but its record remains — dropped by hand, or restored from a backup taken before it —
   * `seed:migrate` re-runs NOTHING, prints "tenant converged", and leaves the database exactly as
   * unsafe as it found it. Verified on 2026-08-14: `migrationsApplied: []`, index still absent.
   * Telling somebody to run it would send them away believing they had fixed this.
   *
   * On an inconsistent history it is worse than useless: it would apply an outstanding migration
   * AFTER one that already ran past it. And when a preflight refuses, it will simply refuse again
   * — the data has to be dealt with first.
   */
  const drifted = verdict.missing.length > 0 && verdict.pending.length === 0;

  lines.push("  Remediation:", "");
  if (verdict.history.inconsistent.length > 0) {
    lines.push(
      "  Do NOT run `seed:migrate` against this tenant. An outstanding migration would be applied",
      "  after one that has already run past it, and a renumbered record means the id this release",
      "  ships is not the id this database holds.",
      "",
      "  Establish first WHERE this history came from — a partial restore, a hand-edited",
      "  `migrations` collection, or a database that was migrated by a different build. The record",
      "  is the only account of what has been applied, so repairing it by guesswork replaces a",
      "  known-bad state with an unknown one.",
    );
  } else if (verdict.blockedBy) {
    lines.push(
      `  Converging is blocked by \`${verdict.blockedBy.migration}\`, not by the schema. Deal with`,
      "  the data it names above, then:",
      "",
      `      pnpm seed:migrate --slug ${slug}`,
    );
  } else if (drifted) {
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
