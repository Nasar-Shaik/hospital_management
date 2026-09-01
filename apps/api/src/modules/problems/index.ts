/**
 * Problems module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5).
 *
 * Owns the patient's longitudinal problem list: what is true of them today, across every visit.
 * Depends on `patients` (a problem belongs to someone), `consultations` (the only source of a
 * promotion, and the thing that proves the visit is in scope) and `mrd` (the ICD master). Nothing
 * depends on this, so the graph stays acyclic.
 *
 * It does NOT change what a consultation diagnosis or an encounter coding means — see
 * `problem.model.ts` for the three-way distinction this rests on.
 */
export { problemRouter } from "./problem.routes.js";

export {
  addProblem,
  promoteDiagnosis,
  listProblems,
  activeProblems,
  resolveProblem,
  type Problem,
  type AddProblemInput,
  type PromoteInput,
} from "./problem.service.js";

export { PROBLEM_STATUSES, type ProblemStatus } from "./problem.model.js";

/** Re-points problems onto the survivor on merge. Registered by eventConsumer.ts. */
export { problemConsumers } from "./problem.consumers.js";
