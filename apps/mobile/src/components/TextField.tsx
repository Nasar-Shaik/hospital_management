import { StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";
import { useTheme } from "../hooks/useTheme.js";
import { radius, size, space, typography } from "../theme/tokens.js";

/**
 * A labelled input that renders the API's field errors directly.
 *
 * `errors` is `string[]` because that is the shape `details.fields` arrives in from a
 * `HMS-VAL-001` response — mapped onto the form by name with no translation step, which is what
 * the API's error contract was designed for.
 */
export function TextField({
  label,
  errors,
  hint,
  ...input
}: TextInputProps & { label: string; errors?: string[]; hint?: string }): React.JSX.Element {
  const theme = useTheme();
  const invalid = (errors?.length ?? 0) > 0;

  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: theme.colors.fgMuted }]}>{label}</Text>
      <TextInput
        {...input}
        accessibilityLabel={label}
        accessibilityHint={hint}
        placeholderTextColor={theme.colors.fgSubtle}
        style={[
          styles.input,
          {
            color: theme.colors.fg,
            backgroundColor: theme.colors.bgSubtle,
            borderColor: invalid ? theme.colors.danger : theme.colors.border,
          },
        ]}
      />
      {invalid ? (
        <Text style={[styles.error, { color: theme.colors.danger }]}>{errors?.join(". ")}</Text>
      ) : hint ? (
        <Text style={[styles.hint, { color: theme.colors.fgSubtle }]}>{hint}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: space[1] },
  label: { ...typography.label },
  input: {
    minHeight: size.touchTarget,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: space[3],
    ...typography.body,
  },
  error: { ...typography.caption },
  hint: { ...typography.caption },
});
