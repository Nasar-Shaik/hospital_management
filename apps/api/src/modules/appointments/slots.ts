/**
 * Slot generation — turns a weekly schedule template into the concrete slots a
 * receptionist can actually click on for a given day.
 *
 * Slots are COMPUTED, never stored. A stored slot table would be millions of rows
 * describing something a single row already says ("Tuesdays, 09:00–13:00, 15 min"),
 * and it would drift the moment a doctor's hours changed — you would then have
 * bookable slots that no longer exist and free time nobody can book. The only
 * durable rows are the appointments themselves.
 *
 * ── TIME IS THE HARD PART, AND THE CALLER NOW OWNS IT (M0 §21 item C) ────────
 * `startMinute` is minutes from the clinic's midnight, and this module is handed that midnight as
 * an INSTANT rather than deriving one. It used to call `d.setHours(0,0,0,0)`, which is midnight in
 * the PROCESS zone — UTC on the shipped image — so a 09:00 clinic was offered at 14:30 IST.
 *
 * Resolving the zone is the service's job (`clinicZone`, `dayRangeInZone`), because only it knows
 * which branch the request is scoped to. What is left here is arithmetic on a known anchor, which
 * is the part that genuinely is simple.
 *
 * Still true, and still worth stating: a session spanning a daylight-saving discontinuity would
 * drift by the offset change, because minutes are added to a fixed instant. India does not observe
 * DST and neither do the launch markets. When one is onboarded the fix is to re-resolve the
 * wall-clock time per slot, not to patch arithmetic here.
 */
export interface SlotTemplate {
  startMinute: number;
  endMinute: number;
  slotMinutes: number;
}

export interface Slot {
  startAt: Date;
  endAt: Date;
}

/**
 * Every slot a template produces on a day. Partial trailing time is discarded: a
 * 09:00–13:10 window with 15-minute slots ends at 13:00, because a 10-minute
 * stub is not an appointment anyone can keep.
 *
 * @param clinicMidnight the UTC instant at which the clinic's own day begins — from
 * `dayRangeInZone(dayKey, branchZone).from`. NOT a date to be truncated here: this module has no
 * way to know which zone the truncation should happen in, and guessing is the defect item C fixed.
 */
export function slotsFor(clinicMidnight: Date, template: SlotTemplate): Slot[] {
  const base = clinicMidnight.getTime();
  const slots: Slot[] = [];

  for (
    let minute = template.startMinute;
    minute + template.slotMinutes <= template.endMinute;
    minute += template.slotMinutes
  ) {
    slots.push({
      startAt: new Date(base + minute * 60_000),
      endAt: new Date(base + (minute + template.slotMinutes) * 60_000),
    });
  }

  return slots;
}

/**
 * Removes slots that are already taken, or that have already passed.
 *
 * Dropping past slots matters more than it looks: offering 09:00 at 11am produces
 * a booking that is instantly a no-show, and the front desk learns to distrust the
 * whole screen. `now` is injected rather than read from the clock so this stays a
 * pure function — the alternative is a test that only passes in the morning.
 */
export function availableSlots(slots: Slot[], taken: Date[], now: Date): Slot[] {
  const takenAt = new Set(taken.map((d) => d.getTime()));
  return slots.filter((s) => s.startAt > now && !takenAt.has(s.startAt.getTime()));
}
