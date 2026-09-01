/**
 * Alerts (M4 A) — the messages addressed to this person.
 *
 * ── WHAT THIS TAB WAS WAITING FOR ───────────────────────────────────────────
 * It shipped in M1 as a `ComingLater` placeholder naming its own blocker: the backend had
 * `GET /notifications`, which returns the whole hospital's PHI behind `notification:manage`, and
 * nothing a clinician could call. `GET /notifications/me` is that route — self-scoped,
 * authenticated, deliberately unpermissioned — which is why this screen has no `needs` and no
 * permission redirect. Everyone has an inbox.
 *
 * ── NOT BRANCH-SCOPED, UNLIKE EVERY OTHER LIST IN THIS APP ──────────────────
 * `queries.notifications()` is keyed on the tenant alone. A message is addressed to a PERSON, so
 * a doctor who switches the branch picker must not watch their unread count fall to zero — which
 * looks exactly like "nothing needs you". The branch is shown on the row instead, when the message
 * carries one. See `AI_Workflow/docs/COMMUNICATION_POLICY.md`.
 *
 * ── CRITICAL FIRST, THEN NEWEST ─────────────────────────────────────────────
 * The same rule as the results list (`clinical/results.ts` `sortForReview`): a critical potassium
 * from this morning must not be buried under four routine results that came back since. The band
 * is not a filter the user has to discover.
 */
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Screen } from "../../src/components/Screen";
import { Button } from "../../src/components/Button";
import { QueryGate } from "../../src/components/QueryGate";
import { CriticalFlag, Pill } from "../../src/components/Pill";
import { useClinical, useZoneFor } from "../../src/hooks/useClinical";
import { useRuntime } from "../../src/providers/RuntimeProvider";
import { useTheme } from "../../src/hooks/useTheme";
import { isUnread, sortAlerts, toneFor } from "../../src/clinical/alerts";
import { destinationFor } from "../../src/lib/push";
import { formatDateTime } from "../../src/lib/time";
import { radius, space, typography } from "../../src/theme/tokens";

export default function Alerts(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const runtime = useRuntime();
  const client = useQueryClient();
  const { queries } = useClinical();
  /**
   * A resolver, not a zone. This list ALWAYS spans sites — an inbox is addressed to a person, not
   * a branch — so a single zone for the screen would misdate every message from the other one.
   * `zoneFor(message.branchId)` is the same pattern the results tab uses in All-branches mode.
   */
  const zoneFor = useZoneFor();

  /**
   * The descriptor is held rather than inlined so the invalidation below can reuse its key. A
   * hand-built `[tenantSlug, "notifications"]` would be the one place in the app where a key was
   * not minted by `keys.ts` — which is exactly how the branch prefix comes to be forgotten on one
   * screen, and `routes.test.ts` refuses it.
   */
  const inbox = queries.notifications();
  const list = useInfiniteQuery(inbox);

  /**
   * Marking one read does NOT go through `useWrite`.
   *
   * That layer exists for CLINICAL writes: an idempotency key held across retries, an offline
   * guard, a licence block, and reconciliation when a response is lost. None of it applies here.
   * The server is already idempotent by its own query (it only updates a row with no `readAt`, so
   * a replay returns the original time), a read receipt is not worth blocking on connectivity, and
   * refusing it under an expiring licence would hide alerts from a hospital that is still open.
   */
  const open = useMutation({
    mutationFn: (id: string) => runtime.api.markNotificationRead(id),
    onSettled: () => client.invalidateQueries({ queryKey: inbox.queryKey }),
  });

  const messages = sortAlerts(list.data?.pages.flatMap((page) => page.items) ?? []);
  const unread = messages.filter(isUnread).length;

  return (
    <Screen padded={false}>
      <View style={styles.header}>
        <Text style={[styles.heading, { color: theme.colors.fg }]}>Alerts</Text>
        {unread > 0 ? <Pill label={`${String(unread)} unread`} tone="warning" /> : null}
      </View>

      <QueryGate
        loading={list.isPending}
        error={list.error}
        empty={messages.length === 0}
        emptyTitle="Nothing for you"
        emptyBody="Results you ordered, and anything needing your attention, arrive here."
        loadingLabel="Loading alerts…"
        onRetry={() => void list.refetch()}
      >
        <FlatList
          data={messages}
          keyExtractor={(message) => message.id}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={list.isRefetching && !list.isFetchingNextPage}
              onRefresh={() => void list.refetch()}
              tintColor={theme.colors.brand}
            />
          }
          renderItem={({ item }) => {
            const critical = toneFor(item.templateKey) === "critical";
            return (
              <Pressable
                /**
                 * ── OPENING AN ALERT MEANS OPENING WHAT IT IS ABOUT (M4) ──────
                 * A tap used to do one thing: mark the row read. For the message this list exists
                 * for — a critical potassium — that left the doctor holding a sentence and a
                 * search: back out, find the Results tab, find the patient, find the test. The
                 * destination travels ON the message (`resourceType`/`resourceId`), so it is the
                 * same landing a push notification makes, and neither can drift from the other.
                 *
                 * `destinationFor` returns `/alerts` for anything this build cannot open, so a
                 * message from a newer server is a row that stays put rather than a dead end.
                 */
                onPress={() => {
                  if (isUnread(item)) open.mutate(item.id);
                  const to = destinationFor(item);
                  if (to !== "/alerts") router.push(to as never);
                }}
                accessibilityRole="button"
                accessibilityLabel={`${critical ? "Critical alert. " : ""}${item.subject ?? item.templateKey}`}
                style={[
                  styles.row,
                  {
                    backgroundColor: theme.colors.bgElevated,
                    borderColor: critical ? theme.colors.criticalClinical : theme.colors.border,
                  },
                ]}
              >
                <View style={styles.rowHead}>
                  {critical ? <CriticalFlag /> : null}
                  {isUnread(item) ? <Pill label="Unread" tone="warning" /> : null}
                  <Text style={[styles.when, { color: theme.colors.fgMuted }]}>
                    {formatDateTime(new Date(item.createdAt), zoneFor(item.branchId))}
                  </Text>
                </View>

                <Text style={[styles.subject, { color: theme.colors.fg }]}>
                  {item.subject ?? item.templateKey}
                </Text>
                <Text style={[styles.body, { color: theme.colors.fgMuted }]}>{item.body}</Text>
              </Pressable>
            );
          }}
          ListFooterComponent={
            list.hasNextPage ? (
              <View style={styles.footer}>
                <Button
                  label={list.isFetchingNextPage ? "Loading…" : "Load more"}
                  variant="secondary"
                  onPress={() => void list.fetchNextPage()}
                  disabled={list.isFetchingNextPage}
                />
              </View>
            ) : null
          }
        />
      </QueryGate>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[2],
    paddingHorizontal: space[4],
    paddingVertical: space[3],
  },
  heading: { ...typography.title },
  list: { gap: space[3], padding: space[4] },
  row: { borderRadius: radius.lg, borderWidth: 1, gap: space[2], padding: space[4] },
  rowHead: { alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: space[2] },
  when: { ...typography.caption, marginLeft: "auto" },
  subject: { ...typography.label },
  body: { ...typography.body },
  footer: { paddingVertical: space[4] },
});
