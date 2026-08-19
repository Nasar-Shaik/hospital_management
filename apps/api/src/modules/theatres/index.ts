/**
 * Theatres module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5, Module B5).
 *
 * Owns the operation-theatre registry and the procedures scheduled on them. It reads the patient
 * module (`namesByIds`) to name a booking on the board; nothing reads back into it, so the graph
 * stays acyclic. ICU/ER are NOT here — they are beds, owned by the ward inventory (B4).
 */
export { theatreRouter } from "./theatre.routes.js";

export {
  listTheatres,
  getTheatre,
  createTheatre,
  updateTheatre,
  listBookings,
  createBooking,
  transitionBooking,
  recordOperativeNote,
  type Theatre,
  type OtBooking,
  type OtBookingView,
  type OperativeNoteView,
} from "./theatre.service.js";

export {
  THEATRE_KINDS,
  THEATRE_STATUSES,
  OT_BOOKING_STATUSES,
  type TheatreKind,
  type TheatreStatus,
  type OtBookingStatus,
} from "./theatre.model.js";
