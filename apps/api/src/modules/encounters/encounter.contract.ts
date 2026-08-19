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
import type {
  AdmitResult,
  EncounterRow,
  InpatientRow,
  StartEncounterResult,
} from "./encounter.service.js";

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
 * Who the visit belongs to — carried by every LIST a person reads.
 *
 * ── THE SAME DEFECT, TWICE, BECAUSE ONLY ONE LIST WAS FIXED ─────────────────
 * An encounter is a visit; naming the patient on every single one of them would cost a lookup on
 * paths that never display a name — `GET /encounters/:id` still does not carry it. But a LIST of
 * visits is a screen somebody reads, and every consumer of one needs exactly this: who.
 *
 * Leaving them to reconstruct it produced the defect on `/inpatients` first: the web ward page
 * resolved names from the hundred most recently REGISTERED patients, so anyone admitted longer ago
 * than that reached the medication confirmation with no name and no UHID — the identity check that
 * catches the right drug given to the wrong person. That was fixed here, for that one route, and
 * the doctor's queue went on doing the identical join against the identical hundred: 15 of 99 rows
 * showed a dash where a person should be (D18). Both lists now carry identity, so there is no
 * longer a "which list did we fix" to get wrong.
 *
 * Resolved server-side by `namesByIds`, exactly as `/bed-board` and `/medication-round` already
 * do — the same call, the same hospital-wide semantics, no new domain rule. Additive: every field
 * an existing client reads is still here and still means what it meant.
 */
const patientIdentity = {
  /** `Unknown patient` when the record cannot be read — never silently blank. */
  patientName: z.string(),
  /** Empty only when the patient record itself carries none. */
  uhid: z.string(),
};

/** A queue/register row: the encounter plus who it is about. */
export const encounterRow = contract("EncounterRow", encounter.extend(patientIdentity));
export type EncounterRowProof = Proves<Matches<typeof encounterRow, EncounterRow>>;

/** A stay on the ward list. Structurally the same row; named separately because `/inpatients`
 *  has documented `InpatientRow` since it was built, and a schema name is public surface. */
export const inpatientRow = contract("InpatientRow", encounter.extend(patientIdentity));
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
