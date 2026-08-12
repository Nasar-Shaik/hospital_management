/**
 * An unmatched route.
 *
 * Reached mainly by a deep link the build does not know — an alert for a screen that shipped in a
 * later version, opened on a phone that has not updated. It says so, rather than showing a blank
 * page, and gets the user back to somewhere real.
 */
import { Stack, useRouter } from "expo-router";
import { Screen } from "../src/components/Screen.js";
import { ErrorState } from "../src/components/StateView.js";

export default function NotFound(): React.JSX.Element {
  const router = useRouter();
  return (
    <>
      <Stack.Screen options={{ title: "Not found" }} />
      <Screen>
        <ErrorState
          error={{
            title: "This link does not open here",
            body: "The screen may have moved, or this app may need an update.",
            severity: "notice",
            action: "reload",
          }}
          onAction={() => router.replace("/")}
        />
      </Screen>
    </>
  );
}
