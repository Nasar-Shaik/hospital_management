/**
 * MAR service (Module D5 / nursing).
 *
 * An administration is charted against a REAL, signed prescription line for THIS visit. The service
 * proves all three before it writes a dose into the record: the prescription belongs to the
 * encounter, it is actually in force (signed — you do not administer a draft or a cancelled order),
 * and the drug is a line on it. The drug's identity is then copied from the immutable signed line,
 * so the MAR row can never disagree with what was prescribed.
 *
 * ── M3-S1: A DOSE NOW HAS A SLOT ────────────────────────────────────────────
 * Everything above was already true and none of it stopped the same dose being charted twice.
 * What was missing was IDENTITY: `administeredAt` is when the nurse pressed the button, so two
 * nurses charting the 14:00 round produced two different values and nothing could tell they meant
 * the same event. `scheduledFor` gives the round itself a name, migration 0049 makes that name
 * unique, and the database refuses the second one. See `schedule.ts`.
 */
import { AppError } from "../../core/errors/appError.js";
import { env } from "../../config/env.js";
import { dayKeyInZone, dayRangeInZone } from "../../core/time/day.js";
import { zoneOrDefault } from "../../core/time/zone.js";
import { getBranch } from "../branches/index.js";
import {
  getPrescription,
  isDispensable,
  listPrescriptions,
  type DrugFrequency,
  type Prescription,
  type PrescriptionLine,
} from "../prescriptions/index.js";
import * as repo from "./mar.repository.js";
import { DEFAULT_ROUND_TIMES, dosesInRange, slotFor, type Course } from "./schedule.js";
import type { MarStatus } from "./mar.model.js";

export type { MedicationAdministration } from "./mar.repository.js";

export const listAdministrations = repo.listByEncounter;

/** A dose is shown as overdue an hour after its round. A display aid, never a stored status. */
const OVERDUE_AFTER_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The zone the ward's clock runs in. Never the process zone, never the phone's (M0 §21 item C). */
async function wardZone(branchId?: string): Promise<string> {
  if (!branchId) return env.DEFAULT_TIMEZONE;
  const branch = await getBranch(branchId).catch(() => undefined);
  return zoneOrDefault(branch?.timezone, env.DEFAULT_TIMEZONE);
}

/** Only a live signed order may be administered — `dispensed` is still in force to give against. */
function isAdministrable(status: Prescription["status"]): boolean {
  return isDispensable(status) || status === "dispensed";
}

/**
 * When the order stopped, if it did.
 *
 * Read off the status history rather than stored separately: `cancelPrescription` already records
 * the transition, and a second field recording the same fact is a second thing to keep in step.
 */
function stoppedAt(rx: Prescription): Date | undefined {
  const stop = rx.history.find((h) => h.to === "cancelled" || h.to === "discarded");
  return stop?.at;
}

function courseOf(rx: Prescription, line: PrescriptionLine): Course | undefined {
  if (!rx.signedAt) return undefined;
  const stopped = stoppedAt(rx);
  return {
    signedAt: rx.signedAt,
    ...(stopped ? { stoppedAt: stopped } : {}),
    ...(line.durationDays !== undefined ? { durationDays: line.durationDays } : {}),
  };
}

/**
 * Which line of the prescription is being charted.
 *
 * ── WHY `drugCode` ALONE IS NOT AN ANSWER ───────────────────────────────────
 * A prescription may carry the same drug twice — paracetamol QID on the round AND paracetamol SOS
 * for breakthrough fever — and nothing forbids it. The old code did `lines.find(l => l.drugCode
 * === code)` and took the FIRST match, which silently charted the regular line when the nurse meant
 * the PRN one, copying the wrong dose and frequency into a medico-legal record.
 *
 * So: an explicit `lineIndex` wins. Without one, a code that matches exactly one line still works
 * (which is every prescription that does not do this, i.e. almost all of them, and is what keeps
 * existing clients working). A code matching two or more is now a 400 that names the remedy,
 * because the honest answer to "which one did you mean?" is to ask.
 */
function resolveLine(rx: Prescription, lineIndex: number | undefined, drugCode: string): number {
  if (lineIndex !== undefined) {
    const line = rx.lines[lineIndex];
    if (!line) {
      throw new AppError("HMS-VAL-001", 400, "Validation failed", {
        lineIndex: [`this prescription has ${String(rx.lines.length)} lines`],
      });
    }
    if (line.drugCode !== drugCode) {
      throw new AppError("HMS-VAL-001", 400, "Validation failed", {
        drugCode: [`line ${String(lineIndex)} is ${line.drugCode}, not ${drugCode}`],
      });
    }
    return lineIndex;
  }

  const matches = rx.lines.reduce<number[]>(
    (acc, l, i) => (l.drugCode === drugCode ? [...acc, i] : acc),
    [],
  );
  if (matches.length === 0) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      drugCode: ["that drug is not on this prescription"],
    });
  }
  if (matches.length > 1) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      lineIndex: [
        `${drugCode} is on this prescription ${String(matches.length)} times — say which line`,
      ],
      candidates: matches.map(String),
    });
  }
  return matches[0] as number;
}

export interface RecordAdministrationInput {
  prescriptionId: string;
  drugCode: string;
  /** Which line — authoritative when the same drug appears twice. See `resolveLine`. */
  lineIndex?: number;
  status: MarStatus;
  /** The dose slot being answered. Validated against the derived schedule; never trusted as given. */
  scheduledFor?: string;
  administeredAt?: string;
  reason?: string;
  note?: string;
}

export async function recordAdministration(
  encounterId: string,
  input: RecordAdministrationInput,
): Promise<repo.MedicationAdministration> {
  const prescription = await getPrescription(input.prescriptionId);
  if (!prescription) {
    throw new AppError("HMS-GEN-404", 404, "Prescription not found", { id: input.prescriptionId });
  }

  // The prescription must be for THIS visit — a dose charted on the wrong stay is a wrong record.
  if (prescription.encounterId !== encounterId) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      prescriptionId: ["this prescription is not for this visit"],
    });
  }

  // Only a live signed prescription can be administered. `isDispensable` is exactly that set
  // (signed / partially_dispensed); a fully `dispensed` one is still in force to administer, so it
  // is allowed too. A draft / cancelled / discarded one is not a lawful order to give against.
  if (!isAdministrable(prescription.status)) {
    throw new AppError("HMS-STATE-001", 422, "Invalid state transition", {
      status: prescription.status,
      reason: "only a signed prescription can be administered",
    });
  }

  const lineIndex = resolveLine(prescription, input.lineIndex, input.drugCode);
  const line = prescription.lines[lineIndex] as PrescriptionLine;

  // A held dose with no reason is the blank the MAR exists to prevent.
  if (input.status === "held" && !input.reason?.trim()) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      reason: ["say why the dose was held"],
    });
  }

  const administeredAt = input.administeredAt ? new Date(input.administeredAt) : new Date();
  if (Number.isNaN(administeredAt.getTime())) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      administeredAt: ["invalid time"],
    });
  }

  const zone = await wardZone(prescription.branchId);
  const scheduledFor = resolveSlot(prescription, line, lineIndex, zone, administeredAt, input);

  const result = await repo.record({
    encounterId,
    patientId: prescription.patientId,
    prescriptionId: prescription.id,
    lineIndex,
    drugCode: line.drugCode,
    drugName: line.drugName,
    dose: line.dose,
    route: line.route,
    status: input.status,
    ...(scheduledFor ? { scheduledFor } : {}),
    administeredAt,
    ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
  });

  if (result.outcome === "recorded") return result.entry;

  /**
   * ── THE RECONCILIATION ORACLE ─────────────────────────────────────────────
   * The slot is taken. This one response is simultaneously the duplicate guard and the answer a
   * client needs: a nurse whose 201 was lost on ward wifi retries, gets this, and can truthfully
   * say "already given, by whom, at what time" instead of charting a second dose.
   *
   * `existing` carries the administration itself — it is the same DTO the MAR list returns, so
   * there is one shape for one thing and no client has to learn a second.
   */
  throw new AppError("HMS-MAR-001", 409, "This dose has already been administered", {
    scheduledFor: (scheduledFor as Date).toISOString(),
    drugName: line.drugName,
    ...(result.existing ? { existing: result.existing } : {}),
  });
}

/**
 * The slot an administration answers, or `undefined` when it answers none.
 *
 * A client may name one, and it is checked against the derived schedule rather than believed —
 * §"SCHEDULE VALIDATION": nobody may declare "this was the 14:00 dose" when the order says
 * otherwise. A client that names nothing does NOT thereby escape the uniqueness rule; the server
 * binds the nearest round itself, so an old build gets the protection too.
 */
function resolveSlot(
  rx: Prescription,
  line: PrescriptionLine,
  lineIndex: number,
  zone: string,
  administeredAt: Date,
  input: RecordAdministrationInput,
): Date | undefined {
  const policy = DEFAULT_ROUND_TIMES[line.frequency as DrugFrequency] as
    { kind: string } | undefined;

  /**
   * PRN is not a schedule and must never be forced into one. An `SOS` analgesic may be given
   * several times in a day and each is a real, separate event; binding it to a slot would make the
   * unique index refuse the second legitimate dose — a worse defect than the one S1 fixes, landing
   * on a patient in pain. A client that sends a slot for a PRN line is confused, and told so.
   */
  if (policy?.kind === "prn") {
    if (input.scheduledFor) {
      throw new AppError("HMS-VAL-001", 400, "Validation failed", {
        scheduledFor: [`${line.frequency} is given as needed — it has no scheduled doses`],
      });
    }
    return undefined;
  }

  const course = courseOf(rx, line);
  if (!course) return undefined;

  // A bounded window, always: an open-ended course has infinitely many doses. A day either side of
  // the administration covers a late-night round charted after midnight and an early one before it.
  const doses = dosesInRange(
    line.frequency,
    lineIndex,
    course,
    zone,
    new Date(administeredAt.getTime() - DAY_MS),
    new Date(administeredAt.getTime() + DAY_MS),
  );

  if (input.scheduledFor) {
    const claimed = new Date(input.scheduledFor);
    if (Number.isNaN(claimed.getTime())) {
      throw new AppError("HMS-VAL-001", 400, "Validation failed", {
        scheduledFor: ["invalid time"],
      });
    }
    const match = doses.find((d) => d.scheduledFor.getTime() === claimed.getTime());
    if (!match) {
      throw new AppError("HMS-VAL-001", 400, "Validation failed", {
        scheduledFor: ["that is not a scheduled dose for this medication"],
      });
    }
    return match.scheduledFor;
  }

  return slotFor(doses, administeredAt)?.scheduledFor;
}

/* ── the schedule view ─────────────────────────────────────────────────────── */

/** What a slot is showing. The first four are recorded facts; the last two are derived from now. */
export type DoseState = MarStatus | "due" | "overdue";

export interface DoseSlotView {
  prescriptionId: string;
  lineIndex: number;
  drugCode: string;
  drugName: string;
  dose: string;
  route: string;
  frequency: string;
  scheduledFor: string;
  state: DoseState;
  /** Present once the slot has been answered — the administration that answered it. */
  administrationId?: string;
  administeredAt?: string;
  administeredBy?: string;
  reason?: string;
}

/**
 * Every dose due on one ward day, with what has actually happened to each.
 *
 * ── THIS IS THE ORACLE THE WHOLE SLICE EXISTS TO PROVIDE ────────────────────
 * "Was the 2pm antibiotic given?" is the question the MAR was built to answer and could not, for
 * want of anything to hang the question on. A client asks this endpoint and gets the truth from
 * the server; it never decides locally what is due, and never uses the phone's clock to do it.
 *
 * ── NO N+1 ──────────────────────────────────────────────────────────────────
 * Two queries total, whatever the number of drugs: one for the encounter's live prescriptions and
 * one for its administrations. The slots themselves are arithmetic. That is what lets the nurse
 * worklist (S3/S5) ask this for a whole ward without a query per patient per drug.
 */
export async function getSchedule(encounterId: string, date?: string): Promise<DoseSlotView[]> {
  const { items } = await listPrescriptions({
    encounterId,
    currentOnly: true,
    skip: 0,
    limit: 100,
  });
  const live = items.filter((rx) => isAdministrable(rx.status) && rx.signedAt);
  if (live.length === 0) return [];

  const zone = await wardZone(live[0]?.branchId);
  const dayKey = date ?? dayKeyInZone(new Date(), zone);
  const { from, before } = dayRangeInZone(dayKey, zone);

  const given = await repo.listByEncounter(encounterId);
  const answered = new Map(
    given
      .filter((g) => g.scheduledFor !== undefined && g.lineIndex !== undefined)
      .map((g) => [`${g.prescriptionId}:${String(g.lineIndex)}:${String(g.scheduledFor)}`, g]),
  );

  const now = Date.now();
  const slots: DoseSlotView[] = [];

  for (const rx of live) {
    rx.lines.forEach((line, lineIndex) => {
      const course = courseOf(rx, line);
      if (!course) return;

      for (const d of dosesInRange(line.frequency, lineIndex, course, zone, from, before)) {
        const iso = d.scheduledFor.toISOString();
        const hit = answered.get(`${rx.id}:${String(lineIndex)}:${iso}`);
        slots.push({
          prescriptionId: rx.id,
          lineIndex,
          drugCode: line.drugCode,
          drugName: line.drugName,
          dose: line.dose,
          route: line.route,
          frequency: line.frequency,
          scheduledFor: iso,
          state: hit
            ? hit.status
            : d.scheduledFor.getTime() + OVERDUE_AFTER_MS < now
              ? "overdue"
              : "due",
          ...(hit
            ? {
                administrationId: hit.id,
                administeredAt: hit.administeredAt,
                ...(hit.administeredBy ? { administeredBy: hit.administeredBy } : {}),
                ...(hit.reason ? { reason: hit.reason } : {}),
              }
            : {}),
        });
      }
    });
  }

  slots.sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
  return slots;
}
