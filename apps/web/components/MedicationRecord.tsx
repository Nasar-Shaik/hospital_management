"use client";

/**
 * The Medication Administration Record — the ward screen's most consequential write.
 *
 * ── WHY IT IS ITS OWN COMPONENT ─────────────────────────────────────────────
 * It moved out of `app/ward/page.tsx` when W3 brought it up to the M3 safety envelope. That page
 * is the ward round: a list, a chart, a bill, a discharge form. This is the one thing on it that
 * can put a drug into a patient, and it now carries a confirmation, an allergy banner, an
 * idempotency key and a reconciliation path. Buried in a fourteen-hundred-line page, none of that
 * could be tested without rendering the entire ward.
 *
 * The division of labour is absolute and almost none of it lives here:
 *
 *   the DATABASE decides whether a slot is free   — unique index, migration 0049
 *   the SERVER decides what is due and when       — the schedule endpoint, in the ward's zone
 *   `@medicore/api-client` decides what a response MEANT — `attemptAdministration`
 *   `lib/marAdminister.ts` decides what to show and what to send
 *   this FILE renders it
 */
import { useCallback, useEffect, useState } from "react";
import {
  ApiClientError,
  findSlot,
  isSlotOpen,
  type Allergy,
  type DoseSlot,
  type SlotRef,
  type MarStatus,
  type MedicationAdministration,
  type Prescription,
} from "@medicore/api-client";
import { useAuth } from "./AuthProvider";
import { useBranch } from "./BranchProvider";
import { Alert, Badge, Button, Modal } from "./ui";
import { dateTimeInZone, timeInZone } from "../lib/day";
import { useIntentKeys } from "../lib/idempotency";
import {
  OUTCOMES,
  actorLabel,
  attemptDose,
  attemptNotice,
  canConfirm,
  confirmLines,
  outcomeOption,
  type AdministerOutcome,
  type AttemptNotice,
  type DrugLine,
} from "../lib/marAdminister";
import { doseStateLabel } from "../lib/round";

const MAR_TONE: Record<MarStatus, "success" | "warning" | "neutral"> = {
  given: "success",
  held: "warning",
  refused: "warning",
  not_available: "neutral",
};
const MAR_LABEL: Record<MarStatus, string> = {
  given: "Given",
  held: "Held",
  refused: "Refused",
  not_available: "Not available",
};

/**
 * The server's current word on the dose the round pointed at — resolved on load, never navigated in.
 *
 * `gone` is its own state and not a failure: today's schedule rolled over in the ward's zone, or the
 * order was stopped. Saying "that dose is no longer on today's schedule" is honest; silently showing
 * the line's next dose instead would let a nurse chart a different one than they chose.
 */
type FocusState =
  | null
  | { state: "gone" }
  | { state: "open"; slot: DoseSlot }
  | { state: "answered"; slot: DoseSlot };

/**
 * The identity one attempt is keyed on — the intent, not the click.
 *
 * A key that changes per click protects nothing (`lib/idempotency.ts` explains the bug at length).
 * Give, Hold and Refuse against the same slot are three DIFFERENT clinical decisions and must never
 * share a key, or the second would replay the first's response and the chart would say the wrong
 * thing. The slot is in the key too, so tomorrow's 08:00 dose is a new intent rather than a
 * duplicate of today's.
 */
function intentOf(line: DrugLine, outcome: AdministerOutcome): string {
  return `${line.prescriptionId}:${String(line.lineIndex)}:${line.scheduledFor ?? "prn"}:${outcome}`;
}

export function MedicationRecord({
  encounterId,
  patientId,
  patientName,
  uhid,
  canAdminister,
  canReadAllergies,
  focusSlot,
  onCharted,
}: {
  encounterId: string;
  patientId: string;
  patientName: string;
  uhid: string;
  canAdminister: boolean;
  canReadAllergies: boolean;
  /**
   * The dose the nurse chose on the round (W4) — a HINT ABOUT WHICH LINE, never a clinical claim.
   *
   * ── WHAT ARRIVES HERE IS ALREADY OUT OF DATE ────────────────────────────────
   * Between the round rendering and the nurse clicking, another nurse may have answered this exact
   * slot. So nothing is read off this triple except which line to surface: the drug, the dose, the
   * route, the time and above all the STATE are taken from the schedule this component fetches for
   * itself on mount. If the slot is no longer open, the nurse is told so and no action is offered.
   */
  focusSlot?: SlotRef;
  /**
   * Fired once a dose has an ANSWER from the server — charted, or found already answered.
   *
   * The round uses it to re-read itself. It deliberately carries no payload: handing the caller a
   * status would invite them to paint a row from it, and a round that colours itself from a
   * callback is a round showing local state as though it were the server's.
   */
  onCharted?: () => void;
}) {
  const { api, user } = useAuth();
  const { timezone } = useBranch();
  const [lines, setLines] = useState<DrugLine[]>([]);
  const [log, setLog] = useState<MedicationAdministration[]>([]);
  const [allergies, setAllergies] = useState<Allergy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ line: DrugLine; outcome: AdministerOutcome } | null>(
    null,
  );
  const [reason, setReason] = useState("");
  const [inFlight, setInFlight] = useState(false);
  const [notice, setNotice] = useState<AttemptNotice | null>(null);
  /** What the server currently says about the dose the round sent us to. Never what the round said. */
  const [focus, setFocus] = useState<FocusState>(null);
  const { keyFor, clear } = useIntentKeys();

  /** Times on this screen are the WARD's, never the reader's — W2. */
  const clockLabel = useCallback(
    (iso: string): string => timeInZone(new Date(iso), timezone),
    [timezone],
  );
  const stampLabel = useCallback(
    (iso: string): string => dateTimeInZone(new Date(iso), timezone),
    [timezone],
  );

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api.listPrescriptions({ encounterId, current: true }),
      api.listMedicationAdministrations(encounterId),
      /**
       * The authoritative schedule for this stay's ward day.
       *
       * Fetched for TWO reasons, and the second is the one that matters. It tells the nurse what
       * time each dose is expected — resolved by the server in the branch's zone, never computed
       * here — and it is the ORACLE this screen reconciles against when a write's outcome is
       * unclear. A soft failure is deliberate: no schedule means no slot identities, so doses are
       * charted the way they always were (the server binds the nearest round itself) and an
       * ambiguous failure reports `unknown` rather than guessing.
       */
      api.listMedicationSchedule(encounterId).catch(() => [] as DoseSlot[]),
    ])
      .then(([rx, mar, slots]: [Prescription[], MedicationAdministration[], DoseSlot[]]) => {
        // Only a live signed prescription is administrable.
        const live = rx.filter(
          (p) =>
            p.status === "signed" || p.status === "partially_dispensed" || p.status === "dispensed",
        );
        /**
         * The dose the round sent us, RE-READ from the schedule we just fetched.
         *
         * This is the whole reason the round may hand over an identity at all. `findSlot` matches
         * on prescription + line + scheduled instant, and whatever comes back is the server's
         * current word on that dose — which may be that another nurse answered it while the round
         * sat on screen, or that it has left today's schedule entirely.
         */
        const focused = focusSlot ? findSlot(slots, focusSlot) : undefined;
        setFocus(
          !focusSlot
            ? null
            : !focused
              ? { state: "gone" }
              : isSlotOpen(focused)
                ? { state: "open", slot: focused }
                : { state: "answered", slot: focused },
        );

        setLines(
          live.flatMap((p) =>
            p.lines.map((l, lineIndex) => {
              // The next dose still open on this line. `due`/`overdue` are the server's verdict —
              // an overdue dose is still very much giveable, so lateness is shown, not gated.
              const nextOpen = slots.find(
                (s) =>
                  s.prescriptionId === p.id &&
                  s.lineIndex === lineIndex &&
                  (s.state === "due" || s.state === "overdue"),
              );
              /**
               * On the line the nurse came here for, the CHOSEN dose wins over the earliest one.
               *
               * A patient on paracetamol QID has 08:00, 14:00, 20:00 and 02:00 open at once. A
               * nurse who clicked 14:00 on the round must chart 14:00 — binding the earliest open
               * slot instead would silently answer the 08:00 dose and leave the one they actually
               * gave still showing as due.
               */
              const focusesThisLine =
                focused !== undefined &&
                isSlotOpen(focused) &&
                focused.prescriptionId === p.id &&
                focused.lineIndex === lineIndex;
              const slot = focusesThisLine ? focused : nextOpen;
              return {
                prescriptionId: p.id,
                lineIndex,
                drugCode: l.drugCode,
                drugName: l.drugName,
                dose: l.dose,
                route: l.route,
                frequency: l.frequency,
                ...(slot ? { scheduledFor: slot.scheduledFor } : {}),
              };
            }),
          ),
        );
        setLog(mar);
      })
      .catch((e: unknown) =>
        setError(e instanceof ApiClientError ? e.message : "Could not load medications."),
      )
      .finally(() => setLoading(false));
  }, [api, encounterId]);
  useEffect(load, [load]);

  /**
   * Allergies are the patient's, read HOSPITAL-WIDE — an allergy recorded at any branch is still
   * an allergy here (the M3 domain decision, unchanged).
   *
   * The permission gates the REQUEST, not just the rendering: the ward screen already established
   * why (see `loadChart`). A role without `allergy:read` firing this on every chart open would
   * manufacture a denial in the audit trail every time, burying the signal that denials exist to
   * carry.
   */
  useEffect(() => {
    if (!canReadAllergies) {
      setAllergies([]);
      return;
    }
    let cancelled = false;
    void api
      .listAllergies(patientId)
      .then((all) => {
        if (!cancelled) setAllergies(all.filter((a) => a.status === "active"));
      })
      .catch(() => {
        if (!cancelled) setAllergies([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api, patientId, canReadAllergies]);

  function ask(line: DrugLine, outcome: AdministerOutcome) {
    setNotice(null);
    setReason("");
    setPending({ line, outcome });
  }

  /**
   * The write, after the nurse has confirmed it.
   *
   * ── NOTHING IS SHOWN AS CHARTED UNTIL THE SERVER SAYS SO ────────────────────
   * There is no optimistic update here, deliberately. Every other list in this app may show a row
   * a moment early and reconcile; a medication record may not, because "Given" on a screen is what
   * the next nurse reads before deciding whether the patient still needs it.
   */
  async function confirm() {
    if (!pending) return;
    const { line, outcome } = pending;
    const intent = intentOf(line, outcome);
    const trimmed = reason.trim();

    setInFlight(true);
    setError(null);
    const result = await attemptDose({
      record: () =>
        api.recordMedicationAdministration(
          encounterId,
          {
            prescriptionId: line.prescriptionId,
            lineIndex: line.lineIndex,
            drugCode: line.drugCode,
            status: outcome,
            ...(line.scheduledFor ? { scheduledFor: line.scheduledFor } : {}),
            ...(trimmed ? { reason: trimmed } : {}),
          },
          // The key is not optional. For a PRN dose it is the ONLY thing standing between a lost
          // response and a second dose — the unique index does not constrain an as-needed drug.
          keyFor(intent),
        ),
      reloadSchedule: () => api.listMedicationSchedule(encounterId),
      ...(line.scheduledFor
        ? {
            ref: {
              prescriptionId: line.prescriptionId,
              lineIndex: line.lineIndex,
              scheduledFor: line.scheduledFor,
            },
          }
        : {}),
    });

    setInFlight(false);
    setNotice(attemptNotice(result, user?.id, clockLabel));

    // The intent is over once it has an answer — the next dose on this line must get a fresh key.
    // `unknown` is the exception: the key is HELD so that re-sending replays the original response
    // instead of writing a second row.
    if (result.outcome !== "unknown") clear(intent);
    if (result.outcome !== "failed") {
      setPending(null);
      load();
      /**
       * Tell the round to re-read ITSELF from the server.
       *
       * Not "mark that row given" — re-read. `recorded` and `alreadyAnswered` are both answers and
       * both change the ward's outstanding work, and the only honest way for a list to reflect that
       * is to ask the API again. A parent that patched a row locally would be showing its own
       * optimism in the place a nurse checks what is still outstanding.
       */
      onCharted?.();
    }
  }

  if (loading) {
    return <p className="text-xs text-[var(--color-fg-subtle)]">Loading…</p>;
  }

  return (
    <div className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}

      {/*
       * What became of the dose the nurse chose on the round, as the SERVER sees it now. Only the
       * `open` case says nothing here — the highlighted line below is the answer to that one.
       */}
      {focus?.state === "gone" && (
        <Alert tone="warning">
          That dose is no longer on today&apos;s schedule for this patient. The medicines still due
          are listed below.
        </Alert>
      )}
      {focus?.state === "answered" && (
        <Alert tone="warning">
          {`That dose was already answered — ${doseStateLabel(focus.slot).text.toLowerCase()}${
            focus.slot.administeredAt ? ` at ${clockLabel(focus.slot.administeredAt)}` : ""
          } ${actorLabel(focus.slot.administeredBy, user?.id)}. Nothing was charted again.`}
        </Alert>
      )}

      {notice && (
        // `Alert` is already a live region — `role="status"` for a warning, `role="alert"` for a
        // danger. Wrapping the text in a second one would announce it twice.
        <Alert tone={notice.tone}>
          {notice.text}
          {notice.canRecheck && (
            <button
              type="button"
              onClick={load}
              className="ml-2 underline underline-offset-2 hover:no-underline"
            >
              Check the chart
            </button>
          )}
        </Alert>
      )}

      {/* Active drugs to give against */}
      {lines.length === 0 ? (
        <p className="text-xs text-[var(--color-fg-subtle)]">
          No signed prescriptions for this stay.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {lines.map((l) => {
            const key = `${l.prescriptionId}:${String(l.lineIndex)}`;
            // The line the nurse arrived for, when the server still says that dose is open.
            const chosen =
              focus?.state === "open" &&
              focus.slot.prescriptionId === l.prescriptionId &&
              focus.slot.lineIndex === l.lineIndex;
            return (
              <li
                key={key}
                className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 ${
                  chosen
                    ? "border-[var(--color-brand-500)] bg-[var(--color-brand-50)]"
                    : "border-[var(--color-border)] bg-[var(--color-bg-subtle)]"
                }`}
              >
                <div>
                  {/* Never colour alone: the chosen dose is named in words for anyone who cannot
                      see the highlight, and it is the first thing read on the row. */}
                  {chosen && (
                    <span className="mr-2 rounded bg-[var(--color-brand-500)] px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-white uppercase">
                      Selected dose
                    </span>
                  )}
                  <span className="text-sm font-medium text-[var(--color-fg)]">{l.drugName}</span>
                  <span className="ml-2 text-xs text-[var(--color-fg-subtle)]">
                    {l.dose} · {l.route} · {l.frequency}
                  </span>
                  {/* The ward's time for the next open dose — the server's verdict, not ours. */}
                  {l.scheduledFor && (
                    <span className="ml-2 text-xs font-medium text-[var(--color-fg-muted)]">
                      due {clockLabel(l.scheduledFor)}
                    </span>
                  )}
                </div>
                {canAdminister && (
                  <div className="flex gap-1.5">
                    {OUTCOMES.map((o) => (
                      <button
                        key={o.status}
                        type="button"
                        disabled={inFlight}
                        onClick={() => ask(l, o.status)}
                        className={
                          o.status === "given"
                            ? "rounded-md border border-[var(--color-success)]/40 px-2.5 py-1 text-xs font-medium text-[var(--color-success)] hover:bg-[var(--color-success-bg)] disabled:opacity-50"
                            : "rounded-md border border-[var(--color-border-strong)] px-2.5 py-1 text-xs font-medium text-[var(--color-fg-muted)] hover:border-[var(--color-warning)] disabled:opacity-50"
                        }
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* The record */}
      {log.length > 0 && (
        <div>
          <div className="mb-1.5 text-xs font-semibold tracking-wide text-[var(--color-fg-muted)] uppercase">
            Charted
          </div>
          <ul className="space-y-1">
            {log.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="text-[var(--color-fg)]">
                  {m.drugName} <span className="text-[var(--color-fg-subtle)]">{m.dose}</span>
                </span>
                <span className="flex items-center gap-2 text-[var(--color-fg-muted)]">
                  {m.reason && <span className="text-[var(--color-fg-subtle)]">{m.reason}</span>}
                  {/* Who gave it. The next nurse needs to know whether to go and ask somebody. */}
                  <span className="text-[var(--color-fg-subtle)]">
                    {actorLabel(m.administeredBy, user?.id)}
                  </span>
                  <span>{stampLabel(m.administeredAt)}</span>
                  <Badge tone={MAR_TONE[m.status]}>{MAR_LABEL[m.status]}</Badge>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {pending && (
        <ConfirmDose
          line={pending.line}
          outcome={pending.outcome}
          patientName={patientName}
          uhid={uhid}
          allergies={allergies}
          canReadAllergies={canReadAllergies}
          reason={reason}
          onReason={setReason}
          inFlight={inFlight}
          scheduledLabel={pending.line.scheduledFor ? clockLabel(pending.line.scheduledFor) : "PRN"}
          onCancel={() => setPending(null)}
          onConfirm={() => void confirm()}
        />
      )}
    </div>
  );
}

/**
 * The last screen before a drug goes into a patient.
 *
 * ── IT EXISTS BECAUSE THE OLD ONE DID NOT ───────────────────────────────────
 * "Give" used to be a single click that wrote immediately, and a hold reason was collected with
 * `window.prompt`. One misplaced click on a list of six drugs charted the wrong one, with nothing
 * in between showing WHICH patient was about to receive it.
 *
 * The lines are the five rights, patient first: the check that catches the catastrophic error is
 * the right drug given to the wrong person. The scheduled time arrives already formatted in the
 * ward's zone — this component holds no clock.
 */
function ConfirmDose({
  line,
  outcome,
  patientName,
  uhid,
  allergies,
  canReadAllergies,
  reason,
  onReason,
  inFlight,
  scheduledLabel,
  onCancel,
  onConfirm,
}: {
  line: DrugLine;
  outcome: AdministerOutcome;
  patientName: string;
  uhid: string;
  allergies: Allergy[];
  canReadAllergies: boolean;
  reason: string;
  onReason: (value: string) => void;
  inFlight: boolean;
  scheduledLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const option = outcomeOption(outcome);
  const rows = confirmLines({ patientName, uhid, line, scheduledLabel, outcome });

  return (
    <Modal title={`${option.recordAs}: ${line.drugName}`} onClose={onCancel}>
      <div className="space-y-4">
        {/*
         * Allergies, shown as the hospital RECORDED them — the labels and the severity the
         * allergy service already resolved. Nothing is re-graded here: a browser deciding what
         * counts as a severe allergy would be a second clinical opinion with no record behind it.
         * An empty list means none RECORDED, which is not the same as none, and it says so.
         */}
        {canReadAllergies &&
          (allergies.length > 0 ? (
            <div className="rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger-bg)] px-3 py-2">
              <span className="text-xs font-semibold text-[var(--color-danger)]">
                ⚠ Allergies on record:
              </span>{" "}
              <span className="text-xs text-[var(--color-fg)]">
                {allergies.map((a) => `${a.label} (${a.severity})`).join(", ")}
              </span>
            </div>
          ) : (
            <p className="text-xs text-[var(--color-fg-subtle)]">
              No allergies recorded — which is not the same as none.
            </p>
          ))}

        <dl className="divide-y divide-[var(--color-border)]">
          {rows.map((r) => (
            <div key={r.label} className="flex items-baseline justify-between gap-4 py-1.5">
              <dt className="text-xs text-[var(--color-fg-muted)]">{r.label}</dt>
              <dd
                className={
                  r.identity
                    ? "text-sm font-medium text-[var(--color-fg)]"
                    : "text-sm text-[var(--color-fg-muted)]"
                }
              >
                {r.value}
              </dd>
            </div>
          ))}
        </dl>

        {/*
         * The reason, captured in the application rather than by `window.prompt` — which the old
         * flow used, which cannot be styled, labelled, validated or read by a screen reader, and
         * which some browsers suppress entirely. A held dose whose reason box was suppressed is a
         * held dose the server refuses, at the bedside, with no way to see why.
         */}
        <label className="block text-sm font-medium text-[var(--color-fg)]">
          {option.reasonRequired ? "Reason (required)" : "Note (optional)"}
          <textarea
            value={reason}
            onChange={(e) => onReason(e.target.value)}
            placeholder={option.reasonPrompt}
            rows={2}
            required={option.reasonRequired}
            className="mt-1.5 w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm font-normal text-[var(--color-fg)]"
          />
        </label>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={inFlight}>
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            disabled={!canConfirm({ outcome, reason, inFlight })}
            loading={inFlight}
          >
            {/* Never "Given" until the server has said so — this is the verb, not the record. */}
            {inFlight ? "Recording…" : `Confirm ${option.recordAs.toLowerCase()}`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
