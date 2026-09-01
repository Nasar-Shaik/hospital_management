/**
 * Plain-language guide to what each role is FOR.
 *
 * ── WHY THIS LIVES IN THE WEB, NOT THE PERMISSIONS PACKAGE ───────────────────
 * The permissions package is the source of truth for what a role may DO (its permission
 * codes). This is the source of truth for how to EXPLAIN that to a hospital administrator who
 * is deciding which logins to create — onboarding copy, not authorization. Keeping it here
 * means the wording can be tuned without touching the authorization catalogue or shipping a
 * migration for a sentence. The roles themselves still come from the API (`listRoles`); this
 * only decorates the ones it recognises, and an unrecognised role falls back to its own
 * description, so a custom role a hospital adds later never breaks this screen.
 */

export interface RoleGuideEntry {
  /** One line: who this is. */
  summary: string;
  /** The single most useful sentence for an admin: when to create this login. */
  createFor: string;
  /** Day-to-day responsibilities, in the words a hospital uses. */
  duties: string[];
  /** The parts of the app this login opens. */
  access: string[];
}

/**
 * Keyed on the role CODE (stable), never the display name. Covers the roles the product ships
 * with; a hospital's own custom roles simply have no entry and render their description.
 */
export const ROLE_GUIDE: Record<string, RoleGuideEntry> = {
  TENANT_ADMIN: {
    summary: "Runs the hospital's account — the login you are using now.",
    createFor: "There is normally one. It sets up everyone else and configures the hospital.",
    duties: [
      "Create, edit, disable and re-enable every other staff login",
      "Assign roles and reset passwords",
      "See the subscription, usage and the full activity trail",
      "Configure the hospital's settings, tariffs and services",
    ],
    access: ["Everything — this login is not restricted by department"],
  },
  DOCTOR: {
    summary: "Sees patients, decides care, and signs the record.",
    createFor:
      "Create a doctor login for anyone who runs an OPD clinic, admits patients, or needs to see their own appointment queue.",
    duties: [
      "See the queue of patients waiting for them and call them in",
      "Order lab tests and X-rays, and read the results that come back",
      "Prescribe medicines (checked against the patient's allergies)",
      "Admit a patient to a bed, write ward notes, and discharge them",
      "Transfer a case to another doctor",
    ],
    access: ["My patients", "Worklist (their orders)", "Ward", "Appointments"],
  },
  NURSE: {
    summary: "Bedside and ward care — vitals, medication rounds, nursing notes.",
    createFor:
      "Create a nurse login for ward and triage staff who record vitals, give medicines and move patients along the queue.",
    duties: [
      "Record vitals and nursing notes",
      "Administer prescribed medicines on the ward round",
      "Collect samples for the lab",
      "Maintain the patient's allergy list",
    ],
    access: ["My patients (read)", "Ward", "Worklist"],
  },
  RECEPTIONIST: {
    summary: "The front desk — registration, appointments and the day's register.",
    createFor:
      "Create a receptionist login for the front desk. Nobody becomes a patient in the system without this login.",
    duties: [
      "Register new patients and issue their permanent UHID",
      "Book, reschedule and check in appointments",
      "Start a visit and put the patient in a doctor's queue",
      "See the day's list of patients by date",
    ],
    access: ["Reception", "Appointments", "Patients"],
  },
  LAB_TECHNICIAN: {
    summary: "Runs the diagnostic tests and enters the results.",
    createFor:
      "Create a lab technician login for anyone who collects samples, runs blood tests, and uploads reports. This is the login that turns an ordered test into a diagnosis.",
    duties: [
      "Accept a test off the lab worklist and run it",
      "Enter results and upload report files (PDF or image)",
      "Collect and label samples",
    ],
    access: ["Worklist (lab)"],
  },
  PATHOLOGIST: {
    summary: "Approves and signs off laboratory results — the second pair of eyes.",
    createFor:
      "Create a pathologist login for the senior who certifies blood results. Deliberately separate from the technician who ran the test.",
    duties: [
      "Review the technician's results and verify them",
      "Release the report to the ordering doctor",
      "Cannot run the test they sign — that is the technician's job, on purpose",
    ],
    access: ["Worklist (lab approval)"],
  },
  RADIOLOGY_TECHNICIAN: {
    summary: "Takes X-rays, ultrasounds and scans, and reports them.",
    createFor:
      "Create this login for whoever operates the imaging room. It is the only radiology login most hospitals need — a radiologist is optional.",
    duties: [
      "See imaging asked for by the doctors, on this site's worklist",
      "Perform the study, type the findings, attach the film",
      "Release the report to the doctor who asked",
      "Cannot open the patient's chart — only the studies on their own worklist",
    ],
    access: ["Worklist (radiology)"],
  },
  RADIOLOGIST: {
    summary: "Reads and signs imaging studies. Optional — most hospitals do not need one.",
    createFor:
      "Only if a consultant radiologist reads your imaging. Give the technician the study and the radiologist the sign-off; otherwise the technician does both.",
    duties: [
      "Report on imaging studies and sign them",
      "Verify and release imaging reports to the doctor",
      "Read the patient's chart alongside the study",
    ],
    access: ["Worklist (radiology)", "Patient charts"],
  },
  PHARMACIST: {
    summary: "Dispenses medicines and runs the pharmacy stock.",
    createFor:
      "Create a pharmacist login for the medicine counter. They see what a doctor prescribed and hand it over.",
    duties: [
      "See prescriptions the moment a doctor signs them",
      "Dispense — including handing over less than prescribed — and take payment",
      "See the patient's allergies (the last check before a drug leaves the shelf)",
      "Maintain the medicine list and stock",
    ],
    access: ["Pharmacy"],
  },
  CASHIER: {
    summary: "The billing counter — bills and payments.",
    createFor: "Create a cashier login for the billing desk.",
    duties: ["Finalise a bill and take payment", "See what each visit owes"],
    access: ["Billing"],
  },
  AUDITOR: {
    summary: "Read-only compliance access. Can look, can change nothing.",
    createFor:
      "Create an auditor login for compliance or finance review — someone who must see the activity trail without being able to touch clinical data.",
    duties: [
      "Read the tamper-evident activity trail and export it",
      "Cannot create, edit or delete anything",
    ],
    access: ["Activity trail"],
  },
  PATIENT: {
    summary: "The patient's own portal login (not staff).",
    createFor:
      "Not a staff role — this is for a patient to see their own records. Do not assign it to staff.",
    duties: ["See their own visits, prescriptions and reports"],
    access: ["Patient portal (self-service only)"],
  },
};
