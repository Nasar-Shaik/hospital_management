/**
 * Theatre & OT-booking service (Module B5).
 *
 * The registry side is thin (turn a duplicate code into a sentence, a miss into a 404). The booking
 * side carries the module's real rules:
 *   - a booking's window must be well-formed (end after start) and land on an ACTIVE theatre;
 *   - it must not OVERLAP another occupying booking on that theatre (the collision rule);
 *   - its lifecycle moves only along legal edges (scheduled → in_progress → completed, or cancelled).
 * The patient's NAME on the board is joined here from the patient module — the repository owns only
 * its own two collections.
 */
import { AppError } from "../../core/errors/appError.js";
import { getContext } from "../../core/context/requestContext.js";
import { namesByIds } from "../patients/index.js";
import * as repo from "./theatre.repository.js";
import { canTransition, type OtBookingStatus } from "./theatre.model.js";

export type { Theatre, OtBooking } from "./theatre.repository.js";

export const listTheatres = repo.listTheatres;
export const getTheatre = repo.findTheatreById;

/* ── Theatres ───────────────────────────────────────────────────────────────── */

export interface CreateTheatreInput {
  name: string;
  code: string;
  kind: repo.CreateTheatreInput["kind"];
}

export async function createTheatre(input: CreateTheatreInput): Promise<repo.Theatre> {
  try {
    return await repo.createTheatre(input);
  } catch (err) {
    if (repo.isDuplicateKey(err)) {
      throw new AppError("HMS-VAL-001", 409, "That theatre code is already in use", {
        code: input.code,
        hint: "theatre codes are unique per hospital — pick another",
      });
    }
    throw err;
  }
}

export async function updateTheatre(
  id: string,
  patch: repo.UpdateTheatreInput,
): Promise<repo.Theatre> {
  const existing = await repo.findTheatreById(id);
  if (!existing) throw new AppError("HMS-GEN-404", 404, "Theatre not found", { id });
  const updated = await repo.updateTheatre(id, patch);
  if (!updated) throw new AppError("HMS-GEN-404", 404, "Theatre not found", { id });
  return updated;
}

/* ── OT bookings ────────────────────────────────────────────────────────────── */

/** A booking on the board, with the patient named for the human reading it. */
export interface OtBookingView extends repo.OtBooking {
  patientName: string;
  uhid: string;
}

async function withPatients(bookings: repo.OtBooking[]): Promise<OtBookingView[]> {
  const names = await namesByIds([...new Set(bookings.map((b) => b.patientId))]);
  const byId = new Map(names.map((n) => [n.id, n]));
  return bookings.map((b) => ({
    ...b,
    patientName: byId.get(b.patientId)?.name ?? "Unknown patient",
    uhid: byId.get(b.patientId)?.uhid ?? "—",
  }));
}

export interface ListBookingsInput {
  from: Date;
  to: Date;
  theatreId?: string;
  status?: OtBookingStatus;
}

export async function listBookings(input: ListBookingsInput): Promise<OtBookingView[]> {
  return withPatients(await repo.listBookings(input));
}

export interface CreateBookingInput {
  theatreId: string;
  patientId: string;
  surgeonId: string;
  encounterId?: string;
  procedureName: string;
  scheduledStart: Date;
  scheduledEnd: Date;
}

export async function createBooking(input: CreateBookingInput): Promise<OtBookingView> {
  if (input.scheduledEnd <= input.scheduledStart) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      scheduledEnd: ["the procedure must end after it starts"],
    });
  }

  const theatre = await repo.getTheatreDoc(input.theatreId);
  if (!theatre)
    throw new AppError("HMS-GEN-404", 404, "Theatre not found", { id: input.theatreId });
  if (theatre.status !== "active") {
    throw new AppError("HMS-VAL-001", 409, "That theatre is out of service", {
      theatreId: input.theatreId,
      hint: "pick an active theatre",
    });
  }

  const clash = await repo.findOverlap(input.theatreId, input.scheduledStart, input.scheduledEnd);
  if (clash) {
    throw new AppError("HMS-VAL-001", 409, "That theatre is already booked for this window", {
      theatre: theatre.code,
      conflictsWith: clash.procedureName,
      from: clash.scheduledStart,
      to: clash.scheduledEnd,
    });
  }

  const bookedBy = getContext().userId;
  try {
    const created = await repo.createBooking(
      { ...input, ...(bookedBy ? { bookedBy } : {}) },
      theatre,
    );
    return (await withPatients([created]))[0]!;
  } catch (err) {
    // The race backstop fired: another identical booking won the same exact start (see the model
    // header). Report it as the same conflict the overlap check would have.
    if (repo.isDuplicateKey(err)) {
      throw new AppError("HMS-VAL-001", 409, "That theatre is already booked for this window", {
        theatre: theatre.code,
        hint: "another booking just took this slot — refresh the board",
      });
    }
    throw err;
  }
}

export interface TransitionInput {
  to: OtBookingStatus;
  reason?: string;
}

export async function transitionBooking(
  id: string,
  input: TransitionInput,
): Promise<OtBookingView> {
  const booking = await repo.findBookingDocById(id);
  if (!booking) throw new AppError("HMS-GEN-404", 404, "Booking not found", { id });

  if (!canTransition(booking.status, input.to)) {
    throw new AppError(
      "HMS-VAL-001",
      409,
      `Cannot move a ${booking.status} booking to ${input.to}`,
      {
        from: booking.status,
        to: input.to,
      },
    );
  }

  const by = getContext().userId;
  const updated = await repo.setStatus(id, input.to, {
    from: booking.status,
    to: input.to,
    at: new Date(),
    ...(by ? { by } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
  });
  if (!updated) throw new AppError("HMS-GEN-404", 404, "Booking not found", { id });
  return (await withPatients([updated]))[0]!;
}
