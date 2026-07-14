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
import { getContext } from "../../core/context/requestContext.js";
import { withTransaction } from "../../core/db/transaction.js";
import { publish } from "../../core/events/outbox.js";
import { EVENTS } from "../../core/events/eventCatalog.js";
import { getPatient } from "../patients/index.js";
import { getById as getTenant, policyOf } from "../tenants/index.js";
import * as repo from "./encounter.repository.js";
import {
  canTransition,
  isQueued,
  type EncounterClass,
  type EncounterOrigin,
  type EncounterStatus,
} from "./encounter.model.js";

const logger = createLogger({ service: "encounters" });

export type { Encounter } from "./encounter.repository.js";

export interface StartEncounterInput {
  patientId: string;
  origin: EncounterOrigin;
  class?: EncounterClass;
  doctorId?: string;
  departmentId?: string;
  appointmentId?: string;
  reason?: string;
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
          ...(input.doctorId ? { doctorId: input.doctorId } : {}),
          ...(input.departmentId ? { departmentId: input.departmentId } : {}),
          ...(input.appointmentId ? { appointmentId: input.appointmentId } : {}),
          ...(input.reason ? { reason: input.reason } : {}),
          ...(input.branchId ? { branchId: input.branchId } : {}),
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
            ...(encounter.doctorId ? { doctorId: encounter.doctorId } : {}),
            ...(encounter.departmentId ? { departmentId: encounter.departmentId } : {}),
          },
          ...(input.branchId ? { branchId: input.branchId } : {}),
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

/** The patient is called in from the waiting room. */
export const startConsultation = (id: string): Promise<repo.Encounter> =>
  transition(id, "in_progress");

/** Sent for tests. THEY KEEP THIS ENCOUNTER — see the model header. */
export const sendForInvestigations = (id: string): Promise<repo.Encounter> =>
  transition(id, "awaiting_results");

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

export const listEncounters = repo.list;
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
