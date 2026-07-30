"use client";

/**
 * Mortuary (Module support.mortuary) — the body custody register.
 *
 * The occupancy board shows which bodies are in storage — tag, drawer, and whether the case is
 * medico-legal (a red hold that blocks release without a police clearance). Receiving a body needs a
 * recorded death (the death record supplies the patient and the medico-legal flag); releasing it is
 * the controlled act. Managing is `mortuary:manage`; releasing is `mortuary:release`.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { type MortuaryEntry, type MortuaryStatus } from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import { Badge, Button, Card, Field, ErrorAlert } from "../../components/ui";

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-xl">
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-3.5">
          <h2 className="font-semibold text-[var(--color-fg)]">{title}</h2>
          <button
            onClick={onClose}
            className="text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

function ReceiveForm({
  onSubmit,
  saving,
  error,
}: {
  onSubmit: (v: {
    encounterId: string;
    tagNumber: string;
    storageUnit?: string;
    remarks?: string;
  }) => void;
  saving: boolean;
  error?: unknown;
}) {
  const [encounterId, setEncounterId] = useState("");
  const [tagNumber, setTagNumber] = useState("");
  const [storageUnit, setStorageUnit] = useState("");
  const [remarks, setRemarks] = useState("");

  return (
    <div className="space-y-4">
      {error != null && <ErrorAlert error={error} fallback="Could not receive the body." />}
      <p className="text-xs text-[var(--color-fg-muted)]">
        The death must already be recorded — the patient and medico-legal status come from the death
        record.
      </p>
      <Field
        label="Encounter (visit) ID"
        name="encounterId"
        value={encounterId}
        onChange={(e) => setEncounterId(e.target.value.trim())}
        placeholder="the deceased's visit id"
        required
      />
      <Field
        label="Body tag number"
        name="tagNumber"
        value={tagNumber}
        onChange={(e) => setTagNumber(e.target.value)}
        placeholder="MRT-0007"
        required
      />
      <Field
        label="Storage (drawer / freezer)"
        name="storageUnit"
        value={storageUnit}
        onChange={(e) => setStorageUnit(e.target.value)}
        placeholder="Chamber B — drawer 3"
      />
      <Field
        label="Remarks (optional)"
        name="remarks"
        value={remarks}
        onChange={(e) => setRemarks(e.target.value)}
      />
      <div className="flex justify-end">
        <Button
          loading={saving}
          disabled={!encounterId.trim() || !tagNumber.trim()}
          onClick={() =>
            onSubmit({
              encounterId: encounterId.trim(),
              tagNumber: tagNumber.trim(),
              ...(storageUnit.trim() ? { storageUnit: storageUnit.trim() } : {}),
              ...(remarks.trim() ? { remarks: remarks.trim() } : {}),
            })
          }
        >
          Receive body
        </Button>
      </div>
    </div>
  );
}

function ReleaseForm({
  entry,
  onSubmit,
  saving,
  error,
}: {
  entry: MortuaryEntry;
  onSubmit: (v: {
    releasedTo: string;
    releasedRelationship: string;
    clearanceRef?: string;
    remarks?: string;
  }) => void;
  saving: boolean;
  error?: unknown;
}) {
  const [releasedTo, setReleasedTo] = useState("");
  const [releasedRelationship, setReleasedRelationship] = useState("");
  const [clearanceRef, setClearanceRef] = useState("");
  const [remarks, setRemarks] = useState("");
  const needsClearance = entry.medicoLegal;

  return (
    <div className="space-y-4">
      {error != null && <ErrorAlert error={error} fallback="Could not release the body." />}
      {needsClearance && (
        <div className="rounded-lg border border-[var(--color-danger)]/20 bg-[var(--color-danger-bg)] px-3 py-2 text-xs text-[var(--color-danger)]">
          Medico-legal case — a police / magistrate clearance reference is required before release.
        </div>
      )}
      <Field
        label="Released to"
        name="releasedTo"
        value={releasedTo}
        onChange={(e) => setReleasedTo(e.target.value)}
        placeholder="Name of the person receiving the body"
        required
      />
      <Field
        label="Relationship to the deceased"
        name="releasedRelationship"
        value={releasedRelationship}
        onChange={(e) => setReleasedRelationship(e.target.value)}
        placeholder="Son / spouse / …"
        required
      />
      <Field
        label={needsClearance ? "Clearance reference (required)" : "Clearance reference (optional)"}
        name="clearanceRef"
        value={clearanceRef}
        onChange={(e) => setClearanceRef(e.target.value)}
        placeholder="Police NOC / magistrate order no."
      />
      <Field
        label="Remarks (optional)"
        name="remarks"
        value={remarks}
        onChange={(e) => setRemarks(e.target.value)}
      />
      <div className="flex justify-end">
        <Button
          loading={saving}
          disabled={
            !releasedTo.trim() ||
            !releasedRelationship.trim() ||
            (needsClearance && !clearanceRef.trim())
          }
          onClick={() =>
            onSubmit({
              releasedTo: releasedTo.trim(),
              releasedRelationship: releasedRelationship.trim(),
              ...(clearanceRef.trim() ? { clearanceRef: clearanceRef.trim() } : {}),
              ...(remarks.trim() ? { remarks: remarks.trim() } : {}),
            })
          }
        >
          Release body
        </Button>
      </div>
    </div>
  );
}

function MortuaryPage() {
  const { api, can } = useAuth();
  const canManage = can("mortuary:manage");
  const canRelease = can("mortuary:release");

  const [tab, setTab] = useState<MortuaryStatus>("in_storage");
  const [entries, setEntries] = useState<MortuaryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [modal, setModal] = useState<
    { kind: "receive" } | { kind: "release"; entry: MortuaryEntry } | null
  >(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<unknown>(null);

  const load = useCallback(() => {
    setLoading(true);
    api
      .listMortuary(tab)
      .then(setEntries)
      .catch((e: unknown) => setError(e))
      .finally(() => setLoading(false));
  }, [api, tab]);
  useEffect(load, [load]);

  async function run(fn: () => Promise<unknown>) {
    setSaving(true);
    setFormError(null);
    try {
      await fn();
      setModal(null);
      load();
    } catch (e) {
      setFormError(e);
    } finally {
      setSaving(false);
    }
  }

  const inStorage = tab === "in_storage";

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-fg)]">Mortuary</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            The body custody register — from receipt into storage to release.
          </p>
        </div>
        {canManage && (
          <Button
            onClick={() => {
              setFormError(null);
              setModal({ kind: "receive" });
            }}
          >
            Receive a body
          </Button>
        )}
      </div>

      <div className="flex gap-1 rounded-lg bg-[var(--color-bg-subtle)] p-1 text-sm">
        {(
          [
            ["in_storage", "In storage"],
            ["released", "Released"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            onClick={() => setTab(value)}
            className={`flex-1 rounded-md px-3 py-1.5 font-medium ${
              tab === value
                ? "bg-[var(--color-bg-elevated)] text-[var(--color-fg)] shadow-sm"
                : "text-[var(--color-fg-muted)]"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {error != null && <ErrorAlert error={error} fallback="Could not load the register." />}

      {loading ? (
        <p className="py-8 text-center text-sm text-[var(--color-fg-muted)]">Loading…</p>
      ) : entries.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-sm text-[var(--color-fg-muted)]">
            {inStorage ? "No bodies in storage." : "No bodies have been released yet."}
          </p>
        </Card>
      ) : (
        <div className="space-y-2">
          {entries.map((e) => (
            <Card key={e.id} className="space-y-2 p-4">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-mono text-sm font-semibold text-[var(--color-fg)]">
                  {e.tagNumber}
                </span>
                <span className="min-w-40 flex-1 text-sm font-medium text-[var(--color-fg)]">
                  {e.deceasedName}
                </span>
                {e.medicoLegal && <Badge tone="danger">Medico-legal</Badge>}
                {inStorage ? (
                  <Badge tone="info">In storage</Badge>
                ) : (
                  <Badge tone="success">Released</Badge>
                )}
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-[var(--color-fg-muted)]">
                {e.storageUnit && <span>Storage: {e.storageUnit}</span>}
                <span>Received: {when(e.receivedAt)}</span>
                {e.releasedAt && <span>Released: {when(e.releasedAt)}</span>}
                {e.releasedTo && (
                  <span>
                    To: {e.releasedTo}
                    {e.releasedRelationship ? ` (${e.releasedRelationship})` : ""}
                  </span>
                )}
                {e.clearanceRef && <span>Clearance: {e.clearanceRef}</span>}
              </div>
              {inStorage && canRelease && (
                <div className="flex justify-end">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setFormError(null);
                      setModal({ kind: "release", entry: e });
                    }}
                  >
                    Release
                  </Button>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {modal?.kind === "receive" && (
        <Modal title="Receive a body" onClose={() => setModal(null)}>
          <ReceiveForm
            saving={saving}
            error={formError}
            onSubmit={(v) => void run(() => api.receiveBody(v))}
          />
        </Modal>
      )}
      {modal?.kind === "release" && (
        <Modal title={`Release — ${modal.entry.deceasedName}`} onClose={() => setModal(null)}>
          <ReleaseForm
            entry={modal.entry}
            saving={saving}
            error={formError}
            onSubmit={(v) => void run(() => api.releaseBody(modal.entry.id, v))}
          />
        </Modal>
      )}
    </div>
  );
}

export default function Page() {
  return <MortuaryPage />;
}
