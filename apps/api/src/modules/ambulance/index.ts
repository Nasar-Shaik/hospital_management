/**
 * Ambulance module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5, Module B6).
 *
 * Owns the ambulance fleet and the trips dispatched on it. It reads the patient module
 * (`namesByIds`) to name a trip on the board when one is linked; nothing reads back into it, so the
 * graph stays acyclic.
 */
export { ambulanceRouter } from "./ambulance.routes.js";

export {
  listAmbulances,
  getAmbulance,
  createAmbulance,
  updateAmbulance,
  listTrips,
  createTrip,
  transitionTrip,
  type Ambulance,
  type AmbulanceTrip,
  type AmbulanceTripView,
} from "./ambulance.service.js";

export {
  AMBULANCE_KINDS,
  AMBULANCE_STATUSES,
  AMBULANCE_TRIP_STATUSES,
  AMBULANCE_TRIP_PURPOSES,
  type AmbulanceKind,
  type AmbulanceStatus,
  type AmbulanceTripStatus,
  type AmbulanceTripPurpose,
} from "./ambulance.model.js";
