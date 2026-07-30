/**
 * Mortuary module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5, Module support.mortuary).
 *
 * Owns the body custody register: receiving a deceased body and releasing it. Depends on
 * `medicolegal` (the death record gates receipt) and `patients` (the deceased's name); nothing reads
 * back, so the module graph stays acyclic.
 */
export { mortuaryRouter } from "./mortuary.routes.js";

export {
  listRegister,
  getEntry,
  getEntryForEncounter,
  receiveBody,
  releaseBody,
  type MortuaryEntry,
  type MortuaryStatus,
} from "./mortuary.service.js";
