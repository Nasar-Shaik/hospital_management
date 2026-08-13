/**
 * Encounter response contracts — the visit, which is the spine of the clinical record.
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves } from "../../core/http/contract.js";
import {
  DISCHARGE_DISPOSITIONS,
  ENCOUNTER_CLASSES,
  ENCOUNTER_ORIGINS,
  ENCOUNTER_STATUSES,
} from "./encounter.model.js";
import type { Encounter } from "./encounter.repository.js";
import type { AdmitResult, InpatientRow, StartEncounterResult } from "./encounter.service.js";

const encounterStatus = z.enum(ENCOUNTER_STATUSES);

export const encounterHistoryEntry = contract(
  "EncounterHistoryEntry",
  z.object({
    from: encounterStatus,
    to: encounterStatus,
    at: z.string(),
    by: z.string().optional(),
    reason: z.string().optional(),
  }),
);

export const encounter = contract(
  "Encounter",
  z.object({
    id: z.string(),
    patientId: z.string(),
    episodeId: z.string(),
    origin: z.enum(ENCOUNTER_ORIGINS),
    class: z.enum(ENCOUNTER_CLASSES),
    status: encounterStatus,
    appointmentId: z.string().optional(),
    doctorId: z.string().optional(),
    departmentId: z.string().optional(),
    /** The number the patient is called by. Lives HERE, not on the appointment. */
    token: z.number().optional(),
    /** A paid fast-track OP visit — sorts above normal patients in the doctor's queue. */
    express: z.boolean().optional(),
    reason: z.string().optional(),
    /** The doctor's OP visit summary — printed on the OPD slip. */
    diagnosis: z.string().optional(),
    advice: z.string().optional(),
    branchId: z.string().optional(),
    arrivedAt: z.string(),
    /**
     * When the doctor called the patient in. ABSENT MEANS THE CONSULTATION HAS NOT STARTED —
     * which is what the OPD slip reads to decide whether a doctor's signature belongs on the
     * sheet. `doctorId` is who they are waiting for, and is set at registration.
     */
    seenAt: z.string().optional(),
    closedAt: z.string().optional(),
    /** Present when `class` is `IP`. The bed is recorded, not reserved. */
    bed: z
      .object({
        ward: z.string(),
        bedCode: z.string(),
        tariffCode: z.string(),
        bedId: z.string().optional(),
      })
      .optional(),
    admittedAt: z.string().optional(),
    dischargedAt: z.string().optional(),
    disposition: z.enum(DISCHARGE_DISPOSITIONS).optional(),
    admittedFrom: z.string().optional(),
    /** Still-live orders on this visit — the guard on "send for investigations" reads it. */
    activeOrderCount: z.number(),
    history: z.array(encounterHistoryEntry),
    createdAt: z.string(),
  }),
);
export type EncounterProof = Proves<Matches<typeof encounter, Encounter>>;

/**
 * A stay on the ward list, WITH the patient it belongs to.
 *
 * ── WHY THE WARD LIST IDENTIFIES ITS PATIENTS AND A BARE ENCOUNTER DOES NOT ──
 * An encounter is a visit; naming the patient on every one of them would cost a lookup on paths
 * that never display a name. But `/inpatients` is read by a human walking a ward, and every
 * consumer of it needs exactly this: who is in the bed. Leaving them to reconstruct it produced a
 * real defect — the web ward page resolved names from the hundred most recently REGISTERED
 * patients, so anyone admitted longer ago than that reached the medication confirmation with no
 * name and no UHID, which is the identity check that catches the right drug given to the wrong
 * person.
 *
 * Resolved server-side by `namesByIds`, exactly as `/bed-board` and `/medication-round` already
 * do — the same call, the same hospital-wide semantics, no new domain rule. Additive: every field
 * an existing client reads is still here and still means what it meant.
 */
export const inpatientRow = contract(
  "InpatientRow",
  encounter.extend({
    /** `Unknown patient` when the record cannot be read — never silently blank. */
    patientName: z.string(),
    /** Empty only when the patient record itself carries none. */
    uhid: z.string(),
  }),
);
export type InpatientRowProof = Proves<Matches<typeof inpatientRow, InpatientRow>>;

/** 201 for a new visit, 200 when the patient was already in the building — `resumed` says which. */
export const startEncounterResult = contract(
  "StartEncounterResult",
  z.object({ encounter, resumed: z.boolean() }),
);
export type StartEncounterResultProof = Proves<
  Matches<typeof startEncounterResult, StartEncounterResult>
>;

/** Admission closes the OP encounter and opens an IP one in the same episode. */
export const admitResult = contract(
  "AdmitResult",
  z.object({ outpatient: encounter, inpatient: encounter }),
);
export type AdmitResultProof = Proves<Matches<typeof admitResult, AdmitResult>>;
