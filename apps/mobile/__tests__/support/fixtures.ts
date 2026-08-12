/**
 * Clinical fixtures, shaped by the CONTRACTS rather than by what a test happens to need.
 *
 * Every builder starts from a complete, valid record — `history: []`, `activeOrderCount: 0`,
 * `flags: {}` — so a test that forgets a field gets the API's real shape instead of a partial one
 * that would let a missing-field bug pass. Overrides are shallow on purpose: a test that wants a
 * nested change states the whole nested value, which keeps the fixture honest about what it is.
 */
import type {
  Allergy,
  BedBoard,
  ConsultationNote,
  Encounter,
  MedicationAdministration,
  Order,
  Paged,
  Patient,
  Prescription,
  VitalsReading,
  WardNote,
} from "@medicore/api-client";

export const PATIENT_ID = "patient-1";
export const ENCOUNTER_ID = "encounter-1";
export const EPISODE_ID = "episode-1";

export function patient(overrides: Partial<Patient> = {}): Patient {
  return {
    id: PATIENT_ID,
    uhid: "APL000123",
    name: "Meera Nair",
    gender: "female",
    status: "active",
    dob: "1991-04-02",
    contact: { phone: "9000000001" },
    createdAt: "2026-01-04T04:00:00.000Z",
    updatedAt: "2026-01-04T04:00:00.000Z",
    ...overrides,
  };
}

export function encounter(overrides: Partial<Encounter> = {}): Encounter {
  return {
    id: ENCOUNTER_ID,
    patientId: PATIENT_ID,
    episodeId: EPISODE_ID,
    origin: "walk_in",
    class: "OP",
    status: "in_queue",
    doctorId: "user-1",
    token: 12,
    arrivedAt: "2026-08-12T03:30:00.000Z",
    activeOrderCount: 0,
    history: [],
    createdAt: "2026-08-12T03:30:00.000Z",
    branchId: "branch-hyd",
    ...overrides,
  };
}

export function order(overrides: Partial<Order> = {}): Order {
  return {
    id: "order-1",
    encounterId: ENCOUNTER_ID,
    patientId: PATIENT_ID,
    episodeId: EPISODE_ID,
    category: "lab",
    code: "CBC",
    name: "Complete blood count",
    priority: "routine",
    status: "placed",
    orderedBy: "user-1",
    orderedAt: "2026-08-12T04:00:00.000Z",
    history: [],
    createdAt: "2026-08-12T04:00:00.000Z",
    branchId: "branch-hyd",
    ...overrides,
  };
}

/** A released result the lab flagged critical — the one case `criticalClinical` is spent on. */
export function criticalOrder(overrides: Partial<Order> = {}): Order {
  return order({
    id: "order-critical",
    name: "Serum potassium",
    status: "released",
    completedAt: "2026-08-12T05:00:00.000Z",
    verifiedBy: "user-lab",
    verifiedAt: "2026-08-12T05:10:00.000Z",
    releasedAt: "2026-08-12T05:20:00.000Z",
    result: {
      summary: "Potassium 7.1 mmol/L — critical",
      critical: true,
      values: [
        {
          code: "K",
          label: "Potassium",
          value: "7.1",
          unit: "mmol/L",
          referenceRange: "3.5–5.1",
          flag: "critical_high",
        },
      ],
    },
    ...overrides,
  });
}

export function vitals(overrides: Partial<VitalsReading> = {}): VitalsReading {
  return {
    id: "vitals-1",
    encounterId: ENCOUNTER_ID,
    patientId: PATIENT_ID,
    systolic: 148,
    diastolic: 92,
    pulse: 88,
    temperature: 37.4,
    spo2: 97,
    recordedBy: "user-nurse",
    recordedAt: "2026-08-12T03:45:00.000Z",
    flags: { systolic: "high", diastolic: "high", pulse: "normal" },
    abnormal: true,
    ...overrides,
  };
}

export function prescription(overrides: Partial<Prescription> = {}): Prescription {
  return {
    id: "rx-1",
    encounterId: ENCOUNTER_ID,
    patientId: PATIENT_ID,
    episodeId: EPISODE_ID,
    status: "signed",
    lines: [
      {
        drugCode: "AMOX500",
        drugName: "Amoxicillin 500mg",
        dose: "1 cap",
        route: "oral",
        frequency: "TDS",
        durationDays: 5,
        quantity: 15,
        dispensedQty: 0,
      },
    ],
    prescribedBy: "user-1",
    prescribedAt: "2026-08-12T04:30:00.000Z",
    signedBy: "user-1",
    signedAt: "2026-08-12T04:31:00.000Z",
    version: 1,
    history: [],
    createdAt: "2026-08-12T04:30:00.000Z",
    branchId: "branch-hyd",
    ...overrides,
  };
}

export function consultationNote(overrides: Partial<ConsultationNote> = {}): ConsultationNote {
  return {
    encounterId: ENCOUNTER_ID,
    patientId: PATIENT_ID,
    doctorId: "user-1",
    chiefComplaint: "Cough for four days",
    diagnoses: [{ text: "Acute bronchitis", type: "provisional" }],
    branchId: "branch-hyd",
    updatedAt: "2026-08-12T04:20:00.000Z",
    ...overrides,
  };
}

export function allergy(overrides: Partial<Allergy> = {}): Allergy {
  return {
    id: "allergy-1",
    patientId: PATIENT_ID,
    allergen: "penicillins",
    label: "Penicillins",
    severity: "anaphylaxis",
    status: "active",
    notedBy: "user-1",
    notedAt: "2026-02-01T04:00:00.000Z",
    ...overrides,
  };
}

/** The `{ items, meta }` envelope `paged()` unwraps, with the server's own `hasMore`. */
export function page<T>(items: T[], meta: Partial<Paged<T>["meta"]> = {}): Paged<T> {
  return {
    items,
    meta: { page: 1, limit: 20, total: items.length, hasMore: false, ...meta },
  };
}

/* ════════════════════════════════════════════════════════════════════════════
 * IPD (M2 J)
 * ══════════════════════════════════════════════════════════════════════════ */

export const IP_ENCOUNTER_ID = "encounter-ip-1";

/**
 * An admission. `class: "IP"`, `status: "in_progress"`, a bed and an `admittedAt` — exactly what
 * `admitPatient` writes, because the IP encounter IS the admission (ADR-0013 §1) and there is no
 * second object to fake.
 */
export function inpatient(overrides: Partial<Encounter> = {}): Encounter {
  return encounter({
    id: IP_ENCOUNTER_ID,
    class: "IP",
    status: "in_progress",
    origin: "transfer",
    bed: { ward: "General ward", bedCode: "G-14", tariffCode: "BED-GEN", bedId: "bed-14" },
    admittedAt: "2026-08-10T18:30:00.000Z",
    admittedFrom: ENCOUNTER_ID,
    ...overrides,
  });
}

export function wardNote(overrides: Partial<WardNote> = {}): WardNote {
  return {
    id: "note-1",
    encounterId: IP_ENCOUNTER_ID,
    patientId: PATIENT_ID,
    episodeId: EPISODE_ID,
    type: "progress",
    text: "Reviewed. Afebrile overnight, chest clear. Continue same.",
    authorId: "user-1",
    at: "2026-08-12T03:40:00.000Z",
    branchId: "branch-hyd",
    ...overrides,
  };
}

export function dose(overrides: Partial<MedicationAdministration> = {}): MedicationAdministration {
  return {
    id: "mar-1",
    encounterId: IP_ENCOUNTER_ID,
    patientId: PATIENT_ID,
    prescriptionId: "rx-1",
    drugCode: "AMOX500",
    drugName: "Amoxicillin 500mg",
    dose: "1 cap",
    route: "oral",
    status: "given",
    administeredAt: "2026-08-12T03:00:00.000Z",
    administeredBy: "user-nurse",
    ...overrides,
  };
}

/**
 * The estate, with one occupied bed, one free, one blocked, and one legacy free-text stay.
 *
 * The counts are the SERVER's — deliberately stated here rather than derived from the beds array,
 * because that is the contract the app must not second-guess. A test that computed them would be
 * testing its own arithmetic and would keep passing if the app started computing them too.
 */
export function bedBoard(overrides: Partial<BedBoard> = {}): BedBoard {
  return {
    wards: [
      {
        wardId: "ward-gen",
        name: "General ward",
        kind: "general",
        status: "active",
        tariffCode: "BED-GEN",
        counts: { total: 24, free: 21, occupied: 2, blocked: 1 },
        beds: [
          {
            bedId: "bed-14",
            code: "G-14",
            roomId: "room-2",
            roomName: "Room 2",
            roomKind: "sharing",
            tariffCode: "BED-GEN",
            state: "occupied",
            occupant: {
              encounterId: IP_ENCOUNTER_ID,
              patientId: PATIENT_ID,
              patientName: "Meera Nair",
              uhid: "APL000123",
              admittedAt: "2026-08-10T18:30:00.000Z",
              doctorId: "user-1",
            },
          },
          { bedId: "bed-15", code: "G-15", tariffCode: "BED-GEN", state: "free" },
          {
            bedId: "bed-16",
            code: "G-16",
            tariffCode: "BED-GEN",
            state: "blocked",
            blockedReason: "Awaiting deep clean",
          },
        ],
      },
      {
        wardId: "ward-icu",
        name: "ICU",
        kind: "icu",
        status: "active",
        tariffCode: "BED-ICU",
        counts: { total: 6, free: 5, occupied: 1, blocked: 0 },
        beds: [
          {
            bedId: "bed-icu-1",
            code: "I-01",
            tariffCode: "BED-ICU",
            state: "occupied",
            occupant: {
              encounterId: "encounter-ip-2",
              patientId: "patient-2",
              patientName: "Rahul Verma",
              uhid: "APL000456",
              admittedAt: "2026-08-11T02:00:00.000Z",
            },
          },
        ],
      },
    ],
    totals: { total: 30, free: 26, occupied: 3, blocked: 1 },
    unlisted: [
      {
        encounterId: "encounter-ip-3",
        patientId: "patient-3",
        patientName: "Anita Das",
        uhid: "APL000789",
        ward: "Maternity",
        bedCode: "M-3",
        admittedAt: "2026-08-12T01:00:00.000Z",
      },
    ],
    ...overrides,
  };
}
