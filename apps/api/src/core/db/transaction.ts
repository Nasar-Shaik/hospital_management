/**
 * Transactions on the tenant database (Doc 03 §5.2, Doc 09 §9).
 *
 * ── WHY THIS ARRIVES WITH THE PATIENTS MODULE, AND NOT BEFORE ────────────────
 * Every service up to now wrote ONE collection per request, and a single-document
 * write in MongoDB is already atomic — a transaction would have been ceremony.
 * Registering a patient is the first operation with a genuine multi-document
 * invariant: it allocates a UHID from `counters`, inserts into `patients`, appends
 * to `auditLogs`, and writes to `outboxEvents`. Those four must commit together or
 * not at all. Half of them is not a slower success, it is corruption:
 *
 *   counter++ then crash   → a UHID is burned; the next patient skips a number
 *   patient  then crash    → a patient with no audit entry — invisible in the trail
 *   patient  then crash    → a registration nobody is ever notified about
 *   audit    then crash    → the trail records a patient who does not exist
 *
 * ── WHAT IT BUYS FOR FREE ────────────────────────────────────────────────────
 * `recordAudit` and `publish` have accepted a `session` since A5, and `auditPlugin`
 * already threads the session of the query that triggered it. So a service that
 * wraps its work in `withTransaction` gets **audit atomic with the mutation it
 * describes** with no change to any of that machinery. This closes the debt entry
 * recorded in PROJECT_MEMORY at A5 ("audit is not yet atomic with the mutation").
 *
 * ── THE CALLBACK MAY RUN MORE THAN ONCE ──────────────────────────────────────
 * `withTransaction` retries on transient errors (write conflicts — two clerks
 * registering a patient at the same instant contend on the UHID counter, and one
 * loses and retries). So the callback must contain ONLY database work: no email,
 * no queue push, no counter in memory, nothing that a second execution would do
 * twice. This is exactly why the outbox exists — the intent to notify is a
 * database row here, and the relay sends it after the commit.
 *
 * Requires a replica set. The dev compose and CI both run a single-node one; a
 * standalone mongod fails here immediately and unmistakably, which is the point.
 */
import type { ClientSession } from "mongoose";
import { getTenantDb } from "../context/requestContext.js";

/**
 * Runs `fn` inside a transaction on the current request's tenant database and
 * returns its result. Commits on success; aborts on any thrown error, which then
 * propagates unchanged so the route's error handler still sees the real cause.
 */
export async function withTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await getTenantDb().startSession();

  try {
    // A holder rather than a plain `let result: T` assigned inside: on a retry the
    // callback runs again and must overwrite cleanly, and `undefined` has to stay
    // a legal result for a `Promise<void>` caller.
    const holder: { value?: T } = {};

    await session.withTransaction(async () => {
      holder.value = await fn(session);
    });

    return holder.value as T;
  } finally {
    // Always: a leaked session pins a server-side cursor and a connection.
    await session.endSession();
  }
}
