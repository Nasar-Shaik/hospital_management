"use client";

/**
 * Today's entry on the ward round — for whoever is entitled to write one.
 *
 * ── THE DEFECT THIS CLOSES (F-2) ────────────────────────────────────────────
 * This box used to live inside `app/ward/page.tsx`, hard-coded to `emr:write` and
 * `api.addWardNote`. `emr:write` is the DOCTOR's permission, so a nurse standing at the bedside
 * with the ward screen open saw NO note box at all — `PermissionGate` removed it — while
 * `nursing:manage`, which they do hold, gated a route no browser ever called. The nurse's own
 * record of the shift existed on the server and had no door in the building.
 *
 * The endpoint choice is NOT made here. `chartNoteCapability` in `@medicore/api-client` owns it,
 * because mobile had the identical bug and a rule duplicated in two apps is a rule that will drift
 * again the next time a note type is added.
 *
 * ── EXTRACTED SO THE WIRE CAN BE ASSERTED ───────────────────────────────────
 * A `page.tsx` in the App Router may not export arbitrary symbols, so a component that lives there
 * cannot be rendered by a test. The question this component answers — WHICH URL leaves the
 * browser, and does it carry the key — is only answerable against a real `ApiClient`. Same reason
 * `VitalsForm` sits in `components/` rather than in the page that uses it.
 */
import { useState, type JSX } from "react";
import {
  ApiClientError,
  writeChartNote,
  type ApiClient,
  type ChartNoteCapability,
  type WardNote,
} from "@medicore/api-client";
import { Alert, Button } from "./ui";
import { idempotencyMessage, useIdempotencyKey } from "../lib/idempotency";

export function AddChartNote({
  api,
  capability,
  encounterId,
  onAdded,
}: {
  api: ApiClient;
  /** Which note this user may write. The caller renders nothing when there is none. */
  capability: ChartNoteCapability;
  encounterId: string;
  onAdded: (note: WardNote) => void;
}): JSX.Element {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * One key per SUBMISSION, held across the retries of that submission.
   *
   * ── WHY THE KEY MATTERS MORE HERE THAN ALMOST ANYWHERE ──────────────────────
   * A ward note is append-only: no update path, no delete path, by design (a contemporaneous
   * record that can be rewritten afterwards is not evidence of anything). Both routes have carried
   * `idempotent()` since M3-S2 and this form simply never asked for it, so a reply lost on ward
   * wifi left the nurse with an error, no way to know whether the note had landed, and one obvious
   * course of action — press save again, which wrote a permanent second entry on a medico-legal
   * record. With the key, that retry replays the original 201 and writes nothing.
   *
   * ── RENEWED WHEN THE WORDS CHANGE, NOT ONLY ON SUCCESS ──────────────────────
   * The server refuses a spent key carrying a DIFFERENT body (`HMS-REQ-002`). So a key that
   * outlived an edit would lock somebody out of the chart entirely after one failed save. The rule
   * in `lib/idempotency.ts` — hold it across a retry of the same request, drop it when the user
   * changes what they are asking for — is what these two `renewKey()` calls implement.
   */
  const [saveKey, renewKey] = useIdempotencyKey();

  function edit(next: string): void {
    // The words are changing, so the next save is a different request and needs its own key.
    if (error !== null) {
      renewKey();
      setError(null);
    }
    setText(next);
  }

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const note = await writeChartNote(api, capability, encounterId, text.trim(), saveKey);
      setText("");
      // On the chart. The next note is a genuinely new intent and must not reuse this key.
      renewKey();
      onAdded(note);
    } catch (err) {
      setError(
        idempotencyMessage(err) ??
          (err instanceof ApiClientError ? err.message : "Could not save the note."),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      {error && <Alert tone="danger">{error}</Alert>}
      <textarea
        value={text}
        onChange={(e) => edit(e.target.value)}
        rows={3}
        aria-label={capability.label}
        placeholder={capability.placeholder}
        className="w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm text-[var(--color-fg)]"
      />
      <Button disabled={busy || text.trim().length === 0} onClick={() => void save()}>
        {busy ? "Saving…" : `Add ${capability.label.toLowerCase()}`}
      </Button>
      <p className="text-xs text-[var(--color-fg-subtle)]">
        A note cannot be edited or deleted once saved. A correction is a new note that says so.
      </p>
    </div>
  );
}
