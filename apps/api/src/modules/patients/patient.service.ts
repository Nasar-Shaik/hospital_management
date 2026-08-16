/**
 * Patient registration & the Master Patient Index (Doc 02 C1, BUSINESS_WORKFLOWS §1).
 *
 * The first clinical module. Three things about it are new to this codebase, and
 * all three are load-bearing:
 *
 *   1. **It runs in transactions.** Registering a patient allocates a UHID, inserts
 *      the record, appends an audit entry and writes an outbox event. Those commit
 *      together or not at all (see core/db/transaction.ts).
 *   2. **Its audit entries are atomic with the mutation they describe.** That falls
 *      out of (1) for free — `recordAudit` and `auditPlugin` have accepted a session
 *      since A5. It closes the debt recorded in PROJECT_MEMORY.
 *   3. **It can refuse to do what it was asked.** The MPI stops a registration that
 *      looks like a duplicate and hands the decision back to a human.
 */
import {
  AppError,
  DuplicatePatientError,
  PatientNotFoundError,
} from "../../core/errors/appError.js";
import { getContext } from "../../core/context/requestContext.js";
import { writeBranchId } from "../../core/context/activeBranch.js";
import { withTransaction } from "../../core/db/transaction.js";
import { recordAudit } from "../../core/audit/auditWriter.js";
import { publish } from "../../core/events/outbox.js";
import { EVENTS } from "../../core/events/eventCatalog.js";
import { PERMISSIONS } from "@medicore/permissions";
import * as repo from "./patient.repository.js";
import { nameKeyOf } from "./patient.model.js";
import { DUPLICATE_THRESHOLD, isProbableDuplicate, rank, type DuplicateCandidate } from "./mpi.js";
import type { Patient } from "./patient.repository.js";
import type { BloodGroup, Gender } from "./patient.model.js";

export type { Patient } from "./patient.repository.js";

export interface RegisterPatientInput {
  name: string;
  gender: Gender;
  dob?: Date;
  bloodGroup?: BloodGroup;
  branchId?: string;
  contact?: { phone?: string; email?: string };
  address?: Patient["address"];
  /**
   * "Yes, I have looked at the candidates, and this is a different person."
   * Requires `patient:merge` — the permission that says this person is trusted to
   * make duplicate decisions. Without that gate, `force` becomes the button every
   * clerk learns to click to make the warning go away.
   */
  force?: boolean;
}

export interface RegisterPatientResult {
  patient: Patient;
  /** Near-misses BELOW the block threshold. Shown, not enforced. */
  possibleDuplicates: DuplicateCandidate[];
}

function serializeCandidates(candidates: DuplicateCandidate[]): unknown[] {
  return candidates.map((c) => ({
    id: c.patient.id,
    uhid: c.patient.uhid,
    name: c.patient.name,
    gender: c.patient.gender,
    dob: c.patient.dob,
    phone: c.patient.contact.phone,
    score: c.score,
    matchedOn: c.matchedOn,
  }));
}

/**
 * Registers a patient, refusing a probable duplicate.
 *
 * The MPI search runs BEFORE the transaction opens. That is deliberate: it is a
 * read, it is the slow part (a wide `$or` over a big collection), and holding a
 * transaction open across it would extend the lock on the UHID counter for the
 * whole duration of a search — turning a read into a throughput ceiling on the
 * busiest desk in the hospital.
 *
 * The gap it leaves is real and worth naming: two clerks could register the same
 * person in the same second, both search, both see nothing, and both insert. No
 * lock prevents that, because there is no key to lock on — "the same person" is a
 * judgement, not a value. Which is exactly why merge exists and is a first-class
 * operation rather than a repair script. The MPI reduces duplicates; only a merge
 * removes one.
 */
export async function registerPatient(input: RegisterPatientInput): Promise<RegisterPatientResult> {
  const ctx = getContext();

  const criteria = {
    name: input.name,
    ...(input.gender ? { gender: input.gender } : {}),
    ...(input.dob ? { dob: input.dob } : {}),
    ...(input.contact?.phone ? { phone: input.contact.phone } : {}),
  };

  const candidates = await repo.findCandidates({
    nameKey: nameKeyOf(input.name),
    ...(input.contact?.phone ? { phone: input.contact.phone } : {}),
    ...(input.dob ? { dob: input.dob } : {}),
  });
  const ranked = rank(criteria, candidates);
  const blocking = isProbableDuplicate(ranked);

  if (blocking && !input.force) {
    throw new DuplicatePatientError({
      candidates: serializeCandidates(ranked),
      threshold: DUPLICATE_THRESHOLD,
      hint: "Use the existing patient, or re-submit with force=true (requires patient:merge) if this is a different person.",
    });
  }

  if (blocking && input.force) {
    // `authorize` published the caller's live permissions into the context, so
    // this is checked against the database of record, not against the token.
    const held = ctx.permissions ?? [];
    if (!held.includes(PERMISSIONS.PATIENT_MERGE.code)) {
      throw new AppError("HMS-AUTH-005", 403, "Insufficient permissions", {
        required: PERMISSIONS.PATIENT_MERGE.code,
        reason: "overriding a duplicate-patient warning",
      });
    }
  }

  const overridden = blocking && input.force === true;

  /**
   * The REGISTERING branch (ADR-0015). A patient's IDENTITY is tenant-level — one UHID across every
   * branch, treatable anywhere — so this is provenance and the default list scope, never an
   * ownership wall. Resolved once, before the transaction: a caller who can reach several branches
   * and has selected none is asked to pick one (HMS-BRANCH-001).
   */
  const branchId = await writeBranchId(input.branchId);

  return withTransaction(async (session) => {
    const uhid = await repo.nextUhid(session);

    const patient = await repo.create(
      {
        uhid,
        name: input.name,
        gender: input.gender,
        ...(input.dob ? { dob: input.dob } : {}),
        ...(input.bloodGroup ? { bloodGroup: input.bloodGroup } : {}),
        branchId,
        ...(input.contact ? { contact: input.contact } : {}),
        ...(input.address ? { address: input.address } : {}),
        ...(ctx.userId ? { registeredBy: ctx.userId } : {}),
        ...(overridden && ctx.userId
          ? {
              duplicateOverride: {
                at: new Date(),
                by: ctx.userId,
                candidateIds: ranked.map((c) => c.patient.id),
              },
            }
          : {}),
      },
      session,
    );

    /**
     * An override is its own audit entry, separate from the `patient.created` one
     * the plugin writes. Someone declaring "these are different people" is a
     * clinical judgement with consequences, and it must be findable as an event —
     * not inferred later by noticing a field on a document.
     */
    if (overridden) {
      await recordAudit(
        {
          action: "patient.duplicateOverridden",
          category: "phi",
          resource: "patient",
          resourceId: patient.id,
          outcome: "success",
          meta: {
            uhid: patient.uhid,
            candidates: ranked.map((c) => ({
              id: c.patient.id,
              uhid: c.patient.uhid,
              score: c.score,
            })),
          },
        },
        session,
      );
    }

    /**
     * Same transaction as the insert (ADR-0007). The patient and the intent to
     * welcome them either both exist or neither does — there is no window in which
     * an SMS goes out about a patient who was never saved.
     *
     * No PHI in the payload beyond what a consumer needs to act: an id, a UHID, a
     * name. The outbox is durable storage that operators can read, so a payload
     * here outlives the request by years (EVENT_CATALOG).
     */
    await publish(
      {
        name: EVENTS.PATIENT_REGISTERED,
        payload: {
          patientId: patient.id,
          uhid: patient.uhid,
          name: patient.name,
          channel: "front-desk",
        },
        branchId,
      },
      session,
    );

    return {
      patient,
      // Below-threshold near-misses still go back to the caller — the clerk who
      // spots the real match in this list prevents a duplicate we never blocked.
      possibleDuplicates: overridden ? [] : ranked,
    };
  });
}

/**
 * Merges a duplicate into a survivor. **Nothing is deleted, ever.**
 *
 * A merged record keeps its row, its UHID and its history, and gains a pointer to
 * the survivor. Three reasons, none of them negotiable:
 *
 *   - The merged UHID is already out in the world — on a wristband, a lab slip, a
 *     discharge summary, an insurance claim. A lookup by that number must still
 *     resolve, or those documents become unverifiable.
 *   - A merge is a human decision and humans get it wrong. A merge that deleted
 *     the loser would be irreversible; this one is a pointer that can be examined,
 *     disputed and (with a future un-merge) undone.
 *   - Deleting clinical records is a statutory offence in most of the jurisdictions
 *     this product will be sold into (DATA_RETENTION_POLICY).
 *
 * The event is what re-points everything else. Every module that will hold a
 * `patientId` — appointments, visits, bills, lab orders — consumes
 * `patient.patients.merged` and updates its own references. That is why this is an
 * event rather than a cascade of writes here: the patients module must not know
 * the name of every collection that will ever reference a patient.
 */
export async function mergePatients(input: {
  survivorId: string;
  duplicateId: string;
  reason: string;
}): Promise<{ survivor: Patient; merged: Patient }> {
  if (input.survivorId === input.duplicateId) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      duplicateId: ["a patient cannot be merged into itself"],
    });
  }

  return withTransaction(async (session) => {
    const survivor = await repo.findByIdentity(input.survivorId, session);
    if (!survivor) throw new PatientNotFoundError({ patientId: input.survivorId });

    const duplicate = await repo.findByIdentity(input.duplicateId, session);
    if (!duplicate) throw new PatientNotFoundError({ patientId: input.duplicateId });

    /**
     * Refuse to build a chain. If the survivor is itself already merged into
     * someone else, then merging into it creates A → B → C, and every consumer
     * that re-points references now has to walk a linked list — one of which will
     * one day contain a cycle. Merge into the record that is actually alive.
     */
    if (survivor.status !== "active") {
      throw new AppError("HMS-STATE-001", 409, "Invalid state transition", {
        survivorId: survivor.id,
        status: survivor.status,
        reason: "the survivor has itself been merged; merge into the surviving record instead",
        ...(survivor.mergedInto ? { mergeInto: survivor.mergedInto } : {}),
      });
    }

    if (duplicate.status !== "active") {
      throw new AppError("HMS-STATE-001", 409, "Invalid state transition", {
        duplicateId: duplicate.id,
        status: duplicate.status,
        reason: "this record has already been merged",
      });
    }

    const merged = await repo.markMerged(duplicate.id, survivor.id, session);
    if (!merged) throw new PatientNotFoundError({ patientId: input.duplicateId });

    await recordAudit(
      {
        action: "patient.merged",
        category: "phi",
        resource: "patient",
        resourceId: survivor.id,
        outcome: "success",
        meta: {
          survivorId: survivor.id,
          survivorUhid: survivor.uhid,
          mergedId: merged.id,
          mergedUhid: merged.uhid,
          reason: input.reason,
        },
      },
      session,
    );

    await publish(
      {
        name: EVENTS.PATIENTS_MERGED,
        payload: {
          survivorId: survivor.id,
          survivorUhid: survivor.uhid,
          mergedId: merged.id,
          mergedUhid: merged.uhid,
        },
      },
      session,
    );

    return { survivor, merged };
  });
}

/**
 * Who this patient IS — tenant-wide, per ADR-0015 §5. See `findByIdentity` for the evidence.
 *
 * Resolving identity grants nothing operational: every encounter, order, admission, MAR row and
 * ward note is filtered on its own read path by the TREATING branch, so a clerk who can now name
 * a patient from another site still cannot open that site's visits. `listPatients` stays
 * branch-defaulted — a register is a site's own list, which is what `branchId` is FOR.
 */
export async function getPatient(id: string): Promise<Patient> {
  const patient = await repo.findByIdentity(id);
  if (!patient) throw new PatientNotFoundError({ patientId: id });
  return patient;
}

export async function getPatientByUhid(uhid: string): Promise<Patient> {
  const patient = await repo.findByUhid(uhid);
  if (!patient) throw new PatientNotFoundError({ uhid });
  return patient;
}

export async function listPatients(filter: repo.ListPatientsFilter): Promise<{
  patients: Patient[];
  total: number;
}> {
  return repo.list(filter);
}

/**
 * Corrects demographics. A merged record is immutable — it is a historical
 * artifact now, and editing it would silently change what the merge decision was
 * made on.
 */
export async function updatePatient(id: string, input: repo.UpdatePatientInput): Promise<Patient> {
  return withTransaction(async (session) => {
    const updated = await repo.update(id, input, session);
    if (!updated) throw new PatientNotFoundError({ patientId: id });
    return updated;
  });
}

/**
 * The duplicate check on its own — what the registration form calls as the clerk
 * types, so the warning appears BEFORE they fill in the whole form and hit save.
 * A block at submit time that could have been a hint at type time is a block the
 * user resents and learns to route around.
 */
export async function findDuplicates(criteria: {
  name: string;
  gender?: Gender;
  dob?: Date;
  phone?: string;
  excludeId?: string;
}): Promise<DuplicateCandidate[]> {
  const candidates = await repo.findCandidates({
    nameKey: nameKeyOf(criteria.name),
    ...(criteria.phone ? { phone: criteria.phone } : {}),
    ...(criteria.dob ? { dob: criteria.dob } : {}),
    ...(criteria.excludeId ? { excludeId: criteria.excludeId } : {}),
  });
  return rank(criteria, candidates);
}

export async function countPatients(): Promise<number> {
  return repo.count();
}
