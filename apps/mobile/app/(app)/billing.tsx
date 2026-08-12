import { ComingLater } from "../../src/components/ComingLater.js";

export default function BillingTab(): React.JSX.Element {
  return <ComingLater title="Billing" milestone="M5" needs="billing:read" />;
}
