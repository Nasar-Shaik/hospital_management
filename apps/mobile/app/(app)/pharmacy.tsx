import { ComingLater } from "../../src/components/ComingLater";

export default function PharmacyTab(): React.JSX.Element {
  return <ComingLater title="Dispense queue" milestone="M5" needs="pharmacy:dispense" />;
}
