/**
 * A tab that exists but has no feature yet.
 *
 * ── WHY THESE SHIP IN M1 AT ALL ─────────────────────────────────────────────
 * The tab bar is derived from permissions, so the derivation cannot be reviewed — or demonstrated
 * to a hospital — unless the destinations exist. They also make the two access rules visible from
 * the first build: a route stays REACHABLE when it is hidden from the bar (a deep link must
 * resolve, not 404), and it still re-checks the permission itself.
 *
 * Each is replaced by a real screen in the milestone named on it.
 */
import { Redirect } from "expo-router";
import { Screen } from "./Screen";
import { EmptyState } from "./StateView";
import { useCapabilities } from "../hooks/useStores";

export function ComingLater({
  title,
  milestone,
  needs,
}: {
  title: string;
  milestone: string;
  needs?: string;
}): React.JSX.Element {
  const { can, ready } = useCapabilities();

  // The re-check that makes deep links safe. A hidden tab reached by URL lands here, not inside a
  // feature — and the server would refuse the data anyway, which is the real boundary.
  if (ready && needs && !can(needs)) return <Redirect href="/" />;

  return (
    <Screen>
      <EmptyState title={title} body={`Arriving in ${milestone}.`} />
    </Screen>
  );
}
