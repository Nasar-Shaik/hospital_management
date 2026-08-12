/**
 * One patient's clinical story, in order.
 *
 * ── THE TIMELINE IS ASSEMBLED, NOT FETCHED ──────────────────────────────────
 * There is no `GET /patients/:id/timeline`, and this does not invent one. Four endpoints the app
 * already reads for other reasons — the episode's encounters, the patient's orders, prescriptions
 * and vitals — each carry an instant, and a doctor thinks about them as one sequence. Merging them
 * on the phone costs nothing (the data is already in the cache) and adds no server surface.
 *
 * Everything below is derived from fields the contracts actually declare. No event is synthesised
 * from an absence, and no field is inferred: if the API does not say when something happened, it
 * does not appear here rather than appearing at a guessed time.
 *
 * ── EVERY EVENT CARRIES ITS OWN `branchId` ──────────────────────────────────
 * Not for filtering — the server already decided what this caller may read — but so the renderer
 * can stamp each row in the zone of the site it happened at (`zone.ts`). In All-branches mode a
 * single list legitimately mixes sites, and one shared zone would misdate half of it.
 */
import type {
  ConsultationNote,
  Encounter,
  Order,
  Prescription,
  VitalsReading,
} from "@medicore/api-client";
import { isCriticalResult, isResultReadable } from "./results";

export type TimelineKind = "visit" | "note" | "order" | "result" | "prescription" | "vitals";

export interface TimelineEvent {
  /** Stable within one assembled list — `kind` prefixed, because ids are only unique per source. */
  id: string;
  kind: TimelineKind;
  /** ISO instant, straight off the record. Sorting and display both use this. */
  at: string;
  title: string;
  /** One line of detail. Absent when the title says everything. */
  detail?: string;
  /** The site the record belongs to, for zone resolution. Absent on pre-branch rows. */
  branchId?: string;
  /** Draws the row's marker. Only a released critical result earns `critical`. */
  critical?: boolean;
  /** Where tapping the row goes, when there is somewhere useful. */
  orderId?: string;
  encounterId?: string;
}

export interface TimelineSources {
  encounters?: readonly Encounter[];
  orders?: readonly Order[];
  prescriptions?: readonly Prescription[];
  vitals?: readonly VitalsReading[];
  /** Keyed by encounter — a note belongs to the visit it was written on. */
  notes?: readonly ConsultationNote[];
}

function visitEvent(encounter: Encounter): TimelineEvent {
  const kindLabel = encounter.class === "IP" ? "Admitted" : "Visit";
  const detail = [encounter.reason, encounter.diagnosis].filter(Boolean).join(" · ");
  return {
    id: `visit:${encounter.id}`,
    kind: "visit",
    at: encounter.arrivedAt,
    title: kindLabel,
    ...(detail ? { detail } : {}),
    ...(encounter.branchId ? { branchId: encounter.branchId } : {}),
    encounterId: encounter.id,
  };
}

/**
 * An order produces up to TWO events: it was asked for, and — separately — an answer came back.
 *
 * They are different clinical moments, often days apart, and collapsing them into one row dated at
 * the request loses the only date a doctor chasing a result cares about. The result event exists
 * only once `isResultReadable` says so, which is the release gate.
 */
function orderEvents(order: Order): TimelineEvent[] {
  const events: TimelineEvent[] = [
    {
      id: `order:${order.id}`,
      kind: "order",
      at: order.orderedAt,
      title: `Ordered — ${order.name}`,
      ...(order.branchId ? { branchId: order.branchId } : {}),
      orderId: order.id,
      encounterId: order.encounterId,
    },
  ];

  // `releasedAt` is the instant the result became readable, and it is the honest date for the row.
  // Falling back to `completedAt` would date the event to when the machine ran, not when a
  // clinician was allowed to see it.
  const releasedAt = order.releasedAt;
  if (isResultReadable(order) && releasedAt) {
    const summary = order.result?.summary;
    events.push({
      id: `result:${order.id}`,
      kind: "result",
      at: releasedAt,
      title: `Result — ${order.name}`,
      ...(summary ? { detail: summary } : {}),
      ...(order.branchId ? { branchId: order.branchId } : {}),
      ...(isCriticalResult(order) ? { critical: true } : {}),
      orderId: order.id,
      encounterId: order.encounterId,
    });
  }

  return events;
}

/**
 * Only SIGNED prescriptions reach the timeline, dated at the signature.
 *
 * A draft binds nobody and may never be signed; showing it as part of the record would put a
 * medication on a chart that the pharmacy will never see and the patient will never take. `signedAt`
 * is present exactly when `status` has passed the signature, so the field itself is the gate.
 */
function prescriptionEvent(rx: Prescription): TimelineEvent | undefined {
  if (!rx.signedAt) return undefined;
  const drugs = rx.lines.map((line) => line.drugName).join(", ");
  return {
    id: `rx:${rx.id}`,
    kind: "prescription",
    at: rx.signedAt,
    title: rx.version > 1 ? `Prescription (v${String(rx.version)})` : "Prescription",
    ...(drugs ? { detail: drugs } : {}),
    ...(rx.branchId ? { branchId: rx.branchId } : {}),
    encounterId: rx.encounterId,
  };
}

function vitalsEvent(reading: VitalsReading): TimelineEvent {
  return {
    id: `vitals:${reading.id}`,
    kind: "vitals",
    at: reading.recordedAt,
    title: "Vitals recorded",
    ...(reading.abnormal ? { detail: "Outside the reference range" } : {}),
    encounterId: reading.encounterId,
  };
}

/**
 * The consultation note has no instant of its own beyond `updatedAt` — there is one note per
 * encounter and it is edited in place, so the timeline shows WHEN IT WAS LAST WRITTEN. That is the
 * truth the contract supports; dating it to the visit would be a guess that reads as a fact.
 */
function noteEvent(note: ConsultationNote): TimelineEvent | undefined {
  const diagnoses = note.diagnoses.map((d) => d.text).join(", ");
  const detail = diagnoses || note.chiefComplaint;
  if (!detail) return undefined;
  return {
    id: `note:${note.encounterId}`,
    kind: "note",
    at: note.updatedAt,
    title: "Consultation note",
    detail,
    ...(note.branchId ? { branchId: note.branchId } : {}),
    encounterId: note.encounterId,
  };
}

/**
 * Newest first — the answer to "what has happened to this patient" starts with the most recent
 * thing, because that is the question actually being asked at a bedside.
 *
 * Ties break on `id` so the order is TOTAL: two events sharing an instant (an order placed in the
 * same second as another) would otherwise swap places between renders and make the list flicker.
 */
export function buildTimeline(sources: TimelineSources): TimelineEvent[] {
  const events: TimelineEvent[] = [
    ...(sources.encounters ?? []).map(visitEvent),
    ...(sources.orders ?? []).flatMap(orderEvents),
    ...(sources.vitals ?? []).map(vitalsEvent),
  ];

  for (const rx of sources.prescriptions ?? []) {
    const event = prescriptionEvent(rx);
    if (event) events.push(event);
  }
  for (const note of sources.notes ?? []) {
    const event = noteEvent(note);
    if (event) events.push(event);
  }

  return events.sort((a, b) => {
    const byTime = b.at.localeCompare(a.at);
    return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
  });
}
