/**
 * Saving observations when the network is not certain (M3-S4).
 *
 * ── THE IMPLEMENTATION NOW LIVES IN `@medicore/api-client` ──────────────────
 * It was written here for S4 and moved to the client package when the WEB vitals form needed the
 * same envelope (D-2). Which HTTP failures mean "nothing was written", and how to recognise our
 * own reading in a reloaded chart, are statements about the API's behaviour rather than about this
 * app — and a nurse on a phone and a nurse at a station should not meet two different behaviours
 * when the wifi drops in the same corridor. The same reasoning moved the MAR classifier in W3.
 *
 * Re-exported under the names this app has always used, so every call site and every S4 test reads
 * unchanged — and those tests, still passing against the shared implementation, are what prove the
 * move changed no behaviour.
 *
 * The reasoning that made this design what it is — two layers, and "when in doubt, say it did not
 * save" — travelled with the code; read it there.
 */
export {
  attemptVitals,
  reconcileVitals,
  newReadingsSince,
  matchingReading,
  type VitalsOutcome,
  type VitalsWriteDeps,
} from "@medicore/api-client";
