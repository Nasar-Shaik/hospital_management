/**
 * Appointments module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5).
 *
 * Owns the appointment book and doctor schedules. Depends on `patients` (an
 * appointment must be FOR someone who exists, and the row scope must hold) —
 * nothing depends on this module, so the graph stays acyclic.
 *
 * NOT a platform module: healthcare vocabulary throughout (PLATFORM_STRATEGY §2).
 */
export { appointmentRouter } from "./appointment.routes.js";

export {
  bookAppointment,
  getAvailability,
  getAppointment,
  listAppointments,
  confirmAppointment,
  cancelAppointment,
  checkInAppointment,
  startConsultation,
  completeAppointment,
  markNoShow,
  rescheduleAppointment,
  setDoctorSchedule,
  getDoctorSchedules,
  removeDoctorSchedule,
  type Appointment,
  type DoctorSchedule,
  type BookAppointmentInput,
} from "./appointment.service.js";

/**
 * What this module does when an appointment event fires: the confirmation, the
 * cancellation, and the day-before reminder. Registered by the event consumer's
 * composition root — core/events/eventConsumer.ts.
 */
export { appointmentConsumers } from "./appointment.consumers.js";

export {
  APPOINTMENT_STATUSES,
  canTransition,
  occupiesSlot,
  type AppointmentStatus,
} from "./appointment.model.js";
