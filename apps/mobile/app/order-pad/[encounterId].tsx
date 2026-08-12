/**
 * The order pad (M2 H) — asking for tests, and the hand-off that has no button.
 *
 * ── ORDERING HERE *IS* THE HAND-OFF ─────────────────────────────────────────
 * There is no "send to lab" anywhere in this product, and that absence is the feature (ADR-0013
 * §3). The moment an order is placed it is on the department's worklist. So the confirmation
 * wording says that rather than "saved": what the doctor needs to know is that somebody has the
 * work, not that a row exists.
 *
 * ── MARK, THEN SEND ─────────────────────────────────────────────────────────
 * A consultation ends with "bloods, a chest film and a urine test", not one test at a time. The
 * pad is multi-select with one priority for the batch — and each test still carries its own
 * idempotency key, so the batch shape costs nothing in safety.
 *
 * ── THE RETRY THAT A DISABLED BUTTON CANNOT SAVE YOU FROM ───────────────────
 * A `busy` flag stops the double-tap. It does nothing about the request that reached the server,
 * created the order, and lost its response on the way back — the doctor sees a failure, presses
 * again, and without a key that is a second real needle in a real arm. The keys are minted once
 * per basket (`useIntentKeys`) and reused for every retry of it, so the server replays the
 * original answer instead. They are reset only after a submission lands, because the NEXT basket
 * is a genuinely new intent and must go through.
 *
 * A replay is a SUCCESS. Neither shape of it — the server's byte-identical original response, or
 * the module's own `requestId` guard answering `duplicate: true` — is shown as a duplicate or as
 * an error. See `clinical/prescribing.ts`.
 */
import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import type { CatalogueItem, OrderCategory, OrderPriority } from "@medicore/api-client";
import { Screen } from "../../src/components/Screen";
import { SectionTitle } from "../../src/components/Card";
import { Button } from "../../src/components/Button";
import { Pill } from "../../src/components/Pill";
import { QueryGate } from "../../src/components/QueryGate";
import { OrderRow } from "../../src/components/clinical/Results";
import { requireRuntime } from "../../src/providers/RuntimeProvider";
import { useClinical, useZoneFor } from "../../src/hooks/useClinical";
import {
  useClinicalMutations,
  useClinicalWrite,
  useIntentKeys,
  useWriteGuard,
} from "../../src/hooks/useWrite";
import { useTheme } from "../../src/hooks/useTheme";
import { toUserMessage } from "../../src/lib/net/errors";
import {
  ORDER_PRIORITIES,
  isOrderable,
  orderRequests,
  placementMessage,
  summarisePlacements,
} from "../../src/clinical/prescribing";
import { orderPriorityLabel, orderPriorityTone, sortForReview } from "../../src/clinical/results";
import { radius, size, space, typography } from "../../src/theme/tokens";

const GROUPS: { label: string; category: OrderCategory }[] = [
  { label: "Blood & lab", category: "lab" },
  { label: "X-ray & imaging", category: "radiology" },
  { label: "Procedures", category: "procedure" },
];

function OrderPad(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const { encounterId } = useLocalSearchParams<{ encounterId: string }>();
  const { queries, ready } = useClinical();
  const zoneFor = useZoneFor();
  const mutations = useClinicalMutations();
  const guard = useWriteGuard("order:create");
  const keys = useIntentKeys();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [priority, setPriority] = useState<OrderPriority>("routine");
  const [notice, setNotice] = useState<string | undefined>(undefined);

  const catalogue = useQuery({ ...queries.catalogue(), enabled: ready });
  const encounter = useQuery({ ...queries.encounter(encounterId), enabled: ready });
  const existing = useQuery({
    ...queries.patientOrders(encounter.data?.patientId ?? ""),
    enabled: ready && Boolean(encounter.data?.patientId),
  });

  const place = useClinicalWrite(mutations.placeOrders(), {
    onSuccess: (results) => {
      setNotice(placementMessage(summarisePlacements(results)));
      setSelected(new Set());
      // The basket landed, so the next one is a new intent. Keeping the keys would make the very
      // next order a replay of this one and quietly never place it.
      keys.reset();
    },
  });

  const orderable = (catalogue.data ?? []).filter((item) => isOrderable(item.category));
  const chosen: CatalogueItem[] = orderable.filter((item) => selected.has(item.code));

  const submit = (): void => {
    if (chosen.length === 0) return;
    setNotice(undefined);
    place.mutate(
      orderRequests(
        encounterId,
        chosen.map((item) => ({
          code: item.code,
          name: item.name,
          category: item.category as OrderCategory,
        })),
        priority,
        (code) => keys.keyFor(code),
      ),
    );
  };

  const toggle = (code: string): void => {
    setNotice(undefined);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  const outstandingFirst = sortForReview(existing.data?.items ?? []).slice(0, 5);

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={styles.body}>
        {notice ? (
          <View
            accessibilityRole="alert"
            style={[styles.notice, { backgroundColor: theme.colors.successBg }]}
          >
            <Text style={[typography.body, { color: theme.colors.success }]}>{notice}</Text>
          </View>
        ) : null}

        {place.error !== null && place.error !== undefined ? (
          <View
            accessibilityRole="alert"
            style={[styles.notice, { backgroundColor: theme.colors.dangerBg }]}
          >
            <Text style={[typography.label, { color: theme.colors.danger }]}>
              {toUserMessage(place.error).title}
            </Text>
            <Text style={[typography.caption, { color: theme.colors.danger }]}>
              {toUserMessage(place.error).body} Your selection is still here — pressing Order again
              is safe, and will not order anything twice.
            </Text>
          </View>
        ) : null}

        <SectionTitle title="Priority" />
        <View style={styles.chips}>
          {ORDER_PRIORITIES.map((option) => (
            <Chip
              key={option}
              label={orderPriorityLabel(option)}
              selected={priority === option}
              onPress={() => setPriority(option)}
            />
          ))}
        </View>
        {priority === "stat" || priority === "emergency" ? (
          <Pill
            label="Goes to the top of the department's list"
            tone={orderPriorityTone(priority)}
          />
        ) : null}

        <QueryGate
          loading={catalogue.isPending && ready}
          error={catalogue.error}
          empty={orderable.length === 0}
          emptyTitle="Nothing to order"
          emptyBody="This branch's service catalogue has no tests configured."
          loadingLabel="Loading the catalogue…"
          onRetry={() => void catalogue.refetch()}
        >
          {GROUPS.map((group) => {
            const items = orderable.filter((item) => item.category === group.category);
            if (items.length === 0) return null;
            return (
              <View key={group.category} style={styles.group}>
                <SectionTitle title={group.label} />
                <View style={styles.chips}>
                  {items.map((item) => (
                    <Chip
                      key={item.code}
                      label={item.name}
                      selected={selected.has(item.code)}
                      onPress={() => toggle(item.code)}
                    />
                  ))}
                </View>
              </View>
            );
          })}
        </QueryGate>

        {outstandingFirst.length > 0 ? (
          <View style={styles.group}>
            <SectionTitle title="Already on this patient" />
            {outstandingFirst.map((order) => (
              <OrderRow
                key={order.id}
                order={order}
                zone={zoneFor(order.branchId)}
                onPress={() => router.push({ pathname: "/order/[id]", params: { id: order.id } })}
              />
            ))}
          </View>
        ) : null}
      </ScrollView>

      <View
        style={[
          styles.bar,
          { borderTopColor: theme.colors.border, backgroundColor: theme.colors.bgElevated },
        ]}
      >
        <Button
          label={
            place.isPending
              ? "Ordering…"
              : chosen.length === 0
                ? "Select tests to order"
                : `Order ${String(chosen.length)} test${chosen.length === 1 ? "" : "s"}`
          }
          loading={place.isPending}
          disabled={!guard.canWrite || chosen.length === 0 || place.isPending}
          reason={guard.reason}
          onPress={submit}
        />
      </View>
    </Screen>
  );
}

function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Text
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[
        styles.chip,
        {
          color: selected ? theme.colors.onAccent : theme.colors.fg,
          backgroundColor: selected ? theme.colors.brandStrong : theme.colors.bgSubtle,
          borderColor: selected ? theme.colors.brandStrong : theme.colors.border,
        },
      ]}
    >
      {selected ? "✓ " : ""}
      {label}
    </Text>
  );
}

export default requireRuntime(OrderPad);

const styles = StyleSheet.create({
  body: { gap: space[3], padding: space[4], paddingBottom: space[8] },
  notice: { borderRadius: radius.lg, padding: space[3], gap: space[1] },
  group: { gap: space[2] },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space[2] },
  chip: {
    ...typography.label,
    borderWidth: 1,
    borderRadius: radius.md,
    minHeight: size.touchTarget - 12,
    paddingHorizontal: space[3],
    paddingVertical: space[2],
    overflow: "hidden",
  },
  bar: { borderTopWidth: 1, padding: space[4] },
});
