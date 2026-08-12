import { ComingLater } from "../../src/components/ComingLater.js";

export default function PatientsTab(): React.JSX.Element {
  return <ComingLater title="Patients" milestone="M2" needs="patient:read" />;
}
