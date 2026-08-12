import { ComingLater } from "../../src/components/ComingLater.js";

/**
 * No `needs`: every signed-in person has an inbox. It arrives in M4 together with the backend's
 * `GET /notifications/me`, which does not exist yet (backend item A) — the reason this tab cannot
 * simply call the existing `GET /notifications`, which returns the whole hospital's PHI.
 */
export default function AlertsTab(): React.JSX.Element {
  return <ComingLater title="Alerts" milestone="M4" />;
}
