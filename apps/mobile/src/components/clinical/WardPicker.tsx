/**
 * Choosing which ward you are working (M3-S5B).
 *
 * ── ONE PICKER, BECAUSE THERE IS ONE WAY OUT OF A WARD ──────────────────────
 * The worklist and the medication round both filter by ward, and the round is reached FROM the
 * worklist carrying its choice. Two copies of the chips would be two chances to reintroduce the
 * defect this component was extracted to fix: the option list is derived from rows that are
 * themselves filtered by the selection, so it collapses to a single entry as soon as a ward is
 * chosen — and a bar with one chip reads as decoration, gets hidden, and strands the nurse on one
 * ward with no way back to "All wards". `wardOptions` unions the selection back in; this renders
 * the bar whenever there is a choice to make OR a selection to escape from.
 *
 * Selection is carried by the BORDER, the label colour and `accessibilityState` — never by fill
 * alone, which is invisible to a screen reader and to anyone reading the ward in sunlight.
 */
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../../hooks/useTheme";
import { radius, size, space, typography } from "../../theme/tokens";

/** No ward chosen — the whole branch, which is what a small hospital wants anyway. */
export const EVERY_WARD = "__every__";

export function WardPicker({
  wards,
  selected,
  onSelect,
}: {
  /** From `wardOptions(rows, selected)`, so the current choice is always among them. */
  wards: readonly string[];
  /** `EVERY_WARD` for no filter. */
  selected: string;
  onSelect: (ward: string) => void;
}): React.JSX.Element | null {
  // Nothing to choose and nothing to escape from: one ward, already showing all of it.
  if (wards.length <= 1 && selected === EVERY_WARD) return null;

  return (
    <View style={styles.filters}>
      <WardChip
        label="All wards"
        selected={selected === EVERY_WARD}
        onPress={() => onSelect(EVERY_WARD)}
      />
      {wards.map((name) => (
        <WardChip
          key={name}
          label={name}
          selected={selected === name}
          onPress={() => onSelect(name)}
        />
      ))}
    </View>
  );
}

function WardChip({
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
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`Show ${label}`}
      style={[
        styles.chip,
        {
          backgroundColor: theme.colors.bgElevated,
          borderColor: selected ? theme.colors.brandStrong : theme.colors.border,
          borderWidth: selected ? 2 : 1,
        },
      ]}
    >
      <Text
        style={[
          typography.caption,
          { color: selected ? theme.colors.brandStrong : theme.colors.fgSubtle },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  filters: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space[1],
    paddingHorizontal: space[4],
    paddingTop: space[2],
  },
  chip: {
    borderRadius: radius.full,
    borderWidth: 1,
    minHeight: size.touchTarget,
    justifyContent: "center",
    paddingHorizontal: space[4],
  },
});
