"use client";

/**
 * The operation record — written once after the procedure, read forever after on the chart.
 *
 * ── WHY IT IS A COMPONENT AND NOT PART OF THE THEATRE PAGE ──────────────────
 * It has two readers in two different places. The OT board writes it (the surgeon, at the end of
 * the list) and the DOCTOR'S CHART reads it back on a patient who may have been operated on years
 * ago in another visit. A copy in each page is a copy that drifts, and the thing most likely to
 * drift is the sentence explaining that the record cannot be edited — which is precisely the
 * sentence a surgeon needs to have read before pressing Save.
 *
 * The write-once rule is the SERVER'S (a conditional update in `theatre.repository.ts`). This form
 * only explains it. Nothing here is a security control: a page that hides the button still posts
 * the same route, which is why `ot:record` gates it on the API.
 */
import { useState, type FormEvent, type JSX } from "react";
import type { ApiClient, OperativeNote, OtBooking } from "@medicore/api-client";
import { Alert, Button, ErrorAlert, Field, Modal } from "./ui";

const fmt = (iso: string) =>
  new Date(iso).toLocaleString([], {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

/** `<input type="datetime-local">` wants a zone-less local string; `toISOString` is UTC. */
function localNow(): string {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 16);
}

/** The record as it reads back — used inside the modal and inline on the chart. */
export function OperativeNoteDetail({ note }: { note: OperativeNote }): JSX.Element {
  return (
    <dl className="space-y-3 text-sm">
      <div>
        <dt className="text-xs font-medium text-[var(--color-fg-muted)]">Procedure performed</dt>
        <dd className="text-[var(--color-fg)]">{note.procedurePerformed}</dd>
      </div>
      <div>
        <dt className="text-xs font-medium text-[var(--color-fg-muted)]">Performed at</dt>
        <dd className="text-[var(--color-fg)]">{fmt(note.performedAt)}</dd>
      </div>
      {note.findings && (
        <div>
          <dt className="text-xs font-medium text-[var(--color-fg-muted)]">Findings</dt>
          <dd className="whitespace-pre-wrap text-[var(--color-fg)]">{note.findings}</dd>
        </div>
      )}
      {note.notes && (
        <div>
          <dt className="text-xs font-medium text-[var(--color-fg-muted)]">Notes</dt>
          <dd className="whitespace-pre-wrap text-[var(--color-fg)]">{note.notes}</dd>
        </div>
      )}
      <div>
        <dt className="text-xs font-medium text-[var(--color-fg-muted)]">Recorded</dt>
        <dd className="text-[var(--color-fg-muted)]">{fmt(note.recordedAt)}</dd>
      </div>
    </dl>
  );
}

export function OperativeNoteModal({
  api,
  booking,
  surgeons,
  canRecord,
  onClose,
  onRecorded,
}: {
  api: ApiClient;
  booking: OtBooking;
  /** Who may be named as the operating surgeon — the doctor list the board already loaded. */
  surgeons: { id: string; name: string }[];
  canRecord: boolean;
  onClose: () => void;
  onRecorded: () => void;
}): JSX.Element {
  const existing = booking.operativeNote;

  const [procedurePerformed, setProcedurePerformed] = useState(booking.procedureName);
  const [surgeonId, setSurgeonId] = useState(booking.surgeonId);
  const [performedAt, setPerformedAt] = useState(localNow());
  const [findings, setFindings] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    api
      .recordOperativeNote(booking.id, {
        procedurePerformed: procedurePerformed.trim(),
        surgeonId,
        performedAt: new Date(performedAt).toISOString(),
        ...(findings.trim() ? { findings: findings.trim() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      })
      .then(() => onRecorded())
      .catch((err: unknown) => setError(err))
      .finally(() => setSaving(false));
  }

  if (existing) {
    return (
      <Modal title="Operation record" onClose={onClose}>
        <div className="space-y-4">
          <p className="text-xs text-[var(--color-fg-muted)]">
            {booking.patientName} · {booking.uhid} · {booking.theatreName}
          </p>
          <OperativeNoteDetail note={existing} />
        </div>
      </Modal>
    );
  }

  if (!canRecord) {
    return (
      <Modal title="Operation record" onClose={onClose}>
        <Alert tone="info" title="Not recorded yet">
          The surgeon has not written the operation record for this procedure.
        </Alert>
      </Modal>
    );
  }

  return (
    <Modal title="Record the operation" onClose={onClose}>
      <form className="space-y-5" onSubmit={submit}>
        {error != null && (
          <ErrorAlert error={error} fallback="Could not save the operation record." />
        )}

        <p className="text-xs text-[var(--color-fg-muted)]">
          {booking.patientName} · {booking.uhid} · booked as <em>{booking.procedureName}</em>
        </p>

        <Alert tone="warning" title="This is written once">
          An operation record cannot be edited or deleted once saved. Say what was actually done.
        </Alert>

        <Field
          label="Procedure performed"
          name="procedurePerformed"
          value={procedurePerformed}
          onChange={(e) => setProcedurePerformed(e.target.value)}
          hint="What was actually done — this may differ from what was booked."
          required
        />

        <label className="block text-sm">
          <span className="mb-1.5 block font-medium text-[var(--color-fg)]">Operating surgeon</span>
          <select
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[var(--color-fg)]"
            value={surgeonId}
            onChange={(e) => setSurgeonId(e.target.value)}
            required
          >
            <option value="">— Select the surgeon —</option>
            {surgeons.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-sm">
          <span className="mb-1.5 block font-medium text-[var(--color-fg)]">Performed at</span>
          <input
            type="datetime-local"
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[var(--color-fg)]"
            value={performedAt}
            onChange={(e) => setPerformedAt(e.target.value)}
            required
          />
        </label>

        <label className="block text-sm">
          <span className="mb-1.5 block font-medium text-[var(--color-fg)]">Findings</span>
          <textarea
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-fg)]"
            rows={3}
            value={findings}
            onChange={(e) => setFindings(e.target.value)}
            placeholder="Inflamed appendix, no perforation. Peritoneal cavity clean."
          />
        </label>

        <label className="block text-sm">
          <span className="mb-1.5 block font-medium text-[var(--color-fg)]">Notes</span>
          <textarea
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-fg)]"
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Post-op: nil by mouth 6 hours, IV antibiotics 48 hours."
          />
        </label>

        <div className="flex justify-end">
          <Button type="submit" loading={saving} disabled={!surgeonId}>
            Save operation record
          </Button>
        </div>
      </form>
    </Modal>
  );
}
