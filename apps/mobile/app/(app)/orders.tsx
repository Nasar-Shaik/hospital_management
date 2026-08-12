import { ComingLater } from "../../src/components/ComingLater.js";

export default function OrdersTab(): React.JSX.Element {
  return <ComingLater title="Orders" milestone="M2" needs="order:read" />;
}
