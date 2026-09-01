/**
 * The branch switcher (ADR-0015, M0 §7).
 *
 * ── THE LIST IS FETCHED, NOT REMEMBERED ─────────────────────────────────────
 * It reads `/me/branches` through TanStack Query every time it opens. Rendering the remembered
 * list would show a site the user was removed from this morning, and let them select it — the
 * server would refuse the eventual write, but only after they had done the work.
 *
 * ── THE APP VALIDATES NOTHING ───────────────────────────────────────────────
 * There is no membership check here and there must never be one. `authorize` validates
 * `X-Active-Branch` against the caller's live scope on every request; a second check in the client
 * would be a copy of that rule that drifts the first time either changes.
 */
import { StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { Screen } from "../../src/components/Screen";
import { Button } from "../../src/components/Button";
import { ErrorState, LoadingState } from "../../src/components/StateView";
import { useRuntime } from "../../src/providers/RuntimeProvider";
import { useBranch, useSession } from "../../src/hooks/useStores";
import { useTheme } from "../../src/hooks/useTheme";
import { queryKeys } from "../../src/query/keys";
import { toUserMessage } from "../../src/lib/net/errors";
import { displayZone } from "../../src/lib/time";
import { space, typography } from "../../src/theme/tokens";

export default function BranchScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const runtime = useRuntime();
  const userId = useSession((s) => s.user?.id);
  const activeBranchId = useBranch((s) => s.activeBranchId);

  const branches = useQuery({
    queryKey: queryKeys.myBranches(runtime.profile.slug),
    queryFn: () => runtime.branches.load(),
    staleTime: 0,
  });

  if (branches.isPending)
    return (
      <Screen>
        <LoadingState label="Loading your sites…" />
      </Screen>
    );

  if (branches.isError) {
    return (
      <Screen>
        <ErrorState
          error={toUserMessage(branches.error)}
          onAction={() => void branches.refetch()}
        />
      </Screen>
    );
  }

  const select = async (branchId: string | undefined): Promise<void> => {
    if (!userId) return;
    await runtime.branches.select(userId, branchId);
    router.back();
  };

  return (
    <Screen>
      <Text style={[styles.heading, { color: theme.colors.fgMuted }]}>
        Which site are you working at?
      </Text>

      {branches.data.branches.map((branch) => {
        const current = branch.id === activeBranchId;
        return (
          <View key={branch.id} style={styles.row}>
            <Button
              label={current ? `${branch.name} · current` : branch.name}
              variant={current ? "primary" : "secondary"}
              onPress={() => void select(branch.id)}
            />
            <Text style={[styles.meta, { color: theme.colors.fgSubtle }]}>
              {branch.code} · {displayZone(branch.timezone)}
            </Text>
          </View>
        );
      })}

      {/**
       * Offered only when the SERVER says so. Aggregate mode reads across sites and cannot write —
       * a write resolves to one branch or is refused with HMS-BRANCH-001, which the write guard
       * explains before the user fills in a form rather than after.
       */}
      {branches.data.canAggregate ? (
        <View style={styles.row}>
          <Button
            label={activeBranchId === undefined ? "All branches · current" : "All branches"}
            variant={activeBranchId === undefined ? "primary" : "secondary"}
            onPress={() => void select(undefined)}
          />
          <Text style={[styles.meta, { color: theme.colors.fgSubtle }]}>
            Reading only — saving asks you to pick a site.
          </Text>
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  heading: { ...typography.label },
  row: { gap: space[1] },
  meta: { ...typography.caption, paddingHorizontal: space[1] },
});
