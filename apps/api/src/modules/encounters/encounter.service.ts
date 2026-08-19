/**
 * Encounter service (Doc 02 E0, ADR-0013) — the front door of the whole product.
 *
 * ── THE WALK-IN IS NOT AN EXCEPTION ─────────────────────────────────────────
 * `startEncounter` is what a government hospital and a small clinic do hundreds of
 * times a day, and it involves no appointment at all. The appointment book is one
 * ORIGIN that feeds this function (`checked_in` → here); it is not a prerequisite,
 * and it is not the entry point.
 *
 * ── THIS IS WHERE THE HOSPITAL'S POLICY IS FINALLY READ ─────────────────────
 * `encounterPolicy` (from the tenant's `organizationType` preset) decides when the
 * token is issued and whether the patient is routed to a named doctor or to a
 * department. That is the whole of the "different journeys" requirement — five
 * switches, one state graph, no workflow engine (ADR-0013 §5).
 *
 * Nothing here branches on `organizationType`. It asks the POLICY. There is a test
 * that reads the source and fails if anyone ever does otherwise.
 */
import { createLogger } from "@medicore/logger";
import { AppError } from "../../core/errors/appError.js";
import { getContext, getTenantDb } from "../../core/context/requestContext.js";
import { writeBranchId } from "../../core/context/activeBranch.js";
import { withTransaction } from "../../core/db/transaction.js";
import { tenantSchemaReadiness } from "../../core/db/schemaReadiness.js";
import type { ClinicalCapability } from "../../core/db/clinicalInvariants.js";
import { publish } from "../../core/events/outbox.js";
import { EVENTS } from "../../core/events/eventCatalog.js";
import { getPatient, namesByIds } from "../patients/index.js";
import { getById as getTenant, policyOf } from "../tenants/index.js";
import { getBed } from "../wards/index.js";
import { branchZone } from "../branches/index.js";
import { dayRangeInZone } from "../../core/time/day.js";
import * as repo from "./encounter.repository.js";
import {
  canTransition,
  isOpen,
  isQueued,
  type DischargeDisposition,
  type EncounterClass,
  type EncounterOrigin,
  type EncounterStatus,
} from "./encounter.model.js";

const logger = createLogger({ service: "encounters" });

export type { Encounter } from "./encounter.repository.js";

/**
 * An encounter WITH the patient it belongs to — the row shape of every list a human reads.
 *
 * The ward list is read by somebody walking a ward and the queue by a doctor calling the next
 * patient in: both need to know WHO, and leaving them to reconstruct it from a separate patient
 * list is what produced the same defect twice. First on the ward (a medication confirmation
 * reaching a nurse with no name and no UHID because the patient had been admitted longer ago than
 * the client's patient page reached back), then — after that was fixed here and not there — on the
 * doctor's queue, where 15 of 99 rows rendered a dash where a person should be (D18).
 */
export interface EncounterRow extends repo.Encounter {
  /** `Unknown patient` when the record cannot be read — never silently blank. */
  patientName: string;
  /** Empty only when the patient record itself carries none. */
  uhid: string;
}

/** The ward list is the same row. The name is kept because `/inpatients` documents it. */
export type InpatientRow = EncounterRow;

/**
 * Attaches each encounter's patient identity — ONE query for the page, not one per row.
 *
 * `namesByIds` takes the whole page's patient ids at once — the same call `/bed-board` and
 * `/medication-round` already make, with the same hospital-wide semantics. It deliberately does
 * NOT apply `scopeFilter()`: naming a patient whose encounter this caller can already see reveals
 * nothing new, and branch-scoping the lookup would blank the identity of anyone registered at
 * another site, which is the failure mode rather than the protection.
 *
 * ── WHY A LOOKUP BY ID AND NOT A JOIN AGAINST A PAGE OF PATIENTS ────────────
 * Because the two are only the same when the page happens to be big enough. A client asking for
 * `/patients?limit=100` and matching locally resolves whoever is in that page of RECENT
 * REGISTRATIONS and silently dashes everyone else — and the queue it is labelling is a different
 * population, ordered by arrival. `$in` on the ids actually present cannot miss.
 */
async function withIdentity<T extends repo.Encounter>(items: T[]): Promise<(T & EncounterRow)[]> {
  if (items.length === 0) return [];

  const names = await namesByIds([...new Set(items.map((e) => e.patientId))]);
  const byId = new Map(names.map((n) => [n.id, n]));

  return items.map((encounter) => {
    const who = byId.get(encounter.patientId);
    return {
      ...encounter,
      // The bed board says "Unknown patient" in the same situation and for the same reason: a
      // row that silently drops its identity is worse than one that says the lookup failed.
      patientName: who?.name ?? "Unknown patient",
      uhid: who?.uhid ?? "",
    };
  });
}

/** One page of the ward, with each stay's patient resolved. */
export async function listInpatientsWithIdentity(filter: {
  limit: number;
  skip: number;
  ward?: string;
}): Promise<{ items: InpatientRow[]; total: number }> {
  const { items, total } = await repo.listInpatients(filter);
  return { items: await withIdentity(items), total };
}

export interface StartEncounterInput {
  patientId: string;
  origin: EncounterOrigin;
  class?: EncounterClass;
  doctorId?: string;
  departmentId?: string;
  appointmentId?: string;
  reason?: string;
  /** A paid fast-track OP visit — priority in the queue plus an express surcharge. */
  express?: boolean;
  branchId?: string;
}

export interface StartEncounterResult {
  encounter: repo.Encounter;
  /**
   * True when the patient was ALREADY in the building and we handed back the
   * encounter that exists rather than making a second one. Not an error — see below.
   */
  resumed: boolean;
}

function invalidTransition(from: EncounterStatus, to: EncounterStatus): AppError {
  return new AppError("HMS-STATE-001", 422, "Invalid state transition", {
    from,
    to,
    allowed: "see STATE_MACHINE_CATALOG §14",
  });
}

/**
 * Was a duplicate-key error the BED index, not the patient one? Both live on `encounters`, so a
 * failed admission could be either; the remedy differs (free a bed vs the patient is already here),
 * so the message must. Read from `keyPattern` rather than the message text, which is not stable.
 */
function isBedOccupiedConflict(err: unknown): boolean {
  const keyPattern = (err as { keyPattern?: Record<string, unknown> }).keyPattern;
  return keyPattern ? "bed.bedCode" in keyPattern : false;
}

/**
 * The capability that PUTTING A PATIENT IN A BED rests on. One, and only its own.
 *
 * ── WHY NOT `open-encounter` AS WELL ────────────────────────────────────────
 * `one_open_encounter_per_patient` (0012) is what `arrive()` rests on, and admission's own
 * "already admitted" refusal is an application check on `current.class === "IP"` — not an index.
 * Losing 0012 lets a patient hold two open encounters, which is a different capability's problem
 * and is protected separately; it does not make the BED assignment ambiguous, because every
 * admission still passes through the occupancy key. Requiring it here would block admissions for
 * a fault that cannot put two patients in one bed.
 */
const BED_REQUIRES: readonly ClinicalCapability[] = ["bed-occupancy"];

/**
 * ── THE ARBITER MUST EXIST BEFORE WE RELY ON IT ─────────────────────────────
 * Neither `admitPatient` nor `transferBed` reads occupancy before writing it. Both insert or
 * update and then read E11000 as "somebody is already in that bed" — `getBed` checks the
 * catalogue's `blocked` flag, which is a maintenance state and says nothing about who is lying
 * there. `one_open_stay_per_bed_per_branch` (migration 0046, which widened 0020's key) is the
 * sole arbiter.
 *
 * Measured against Mongo 7 on 2026-08-17 with the index absent: two patients are admitted into
 * ICU/A-12 at the same branch, both ACCEPTED, and the bed board then shows one bed with two
 * occupants and no way to say which is real. Recreating the index over that pair is REFUSED
 * (11000), so the drift entrenches exactly as MAR's and dispensing's do.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT GUARD ───────────────────────────────────
 * Discharge, and every other way a stay ends. Closing a stay REMOVES the row from the partial
 * filter, so it can never violate the key — measured: after `open: false` the bed accepts the
 * next patient immediately. A drifted hospital must still be able to send people home; refusing
 * that would fill the ward it was trying to protect. Ward-board reads are untouched for the same
 * reason — a board that goes dark is a board nobody can use to sort the mess out.
 */
async function assertBedAssignmentIsSafe(): Promise<void> {
  const ctx = getContext();
  const readiness = await tenantSchemaReadiness(ctx.tenantId, getTenantDb(), BED_REQUIRES);
  if (readiness.safe) return;

  throw new AppError(
    "HMS-ADM-003",
    503,
    "Bed assignment is unavailable on this system — allocate on the ward board and escalate",
    {
      missing: readiness.missing.map((m) => ({
        rule: m.invariant.rule,
        migration: m.invariant.migration,
        found: m.found,
      })),
      ...(readiness.unknown ? { unknown: readiness.unknown } : {}),
    },
    true,
    60,
  );
}

/**
 * The capability that OPENING A VISIT rests on.
 *
 * `one_open_encounter_per_patient` (migration 0012) is not merely a duplicate guard here — it is
 * the mechanism by which `startEncounter` RESUMES a visit instead of forking it. The service has
 * no read-before-write at all, and says so: "two desks registering the same patient at the same
 * instant both read 'no open encounter' and both write. Only the database can arbitrate that."
 */
const ARRIVAL_REQUIRES: readonly ClinicalCapability[] = ["open-encounter"];

/**
 * ── WITHOUT THE INDEX, THE RESUME BECOMES A FORK ────────────────────────────
 * Measured against Mongo 7 on 2026-08-17 with the index absent: the same patient is admitted to
 * the queue twice, two open encounters exist, and the `catch` that would have handed back the
 * first one never runs because nothing threw. That is the commonest data-quality disaster in an
 * OPD, and this codebase already calls it a modelling failure rather than a training one: the
 * census double-counts, the bill splits across two records that no longer reconcile, and the
 * doctor's history has a hole in it — notes land on whichever encounter the screen happened to
 * find. Every duplicate also strands a whole EPISODE, because `createEpisode` runs first inside
 * the same transaction and commits with the row.
 *
 * Recreating the index over that pair is REFUSED (11000), so it entrenches like the others.
 *
 * ── THE KEY IS TENANT-WIDE ON PURPOSE ───────────────────────────────────────
 * Migration 0046 made four keys branch-aware and deliberately left this one alone. A ward name
 * may legitimately repeat across sites; a patient may not be in two places at once. Measured:
 * with the index present, the same patient is refused a second open visit at a DIFFERENT branch,
 * and that is correct rather than a multi-branch bug.
 */
async function assertArrivalIsSafe(): Promise<void> {
  const ctx = getContext();
  const readiness = await tenantSchemaReadiness(ctx.tenantId, getTenantDb(), ARRIVAL_REQUIRES);
  if (readiness.safe) return;

  throw new AppError(
    "HMS-ENC-001",
    503,
    "Starting a visit is unavailable on this system — register on paper and escalate",
    {
      missing: readiness.missing.map((m) => ({
        rule: m.invariant.rule,
        migration: m.invariant.migration,
        found: m.found,
      })),
      ...(readiness.unknown ? { unknown: readiness.unknown } : {}),
    },
    true,
    60,
  );
}

/** The queue a patient is placed in — a named doctor, or a department/OP room. */
function queueKeyOf(input: { doctorId?: string; departmentId?: string }): string {
  return input.doctorId ?? input.departmentId ?? "general";
}

/**
 * A patient arrives. This is the beginning of everything clinical.
 *
 * ── WHY A RETURNING PATIENT IS "RESUMED", NOT REJECTED AND NOT DUPLICATED ───
 * A unique partial index allows one open encounter per patient (migration 0012). So
 * when a clerk registers someone who is already here — overwhelmingly because they
 * have come back from the lab and the clerk does not realise the visit is still
 * open — the insert is refused by the DATABASE and we hand back the existing
 * encounter, token and all.
 *
 * Both alternatives are worse:
 *   - Creating a second encounter fragments one visit into two. The census
 *     double-counts them, the bill splits across two records that no longer add up,
 *     and the doctor's history has a hole in it. This is the commonest
 *     data-quality disaster in an OPD, and it is a MODELLING failure, not a
 *     training failure — so the model must make it impossible.
 *   - Throwing an error tells a clerk with a patient in front of them that the
 *     computer says no. They will find a way around it, and the way around it is a
 *     duplicate patient record — which is worse than a duplicate encounter.
 *
 * The check is the INDEX, not an `if`: two desks registering the same patient at
 * the same instant both read "no open encounter" and both write. Only the database
 * can arbitrate that.
 */
export async function startEncounter(input: StartEncounterInput): Promise<StartEncounterResult> {
  const ctx = getContext();

  /**
   * Guarded here rather than at each caller: the appointment desk's check-in reaches this same
   * function, so there is one door into a visit and one place to hold it. Before the patient read
   * only so the refusal is the first thing the clerk hears — the read is harmless either way.
   */
  await assertArrivalIsSafe();

  const patient = await getPatient(input.patientId);
  if (!patient) {
    throw new AppError("HMS-PAT-001", 404, "Patient not found", { patientId: input.patientId });
  }
  if (patient.status === "merged") {
    // Their chart now lives under the survivor. Starting a visit on a merged record
    // would write clinical history to a chart nobody will ever open again.
    throw new AppError("HMS-STATE-001", 422, "Patient record was merged", {
      patientId: patient.id,
      mergedInto: patient.mergedInto,
    });
  }

  const tenant = await getTenant(ctx.tenantId);
  const policy = policyOf(
    tenant ?? {
      id: ctx.tenantId,
      hospitalName: "",
      slug: ctx.tenantSlug,
      databaseName: "",
      status: "active",
    },
  );

  if (!input.doctorId && !input.departmentId) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      routing: [
        policy.routing === "department"
          ? "this hospital routes patients to a department — departmentId is required"
          : "this hospital routes patients to a doctor — doctorId is required",
      ],
    });
  }

  /**
   * The TREATING branch (ADR-0015) — the site this visit happens at, which is the active branch and
   * NOT necessarily where the patient was first registered (a patient may be seen at any branch). An
   * appointment-originated visit carries its slot's branch in `input.branchId`; a walk-in resolves
   * the active one. Everything the visit spawns downstream — orders, charges, prescriptions, vitals —
   * inherits this branch through the events it publishes.
   */
  const branchId = await writeBranchId(input.branchId);

  try {
    return await withTransaction(async (session) => {
      const episodeId = await repo.createEpisode(input.patientId, session, input.reason);

      /**
       * WHEN the token is issued is the hospital's policy, not ours:
       *   registration → the patient is queued the moment they arrive (government,
       *                  clinic — there is no check-in desk to wait for).
       *   check_in     → issued when they turn up for a booked slot (private).
       *   none         → no token at all (a diagnostic centre calling by name).
       *
       * A patient with a token is IN the queue; one without is merely `arrived`.
       */
      const issueNow = policy.tokenIssuedAt === "registration";
      const token = issueNow ? await repo.nextToken(queueKeyOf(input), session) : undefined;
      const status: EncounterStatus = issueNow ? "in_queue" : "arrived";

      const encounter = await repo.create(
        {
          patientId: input.patientId,
          episodeId,
          origin: input.origin,
          class: input.class ?? "OP",
          status,
          ...(token !== undefined ? { token } : {}),
          ...(input.express ? { express: true } : {}),
          ...(input.doctorId ? { doctorId: input.doctorId } : {}),
          ...(input.departmentId ? { departmentId: input.departmentId } : {}),
          ...(input.appointmentId ? { appointmentId: input.appointmentId } : {}),
          ...(input.reason ? { reason: input.reason } : {}),
          branchId,
        },
        session,
      );

      // Same transaction as the insert: the patient's arrival and the intent to tell
      // anyone about it commit together, or neither does.
      await publish(
        {
          name: EVENTS.ENCOUNTER_STARTED,
          payload: {
            encounterId: encounter.id,
            episodeId,
            patientId: patient.id,
            uhid: patient.uhid,
            origin: encounter.origin,
            class: encounter.class,
            ...(encounter.token !== undefined ? { token: encounter.token } : {}),
            // Carried so the billing consumer can add the express surcharge — money lives in
            // billing, and the clinical module only says WHAT happened (a paid fast-track visit).
            ...(encounter.express ? { express: true } : {}),
            ...(encounter.doctorId ? { doctorId: encounter.doctorId } : {}),
            ...(encounter.departmentId ? { departmentId: encounter.departmentId } : {}),
          },
          branchId,
        },
        session,
      );

      return { encounter, resumed: false };
    });
  } catch (err) {
    if (!repo.isDuplicateKey(err)) throw err;

    // The patient is already here. Hand back the visit they are already on — see
    // the header for why this is a feature and not a swallowed error.
    const existing = await repo.findOpenForPatient(input.patientId);
    if (!existing) throw err; // it closed underneath us; let the caller retry

    logger.info(
      { patientId: input.patientId, encounterId: existing.id, status: existing.status },
      "patient already has an open encounter — resuming it rather than creating a second",
    );
    return { encounter: existing, resumed: true };
  }
}

/**
 * The single door through which an encounter changes state.
 *
 * One door, so the state machine cannot be bypassed by a service that "just needs
 * to set a status quickly" — which is how a patient ends up `closed` while still
 * flagged open, holding their own slot forever.
 */
async function transition(
  id: string,
  to: EncounterStatus,
  reason?: string,
  alsoSet?: Record<string, unknown>,
): Promise<repo.Encounter> {
  const ctx = getContext();

  return withTransaction(async (session) => {
    const current = await repo.findById(id);
    if (!current) throw new AppError("HMS-GEN-404", 404, "Encounter not found", { id });
    if (!canTransition(current.status, to)) throw invalidTransition(current.status, to);

    const extra: Record<string, unknown> = { ...alsoSet };

    /**
     * A patient moving into the queue needs a number, and gets it HERE if the
     * hospital issues tokens at check-in rather than at registration. Issued once:
     * a patient who goes to the lab and comes back keeps the number they were
     * called by, because a waiting room that renumbers people is a riot.
     */
    if (to === "in_queue" && current.token === undefined) {
      extra.token = await repo.nextToken(queueKeyOf(current), session);
    }

    const updated = await repo.setStatus(
      id,
      to,
      {
        from: current.status,
        to,
        at: new Date(),
        ...(ctx.userId ? { by: ctx.userId } : {}),
        ...(reason ? { reason } : {}),
      },
      session,
      extra,
    );
    if (!updated) throw new AppError("HMS-GEN-404", 404, "Encounter not found", { id });

    if (to === "closed") {
      await publish(
        {
          name: EVENTS.ENCOUNTER_CLOSED,
          // The visit's own branch. Billing closes the bill off this event, so a missing branch
          // here is an invoice that cannot say which site raised it (ADR-0015).
          ...(updated.branchId ? { branchId: updated.branchId } : {}),
          payload: {
            encounterId: updated.id,
            episodeId: updated.episodeId,
            patientId: updated.patientId,
            class: updated.class,
            ...(reason ? { reason } : {}),
          },
        },
        session,
      );
    }

    return updated;
  });
}

export interface AdmitInput {
  /**
   * The bed to admit into, picked from the inventory (B4). When present, the ward name, bed code
   * and tariff are taken from the catalogue and the three free-text fields below are ignored.
   */
  bedId?: string;
  /** `General Ward`, `ICU` — legacy free-text path, used only when `bedId` is absent. */
  ward?: string;
  /** `A-12`. Legacy free-text path, used only when `bedId` is absent. */
  bedCode?: string;
  /** The tariff code the bed-day is billed at — legacy free-text path, ignored when `bedId` set. */
  tariffCode?: string;
  /** The consultant who owns the patient on the ward. Defaults to the OP doctor. */
  doctorId?: string;
  reason?: string;
}

export interface AdmitResult {
  /** The OP encounter, now `admitted`. Terminal — it will never reopen. */
  outpatient: repo.Encounter;
  /** The new INPATIENT encounter, in the same Episode of Care. */
  inpatient: repo.Encounter;
}

/**
 * The patient is admitted to a bed.
 *
 * ── TWO ENCOUNTERS, ONE EPISODE. THIS IS ADR-0013 §4, AND IT IS NOT NEGOTIABLE ─
 * The OP encounter CLOSES (`admitted`, terminal). An INPATIENT encounter OPENS, in the
 * SAME `episodeId`. We do not extend the outpatient encounter across the admission, and
 * the reasons are the hospital's own, not the architecture's:
 *
 *   BILLING     — OP and IP tariffs differ, and bed charges accrue per DAY against the IP
 *                 encounter. A merged encounter cannot be billed correctly.
 *   REPORTING   — midnight census, ALOS, admission counts and NABH all count ENCOUNTERS.
 *                 A merged object corrupts every one of those numbers.
 *   IRREVERSIBLE— two encounters can always be JOINED into a timeline. One encounter can
 *                 never be SPLIT back apart once notes, orders and charges have piled up
 *                 on it.
 *
 * The doctor still sees one unbroken history, because the timeline is a read model over
 * the EPISODE (`getEpisodeTimeline`) — not a storage decision. **Continuity is a read
 * concern; separation is a billing and statutory concern. Never trade the second away to
 * buy the first.**
 *
 * ── WHY BOTH HALVES ARE IN ONE TRANSACTION ──────────────────────────────────
 * `one_open_encounter_per_patient` (migration 0012) is a unique partial index on
 * `open: true`. The OP encounter must stop being open BEFORE the IP one starts, or the
 * index rejects the admission. In one transaction that ordering is guaranteed; in two,
 * a crash in between leaves a patient who has been discharged from the OPD and admitted
 * to nothing — standing in a corridor, invisible to every screen in the hospital.
 */
export async function admitPatient(id: string, input: AdmitInput): Promise<AdmitResult> {
  const ctx = getContext();

  /**
   * Before the transaction opens, so a refusal cannot leave the OP encounter closed with nothing
   * to admit into — the very state the transaction exists to make impossible.
   */
  await assertBedAssignmentIsSafe();

  return withTransaction(async (session) => {
    const current = await repo.findById(id);
    if (!current) throw new AppError("HMS-GEN-404", 404, "Encounter not found", { id });

    if (!canTransition(current.status, "admitted")) {
      throw invalidTransition(current.status, "admitted");
    }

    /**
     * Admitting an INPATIENT would be admitting someone who is already in a bed. The
     * state machine cannot catch this on its own — an IP encounter sits at `in_progress`
     * like any other, and `in_progress → admitted` is a legal edge. Without this the
     * ward could admit the same patient twice a day, each time abandoning the previous
     * stay's bed charges on an encounter nobody will ever close.
     */
    if (current.class === "IP") {
      throw new AppError("HMS-STATE-001", 422, "This patient is already admitted", {
        id,
        hint: "to move them to another bed, transfer the bed — do not admit them again",
      });
    }

    /**
     * Resolve the bed. When a `bedId` is given, the ward name, code and tariff come from the
     * INVENTORY (B4) — a real bed, priced as configured — rather than from whatever was typed.
     * Absent a `bedId`, the legacy free-text fields are used as-is (the schema guarantees all
     * three are present in that case). Either way the values flow through identically from here.
     */
    let ward = input.ward;
    let bedCode = input.bedCode;
    let tariffCode = input.tariffCode;
    let bedId: string | undefined;
    if (input.bedId) {
      const catalogueBed = await getBed(input.bedId);
      if (!catalogueBed) {
        throw new AppError("HMS-GEN-404", 404, "Bed not found", { bedId: input.bedId });
      }
      if (catalogueBed.wardStatus !== "active") {
        throw new AppError("HMS-STATE-001", 422, "That ward is not in service", {
          bedId: input.bedId,
          hint: "the ward is retired — pick a bed in an active ward",
        });
      }
      if (catalogueBed.status === "blocked") {
        throw new AppError("HMS-STATE-001", 422, "That bed is out of service", {
          bedId: input.bedId,
          ...(catalogueBed.blockedReason ? { reason: catalogueBed.blockedReason } : {}),
          hint: "this bed is blocked — pick a free bed",
        });
      }
      // A bed belongs to exactly one site. Admitting a Chennai patient into a Hyderabad bed would
      // corrupt both sites' census — the same isolation `branchId` gives every other record.
      if (current.branchId && catalogueBed.branchId && current.branchId !== catalogueBed.branchId) {
        throw new AppError("HMS-STATE-001", 422, "That bed is at another branch", {
          bedId: input.bedId,
          hint: "pick a bed at the patient's current site",
        });
      }
      ward = catalogueBed.wardName;
      bedCode = catalogueBed.code;
      tariffCode = catalogueBed.tariffCode;
      bedId = catalogueBed.id;
    }
    // The schema already refuses an admit that has neither a bedId nor the three fields; this is a
    // belt-and-braces guard so the types below are non-optional and a service caller cannot slip
    // an empty bed through.
    if (!ward || !bedCode || !tariffCode) {
      throw new AppError("HMS-VAL-001", 400, "Validation failed", {
        bedId: ["pick a bed (bedId) or give the ward, bedCode and tariffCode"],
      });
    }

    const admittedAt = new Date();

    const outpatient = await repo.setStatus(
      id,
      "admitted",
      {
        from: current.status,
        to: "admitted",
        at: admittedAt,
        ...(ctx.userId ? { by: ctx.userId } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
      },
      session,
    );
    if (!outpatient) throw new AppError("HMS-GEN-404", 404, "Encounter not found", { id });

    let inpatient: repo.Encounter;
    try {
      inpatient = await repo.create(
        {
          patientId: current.patientId,
          // THE SAME EPISODE. This one line is what makes the admission part of the care
          // story rather than a new one — and what lets the ward see the OP consultation
          // and its results without anything being copied.
          episodeId: current.episodeId,
          // The patient came from inside the building. `transfer` is the ADR-0013 §2 origin
          // for exactly this: an encounter that begins where another one ended.
          origin: "transfer",
          class: "IP",
          // Straight to `in_progress`: there is no queue for a bed. The patient is not
          // waiting to be seen — they are in the ward, and somebody is responsible for them
          // from this second.
          status: "in_progress",
          bed: { ward, bedCode, tariffCode, ...(bedId ? { bedId } : {}) },
          admittedAt,
          admittedFrom: current.id,
          ...((input.doctorId ?? current.doctorId)
            ? { doctorId: (input.doctorId ?? current.doctorId) as string }
            : {}),
          ...(current.departmentId ? { departmentId: current.departmentId } : {}),
          ...(input.reason ? { reason: input.reason } : {}),
          ...(current.branchId ? { branchId: current.branchId } : {}),
        },
        session,
      );
    } catch (err) {
      /**
       * The bed is taken. `one_open_stay_per_bed` (migration 0020) refused a second open stay in
       * this ward+bed — the database enforcing what the ward screen cannot see. Rethrow as the
       * hospital's answer, not a 500: choose a free bed. Because we are inside `withTransaction`,
       * the OP encounter's move to `admitted` rolls back with us, so the patient is NOT left
       * discharged-from-the-OPD-into-nothing — exactly the atom the admission is wrapped in for.
       */
      if (repo.isDuplicateKey(err) && isBedOccupiedConflict(err)) {
        throw new AppError("HMS-STATE-001", 409, "That bed is already occupied", {
          ward,
          bedCode,
          hint: "another patient is currently admitted in this bed — choose a free bed",
        });
      }
      throw err;
    }

    /**
     * Billing listens for this and posts the first bed-day. Published in the SAME
     * transaction as the admission, so a bed can never be occupied without the charge
     * being raised, nor charged for an admission that rolled back.
     */
    await publish(
      {
        name: EVENTS.PATIENT_ADMITTED,
        payload: {
          encounterId: inpatient.id,
          outpatientEncounterId: outpatient.id,
          episodeId: inpatient.episodeId,
          patientId: inpatient.patientId,
          ward,
          bedCode,
          tariffCode,
          admittedAt: admittedAt.toISOString(),
          ...(inpatient.doctorId ? { doctorId: inpatient.doctorId } : {}),
        },
        ...(inpatient.branchId ? { branchId: inpatient.branchId } : {}),
      },
      session,
    );

    return { outpatient, inpatient };
  });
}

/**
 * Hands the patient to another doctor.
 *
 * ── A TRANSFER IS A CLINICAL HANDOVER, NOT AN EDIT ──────────────────────────
 * The naive version of this is `PATCH /encounters/:id { doctorId }`, and it is wrong in a
 * way that only shows up at an inquest: the patient silently moves off one doctor's list
 * and onto another's, with nothing recording that a handover happened, who decided it, or
 * why. "Who was responsible for this patient at 4pm?" then has no answer.
 *
 * So it is its own act, it REQUIRES a reason, and it lands in the history. The reason is
 * the handover note — "needs surgical opinion", "my shift ends" — and it is the only
 * thing the receiving doctor has to go on.
 *
 * The ENCOUNTER moves; the episode, the orders, the results and the prescriptions do not
 * budge, because they all hang off the encounter and the episode rather than the doctor.
 * That is the whole return on ADR-0013: handing over a patient is one field, not a
 * migration.
 */
export async function transferDoctor(
  id: string,
  toDoctorId: string,
  reason: string,
): Promise<repo.Encounter> {
  const ctx = getContext();

  return withTransaction(async (session) => {
    const current = await repo.findById(id);
    if (!current) throw new AppError("HMS-GEN-404", 404, "Encounter not found", { id });

    /**
     * A closed visit has no responsible doctor to hand over. Transferring one would move
     * a finished patient onto a colleague's list — they would call a name that is not
     * coming, because that patient went home hours ago.
     */
    if (!isOpen(current.status)) {
      throw new AppError("HMS-STATE-001", 422, "Cannot transfer a visit that is over", {
        id,
        status: current.status,
        hint: "the patient has left — if they are back, that is a new encounter in the same episode",
      });
    }

    if (current.doctorId === toDoctorId) {
      throw new AppError("HMS-VAL-001", 400, "Validation failed", {
        doctorId: ["this patient is already with that doctor"],
      });
    }

    const from = current.doctorId;

    const updated = await repo.setDoctor(
      id,
      toDoctorId,
      {
        from: current.status,
        // The status does not change — the patient is exactly as waiting as they were.
        // What changed is WHO they are waiting for, and the history says so in words.
        to: current.status,
        at: new Date(),
        ...(ctx.userId ? { by: ctx.userId } : {}),
        reason: `transferred to another doctor: ${reason}`,
      },
      session,
    );
    if (!updated) throw new AppError("HMS-GEN-404", 404, "Encounter not found", { id });

    await publish(
      {
        name: EVENTS.ENCOUNTER_TRANSFERRED,
        payload: {
          encounterId: updated.id,
          patientId: updated.patientId,
          episodeId: updated.episodeId,
          toDoctorId,
          reason,
          ...(from ? { fromDoctorId: from } : {}),
        },
        ...(updated.branchId ? { branchId: updated.branchId } : {}),
      },
      session,
    );

    return updated;
  });
}

export interface TransferBedInput {
  /** The target bed, picked from the inventory (B4). Ward name, code come from the catalogue. */
  bedId?: string;
  /** Legacy free-text path, used only when `bedId` is absent (a hospital with no bed catalogue). */
  ward?: string;
  bedCode?: string;
  reason?: string;
}

export interface TransferBedResult {
  encounter: repo.Encounter;
  from: { ward: string; bedCode: string };
  to: { ward: string; bedCode: string };
}

/**
 * Moves an admitted patient from one bed to another (B4 bed-to-bed transfer).
 *
 * ── THE PHYSICAL BED MOVES; THE BILLING TARIFF DOES NOT ─────────────────────
 * A transfer records that the patient is now in a different bed — nothing else. It deliberately
 * KEEPS the stay's `tariffCode`: bed-days are billed at a single rate for the whole stay (charged
 * at admission and again at discharge from `bed.tariffCode`, with no per-night cron), so silently
 * adopting the new bed's rate would re-price every night already spent, not just the ones ahead. A
 * genuine rate change is a deliberate billing action, not a side effect of wheeling a bed — so this
 * does not make one. What it guarantees is the same occupancy invariant admission does: the target
 * bed must be a real, active, unblocked bed at the patient's site, and it must be FREE — enforced by
 * `one_open_stay_per_bed`, which turns a move onto a taken bed into a 409.
 *
 * No transaction: this is a single-document update, and the unique index is its own atomic guard.
 * The reason for the move is recorded by the caller (admissions) as a ward note — the durable
 * clinical record of why the patient was moved.
 */
export async function transferBed(id: string, input: TransferBedInput): Promise<TransferBedResult> {
  /**
   * A move is an assignment: it vacates one bed and claims another, and the claim is arbitrated by
   * the same key. `admissions.transferBed` delegates here, so guarding this function covers the
   * ward-round wrapper too — there is no second door into a bed.
   */
  await assertBedAssignmentIsSafe();

  const current = await repo.findById(id);
  if (!current) throw new AppError("HMS-GEN-404", 404, "Encounter not found", { id });

  if (current.class !== "IP" || !isOpen(current.status) || !current.bed) {
    throw new AppError("HMS-STATE-001", 422, "This patient is not admitted", {
      id,
      hint: "a bed transfer needs an open inpatient stay",
    });
  }

  // Keep the stay's tariff (see the header); only the physical location changes.
  const tariffCode = current.bed.tariffCode;
  let ward = input.ward;
  let bedCode = input.bedCode;
  let bedId: string | undefined;

  if (input.bedId) {
    const catalogueBed = await getBed(input.bedId);
    if (!catalogueBed) {
      throw new AppError("HMS-GEN-404", 404, "Bed not found", { bedId: input.bedId });
    }
    if (catalogueBed.wardStatus !== "active") {
      throw new AppError("HMS-STATE-001", 422, "That ward is not in service", {
        bedId: input.bedId,
        hint: "pick a bed in an active ward",
      });
    }
    if (catalogueBed.status === "blocked") {
      throw new AppError("HMS-STATE-001", 422, "That bed is out of service", {
        bedId: input.bedId,
        ...(catalogueBed.blockedReason ? { reason: catalogueBed.blockedReason } : {}),
        hint: "this bed is blocked — pick a free bed",
      });
    }
    if (current.branchId && catalogueBed.branchId && current.branchId !== catalogueBed.branchId) {
      throw new AppError("HMS-STATE-001", 422, "That bed is at another branch", {
        bedId: input.bedId,
        hint: "pick a bed at the patient's current site",
      });
    }
    ward = catalogueBed.wardName;
    bedCode = catalogueBed.code;
    bedId = catalogueBed.id;
  }

  if (!ward || !bedCode) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      bedId: ["pick a bed (bedId) or give the ward and bedCode"],
    });
  }

  if (ward === current.bed.ward && bedCode === current.bed.bedCode) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      bedId: ["the patient is already in this bed"],
    });
  }

  const from = { ward: current.bed.ward, bedCode: current.bed.bedCode };

  try {
    const updated = await repo.setBed(id, {
      ward,
      bedCode,
      tariffCode,
      ...(bedId ? { bedId } : {}),
    });
    if (!updated) throw new AppError("HMS-GEN-404", 404, "Encounter not found", { id });
    return { encounter: updated, from, to: { ward, bedCode } };
  } catch (err) {
    // The target bed is taken — `one_open_stay_per_bed` refused the move, the same way it refuses a
    // double admission. Report the hospital's answer, not a 500: choose a free bed.
    if (repo.isDuplicateKey(err) && isBedOccupiedConflict(err)) {
      throw new AppError("HMS-STATE-001", 409, "That bed is already occupied", {
        ward,
        bedCode,
        hint: "another patient is currently admitted in this bed — choose a free bed",
      });
    }
    throw err;
  }
}

/**
 * The patient goes home.
 *
 * ── DISCHARGE IS NOT "CLOSING A VISIT" ──────────────────────────────────────
 * It closes the inpatient encounter, so mechanically it is one transition. But it also
 * emits `patient.discharged`, and that event is what ALOS, the midnight census and every
 * bed-occupancy figure in the hospital are counted from. `encounter.closed` fires for
 * every OP consultation too — a consumer trying to count discharges from it would count
 * the entire outpatient department.
 *
 * The bed-day charges land from that event, for every night not yet billed. They are
 * posted from `dischargedAt` as recorded HERE, not from the consumer's clock: a
 * redelivery an hour later must bill the same stay, not a longer one.
 *
 * ── EVERY WAY A STAY CAN END GOES THROUGH THIS ONE DOOR ─────────────────────
 * `disposition` says which one it was — a routine discharge, LAMA, absconded, or a death.
 * All four close the encounter and occupied the bed until they happened, so all four bill
 * their bed-days; they differ in the RECORD, not the mechanics. The disposition rides on
 * the event so the census, ALOS and mortality figures can tell a death from a homecoming
 * instead of counting them alike.
 */
export async function dischargePatient(
  id: string,
  disposition: DischargeDisposition,
  reason?: string,
): Promise<repo.Encounter> {
  const ctx = getContext();

  return withTransaction(async (session) => {
    const current = await repo.findById(id);
    if (!current) throw new AppError("HMS-GEN-404", 404, "Encounter not found", { id });

    /**
     * Only an inpatient can be discharged. An OP consultation ENDS — it is closed, and
     * `closeEncounter` is that. Letting this run on an OP encounter would emit
     * `patient.discharged` for somebody who never had a bed, and every occupancy number
     * downstream would count them as a stay.
     */
    if (current.class !== "IP") {
      throw new AppError("HMS-STATE-001", 422, "This patient is not admitted", {
        id,
        class: current.class,
        hint: "an outpatient visit is CLOSED, not discharged — POST /encounters/:id/close",
      });
    }
    if (!canTransition(current.status, "closed")) throw invalidTransition(current.status, "closed");

    const dischargedAt = new Date();

    const updated = await repo.setStatus(
      id,
      "closed",
      {
        from: current.status,
        to: "closed",
        at: dischargedAt,
        ...(ctx.userId ? { by: ctx.userId } : {}),
        // The disposition is the reason the stay ended; keep an explicit reason too when one
        // was given (e.g. the cause of death), but never lose which of the four it was.
        reason: reason ?? disposition,
      },
      session,
      { dischargedAt, disposition },
    );
    if (!updated) throw new AppError("HMS-GEN-404", 404, "Encounter not found", { id });

    await publish(
      {
        name: EVENTS.PATIENT_DISCHARGED,
        payload: {
          encounterId: updated.id,
          episodeId: updated.episodeId,
          patientId: updated.patientId,
          disposition,
          admittedAt: (updated.admittedAt ?? updated.arrivedAt).toISOString(),
          dischargedAt: dischargedAt.toISOString(),
          ...(updated.bed
            ? {
                ward: updated.bed.ward,
                bedCode: updated.bed.bedCode,
                tariffCode: updated.bed.tariffCode,
              }
            : {}),
          ...(reason ? { reason } : {}),
        },
        ...(updated.branchId ? { branchId: updated.branchId } : {}),
      },
      session,
    );

    return updated;
  });
}

/** Everyone currently in a bed. The ward round's list. */
export const listInpatients = repo.listInpatients;

/* ── Reporting aggregations (used by the reporting module) ─────────────────── */
export const visitReport = repo.visitReport;
export const doctorProductivity = repo.doctorProductivity;
export const dischargeRegister = repo.dischargeRegister;

/** The patient is called in from the waiting room. */
export const startConsultation = (id: string): Promise<repo.Encounter> =>
  transition(id, "in_progress");

/**
 * Sent for tests. THEY KEEP THIS ENCOUNTER — see the model header.
 *
 * ── AT LEAST ONE TEST MUST BE ORDERED FIRST ─────────────────────────────────
 * "Send for tests" parks the patient in `awaiting_results` to wait for the lab. Doing that with
 * nothing ordered strands the patient in a waiting state no result will ever release them from — so
 * the guard refuses it. The count is maintained by the orders module inside the order's transaction
 * (`activeOrderCount`), which is why a doctor who orders a test and immediately clicks send is not
 * wrongly blocked. The doctor orders as many tests as they like (each is live the instant it is
 * placed); this transition is the separate "I am done ordering, send them to wait" step.
 */
export async function sendForInvestigations(id: string): Promise<repo.Encounter> {
  const encounter = await repo.findById(id);
  if (!encounter) throw new AppError("HMS-GEN-404", 404, "Encounter not found", { id });
  if ((encounter.activeOrderCount ?? 0) <= 0) {
    throw new AppError("HMS-STATE-001", 422, "Order at least one test before sending for tests", {
      encounterId: id,
      hint: "place the tests first — an investigations visit with nothing ordered never comes back",
    });
  }
  return transition(id, "awaiting_results");
}

/**
 * The orders module's hooks into the live order count (see `encounter.model.ts`). Called from
 * INSIDE the order's own transaction so the count and the order commit together — never an event,
 * which would let a doctor send for tests before an async consumer had counted the order they just
 * placed. The direction is orders → encounters, which the module graph already allows.
 */
export const recordOrderPlaced = (
  id: string,
  session?: Parameters<typeof repo.bumpOrderCount>[2],
) => repo.bumpOrderCount(id, 1, session);
export const recordOrderCancelled = (
  id: string,
  session?: Parameters<typeof repo.bumpOrderCount>[2],
) => repo.bumpOrderCount(id, -1, session);

export const queuePatient = (id: string): Promise<repo.Encounter> => transition(id, "in_queue");

export const closeEncounter = (id: string, reason?: string): Promise<repo.Encounter> =>
  transition(id, "closed", reason);

/** Cancellation REQUIRES a reason — "cancelled" with no why is useless downstream. */
export const cancelEncounter = (id: string, reason: string): Promise<repo.Encounter> =>
  transition(id, "cancelled", reason);

/**
 * They waited and left. A distinct outcome from `cancelled`, and the distinction is
 * the hospital's problem to see: a rising LWBS count is a queue that is too slow,
 * and it is one of the few numbers that predicts a patient coming back sicker.
 */
export const markLeftWithoutBeingSeen = (id: string): Promise<repo.Encounter> =>
  transition(id, "left_without_being_seen");

export const getEncounter = (id: string): Promise<repo.Encounter | undefined> => repo.findById(id);

export interface VisitSummaryInput {
  diagnosis?: string;
  advice?: string;
}

/**
 * Records the doctor's OP visit summary (diagnosis / advice) for the OPD slip.
 *
 * Only the fields the caller SENT are touched — omitting `advice` leaves it as it was. An empty
 * string is a deliberate CLEAR (the doctor wiped the box), so it `$unset`s the field rather than
 * storing "" and printing a blank labelled line on the slip.
 */
export async function recordVisitSummary(
  id: string,
  input: VisitSummaryInput,
): Promise<repo.Encounter> {
  const current = await repo.findById(id);
  if (!current) throw new AppError("HMS-GEN-404", 404, "Encounter not found", { id });

  const set: { diagnosis?: string; advice?: string } = {};
  const unset: { diagnosis?: 1; advice?: 1 } = {};
  for (const key of ["diagnosis", "advice"] as const) {
    const value = input[key];
    if (value === undefined) continue;
    const trimmed = value.trim();
    if (trimmed) set[key] = trimmed;
    else unset[key] = 1;
  }

  const updated = await repo.setVisitSummary(id, set, unset);
  if (!updated) throw new AppError("HMS-GEN-404", 404, "Encounter not found", { id });
  return updated;
}

/**
 * The front desk's list, and — when a day is asked for — the day it is a register OF.
 *
 * ── THE DAY IS THE BRANCH'S, NOT THE HOSPITAL DEFAULT'S (risk register D2) ──
 * `date` is `YYYY-MM-DD` rather than an instant because a receptionist thinks in days, so turning
 * it into a half-open range of instants needs a zone. That zone used to be `env.DEFAULT_TIMEZONE`,
 * which was correct while a hospital was one site and silently wrong once it was not: a clerk at a
 * site nine hours away asked for "today" and was answered in the head office's today. Near either
 * midnight those are different days, and the register quietly omits the visits in the gap.
 *
 * The MAR, the medication round, the ward worklist and the clinic's own opening hours were all
 * moved to the branch's zone. This is the same rule, applied to the same kind of boundary, through
 * the same helper.
 *
 * ── WHY THE ACTIVE BRANCH IS THE RIGHT SOURCE ───────────────────────────────
 * It is already what scopes the rows: the register shows the site you are working at, so the day
 * it covers should be that site's day. With no branch selected — the aggregate view — there is no
 * single clock to answer with, and `branchZone` falls back to the hospital default, which is both
 * the previous behaviour and the only honest answer for "all sites at once".
 *
 * Resolved here rather than in the controller: it is an async lookup and a domain rule, and the
 * controller is HTTP only (Doc 09 §11).
 */
export async function listEncounters(
  filter: Omit<repo.ListEncountersFilter, "arrivedFrom" | "arrivedBefore"> & { date?: string },
): Promise<{ items: repo.Encounter[]; total: number }> {
  const { date, ...rest } = filter;
  if (!date) return repo.list(rest);

  const zone = await branchZone(getContext().activeBranchId);
  const { from, before } = dayRangeInZone(date, zone);
  return repo.list({ ...rest, arrivedFrom: from, arrivedBefore: before });
}

/**
 * The same page, with each visit's patient named — what `GET /encounters` returns (D18).
 *
 * ── WHY THE HTTP LIST NAMES ITS PATIENTS AND `listEncounters` DOES NOT ───────
 * Every consumer of the HTTP list is a screen a person reads: the doctor's queue, the reception
 * register, the phone's round. All three showed a `patientId`, and all three had to turn it into a
 * name somehow — the two web screens by matching against `/patients?limit=100`, the phone by
 * fetching each patient separately. The first is wrong past a hundred registrations and the second
 * is N round trips for N rows.
 *
 * `listEncounters` stays bare for the module that reads it as DATA rather than as a screen: the ED
 * board (`emergency.service.ts`) resolves its own names alongside the triage rows it joins, and
 * paying for the identity twice would be the cost of a tidier call graph.
 */
export async function listEncountersWithIdentity(
  filter: Omit<repo.ListEncountersFilter, "arrivedFrom" | "arrivedBefore"> & { date?: string },
): Promise<{ items: EncounterRow[]; total: number }> {
  const { items, total } = await listEncounters(filter);
  return { items: await withIdentity(items), total };
}

export const getOpenEncounterFor = repo.findOpenForPatient;

/**
 * The whole care story: every encounter in this episode, oldest first.
 *
 * When admission lands, THIS is what makes the OP consultation, its investigations
 * and its prescriptions "automatically part of the admission episode" — the
 * admission is a new encounter in the same episode, and the inheritance is a read.
 */
export const getEpisodeTimeline = repo.encountersInEpisode;

/** For the queue board and the doctor's day — the states that occupy a queue. */
export { isQueued };
