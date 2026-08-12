import { ComingLater } from "../../src/components/ComingLater";

export default function QueueTab(): React.JSX.Element {
  return <ComingLater title="Today's queue" milestone="M2" needs="encounter:read" />;
}
