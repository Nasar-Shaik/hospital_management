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
  /** Monotonic, unique, never renumbered. */
  id: string;
  description: string;
  up: (db: Connection) => Promise<void>;
  down: (db: Connection) => Promise<void>;
}

interface MigrationRecord {
  _id: string;
  description: string;
  appliedAt: Date;
}

const MIGRATIONS_COLLECTION = "migrations";

async function appliedIds(db: Connection): Promise<Set<string>> {
  const records = await db
    .collection<MigrationRecord>(MIGRATIONS_COLLECTION)
    .find({}, { projection: { _id: 1 } })
    .toArray();
  return new Set(records.map((r) => r._id));
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

/** Pending count — feeds the `hms_migration_pending` metric (OBSERVABILITY_GUIDE). */
export async function pendingCount(db: Connection, migrations: Migration[]): Promise<number> {
  const done = await appliedIds(db);
  return migrations.filter((m) => !done.has(m.id)).length;
}
