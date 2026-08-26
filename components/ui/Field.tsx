/**
 * Text input.
 *
 * All TextInput props pass straight through, which is load-bearing: several
 * screens rely on `secureTextEntry` reaching the native input.
 *
 * The label floats — it sits inside the field at rest and rises to straddle the
 * top border once the field is focused or filled, the way the design system
 * draws it. It is `pointerEvents="none"` so taps fall through to the input
 * underneath, and it is driven by React state rather than reanimated because it
 * only moves on focus and blur, which are already JS-thread events.
 *
 * Focus is marked by border *colour* only. Animating border width would force a
 * layout pass per frame; colour alone does not.
 */
import React, { useState } from 'react';
import { StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';

import { colors, radius, spacing, type } from '../../constants/theme';

export function Field({
  label,
  hint,
  error,
  ...inputProps
}: { label: string; hint?: string; error?: string | null } & TextInputProps) {
  const [focused, setFocused] = useState(false);

  const hasValue = inputProps.value != null && inputProps.value !== '';
  // A field showing a placeholder has no room for a resting label, so the
  // label floats from the start in that case too.
  const floating = focused || hasValue || !!inputProps.placeholder;

  const borderColor = error ? colors.danger : focused ? colors.accent : colors.border;
  const labelColor = error ? colors.danger : focused ? colors.accent : colors.textMuted;

  return (
    <View style={styles.wrap}>
      <View>
        <TextInput
          placeholderTextColor={colors.textFaint}
          selectionColor={colors.accent}
          {...inputProps}
          style={[styles.input, { borderColor }, inputProps.style]}
          onFocus={(e) => {
            setFocused(true);
            inputProps.onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            inputProps.onBlur?.(e);
          }}
        />

        <View
          style={[
            styles.labelWrap,
            floating ? styles.labelWrapFloating : styles.labelWrapResting,
          ]}
          pointerEvents="none"
        >
          <Text style={[styles.label, floating && styles.labelFloating, { color: labelColor }]}>
            {label}
          </Text>
        </View>
      </View>

      {error ? (
        <Text style={styles.error}>{error}</Text>
      ) : hint ? (
        <Text style={styles.hint}>{hint}</Text>
      ) : null}
    </View>
  );
}

/** Shared by the input's padding and the label's resting position. */
const PADDING_TOP = spacing.lg + 2;
/** Horizontal breathing room around the label where it masks the border. */
const LABEL_INSET = 4;

const styles = StyleSheet.create({
  wrap: { marginBottom: spacing.lg },
  input: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    color: colors.text,
    paddingHorizontal: spacing.md,
    // Asymmetric on purpose: the extra top padding is the room the label needs
    // to sit at rest without colliding with the border it later floats onto.
    paddingTop: PADDING_TOP,
    paddingBottom: spacing.md,
    ...type.body,
  },
  labelWrap: {
    position: 'absolute',
    // Offset by the inner padding so the label's *text* lands on the input's
    // text origin, not 4px right of it — otherwise it shifts sideways as it
    // floats.
    left: spacing.md - LABEL_INSET,
    // The label's own background masks the border it straddles, so the gap it
    // sits in does not need to be cut out of the border itself.
    backgroundColor: colors.surface,
    paddingHorizontal: LABEL_INSET,
  },
  // At rest the label sits exactly where the input's own text will render, so
  // it reads as a placeholder and only moves vertically when it floats.
  labelWrapResting: { top: PADDING_TOP },
  labelWrapFloating: { top: -7 },
  label: { ...type.body },
  labelFloating: { ...type.caption, fontSize: 11.5 },
  hint: { ...type.caption, color: colors.textMuted, marginTop: spacing.sm },
  error: { ...type.caption, color: colors.danger, marginTop: spacing.sm },
});
