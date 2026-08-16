/**
 * Per-tenant migration runner (Doc 04 §7).
 *
 * Every tenant database tracks its OWN applied migrations in a `migrations`
 * collection, so a newly provisioned or restored tenant converges automatically
 * without a fleet-wide replay. Runs are idempotent and re-runnable; a failure on
 * one tenant DB halts only that tenant (risk T2).
 *
 * Migrations follow expand → migrate → contract (RELEASE_MANAGEMENT §6):
 * a release must never require its own migration to serve traffic.
 */
import type { Connection } from "mongoose";

export interface Migration {
  /** Monotonic, unique, never renumbered. Shape: `NNNN-kebab-name`. */
  id: string;
  description: string;
  /**
   * Read-only: can this migration succeed against the data already in this database?
   *
   * Returns the blocking reason, or `null` when it would apply cleanly. Most migrations need none
   * — a widened unique key cannot be violated by data that satisfied the narrower one, and an
   * index whose key includes a brand-new field covers zero historical rows. It exists for the
   * ones that CAN fail (0048), and it exists as a separate function rather than a throw inside
   * `up` so the deployment gate can predict the failure **without causing it**. `migrateTenantDb`
   * calls it too, so the prediction and the real attempt can never disagree.
   */
  preflight?: (db: Connection) => Promise<string | null>;
  up: (db: Connection) => Promise<void>;
  down: (db: Connection) => Promise<void>;
}

export interface MigrationRecord {
  _id: string;
  description: string;
  appliedAt: Date;
}

const MIGRATIONS_COLLECTION = "migrations";

/** The tenant's own account of what has been applied to it. Reads nothing else. */
export async function readHistory(db: Connection): Promise<MigrationRecord[]> {
  return db.collection<MigrationRecord>(MIGRATIONS_COLLECTION).find({}).toArray();
}

async function appliedIds(db: Connection): Promise<Set<string>> {
  const records = await db
    .collection<MigrationRecord>(MIGRATIONS_COLLECTION)
    .find({}, { projection: { _id: 1 } })
    .toArray();
  return new Set(records.map((r) => r._id));
}

/** The `NNNN` a migration id opens with, or `null` when the id is not one of ours. */
export function migrationSequence(id: string): number | null {
  const match = /^(\d{4})-/.exec(id);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/**
 * What this tenant's history says, judged against the migrations THIS RELEASE ships.
 *
 * ── WHY A SET DIFFERENCE IS NOT ENOUGH ──────────────────────────────────────
 * `pendingCount` asks one question: which of my migrations are missing from that list? It is the
 * right question and it stays the canonical one, but it is blind in both directions.
 *
 * It cannot see a record it does not recognise. A tenant migrated by a NEWER release and then
 * served by an OLDER one (an ordinary rollback) has every known id recorded, so the difference is
 * empty and the tenant reports "converged" — true, but silently. That is a fact an operator
 * deploying an older build should be told, not left to infer.
 *
 * And it cannot see an IMPOSSIBLE history. A record whose number this release knows under a
 * different name means an id was renumbered — the one thing `Migration.id` forbids. A migration
 * still pending while a LATER one is already recorded means something applied out of order, and
 * `migrateTenantDb` would happily run the older one now, after the newer. Both arrive at
 * `pendingCount` looking exactly like ordinary lag, and "run `migrate --all`" is the wrong
 * instruction for both.
 */
export interface HistoryAnalysis {
  /** Recorded, and known to this release. */
  applied: string[];
  /** Known to this release, not recorded. */
  pending: string[];
  /**
   * Recorded, numbered beyond anything this release ships — the tenant is on a NEWER schema.
   * Not a failure: expand→migrate→contract makes old code compatible with the expanded schema,
   * and RELEASE_MANAGEMENT §6 defines rollback as redeploying the previous image against exactly
   * this state. Reported, never blocking.
   */
  ahead: string[];
  /** Recorded states that cannot have arisen from running this release's migrations in order. */
  inconsistent: string[];
}

export function analyseHistory(
  records: readonly Pick<MigrationRecord, "_id">[],
  migrations: readonly Migration[],
): HistoryAnalysis {
  const known = new Set(migrations.map((m) => m.id));
  const bySequence = new Map<number, string>();
  for (const migration of migrations) {
    const sequence = migrationSequence(migration.id);
    if (sequence !== null) bySequence.set(sequence, migration.id);
  }
  const highestKnown = Math.max(-1, ...[...bySequence.keys()]);

  const applied: string[] = [];
  const ahead: string[] = [];
  const inconsistent: string[] = [];

  for (const record of records) {
    if (known.has(record._id)) {
      applied.push(record._id);
      continue;
    }
    const sequence = migrationSequence(record._id);
    if (sequence === null) {
      inconsistent.push(`\`${record._id}\` is not a migration id — expected \`NNNN-name\``);
    } else if (sequence > highestKnown) {
      ahead.push(record._id);
    } else if (bySequence.has(sequence)) {
      inconsistent.push(
        `\`${record._id}\` holds number ${String(sequence)}, which this release ships as ` +
          `\`${String(bySequence.get(sequence))}\` — a migration was renumbered or renamed`,
      );
    } else {
      inconsistent.push(
        `\`${record._id}\` is recorded but no such migration exists in this release, and its ` +
          `number is below the newest one shipped`,
      );
    }
  }

  const appliedSet = new Set(applied);
  const pending = migrations.filter((m) => !appliedSet.has(m.id));
  // A gap: an earlier migration is outstanding while a later one has already run. `migrateTenantDb`
  // would apply it NOW, after its successor — so this is not lag, and converging is not the remedy.
  const highestApplied = Math.max(
    -1,
    ...applied.map((id) => migrationSequence(id) ?? -1),
    ...ahead.map((id) => migrationSequence(id) ?? -1),
  );
  for (const migration of pending) {
    const sequence = migrationSequence(migration.id);
    if (sequence !== null && sequence < highestApplied) {
      inconsistent.push(
        `\`${migration.id}\` is outstanding while migration ${String(highestApplied)} is already ` +
          `recorded — this history has a gap and converging would apply it out of order`,
      );
    }
  }

  return {
    applied,
    pending: pending.map((m) => m.id),
    ahead,
    inconsistent,
  };
}

/**
 * Applies all pending migrations to ONE tenant database, in order.
 * Returns the ids applied (empty when already converged).
 */
export async function migrateTenantDb(db: Connection, migrations: Migration[]): Promise<string[]> {
  const done = await appliedIds(db);
  const pending = migrations.filter((m) => !done.has(m.id));
  const applied: string[] = [];

  for (const migration of pending) {
    // Refuse before acting, and refuse with the migration's own words. Running this here rather
    // than inside `up` is what lets `migrate --check` predict the refusal without provoking it.
    const blocked = await migration.preflight?.(db);
    if (blocked !== undefined && blocked !== null) throw new Error(blocked);
    await migration.up(db);
    await db.collection<MigrationRecord>(MIGRATIONS_COLLECTION).insertOne({
      _id: migration.id,
      description: migration.description,
      appliedAt: new Date(),
    });
    applied.push(migration.id);
  }
  return applied;
}

/** Rolls back one migration on one tenant database (never automatic in production). */
export async function rollbackTenantDb(db: Connection, migration: Migration): Promise<void> {
  await migration.down(db);
  await db.collection<MigrationRecord>(MIGRATIONS_COLLECTION).deleteOne({ _id: migration.id });
}

/**
 * How many migrations this tenant is behind.
 *
 * OBSERVABILITY_GUIDE lists `hms_migration_pending{tenant}` as the metric this would feed, and a
 * comment here used to say it did. It does not: that catalogue is a design for an observability
 * layer this API has not built — no `prom-client`, no `/metrics`, no registry. Until it exists the
 * fleet answer is `migrate --check`, which calls this for every tenant and exits non-zero if any
 * is behind. (Risk register T2.)
 */
export async function pendingCount(db: Connection, migrations: Migration[]): Promise<number> {
  const done = await appliedIds(db);
  return migrations.filter((m) => !done.has(m.id)).length;
}
