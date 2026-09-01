"use client";

/**
 * The nurse's medication round (W4).
 *
 * ── IT IS A NAVIGATOR, AND THAT IS THE WHOLE DESIGN ─────────────────────────
 * This screen answers one question — "who do I walk to next, and what do they need?" — and then
 * gets out of the way. It has no Give button, no Hold, no Refused, no bulk action and no swipe.
 * Selecting a dose opens the SAME `MedicationRecord` the ward page uses, which re-reads the
 * patient's chart from the server before offering anything, and every safety property W3 proved
 * (confirmation, idempotency key, 409 reconciliation, lost-response handling, no optimistic state)
 * applies here because it is literally the same code path. A round with its own inline actions
 * would be a second administration system, and every one of those properties would have to be
 * proved again on a scrolling list of twelve tap targets.
 *
 * ── AND IT COMPUTES NO CLINICAL STATE ───────────────────────────────────────
 * `due` and `overdue` are derived by the API in the WARD's timezone against real administration
 * rows. Nothing here compares a scheduled time to a clock. `lib/round.ts` holds the ordering and
 * the words; a test scans both files for a clock read.
 *
 * ── ONE REQUEST FOR THE WHOLE WARD ──────────────────────────────────────────
 * `GET /medication-round` returns every patient with their doses, their names, their beds and
 * their allergens in five server-side queries whatever the page size. The obvious alternative —
 * list the ward, then fetch a schedule and an allergy list per patient — is the N+1 that endpoint
 * was built to kill, and a test asserts the request count does not grow with the number of
 * patients.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiClientError,
  slotRef,
  type DoseSlot,
  type MedicationRoundRow,
  type SlotRef,
} from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import { useBranch } from "../../components/BranchProvider";
import { Alert, Button, Card, Spinner } from "../../components/ui";
import { MedicationRecord } from "../../components/MedicationRecord";
import { timeInZone, todayInZone } from "../../lib/day";
import {
  bedLabel,
  doseStateLabel,
  partialOrderNotice,
  quietLabel,
  roundFlags,
  roundOrder,
  slotKey,
  slotOrder,
  summariseRound,
  summaryLabel,
  wardOptions,
  type RoundTone,
} from "../../lib/round";

/** The page size asked for. The server caps at 100 and defaults to 20. */
const PAGE_SIZE = 20;

const TONE_CLASS: Record<RoundTone, string> = {
  critical:
    "border-[var(--color-danger)]/40 bg-[var(--color-danger-bg)] text-[var(--color-danger)]",
  warning:
    "border-[var(--color-warning)]/40 bg-[var(--color-warning-bg)] text-[var(--color-warning)]",
  success:
    "border-[var(--color-success)]/40 bg-[var(--color-success-bg)] text-[var(--color-success)]",
  neutral: "border-[var(--color-border)] bg-[var(--color-bg-subtle)] text-[var(--color-fg-muted)]",
};

/** The dose the nurse has opened, and the patient it belongs to. */
interface Selection {
  row: MedicationRoundRow;
  ref: SlotRef;
}

export default function MedicationRoundPage() {
  const { api, can } = useAuth();
  const { timezone } = useBranch();

  const [rows, setRows] = useState<MedicationRoundRow[]>([]);
  const [total, setTotal] = useState<number | undefined>(undefined);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ward, setWard] = useState("");
  const [selection, setSelection] = useState<Selection | null>(null);

  /**
   * The day this round is FOR, in the branch's timezone — W2.
   *
   * The API deliberately does not echo which day it resolved (its controller says why: an unread
   * field in the paging envelope reads as a guarantee nobody honours). So the client names the day
   * explicitly rather than letting the server infer it, which also makes the header honest: at
   * 23:30 in Delhi a New York ward is still on yesterday afternoon, and the round belongs to the
   * WARD's day, never the reader's.
   */
  const [date, setDate] = useState(() => todayInZone(timezone));

  // The branch's zone decides the day. Changing branch re-scopes the whole screen (W1 remounts it),
  // but a hospital whose branches sit in different zones must still land on the right day here.
  useEffect(() => {
    setDate(todayInZone(timezone));
  }, [timezone]);

  const clockLabel = useCallback(
    (iso: string): string => timeInZone(new Date(iso), timezone),
    [timezone],
  );

  /**
   * Loads the round from page 1 up to `pages`, so "load more" and a refresh after an
   * administration both end at the same place — the nurse does not lose their position because a
   * dose was charted.
   */
  /**
   * The permission gates the REQUEST, not just the rendering.
   *
   * The ward screen established why and it holds here: a role without `emr:read` firing this on
   * every visit would manufacture a 403 in the audit trail each time, and denials are recorded on
   * purpose — "forty denials from one account in a minute is somebody mapping the permission
   * surface". A screen that generates that noise itself is how a real intrusion goes unnoticed.
   */
  const canRead = can("emr:read");

  const load = useCallback(
    (wanted: number, mode: "replace" | "more") => {
      if (!canRead) {
        setLoading(false);
        return;
      }
      if (mode === "replace") setLoading(true);
      else setLoadingMore(true);

      const requests = Array.from({ length: wanted }, (_, i) =>
        api.listMedicationRound({
          page: i + 1,
          limit: PAGE_SIZE,
          date,
          ...(ward ? { ward } : {}),
        }),
      );

      void Promise.all(requests)
        .then((results) => {
          setRows(results.flatMap((r) => r.items));
          setTotal(results[0]?.meta.total);
          setError(null);
        })
        .catch((e: unknown) =>
          setError(e instanceof ApiClientError ? e.message : "Could not load the round."),
        )
        .finally(() => {
          setLoading(false);
          setLoadingMore(false);
        });
    },
    [api, date, ward, canRead],
  );

  useEffect(() => {
    load(pages, pages === 1 ? "replace" : "more");
  }, [load, pages]);

  // A new ward or a new day is a different round; start from the first page rather than keeping a
  // depth that belonged to the previous query.
  useEffect(() => {
    setPages(1);
  }, [ward, date]);

  const ordered = useMemo(() => roundOrder(rows), [rows]);
  const summary = useMemo(() => summariseRound(rows, total), [rows, total]);
  const wards = useMemo(() => wardOptions(rows), [rows]);
  const partial = partialOrderNotice(summary);
  const canAdminister = can("mar:administer");

  if (!canRead) {
    return (
      <Alert tone="warning">
        You do not have access to the medication round. It needs the clinical record permission.
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--color-fg)]">Medication round</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            Every dose expected on the ward today, earliest outstanding first.
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <label className="block text-xs text-[var(--color-fg-muted)]">
            Ward
            <input
              list="round-wards"
              value={ward}
              onChange={(e) => setWard(e.target.value)}
              placeholder="All wards"
              className="mt-1 block w-44 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm text-[var(--color-fg)]"
            />
            {/* Free text, because a ward IS free text on this product's admission form. The
                suggestions are the wards actually loaded, so they always match. */}
            <datalist id="round-wards">
              {wards.map((w) => (
                <option key={w} value={w} />
              ))}
            </datalist>
          </label>

          <label className="block text-xs text-[var(--color-fg-muted)]">
            Day
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="mt-1 block rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm text-[var(--color-fg)]"
            />
          </label>

          <Button variant="secondary" onClick={() => load(pages, "replace")} disabled={loading}>
            Refresh
          </Button>
        </div>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      {/*
       * The headline, and the honest note beneath it. The server pages the round in BED order and
       * says so explicitly, so the urgency sort above is an order over what is IN THE BROWSER —
       * a nurse reading "2 doses due" off page one of three and stopping is the failure this says
       * out loud rather than hides.
       */}
      <Card className="p-4">
        <p className="text-sm font-medium text-[var(--color-fg)]" role="status">
          {loading ? "Loading the round…" : summaryLabel(summary)}
        </p>
        {partial && !loading && (
          <p className="mt-1 text-xs text-[var(--color-fg-muted)]">{partial}</p>
        )}
      </Card>

      {loading ? (
        <div className="flex justify-center py-10">
          <Spinner className="h-6 w-6" />
        </div>
      ) : ordered.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-sm text-[var(--color-fg-muted)]">
            {ward
              ? `Nobody is admitted to “${ward}” on this day.`
              : "Nobody is admitted on this day."}
          </p>
        </Card>
      ) : (
        <ul className="space-y-3">
          {ordered.map((row) => (
            <PatientRow
              key={row.encounterId}
              row={row}
              clockLabel={clockLabel}
              canAdminister={canAdminister}
              selectedSlot={selection?.row.encounterId === row.encounterId ? selection.ref : null}
              onSelect={(slot) => setSelection({ row, ref: slotRef(slot) })}
              onClose={() => setSelection(null)}
              onCharted={() => load(pages, "replace")}
              canReadAllergies={can("allergy:read")}
            />
          ))}
        </ul>
      )}

      {!loading && !summary.complete && (
        <div className="flex justify-center">
          <Button variant="secondary" onClick={() => setPages((p) => p + 1)} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more patients"}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * One patient on the round.
 *
 * Name and UHID lead; the bed is context on the second line. A bed is where somebody was an hour
 * ago and the wristband is what a nurse checks against, which is why the endpoint resolves both
 * server-side rather than leaving the identity to an enrichment that can be missing.
 */
function PatientRow({
  row,
  clockLabel,
  canAdminister,
  canReadAllergies,
  selectedSlot,
  onSelect,
  onClose,
  onCharted,
}: {
  row: MedicationRoundRow;
  clockLabel: (iso: string) => string;
  canAdminister: boolean;
  canReadAllergies: boolean;
  selectedSlot: SlotRef | null;
  onSelect: (slot: DoseSlot) => void;
  onClose: () => void;
  onCharted: () => void;
}) {
  const flags = roundFlags(row);
  const quiet = quietLabel(row);
  const slots = slotOrder(row.slots);

  return (
    <li>
      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-[var(--color-fg)]">
              {row.patientName}
              {row.uhid && (
                <span className="ml-2 font-normal text-[var(--color-fg-muted)]">{row.uhid}</span>
              )}
            </p>
            <p className="text-xs text-[var(--color-fg-subtle)]">{bedLabel(row)}</p>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {flags.map((flag) => (
              // The spoken label carries the meaning; the pill's colour only repeats it.
              <span
                key={flag.label}
                className={`rounded-full border px-2 py-0.5 text-xs font-medium ${TONE_CLASS[flag.tone]}`}
              >
                <span aria-hidden>{flag.label}</span>
                <span className="sr-only">{flag.accessibilityLabel}</span>
              </span>
            ))}
          </div>
        </div>

        {/*
         * The quiet line is a NOTE, not a replacement for the list.
         *
         * It said "All doses answered" INSTEAD of the doses at first, which hid every given, held
         * and refused dose the moment a patient had nothing left outstanding — exactly when a nurse
         * checking "did the 08:00 go in?" needs to see them. The summary and the record are
         * different questions and both get answered.
         */}
        {quiet && <p className="mt-3 text-xs text-[var(--color-fg-subtle)]">{quiet}</p>}

        {slots.length > 0 && (
          <ul className="mt-3 space-y-1.5">
            {slots.map((slot) => {
              const state = doseStateLabel(slot);
              const open = slot.state === "due" || slot.state === "overdue";
              const chosen =
                selectedSlot !== null &&
                selectedSlot.prescriptionId === slot.prescriptionId &&
                selectedSlot.lineIndex === slot.lineIndex &&
                selectedSlot.scheduledFor === slot.scheduledFor;

              return (
                <li key={slotKey(slot)}>
                  {/*
                   * The row is a NAVIGATION control, never an action. Its accessible name says so
                   * — "Open …", not "Give …" — because a button a nurse believes administers a
                   * drug is an inline administration whatever the code behind it does.
                   */}
                  <button
                    type="button"
                    disabled={!open || !canAdminister}
                    aria-pressed={chosen}
                    onClick={() => onSelect(slot)}
                    className={`flex w-full flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left transition-colors ${
                      chosen
                        ? "border-[var(--color-brand-500)] bg-[var(--color-brand-50)]"
                        : "border-[var(--color-border)] bg-[var(--color-bg-subtle)]"
                    } ${open && canAdminister ? "hover:border-[var(--color-border-strong)]" : "cursor-default"}`}
                  >
                    <span className="min-w-0">
                      <span className="text-sm font-medium text-[var(--color-fg)]">
                        {slot.drugName}
                      </span>
                      <span className="ml-2 text-xs text-[var(--color-fg-subtle)]">
                        {slot.dose} · {slot.route}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {/* The ward's clock, not the reader's — W2. */}
                      <span className="text-xs font-medium text-[var(--color-fg-muted)]">
                        {clockLabel(slot.scheduledFor)}
                      </span>
                      <span
                        className={`rounded-full border px-2 py-0.5 text-xs font-medium ${TONE_CLASS[state.tone]}`}
                      >
                        {state.text}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {/*
         * The administration surface — the ward page's component, unchanged. It re-reads this
         * patient's chart from the server before offering anything, so the identity that travelled
         * from the row above is only ever a hint about WHICH LINE, never a claim about its state.
         */}
        {selectedSlot && (
          <div className="mt-4 border-t border-[var(--color-border)] pt-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-[var(--color-fg)]">
                Chart a dose · {row.patientName}
              </h2>
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
            </div>
            <MedicationRecord
              encounterId={row.encounterId}
              patientId={row.patientId}
              patientName={row.patientName}
              uhid={row.uhid}
              canAdminister={canAdminister}
              canReadAllergies={canReadAllergies}
              focusSlot={selectedSlot}
              onCharted={onCharted}
            />
          </div>
        )}
      </Card>
    </li>
  );
}
