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
  ConsultationNote,
  Encounter,
  Order,
  Paged,
  Patient,
  Prescription,
  VitalsReading,
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
