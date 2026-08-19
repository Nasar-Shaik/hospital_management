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

/**
 * ── THE REGISTRATION GAP, AND THE LIST THAT CLOSES IT ───────────────────────
 * `CLINICAL_SAFETY_INVARIANTS` protects what somebody remembered to declare. Nothing stopped a
 * future migration from adding a unique index that IS a clinical sole arbiter and never appearing
 * here — the guard would simply not exist, silently, and no test would notice.
 *
 * So every unique index a migrated tenant actually carries must be accounted for: either declared
 * above, or listed here with a reason it is not a CLINICAL safety constraint. `registrationGap`
 * (schemaGuard.int.test.ts) reads the real indexes off a freshly provisioned tenant and fails if
 * anything is in neither list — and fails the other way too, if an entry here no longer matches a
 * real index, so the list cannot rot into a rubber stamp.
 *
 * ── WHAT "NOT CLINICAL" MEANS HERE ──────────────────────────────────────────
 * Not "unimportant". It means a duplicate would be VISIBLE and CORRECTABLE by a human rather than
 * silently producing a second dose, a second needle, two patients in one bed or two people behind
 * one hospital number. A duplicate ward name is a mess somebody renames; a duplicate charted dose
 * is a fact that cannot be withdrawn.
 */
export interface ExemptUniqueIndex {
  collection: string;
  /** The index name, which is what the gate reads off the database. */
  index: string;
  /** Why losing this is not a clinical runtime-safety failure. */
  reason: string;
  /**
   * Set when the index IS shaped like a clinical arbiter and is a candidate for a future runtime
   * guard, but is not protected today. Recorded so the follow-up is in the code rather than in
   * somebody's memory — the gate treats it exactly like any other exemption.
   */
  candidate?: true;
}

export const NON_CLINICAL_UNIQUE_INDEXES: readonly ExemptUniqueIndex[] = [
  /* ── catalogue and configuration: a duplicate is a mess, not a harm ─────── */
  {
    collection: "departments",
    index: "one_department_code_per_tenant",
    reason: "a duplicate department code is a configuration error an admin can see and rename",
  },
  {
    collection: "icdCodes",
    index: "one_icd_code_per_tenant",
    reason: "reference data; a duplicate ICD row is visible in the picker and editable",
  },
  {
    collection: "labTests",
    index: "one_lab_test_code_per_tenant",
    reason: "catalogue data; a duplicate test definition is visible and editable",
  },
  {
    collection: "medicines",
    index: "one_medicine_per_code",
    reason: "formulary data; a duplicate medicine is visible in the picker and editable",
  },
  {
    collection: "medicineBatches",
    index: "one_row_per_batch",
    /**
     * Weighed rather than assumed, because the recall argument pulls the other way: two rows for
     * one physical box would let FEFO hand the same tablets out twice and would make a recall miss
     * half the stock, and a recall is unquestionably about patients.
     *
     * It is still not a CLINICAL-SAFETY invariant in the sense the other list means. The rule that
     * keeps expired stock away from a patient is the query filter in `allocatableFor`, which holds
     * whether or not a lot is duplicated; the rule that stops a lot being over-drawn is the
     * conditional take. This index protects the BOOKS — it keeps one box as one row — and a
     * duplicate is visible on the pharmacist's Batches view as two lots with the same number,
     * which is exactly the "visible and editable" test the entries above apply.
     */
    reason:
      "stock bookkeeping; a duplicate lot is visible on the batches view as two rows with the " +
      "same number, and neither the expiry refusal nor the over-draw guard depends on it",
  },
  {
    collection: "edTriage",
    index: "one_triage_per_encounter",
    /**
     * ── SHAPED LIKE A CLINICAL ARBITER, AND STILL NOT ONE ───────────────────────
     * The frightening reading is real and was written out before this was decided: two rows for
     * one ED visit means two priorities, the board picks one, and a `critical` patient could be
     * displayed as `non_urgent` while a nurse walks past them.
     *
     * What stops that being the actual failure is WHO races. The index arbitrates an upsert, so a
     * duplicate needs two concurrent writes on the same encounter, and in practice that is one
     * nurse's double tap — which sends the SAME priority twice. Both rows agree, and the board is
     * right whichever it reads. The genuinely divergent case needs two people triaging one patient
     * in the same instant to different conclusions, and then the board shows one of two defensible
     * clinical opinions rather than a wrong one.
     *
     * Contrast the guarded five: a duplicate charted dose is a second dose in a patient, and no
     * reading of it is benign. `candidate` because the shape is close enough that it deserves
     * re-examination the day the ED board is driven by anything other than a person reading it.
     */
    candidate: true,
    reason:
      "a duplicate triage row needs two concurrent triages of one visit — in practice one nurse's " +
      "double tap, which sends the same priority twice, so the board is right either way",
  },
  {
    collection: "serviceItems",
    index: "tenantId_1_code_1",
    reason: "tariff data; a duplicate service line is visible on the price list",
  },
  {
    collection: "servicePackages",
    index: "one_package_code_per_tenant",
    reason: "tariff data; a duplicate package is visible and editable",
  },
  {
    collection: "theatres",
    index: "one_theatre_code_per_tenant",
    reason: "catalogue data; a duplicate theatre is visible on the OT list",
  },
  {
    collection: "wards",
    index: "one_ward_name_per_branch",
    reason: "catalogue data; a duplicate ward name is visible on the bed board and renameable",
  },
  {
    collection: "rooms",
    index: "one_room_name_per_ward",
    reason: "catalogue data; a duplicate room name is visible on the bed board and renameable",
  },
  {
    collection: "hospitalProfile",
    index: "one_profile_per_tenant",
    reason: "one settings document; a duplicate is a configuration fault, not a clinical one",
  },
  {
    collection: "siteSettings",
    index: "one_site_per_tenant",
    reason: "public-website settings; nothing clinical depends on it",
  },
  {
    collection: "notificationTemplates",
    index: "tenantId_1_key_1",
    reason: "message templates; a duplicate template renders the same message twice at most",
  },

  /* ── identity and authorization: security, audited elsewhere ────────────── */
  {
    collection: "users",
    index: "tenantId_1_email_1",
    reason: "account identity; duplicate logins are an auth concern, covered by the auth suite",
  },
  { collection: "roles", index: "tenantId_1_code_1", reason: "RBAC catalogue, seeded and audited" },
  {
    collection: "permissions",
    index: "tenantId_1_code_1",
    reason: "RBAC catalogue, seeded from code and audited by the permission-lifecycle gate",
  },
  {
    collection: "rolePermissions",
    index: "tenantId_1_roleId_1_permissionId_1",
    reason: "RBAC join row; a duplicate grants nothing extra",
  },
  {
    collection: "userRoles",
    index: "tenantId_1_userId_1_roleId_1",
    reason: "RBAC join row; a duplicate grants nothing extra",
  },
  {
    collection: "sessions",
    index: "tenantId_1_family_1",
    reason: "refresh-token family; reuse detection is proven by the auth suite",
  },
  {
    collection: "refreshTokens",
    index: "tenantId_1_tokenHash_1",
    reason: "token storage; collisions are a cryptographic concern, not a clinical one",
  },
  {
    collection: "passwordResetTokens",
    index: "one_reset_token_per_hash",
    reason: "token storage; single-use is enforced by consuming the row",
  },
  {
    collection: "mfaSecrets",
    index: "tenantId_1_userId_1",
    reason: "one secret per user; a duplicate is an auth fault, covered by the auth suite",
  },

  /* ── messaging and eventing: a duplicate is noise ───────────────────────── */
  {
    collection: "notifications",
    index: "one_message_per_cause",
    reason: "dedupe key; losing it sends a message twice, which is noise rather than harm",
  },
  {
    collection: "outboxEvents",
    index: "eventId_1",
    reason: "consumers are required to be idempotent (ADR-0007); redelivery is designed for",
  },

  /* ── money: real, but a different domain from patient harm ──────────────── */
  {
    collection: "invoices",
    index: "one_invoice_per_number",
    reason:
      "a duplicate invoice number is a finance-audit problem, visible on the register and " +
      "correctable by a credit note — no clinical act depends on it",
    candidate: true,
  },
  {
    collection: "walletAccounts",
    index: "one_wallet_per_patient",
    reason: "a second wallet splits a balance; visible on the ledger and reconcilable",
    candidate: true,
  },
  {
    collection: "stockMovements",
    index: "one_stock_move_per_dispense_line",
    reason:
      "protects the stock ledger from double-decrementing a dispense line. The DISPENSE itself " +
      "is already runtime-guarded (HMS-PHM-004), which is the act that reaches the patient; this " +
      "index protects the count behind it",
    candidate: true,
  },

  /* ── scheduling: a clash is visible on the board before anyone is touched ─ */
  {
    collection: "doctorSchedules",
    index: "one_schedule_per_doctor_weekday_branch",
    reason: "clinic template; a duplicate weekday row is visible in the schedule editor",
  },
  {
    collection: "doctorAvailability",
    index: "one_roster_row_per_doctor_weekday_branch",
    reason: "roster row; a duplicate is visible in the availability editor",
  },
  {
    collection: "otBookings",
    index: "one_booking_per_theatre_start",
    reason:
      "two operations booked into one theatre at one time. Shaped exactly like bed occupancy, " +
      "and the strongest candidate for the next runtime guard — but a theatre list is read by a " +
      "human before anybody is wheeled in, and the clash is visible on it, which is not true of " +
      "a bed the ward believes is empty",
    candidate: true,
  },

  /* ── statutory records: one per encounter, written once, by a human ─────── */
  {
    collection: "deathRecords",
    index: "one_death_record_per_encounter",
    reason:
      "one death record per encounter. Written deliberately once by a doctor against a closed " +
      "stay, with no retry path and no concurrency to arbitrate — a second is not a race",
    candidate: true,
  },
  {
    collection: "mortuaryRegister",
    index: "one_body_per_encounter",
    reason: "one register entry per encounter; a duplicate is visible on the register",
    candidate: true,
  },
  {
    collection: "encounterCodings",
    index: "one_coding_per_encounter",
    reason: "billing/statistics coding; a duplicate is visible to the coder and correctable",
  },
  {
    collection: "consultationNotes",
    index: "one_note_per_encounter",
    reason:
      "one structured note per visit. Written and re-saved by one doctor on one screen; the " +
      "service upserts rather than inserting, so a duplicate is not a race it can lose",
  },
  {
    collection: "allergies",
    index: "one_active_allergy_per_allergen",
    reason:
      "a duplicate active allergy row would make the prescribing check fire TWICE for the same " +
      "allergen, which is noisy but fails safe — it never makes a screen miss",
  },

  /* ── catalogue, continued ───────────────────────────────────────────────── */
  {
    collection: "branches",
    index: "one_code_per_tenant",
    reason: "site catalogue; a duplicate branch code is visible in the switcher and renameable",
  },
  {
    collection: "beds",
    index: "one_bed_code_per_ward",
    reason:
      "the bed CATALOGUE, not occupancy. Who is IN a bed is `one_open_stay_per_bed_per_branch`, " +
      "which is declared and runtime-guarded; a duplicate catalogue row is visible on the board",
  },
  {
    collection: "ambulances",
    index: "one_ambulance_code_per_tenant",
    reason: "fleet catalogue; a duplicate vehicle code is visible on the dispatch list",
  },
  {
    collection: "assets",
    index: "one_asset_tag_per_tenant",
    reason: "asset register; a duplicate tag is an inventory error, not a clinical one",
  },

  /* ── security and audit ─────────────────────────────────────────────────── */
  {
    collection: "apiKeys",
    index: "one_key_per_hash",
    reason: "integration credential storage; collisions are cryptographic, not clinical",
  },
  {
    collection: "credentials",
    index: "tenantId_1_userId_1",
    reason: "one password record per user; an auth concern covered by the auth suite",
  },
  {
    collection: "auditLogs",
    index: "tenantId_1_seq_1",
    reason:
      "the tamper-evident audit chain's sequence. A gap or duplicate is an INTEGRITY finding the " +
      "anchor verification reports directly, which is a stronger control than a 503 would be",
  },
  {
    collection: "auditAnchors",
    index: "tenantId_1_index_1",
    reason: "audit-chain anchor sequence; verified by the audit anchor check, not by a write guard",
  },

  /* ── scheduling and money that ARE arbiter-shaped ───────────────────────── */
  {
    collection: "appointments",
    index: "one_doctor_one_slot",
    reason:
      "double-booking one doctor at one instant. Arbiter-shaped and a genuine candidate — but a " +
      "clash surfaces immediately as two people in a waiting room, before anyone is touched, and " +
      "the booking desk re-reads the slot list constantly. Ranked below the clinical five",
    candidate: true,
  },
  {
    collection: "ambulanceTrips",
    index: "one_trip_per_ambulance_start",
    reason:
      "one vehicle, one departure. Occupancy-shaped like a bed, but dispatch is a human reading " +
      "a board and a clash is visible before the ambulance moves",
    candidate: true,
  },
  {
    collection: "charges",
    index: "one_charge_per_cause",
    reason:
      "THE STRONGEST NON-CLINICAL CANDIDATE. `{sourceId, code}` is what stops an at-least-once " +
      "billing event posting the same bed-day twice — the same shape as the pharmacy order, and " +
      "consumers redeliver by design. It is money rather than patient harm, and a duplicate " +
      "charge is visible on the bill and reversible by a credit note, which is why it is exempt " +
      "and not guarded. It is the first thing to revisit if this list is ever revisited",
    candidate: true,
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
