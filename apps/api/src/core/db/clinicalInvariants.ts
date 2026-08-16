/**
 * THE STORAGE CONSTRAINTS CLINICAL CORRECTNESS RESTS ON — declared once, read by two callers.
 *
 * ── WHY THESE EXIST AS A DECLARATION ────────────────────────────────────────
 * Across roughly twenty modules this application lets the DATABASE arbitrate races rather than
 * checking first and writing second. That is the correct choice — `if (!exists) create()` loses by
 * construction — and `mar.repository.ts` says so outright: "There is deliberately NO read-then-write
 * check… the unique index is what actually arbitrates."
 *
 * The consequence is that a missing index is not a missing optimisation. It is a missing rule, and
 * the code above it goes on behaving as though the rule were still there. Nothing in the
 * application can notice: `create()` simply succeeds. So the constraints have to be written down
 * somewhere both the deployment gate and the running application can check them against the actual
 * database.
 *
 * ── WHY THE LIST IS EXACTLY THIS LONG ───────────────────────────────────────
 * Every entry below is a constraint that some write path treats as its sole arbiter, verified by
 * reading that path. Nothing is here because it looked important. Deliberately absent: `vitals`
 * (migration 0025 creates NO unique index) and nursing notes (`wardNotes`' only uniqueness is
 * partial on `type: "discharge_summary"`). Those capabilities have no correctness dependency on
 * uniqueness at all, and a guard that blocked them would be inventing a rule the product does not
 * have.
 *
 * ── WHY `capability` IS ON EACH ONE ─────────────────────────────────────────
 * So a refusal can be proportionate. A missing dispensing index says nothing about whether a nurse
 * may chart a dose, and blocking a whole hospital because one unrelated constraint is absent would
 * be a worse failure than the one being prevented.
 */
import type { Connection } from "mongoose";

/**
 * A clinical capability whose correctness rests on storage constraints.
 *
 * Deliberately NOT spelled like a permission code (`mar:administer`). These are not permissions and
 * must never be mistaken for them: a permission answers "may this user", this answers "can this
 * database still enforce the rule".
 */
export type ClinicalCapability =
  | "medication-administration"
  | "idempotent-replay"
  | "dispensing"
  | "ordering"
  | "bed-occupancy"
  | "open-encounter"
  | "discharge-summary"
  | "patient-identity";

/**
 * A storage constraint that a clinical rule rests on.
 *
 * `why` is not decoration: when this fires, the reader needs to know what stops working, not which
 * index is absent.
 */
export interface SafetyInvariant {
  /** The capability that cannot be trusted without this. */
  capability: ClinicalCapability;
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
 * Every constraint whose absence turns a correct write path into a silently wrong one.
 *
 * The first two are the pair the 2026-08-14 incident proved, and were the whole list while this
 * served only the validation gate. The rest were found by reading each unique index's write path
 * one at a time: each is documented in its own repository as the thing that arbitrates, so leaving
 * them undeclared while claiming to protect "clinical safety" would have been the more dangerous
 * kind of half-measure — coverage that reads as complete and is not.
 */
export const CLINICAL_SAFETY_INVARIANTS: readonly SafetyInvariant[] = [
  {
    capability: "medication-administration",
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
    capability: "idempotent-replay",
    rule: "one Idempotency-Key claim survives, so a retry replays instead of repeating",
    collection: "idempotencyKeys",
    key: { tenantId: 1, userId: 1, key: 1 },
    unique: true,
    why: "a lost response retried with the held key writes a SECOND administration or observation",
    migration: "0048-idempotency-key-claims",
  },
  {
    capability: "dispensing",
    rule: "one dispense per request id — a retried issue does not hand out the drug twice",
    collection: "dispenses",
    key: { tenantId: 1, requestId: 1 },
    unique: true,
    partialFilterExpression: { requestId: { $exists: true } },
    why: "a retried dispense issues the medicine a second time and decrements stock twice",
    migration: "0015-prescriptions",
  },
  {
    capability: "ordering",
    rule: "one order per request id",
    collection: "orders",
    key: { tenantId: 1, requestId: 1 },
    unique: true,
    partialFilterExpression: { requestId: { $exists: true } },
    why: "a retried request raises a second investigation, which is billed and collected twice",
    migration: "0013-orders",
  },
  {
    capability: "bed-occupancy",
    rule: "one open stay per bed, per branch",
    collection: "encounters",
    key: { tenantId: 1, branchId: 1, "bed.ward": 1, "bed.bedCode": 1 },
    unique: true,
    partialFilterExpression: { open: { $eq: true }, "bed.bedCode": { $exists: true } },
    why: "two patients are recorded in one bed, and the ward board cannot say which is real",
    migration: "0046-branch-aware-uniqueness",
  },
  {
    capability: "open-encounter",
    rule: "a patient has at most one open encounter",
    collection: "encounters",
    key: { tenantId: 1, patientId: 1 },
    unique: true,
    partialFilterExpression: { open: { $eq: true } },
    // `admitPatient` closes the OP encounter and opens the IP one inside ONE transaction precisely
    // because this index refuses the second open row. Without it the ordering guarantee that
    // transaction was written around is gone.
    why: "a patient is open in two places at once, and notes and orders attach to whichever is found",
    migration: "0012-encounters",
  },
  {
    capability: "discharge-summary",
    rule: "one discharge summary per admission",
    collection: "wardNotes",
    key: { tenantId: 1, encounterId: 1, type: 1 },
    unique: true,
    partialFilterExpression: { type: "discharge_summary" },
    why: "a stay ends with two summaries and nothing says which one was sent to the patient",
    migration: "0016-admissions",
  },
  {
    capability: "patient-identity",
    rule: "a UHID identifies exactly one patient",
    collection: "patients",
    key: { tenantId: 1, uhid: 1 },
    unique: true,
    why: "two patients share one hospital number, and a record can be filed against either",
    migration: "0008-patients",
  },
] as const;

/** The invariants a given set of capabilities rests on. */
export function invariantsFor(
  capabilities: readonly ClinicalCapability[],
  invariants: readonly SafetyInvariant[] = CLINICAL_SAFETY_INVARIANTS,
): readonly SafetyInvariant[] {
  return invariants.filter((i) => capabilities.includes(i.capability));
}

export interface MissingInvariant {
  invariant: SafetyInvariant;
  /** What was actually found — so the reader can tell "absent" from "present but wrong". */
  found: string;
}

/** MongoDB `NamespaceNotFound` — the collection has never been created. */
function isNamespaceNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: number }).code === 26;
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
 * Reads the indexes and reports which required constraints are not actually armed.
 *
 * ── WHY THE CHECK IS ON THE KEY AND NOT THE NAME ────────────────────────────
 * Matching `name: "one_administration_per_dose_slot"` would fail if somebody renamed the index while
 * keeping the rule, and pass if somebody kept the name while changing the key — both backwards. This
 * asserts the SHAPE the clinical invariant requires: these fields, in this order, unique, and (where
 * it matters) this partial filter.
 *
 * **Reads only.** Both callers depend on that: the deployment gate must be safe to run against an
 * environment somebody is testing, and the runtime check must never write on a clinical path.
 */
export async function inspectInvariants(
  db: Connection,
  invariants: readonly SafetyInvariant[],
): Promise<MissingInvariant[]> {
  const missing: MissingInvariant[] = [];
  for (const invariant of invariants) {
    let indexes: {
      key: Record<string, unknown>;
      unique?: boolean;
      partialFilterExpression?: unknown;
    }[];
    try {
      indexes = (await db.collection(invariant.collection).indexes()) as typeof indexes;
    } catch (err) {
      /**
       * ── "ABSENT" AND "UNREACHABLE" ARE NOT THE SAME ANSWER ────────────────
       * A collection that does not exist IS the finding — the migration never ran. A database that
       * cannot be reached is not a finding at all, and reporting it as one would tell an operator
       * that eight indexes had been dropped when in fact nothing was learned. Worse, it would let a
       * network blip masquerade as schema drift on a clinical path.
       *
       * Measured against MongoDB 7: a missing namespace is `MongoServerError` code **26**
       * (`NamespaceNotFound`); an unreachable server is `MongooseServerSelectionError` with no code
       * at all. So only 26 is absorbed and everything else propagates to a caller that knows the
       * difference.
       */
      if (!isNamespaceNotFound(err)) throw err;
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
  return missing;
}
