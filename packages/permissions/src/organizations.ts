/**
 * Organization types and their POLICY PRESETS (ADR-0013 §5–6, Doc 07).
 *
 * ── THE ONE RULE THIS FILE EXISTS TO ENFORCE ────────────────────────────────
 *
 *     `if (tenant.organizationType === "government_hospital")` IS FORBIDDEN.
 *
 * Anywhere. Ever. The Constitution (§1) requires 25 organization types from ONE
 * codebase, differentiated only by feature flags, limits, configuration and
 * permissions. A type branch is a 26th axis that CI cannot enforce, tests cannot
 * cover, and every new customer widens.
 *
 * And the branch would not even be TRUE. Government hospitals routinely run paid
 * private wards beside free general wards; medical colleges charge some patients
 * and not others. A hard branch makes those customers unsellable. A policy makes
 * them a configuration change.
 *
 * So `organizationType` does exactly one thing: at PROVISIONING it selects a
 * preset. After that instant it is descriptive — sales metadata, a filter in the
 * operator console, a column in a report. The behaviour lives in the POLICY, which
 * the hospital can then edit without our involvement.
 *
 * ── WHY THE PRESET IS DERIVED, NOT COPIED ───────────────────────────────────
 * We do NOT snapshot the preset into the tenant's record. The effective policy is
 * `{ ...PRESET[type], ...tenant.overrides }`, resolved at read time. A copied
 * preset drifts: improve the government default next year and the hospitals
 * provisioned last year keep the old one, silently, forever. A derived preset with
 * explicit overrides means we can improve the default AND a hospital keeps every
 * deliberate choice it made.
 */

/**
 * The organization types we sell to. Deliberately NOT an exhaustive list of the 25
 * in Doc 07 — a type earns a place here only when it needs a DIFFERENT POLICY.
 * Adding a type that presets identically to an existing one is pure ceremony.
 */
export const ORGANIZATION_TYPES = [
  "private_hospital",
  "government_hospital",
  "clinic",
  "diagnostic_centre",
  "medical_college",
] as const;
export type OrganizationType = (typeof ORGANIZATION_TYPES)[number];

/** Where a patient journey starts (ADR-0013 §2). */
export const ENCOUNTER_ENTRIES = ["appointment", "walk_in", "both"] as const;
export type EncounterEntry = (typeof ENCOUNTER_ENTRIES)[number];

/** When the queue token is issued (ADR-0014 — against the ENCOUNTER, not the appointment). */
export const TOKEN_POINTS = ["registration", "check_in", "none"] as const;
export type TokenPoint = (typeof TOKEN_POINTS)[number];

/** Who the patient is queued to: a named doctor, or a department/OP room. */
export const ROUTING_MODES = ["doctor", "department"] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];

/**
 * When money is collected — and the reason `zero_tariff` is a TARIFF and not an
 * off-switch.
 *
 *   prepaid     — payment gates the consultation (private hospital).
 *   postpaid    — pay on the way out (clinic).
 *   zero_tariff — the patient pays NOTHING. Charges are still POSTED, at ₹0.
 *
 * A government hospital is free to the patient; it is not free to the state. It
 * must still report drug consumption, per-patient cost and NHM/NHM-style
 * utilisation, and those numbers are built from posted charges. If we "skip
 * billing" for them we throw away the data they are legally obliged to produce —
 * and, unlike a price, it cannot be reconstructed afterwards.
 *
 *     A zero-rupee invoice is a record. A missing invoice is a hole.
 *
 * This is why billing is never gated off by organization type: the tariff is
 * zero-rated, the module still runs.
 */
export const BILLING_MODES = ["prepaid", "postpaid", "zero_tariff"] as const;
export type BillingMode = (typeof BILLING_MODES)[number];

export const PHARMACY_MODES = ["in_house", "external"] as const;
export type PharmacyMode = (typeof PHARMACY_MODES)[number];

/**
 * The five switches that make one state graph serve every hospital (ADR-0013 §5).
 *
 * FIVE. Not a workflow engine, not a rules DSL, not a per-tenant graph. The three
 * canonical journeys — private, clinic, government — differ ONLY in these, and a
 * configurable workflow engine would be "different codebases" hidden inside data,
 * where CI cannot see it and no test can cover it.
 *
 * Adding a sixth switch is allowed. Adding a branch is not.
 */
export interface EncounterPolicy {
  entry: EncounterEntry;
  tokenIssuedAt: TokenPoint;
  routing: RoutingMode;
  billingMode: BillingMode;
  pharmacy: PharmacyMode;
}

export interface OrganizationPreset {
  code: OrganizationType;
  name: string;
  /** What the sales conversation actually sounds like. */
  description: string;
  encounterPolicy: EncounterPolicy;
  /** The edition this type usually starts on. A suggestion, never a constraint. */
  suggestedPlan: string;
}

export const ORGANIZATION_PRESETS: Record<OrganizationType, OrganizationPreset> = {
  private_hospital: {
    code: "private_hospital",
    name: "Private hospital",
    description: "Appointment-led. Patients book, arrive, and pay before they are seen.",
    encounterPolicy: {
      entry: "both",
      tokenIssuedAt: "check_in",
      routing: "doctor",
      billingMode: "prepaid",
      pharmacy: "in_house",
    },
    suggestedPlan: "PLAN_HOSPITAL",
  },

  government_hospital: {
    code: "government_hospital",
    name: "Government hospital",
    description:
      "Walk-in led, department-routed, FREE TO THE PATIENT. Charges are still posted at ₹0 — the hospital must report consumption and per-patient cost even when nobody pays.",
    encounterPolicy: {
      entry: "walk_in",
      // The queue starts at the registration counter, not at a check-in desk —
      // there is nothing to check in TO, because nothing was booked.
      tokenIssuedAt: "registration",
      // Patients are sent to an OP room / department, not to a named consultant.
      routing: "department",
      // ₹0 — and the invoice still exists. See BILLING_MODES.
      billingMode: "zero_tariff",
      pharmacy: "in_house",
    },
    suggestedPlan: "PLAN_HOSPITAL",
  },

  clinic: {
    code: "clinic",
    name: "Clinic / single doctor",
    description: "Walk-in led. One doctor, a token, pay on the way out.",
    encounterPolicy: {
      entry: "both",
      tokenIssuedAt: "registration",
      routing: "doctor",
      billingMode: "postpaid",
      pharmacy: "external",
    },
    suggestedPlan: "PLAN_CLINIC",
  },

  diagnostic_centre: {
    code: "diagnostic_centre",
    name: "Diagnostic centre",
    description:
      "Walk-in led, ORDER-led. Patients arrive with a prescription from elsewhere: there are orders and results, and often no consultation at all.",
    encounterPolicy: {
      entry: "both",
      tokenIssuedAt: "registration",
      routing: "department",
      billingMode: "prepaid",
      pharmacy: "external",
    },
    suggestedPlan: "PLAN_DIAGNOSTIC",
  },

  medical_college: {
    code: "medical_college",
    name: "Medical college hospital",
    description:
      "Walk-in led and department-routed like a government hospital, but it charges — usually a subsidised tariff rather than zero.",
    encounterPolicy: {
      entry: "both",
      tokenIssuedAt: "registration",
      routing: "department",
      billingMode: "postpaid",
      pharmacy: "in_house",
    },
    suggestedPlan: "PLAN_ENTERPRISE",
  },
};

/** The type a hospital gets when nobody said. The commonest customer. */
export const DEFAULT_ORGANIZATION_TYPE: OrganizationType = "private_hospital";

/**
 * The policy actually in force for a hospital: the preset, plus whatever that
 * hospital has deliberately changed.
 *
 * This is the ONLY function that should ever consult `organizationType`. Every
 * other caller asks for the POLICY — `policy.billingMode === "zero_tariff"`, not
 * `orgType === "government_hospital"`. The difference is not stylistic:
 *
 *   - The government hospital that opens a PAID private ward flips one override.
 *     Under a type branch it would need a code change, and would be unsellable.
 *   - A charitable trust hospital that is also free gets `zero_tariff` without us
 *     inventing a `charitable_trust` type or touching a line of billing code.
 */
export function resolveEncounterPolicy(
  organizationType: OrganizationType | undefined,
  overrides?: Partial<EncounterPolicy>,
): EncounterPolicy {
  const preset = ORGANIZATION_PRESETS[organizationType ?? DEFAULT_ORGANIZATION_TYPE];
  return { ...preset.encounterPolicy, ...overrides };
}
