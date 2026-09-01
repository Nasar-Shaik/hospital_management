/**
 * Charting a dose from the ward screen (W3) — the most consequential write in this app.
 *
 * ── WHAT MAKES THIS DIFFERENT FROM EVERY OTHER WRITE HERE ───────────────────
 * A duplicate ward note is embarrassing. A duplicate payment is refundable. A duplicate dose is a
 * second drug in a patient. So this module consumes a safety spine rather than inventing one, and
 * the division of labour is absolute:
 *
 *   the DATABASE decides whether a slot is free   — unique index, migration 0049
 *   the SERVER decides what is due and when       — the schedule endpoint, in the ward's zone
 *   `@medicore/api-client` decides what a response MEANT — `attemptAdministration`
 *   this FILE decides what to show and what to send
 *
 * Nothing here checks for duplicates, and nothing here decides whether a dose is due. A
 * client-side "has this been given?" test cannot be authoritative — between the check and the
 * request another nurse's dose fits — and a browser that computes lateness computes it from the
 * reader's clock.
 *
 * ── THE CLASSIFIER IS SHARED WITH THE PHONE, DELIBERATELY ───────────────────
 * `attemptAdministration` lives in the client package because which HTTP failures mean "nothing
 * was written" is the API's promise, not this app's opinion. Two implementations would be two
 * chances to tell a nurse "not saved" about a dose that is already in the patient.
 */
import {
  attemptAdministration,
  type AdministerResult,
  type DoseSlot,
  type MarStatus,
  type MedicationAdministration,
  type SlotRef,
} from "@medicore/api-client";

/**
 * Every outcome the domain has — the ward screen now offers all of them.
 *
 * This was `Extract<MarStatus, "given" | "held" | "refused">`, and the alias is now the domain
 * type itself: there is no outcome the record can hold that a nurse cannot record. See `OUTCOMES`.
 */
export type AdministerOutcome = MarStatus;

export interface OutcomeOption {
  status: AdministerOutcome;
  /** The button, in the words a nurse would use out loud. */
  label: string;
  /** What the record will say, on the confirmation. */
  recordAs: string;
  /** True when the SERVER refuses the write without a reason — see `mar.service.ts`. */
  reasonRequired: boolean;
  /** Prompt for the reason field. */
  reasonPrompt: string;
}

/**
 * ── ONLY `held` REQUIRES A REASON, AND THAT IS THE SERVER'S RULE ────────────
 * `recordAdministration` refuses a held dose with no reason ("say why the dose was held") and
 * refuses nothing else without one. Mirrored here rather than decided here, so the button disables
 * instead of the nurse discovering it from a 400 after they have already left the bedside. In
 * particular `not_available` does NOT require one — inventing a client-side requirement the server
 * does not have would block a nurse from charting a true fact.
 *
 * ── `not_available` IS OFFERED NOW, AND THE OMISSION WAS COSTING SOMETHING ──
 * "The drug was not on the ward to give" (`mar.model.ts`) has been a valid, persisted, audited
 * status since D5 and no client ever offered it. That is not a neutral default: a nurse who cannot
 * record it records HELD with a reason, which files a supply failure in the clinical-decision
 * column — and `held` is read by the next nurse as "somebody decided to withhold this", which is a
 * different fact about the patient. Only the nurse at the bedside can observe a stock-out, and the
 * MAR has exactly one writer, so a status nobody could select was a status nobody could record.
 *
 * Nothing about `given`, `held` or `refused` changes.
 */
const BY_STATUS: Record<MarStatus, OutcomeOption> = {
  given: {
    status: "given",
    label: "Give",
    recordAs: "Given",
    reasonRequired: false,
    reasonPrompt: "Anything the next nurse should know. Optional.",
  },
  held: {
    status: "held",
    label: "Hold",
    recordAs: "Held",
    reasonRequired: true,
    reasonPrompt: "Why is it being held? e.g. systolic 84, patient nil by mouth",
  },
  refused: {
    status: "refused",
    label: "Refused",
    recordAs: "Refused",
    reasonRequired: false,
    reasonPrompt: "Anything the next nurse should know. Optional.",
  },
  not_available: {
    status: "not_available",
    label: "Unavailable",
    // The same words the chart, the round and the phone already print for this status.
    recordAs: "Not available",
    reasonRequired: false,
    reasonPrompt: "Anything the next nurse should know — e.g. none in the ward stock. Optional.",
  },
};

/**
 * The outcomes offered, in the order they appear.
 *
 * Built from `BY_STATUS`, which is a `Record<MarStatus, …>`: adding a fifth `MAR_STATUS` server-side
 * becomes a COMPILE ERROR here rather than another status the clients quietly never offer. That is
 * the failure this step exists to close, so it is closed structurally.
 *
 * `not_available` sits last: it is the only one that is not a decision about the patient.
 */
export const OUTCOMES: readonly OutcomeOption[] = [
  BY_STATUS.given,
  BY_STATUS.held,
  BY_STATUS.refused,
  BY_STATUS.not_available,
];

/** Total, so no cast. The old `find(...) as OutcomeOption` would have returned `undefined`. */
export const outcomeOption = (status: AdministerOutcome): OutcomeOption => BY_STATUS[status];

/* ── what the nurse is asked to confirm ────────────────────────────────────── */

export interface ConfirmLine {
  label: string;
  value: string;
  /** True for the lines checked against the patient in front of them. */
  identity?: boolean;
}

/**
 * The drug line a dose is given against, as this screen holds it.
 *
 * `scheduledFor` is present for a line the SERVER has put on a round and absent for a PRN line,
 * which has no slots and is repeatable by design. That single difference decides both what is sent
 * and what can be reconciled afterwards, so it is carried explicitly rather than inferred from the
 * frequency text.
 */
export interface DrugLine {
  prescriptionId: string;
  lineIndex: number;
  drugCode: string;
  drugName: string;
  dose: string;
  route: string;
  frequency: string;
  /** The slot this line's next dose answers, ISO. Absent for PRN. */
  scheduledFor?: string;
}

/**
 * The facts on the confirmation, in the order they should be checked.
 *
 * ── PATIENT FIRST, DRUG SECOND, AND NEITHER IS OPTIONAL ─────────────────────
 * This is the screen's rendering of the five rights. It leads with WHO, because that is the check
 * that catches the catastrophic error — the right drug given to the wrong patient — and it names
 * them by name AND identifier, never by bed. A bed is where somebody was an hour ago.
 *
 * The scheduled time arrives ALREADY FORMATTED, in the branch's zone: this module holds no clock
 * and no formatter, and a test scans it for both.
 */
export function confirmLines(input: {
  patientName?: string;
  uhid?: string;
  line: DrugLine;
  scheduledLabel: string;
  outcome: AdministerOutcome;
}): ConfirmLine[] {
  const { patientName, uhid, line, scheduledLabel, outcome } = input;
  return [
    { label: "Patient", value: patientName ?? "Not loaded", identity: true },
    { label: "UHID", value: uhid ?? "Not loaded", identity: true },
    { label: "Medication", value: line.drugName, identity: true },
    { label: "Dose", value: line.dose, identity: true },
    { label: "Route", value: line.route, identity: true },
    { label: "Scheduled", value: scheduledLabel, identity: true },
    { label: "Recording", value: outcomeOption(outcome).recordAs },
  ];
}

/**
 * May the confirm button be pressed?
 *
 * UI gating only, and the comment is here because it is the sentence most likely to be misread:
 * this is NOT what stops a double dose. The unique index is. This stops a nurse being invited to
 * submit something the server is certain to refuse, which is a different and much smaller job.
 */
export function canConfirm(input: {
  outcome: AdministerOutcome;
  reason: string;
  inFlight: boolean;
}): boolean {
  if (input.inFlight) return false;
  if (outcomeOption(input.outcome).reasonRequired && input.reason.trim() === "") return false;
  return true;
}

/* ── the write ─────────────────────────────────────────────────────────────── */

export interface DoseAttemptDeps {
  /** `POST …/medication-administrations`, WITH the intent key. Called at most once per attempt. */
  record: () => Promise<MedicationAdministration>;
  /** `GET …/medication-schedule` — the slot oracle, read only when the attempt was ambiguous. */
  reloadSchedule: () => Promise<DoseSlot[]>;
  /** The slot being answered, or `undefined` for a PRN dose, which has none. */
  ref?: SlotRef;
}

/**
 * One attempt at charting a dose.
 *
 * ── A SCHEDULED DOSE AND A PRN DOSE ARE NOT EQUALLY KNOWABLE ────────────────
 * A scheduled dose has a slot, and the slot is an oracle: after any ambiguous failure the screen
 * can ask "is this exact slot answered?" and get a server answer. That is what
 * `attemptAdministration` does, and it is why a lost response on the ward does not become a second
 * dose.
 *
 * A PRN dose has no slot — deliberately, because "as needed" must stay repeatable, and the unique
 * index does not constrain it. So there is nothing to ask. The protection there is the
 * IDEMPOTENCY KEY and nothing else: the same key replays the original response instead of writing
 * a second row, which is exactly why the key is mandatory on this call and why the retry path must
 * reuse it rather than mint a fresh one.
 *
 * Hence the two paths below. The PRN path can reach `recorded` or `failed`, and everything else is
 * `unknown` — it never claims a dose was not given, because it cannot know.
 */
export async function attemptDose(deps: DoseAttemptDeps): Promise<AdministerResult> {
  const { ref } = deps;
  if (ref) {
    return attemptAdministration({
      record: deps.record,
      reloadSchedule: deps.reloadSchedule,
      ref,
    });
  }

  try {
    return { outcome: "recorded", entry: await deps.record() };
  } catch (error) {
    return { outcome: "unknown", error };
  }
}

/* ── words ─────────────────────────────────────────────────────────────────── */

/**
 * Who answered the slot, in words a nurse can act on.
 *
 * ── THE SCREEN CANNOT RESOLVE A STAFF NAME, AND SAYS SO RATHER THAN GUESSING ─
 * `administeredBy` is an opaque user id, and the user directory needs `user:manage` — which the
 * NURSE role does not hold and should not. Printing the raw id would be noise a nurse cannot act
 * on. So this says the one distinction that changes what they do next: was it me (my own lost
 * attempt, nothing to do) or somebody else (go and ask them before touching this dose).
 *
 * Resolving real names would need the server to expand them on the DTO, the way invoice
 * signatories are expanded. Worth doing; not worth inventing a user-lookup path in the browser for.
 */
export function actorLabel(administeredBy: string | undefined, meId: string | undefined): string {
  if (administeredBy !== undefined && meId !== undefined && administeredBy === meId) {
    return "by you";
  }
  return "by another member of staff";
}

/** Whether an existing answer is this nurse's own — a lost response rather than a colleague. */
export function isOwnAnswer(
  existing: Pick<MedicationAdministration, "administeredBy"> | undefined,
  meId: string | undefined,
): boolean {
  return existing?.administeredBy !== undefined && existing.administeredBy === meId;
}

export interface AttemptNotice {
  tone: "success" | "warning" | "danger";
  text: string;
  /**
   * True when the screen may offer to re-ask the server. NEVER true for a state that would put a
   * second dose in the patient if the nurse misreads it.
   */
  canRecheck: boolean;
}

/**
 * What the nurse is told, and it is the safety feature.
 *
 * ── THE WORDING IS LOAD-BEARING, PARTICULARLY FOR `unknown` ─────────────────
 * A nurse told "not saved" gives the dose again. A nurse told "we could not confirm this" checks
 * the chart. The old screen said "Could not chart the dose" for every failure including the ones
 * where the dose HAD been charted, which is the sentence this slice exists to delete.
 *
 * `alreadyAnswered` is deliberately not `danger`. It is an ANSWER — the system working — and
 * painting it red teaches nurses that the safe outcome looks like a fault.
 */
export function attemptNotice(
  result: AdministerResult,
  meId: string | undefined,
  timeLabel: (iso: string) => string,
): AttemptNotice {
  switch (result.outcome) {
    case "recorded":
      return {
        tone: "success",
        text: `Recorded: ${result.entry.drugName} ${statusWord(result.entry.status)}.`,
        canRecheck: false,
      };

    case "alreadyAnswered": {
      const { existing } = result;
      if (!existing) {
        return {
          tone: "warning",
          text: `${result.drugName} has already been answered for this dose. It was not charted again. The record sits in a branch you cannot read, so it cannot be shown here.`,
          canRecheck: false,
        };
      }
      const who = isOwnAnswer(existing, meId)
        ? "by you — your earlier attempt did reach the server"
        : "by another member of staff";
      const at = existing.administeredAt ? ` at ${timeLabel(existing.administeredAt)}` : "";
      return {
        tone: "warning",
        text: `${result.drugName} was already ${statusWord(existing.status)}${at} ${who}. Nothing was charted again.`,
        canRecheck: false,
      };
    }

    case "failed":
      return { tone: "danger", text: failureText(result.error), canRecheck: false };

    case "unknown":
      return {
        tone: "warning",
        text: "We could not confirm whether this dose was recorded. Check the chart before giving it again.",
        canRecheck: true,
      };
  }
}

/**
 * The outcome as it reads inside a sentence: "Recorded: Paracetamol <word>." and "Paracetamol was
 * already <word> at 08:00 by …".
 *
 * `not_available` returned "recorded as not available" here, which was fine in the second sentence
 * and produced "Recorded: Paracetamol recorded as not available." in the first. Unreachable while
 * no client could chart it; reachable now, so it says the same two words the chart, the round and
 * the phone print.
 */
function statusWord(status: MarStatus): string {
  return status === "not_available" ? "not available" : status;
}

function failureText(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && message.trim() !== ""
    ? message
    : "The dose was not charted.";
}
