"use client";

/**
 * The patient profile's Vitals tab — a person's observations, grouped by the visit they belong to.
 *
 * ── WHY GROUPED BY VISIT RATHER THAN ONE FLAT LIST ──────────────────────────
 * A reading only means something inside the episode that framed it: a blood pressure taken during
 * a hypertension review and one taken in casualty three months later are not two points on one
 * line a clinician should read casually. Grouping keeps each set with the visit that explains it,
 * while still letting the eye run down the page for a trend.
 *
 * Recording attaches to the patient's CURRENT open visit. Observations belong to an encounter (see
 * the vitals model), so when there is no open visit there is nothing to attach them to — and the
 * honest answer is to say so and point at reception, not to silently invent a visit.
 */
import type { JSX } from "react";
import type { ApiClient, Encounter, VitalsReading } from "@medicore/api-client";
import { Alert, Badge, Card } from "./ui";
import { VitalsForm, VitalsHistory, VitalsSummary } from "./Vitals";

/** Statuses that mean the patient is still in the hospital's hands on this visit. */
const OPEN_STATUSES = new Set([
  "arrived",
  "in_queue",
  "in_progress",
  "awaiting_results",
  "admitted",
]);

function visitLabel(encounter: Encounter): string {
  const when = new Date(encounter.arrivedAt).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return `${when} · ${encounter.class}`;
}

export function VitalsByVisit({
  api,
  readings,
  encounters,
  canRecord,
  onSaved,
}: {
  api: ApiClient;
  readings: VitalsReading[];
  encounters: Encounter[];
  canRecord: boolean;
  onSaved: (reading: VitalsReading) => void;
}): JSX.Element {
  // Newest visit first — the same order the Visits tab uses.
  const byArrival = [...encounters].sort(
    (a, b) => new Date(b.arrivedAt).getTime() - new Date(a.arrivedAt).getTime(),
  );
  const openVisit = byArrival.find((e) => OPEN_STATUSES.has(e.status));

  const grouped = new Map<string, VitalsReading[]>();
  for (const r of readings) {
    const list = grouped.get(r.encounterId) ?? [];
    list.push(r);
    grouped.set(r.encounterId, list);
  }

  const latest = readings[0];

  return (
    <div className="space-y-5">
      {latest && (
        <Card className="p-4">
          <h3 className="mb-2 text-sm font-semibold text-[var(--color-fg)]">Most recent</h3>
          <VitalsSummary reading={latest} />
        </Card>
      )}

      {canRecord &&
        (openVisit ? (
          <Card className="p-4">
            <h3 className="mb-1 text-sm font-semibold text-[var(--color-fg)]">
              Record observations
            </h3>
            <p className="mb-3 text-xs text-[var(--color-fg-muted)]">
              Charted against the current visit — {visitLabel(openVisit)}
              {openVisit.token ? ` · token ${String(openVisit.token)}` : ""}
            </p>
            <VitalsForm api={api} encounterId={openVisit.id} onSaved={onSaved} />
          </Card>
        ) : (
          <Alert tone="info">
            Observations are recorded against a visit, and this patient has no open visit. Register
            their arrival at reception first.
          </Alert>
        ))}

      {readings.length === 0 ? (
        <Alert tone="info">No observations have been recorded for this patient yet.</Alert>
      ) : (
        byArrival
          .filter((e) => grouped.has(e.id))
          .map((e) => {
            // Stored newest-first by the API; a chart reads oldest-first.
            const forVisit = [...(grouped.get(e.id) ?? [])].sort(
              (a, b) => new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime(),
            );
            return (
              <Card key={e.id} className="p-4">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold text-[var(--color-fg)]">{visitLabel(e)}</h3>
                  <Badge tone="neutral">{e.status.replace(/_/g, " ")}</Badge>
                  {forVisit.some((r) => r.abnormal) && (
                    <Badge tone="warning">Has out-of-range values</Badge>
                  )}
                </div>
                <VitalsHistory readings={forVisit} />
              </Card>
            );
          })
      )}
    </div>
  );
}
