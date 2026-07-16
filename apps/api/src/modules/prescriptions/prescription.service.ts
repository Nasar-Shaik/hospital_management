/**
 * Prescription service (STATE_MACHINE_CATALOG §6).
 *
 * ── THE SHAPE OF THIS MODULE ────────────────────────────────────────────────
 * Compose → sign → (the pharmacy dispenses against it) → dispensed.
 *
 * This module owns the first half and NOT the second: `pharmacy` moves the dispensing
 * states, because the quantities that drive them are recorded at the counter. What lives
 * here is the doctor's half — writing it, signing it, amending it, stopping it.
 *
 * ── SAFETY SCREENING AT THE SIGNATURE ───────────────────────────────────────
 * Signing runs the prescription through `drugSafety.screen()` against the patient's active
 * allergies. An allergy CONTRAINDICATION blocks the signature: it is refused (HMS-RX-001)
 * unless the prescriber supplies an override reason, which is then recorded on the
 * prescription as a medicolegal fact (`safetyOverride`). Lesser findings — cross-sensitivity,
 * a drug interaction, duplicate therapy — are returned by the screen endpoint and shown on
 * the pad, but do NOT block: a hard block on every warning is how prescribers learn to click
 * past the one that matters.
 *
 * ── WHAT THIS MODULE STILL DOES NOT DO ──────────────────────────────────────
 * Renal dosing, paediatric weight bands, pregnancy category, dose ceilings. `drugSafety` is
 * a curated net over fifteen demo drugs, not a formulary — see its header. The SHAPE is the
 * shipping one; the data is not.
 */
import { AppError } from "../../core/errors/appError.js";
import { getContext } from "../../core/context/requestContext.js";
import { withTransaction } from "../../core/db/transaction.js";
import { publish } from "../../core/events/outbox.js";
import { EVENTS } from "../../core/events/eventCatalog.js";
import { getEncounter, isOpen } from "../encounters/index.js";
import { getById as getTenant, policyOf } from "../tenants/index.js";
import { activeAllergies } from "../allergies/index.js";
import {
  screen,
  isBlocking,
  isAllergen,
  type SafetyAlert,
  type ScreenAllergy,
} from "../drugSafety/index.js";
import * as repo from "./prescription.repository.js";
import {
  canTransition,
  type PrescriptionLine,
  type PrescriptionStatus,
} from "./prescription.model.js";

export type { Prescription } from "./prescription.repository.js";

/** What the doctor types. `dispensedQty` is NOT here — only the pharmacy may move it. */
export interface PrescriptionLineInput {
  drugCode: string;
  drugName: string;
  dose: string;
  route: PrescriptionLine["route"];
  frequency: PrescriptionLine["frequency"];
  durationDays?: number;
  quantity: number;
  instructions?: string;
}

export interface CreatePrescriptionInput {
  encounterId: string;
  lines: PrescriptionLineInput[];
  notes?: string;
}

function invalidTransition(from: PrescriptionStatus, to: PrescriptionStatus): AppError {
  return new AppError("HMS-STATE-001", 422, "Invalid state transition", {
    from,
    to,
    allowed: "see STATE_MACHINE_CATALOG §6",
  });
}

/**
 * `dispensedQty` always starts at zero, and the caller does not get a vote.
 *
 * The doctor's input type has no such field, but the SERVICE input is also reachable from
 * a future internal caller, and a prescription that arrived claiming its drugs were
 * already handed over would be dispensed-on-paper and never actually given.
 */
function toLines(input: PrescriptionLineInput[]): PrescriptionLine[] {
  return input.map((l) => ({
    drugCode: l.drugCode,
    drugName: l.drugName,
    dose: l.dose,
    route: l.route,
    frequency: l.frequency,
    quantity: l.quantity,
    dispensedQty: 0,
    ...(l.durationDays === undefined ? {} : { durationDays: l.durationDays }),
    ...(l.instructions ? { instructions: l.instructions } : {}),
  }));
}

/**
 * Writes a prescription. It starts as a DRAFT and binds nobody until it is signed.
 *
 * ── A PRESCRIPTION REQUIRES AN OPEN ENCOUNTER ───────────────────────────────
 * Same rule as an order, and for a sharper reason: prescribing against a closed visit
 * means writing drugs for a patient who has gone home, on a visit that has been settled,
 * with nobody in the building to check them against. If the patient needs something after
 * they have left, they have come back — and coming back is a new encounter in the same
 * episode. That is exactly what an Episode of Care is for (ADR-0013 §4).
 */
export async function createPrescription(
  input: CreatePrescriptionInput,
): Promise<repo.Prescription> {
  const encounter = await requireOpenEncounter(input.encounterId);

  return repo.create({
    encounterId: encounter.id,
    // From the ENCOUNTER, never from the body. A caller who could name the patient could
    // write drugs onto somebody else's chart.
    patientId: encounter.patientId,
    episodeId: encounter.episodeId,
    lines: toLines(input.lines),
    ...(input.notes ? { notes: input.notes } : {}),
    ...(encounter.branchId ? { branchId: encounter.branchId } : {}),
  });
}

async function requireOpenEncounter(
  encounterId: string,
): Promise<{ id: string; patientId: string; episodeId: string; branchId?: string }> {
  const encounter = await getEncounter(encounterId);
  if (!encounter) {
    throw new AppError("HMS-GEN-404", 404, "Encounter not found", { encounterId });
  }
  if (!isOpen(encounter.status)) {
    throw new AppError("HMS-STATE-001", 422, "Cannot prescribe against a closed visit", {
      encounterId: encounter.id,
      status: encounter.status,
      hint: "the patient has left — a further prescription means a new encounter in the same episode",
    });
  }
  return encounter;
}

/** Edits a draft. Refused once signed — that is what `amendPrescription` is for. */
export async function updateDraft(
  id: string,
  input: { lines: PrescriptionLineInput[]; notes?: string },
): Promise<repo.Prescription> {
  const existing = await repo.findById(id);
  if (!existing) throw notFound(id);

  const updated = await repo.updateDraftLines(id, toLines(input.lines), input.notes);
  if (!updated) {
    /**
     * The repository's filter includes `status: "draft"`, so a miss here means it is no
     * longer a draft — it was signed between our read and our write. The error names the
     * remedy rather than just refusing, because the doctor's next question is always
     * "then how do I change the dose?".
     */
    throw new AppError("HMS-STATE-001", 422, "A signed prescription cannot be edited", {
      id,
      status: existing.status,
      hint: "sign a new version instead — POST /prescriptions/:id/amend",
    });
  }

  return updated;
}

/** The safety screen for a prescription — its alerts, and whether any of them blocks. */
export interface PrescriptionScreening {
  prescriptionId: string;
  alerts: SafetyAlert[];
  /** True when at least one alert is a contraindication (see `drugSafety.isBlocking`). */
  blocking: boolean;
}

/**
 * Screens a prescription against the patient's active allergies WITHOUT signing it.
 *
 * The pad calls this as the doctor composes, so the alerts appear before the signature, not
 * as a refusal at the end. It reads the SAME facts and runs the SAME pure function the
 * signature does, so what the doctor is shown and what the signature enforces cannot drift.
 *
 * The allergen read is patient-wide, never branch-scoped (allergy.repository.ts) — an
 * allergy from another branch must still fire here, or the screen is a comforting lie.
 */
export async function screenPrescription(id: string): Promise<PrescriptionScreening> {
  const rx = await repo.findById(id);
  if (!rx) throw notFound(id);

  const allergies = await activeAllergies(rx.patientId);
  const screenAllergies: ScreenAllergy[] = allergies
    // Defensive: only catalogued allergens can match a drug. A stray free-text row (there
    // should be none — the DTO forbids it) is ignored rather than silently breaking the map.
    .filter((a) => isAllergen(a.allergen))
    .map((a) => ({ allergen: a.allergen as ScreenAllergy["allergen"], severity: a.severity }));

  const alerts = screen(
    rx.lines.map((l) => ({ drugCode: l.drugCode, drugName: l.drugName })),
    screenAllergies,
  );

  return { prescriptionId: rx.id, alerts, blocking: alerts.some(isBlocking) };
}

export interface SignOptions {
  /** The prescriber's justification for signing THROUGH a blocking alert. Required to override. */
  overrideReason?: string;
}

/**
 * The signature. This is the moment the document becomes real.
 *
 * ── THE SAFETY BLOCK ────────────────────────────────────────────────────────
 * Before anything is committed, the prescription is screened. A blocking alert (an allergy
 * contraindication) refuses the signature with HMS-RX-001 and the alerts attached — UNLESS
 * the caller supplies `overrideReason`, in which case the signature proceeds and the override
 * is written onto the prescription as a permanent record of who decided what, and why. The
 * screen runs server-side here regardless of what the pad showed: the enforcement point must
 * never trust the client to have checked.
 *
 * ── WHY THE PHARMACY ORDER IS NOT PLACED HERE ───────────────────────────────
 * `placeOrder` opens its own transaction and `withTransaction` is not re-entrant, so
 * calling it from inside this one would commit the order independently of the signature.
 * A crash between the two would leave pharmacy work for a prescription nobody signed —
 * which is a drug leaving a shelf on an authority that does not exist.
 *
 * So the event is published in the SAME transaction as the signature, and
 * `prescription.consumers.ts` places the order from it. The hand-off becomes durable
 * rather than merely probable, and it is idempotent on `rx:<id>`.
 */
export async function signPrescription(
  id: string,
  options: SignOptions = {},
): Promise<repo.Prescription> {
  const ctx = getContext();

  const existing = await repo.findById(id);
  if (!existing) throw notFound(id);
  if (!canTransition(existing.status, "signed")) throw invalidTransition(existing.status, "signed");

  /**
   * ── AN EMPTY PRESCRIPTION IS NOT A PRESCRIPTION ─────────────────────────────
   * Signing zero drugs would produce a legal instrument authorising nothing, a pharmacy
   * order with no work in it, and a worklist item the pharmacist cannot action or clear.
   * It is always a mis-click, and it is free to refuse.
   */
  if (existing.lines.length === 0) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      lines: ["a prescription must contain at least one drug before it can be signed"],
    });
  }

  // The patient must still be on the visit — checked at signing as well as at drafting,
  // because a draft can sit on screen while the encounter closes underneath it.
  await requireOpenEncounter(existing.encounterId);

  /**
   * ── THE SAFETY GATE ─────────────────────────────────────────────────────────
   * Re-screen at the signature, server-side, whatever the pad displayed. A blocking alert
   * refuses the signature unless the prescriber has justified overriding it — and when they
   * have, the justification and the exact alerts they saw are recorded on the prescription.
   */
  const screening = await screenPrescription(id);
  const blockingAlerts = screening.alerts.filter(isBlocking);

  if (blockingAlerts.length > 0 && !options.overrideReason?.trim()) {
    throw new AppError("HMS-RX-001", 422, "This prescription is blocked by a safety alert", {
      alerts: screening.alerts,
      hint: "a contraindication must be acknowledged with an override reason before signing",
    });
  }

  const safetyOverride =
    blockingAlerts.length > 0 && options.overrideReason?.trim()
      ? {
          reason: options.overrideReason.trim(),
          by: ctx.userId ?? "system",
          at: new Date(),
          // Snapshot ALL alerts shown, not only the blocking ones — the record is "what was
          // this prescriber looking at when they decided", and a warning informs that too.
          alerts: screening.alerts.map((a) => ({
            kind: a.kind,
            severity: a.severity,
            message: a.message,
            ...(a.allergen ? { allergen: a.allergen } : {}),
          })),
        }
      : undefined;

  return withTransaction(async (session) => {
    const signed = await repo.setStatus(
      id,
      existing.status,
      "signed",
      {
        from: existing.status,
        to: "signed",
        at: new Date(),
        ...(ctx.userId ? { by: ctx.userId } : {}),
        ...(safetyOverride ? { reason: `safety override: ${safetyOverride.reason}` } : {}),
      },
      session,
      {
        signedAt: new Date(),
        ...(ctx.userId ? { signedBy: ctx.userId } : {}),
        ...(safetyOverride ? { safetyOverride } : {}),
      },
    );

    // The repository matched on `status: draft`, so a miss is a lost race, not a lost row.
    if (!signed) throw invalidTransition(existing.status, "signed");

    await publish(
      {
        name: EVENTS.PRESCRIPTION_SIGNED,
        payload: {
          prescriptionId: signed.id,
          encounterId: signed.encounterId,
          patientId: signed.patientId,
          episodeId: signed.episodeId,
          // The consumer places the pharmacy order in this doctor's name — a consumer
          // has no user of its own, and "who prescribed this" must not decay to "system".
          prescribedBy: signed.signedBy ?? signed.prescribedBy,
          itemCount: signed.lines.length,
        },
        ...(signed.branchId ? { branchId: signed.branchId } : {}),
      },
      session,
    );

    return signed;
  });
}

/**
 * The doctor stops it.
 *
 * Doses already dispensed are untouched, deliberately (STATE_MACHINE_CATALOG §6): they
 * were handed over, they were charged, and they are in the patient. Cancellation stops
 * what has not happened yet. The pharmacy order is cancelled by the consumer — if the
 * pharmacist has not started, the work simply disappears from their counter.
 */
export async function cancelPrescription(id: string, reason: string): Promise<repo.Prescription> {
  const ctx = getContext();

  const existing = await repo.findById(id);
  if (!existing) throw notFound(id);
  if (!canTransition(existing.status, "cancelled")) {
    throw invalidTransition(existing.status, "cancelled");
  }

  return withTransaction(async (session) => {
    const cancelled = await repo.setStatus(
      id,
      existing.status,
      "cancelled",
      {
        from: existing.status,
        to: "cancelled",
        at: new Date(),
        reason,
        ...(ctx.userId ? { by: ctx.userId } : {}),
      },
      session,
      { cancelReason: reason },
    );
    if (!cancelled) throw invalidTransition(existing.status, "cancelled");

    await publish(
      {
        name: EVENTS.PRESCRIPTION_CANCELLED,
        payload: {
          prescriptionId: cancelled.id,
          encounterId: cancelled.encounterId,
          patientId: cancelled.patientId,
          reason,
          ...(cancelled.orderId ? { orderId: cancelled.orderId } : {}),
        },
        ...(cancelled.branchId ? { branchId: cancelled.branchId } : {}),
      },
      session,
    );

    return cancelled;
  });
}

/** Binned before it ever bound anyone. Drafts only — see TRANSITIONS. */
export async function discardPrescription(id: string): Promise<repo.Prescription> {
  const ctx = getContext();

  const existing = await repo.findById(id);
  if (!existing) throw notFound(id);
  if (!canTransition(existing.status, "discarded")) {
    throw invalidTransition(existing.status, "discarded");
  }

  const discarded = await repo.setStatus(id, existing.status, "discarded", {
    from: existing.status,
    to: "discarded",
    at: new Date(),
    ...(ctx.userId ? { by: ctx.userId } : {}),
  });
  if (!discarded) throw invalidTransition(existing.status, "discarded");

  return discarded;
}

/**
 * Changes a signed prescription — by replacing it, never by editing it.
 *
 * ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
 * "Signed is immutable" without an amend path means a doctor who typed 500mg instead of
 * 50mg can only cancel and start again — so the record shows a cancellation and an
 * unrelated new prescription, and the fact that ONE WAS A CORRECTION OF THE OTHER is
 * lost. That link is the single most interesting thing about a dose change when somebody
 * asks, six months later, what happened.
 *
 * So: a new DRAFT, carrying the old lines forward to be edited, at `version + 1`, with
 * `supersedes` pointing back. The original stays exactly as it was signed, forever.
 *
 * The old prescription is NOT cancelled here. It is cancelled when the new version is
 * signed — until then the patient is still on the old drugs, and a chart that showed
 * nothing in force while the doctor was mid-edit would be a lie.
 */
export async function amendPrescription(id: string): Promise<repo.Prescription> {
  const existing = await repo.findById(id);
  if (!existing) throw notFound(id);

  if (existing.status === "draft") {
    throw new AppError("HMS-STATE-001", 422, "A draft can be edited directly", {
      id,
      hint: "PATCH /prescriptions/:id — there is nothing to supersede yet",
    });
  }
  if (existing.supersededById) {
    throw new AppError("HMS-STATE-001", 422, "This prescription has already been superseded", {
      id,
      supersededById: existing.supersededById,
    });
  }

  await requireOpenEncounter(existing.encounterId);

  const next = await repo.create({
    encounterId: existing.encounterId,
    patientId: existing.patientId,
    episodeId: existing.episodeId,
    // Carried forward with the dispensed counts RESET: this is a new authority to hand
    // drugs over, and what the old one had already delivered is the old one's record.
    lines: existing.lines.map((l) => ({ ...l, dispensedQty: 0 })),
    version: existing.version + 1,
    supersedesId: existing.id,
    ...(existing.notes ? { notes: existing.notes } : {}),
    ...(existing.branchId ? { branchId: existing.branchId } : {}),
  });

  await repo.setSupersededBy(existing.id, next.id);

  return next;
}

function notFound(id: string): AppError {
  return new AppError("HMS-GEN-404", 404, "Prescription not found", { id });
}

/** Does this hospital hand out the drugs itself? ADR-0013 §5 — the fifth policy switch. */
export async function dispensesInHouse(): Promise<boolean> {
  const ctx = getContext();
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

  return policy.pharmacy === "in_house";
}

export const getPrescription = repo.findById;
export const listPrescriptions = repo.list;
