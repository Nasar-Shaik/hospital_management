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
  isOpen,
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

export interface AdmitInput {
  /** `General Ward`, `ICU` — what a human calls the place. */
  ward: string;
  /** `A-12`. Free text: there is no bed inventory to validate against (see the model). */
  bedCode: string;
  /** The tariff code the bed-day is billed at — `BED_GEN`, `BED_ICU`. */
  tariffCode: string;
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

    const inpatient = await repo.create(
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
        bed: { ward: input.ward, bedCode: input.bedCode, tariffCode: input.tariffCode },
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
          ward: input.ward,
          bedCode: input.bedCode,
          tariffCode: input.tariffCode,
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
 */
export async function dischargePatient(id: string, reason?: string): Promise<repo.Encounter> {
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
        ...(reason ? { reason } : {}),
      },
      session,
      { dischargedAt },
    );
    if (!updated) throw new AppError("HMS-GEN-404", 404, "Encounter not found", { id });

    await publish(
      {
        name: EVENTS.PATIENT_DISCHARGED,
        payload: {
          encounterId: updated.id,
          episodeId: updated.episodeId,
          patientId: updated.patientId,
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
