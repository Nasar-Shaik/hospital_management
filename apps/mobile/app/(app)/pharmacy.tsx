import { ComingLater } from "../../src/components/ComingLater.js";

export default function PharmacyTab(): React.JSX.Element {
  return <ComingLater title="Dispense queue" milestone="M5" needs="pharmacy:dispense" />;
}
