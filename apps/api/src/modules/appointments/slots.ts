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
 * ── TIME IS THE HARD PART, AND IT IS DELIBERATELY SIMPLE HERE ────────────────
 * `startMinute` is minutes from LOCAL midnight, and slots are built by adding
 * minutes to the local midnight of the requested date. That is correct as long as
 * the hospital's clock has no daylight-saving discontinuity in the middle of a
 * clinic session — true across India and the launch markets, and not something to
 * silently assume forever. When a hospital in a DST zone is onboarded, the fix is
 * a per-tenant IANA timezone and a real date library, NOT arithmetic patched here.
 * Recorded so the next person finds a decision rather than a bug.
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

/** Local midnight of the given day — the anchor every slot is offset from. */
function midnight(day: Date): Date {
  const d = new Date(day);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Every slot a template produces on `day`. Partial trailing time is discarded: a
 * 09:00–13:10 window with 15-minute slots ends at 13:00, because a 10-minute
 * stub is not an appointment anyone can keep.
 */
export function slotsFor(day: Date, template: SlotTemplate): Slot[] {
  const base = midnight(day).getTime();
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
