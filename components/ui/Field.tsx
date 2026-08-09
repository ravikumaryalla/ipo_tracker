/**
 * Text input.
 *
 * All TextInput props pass straight through, which is load-bearing: several
 * screens rely on `secureTextEntry` reaching the native input. The focus ring
 * is drawn by an overlay sibling rather than by animating borderColor, because
 * animating a border width/colour causes a layout pass on every frame.
 */
import React, { useState } from 'react';
import { StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { colors, motion, radius, spacing, type } from '../../constants/theme';

export function Field({
  label,
  hint,
  error,
  ...inputProps
}: { label: string; hint?: string; error?: string | null } & TextInputProps) {
  const focus = useSharedValue(0);
  const reduceMotion = useReducedMotion();
  const [focused, setFocused] = useState(false);

  const ringStyle = useAnimatedStyle(() => ({
    opacity: focus.value,
    transform: [{ scale: reduceMotion ? 1 : 0.99 + focus.value * 0.01 }],
  }));

  return (
    <View style={styles.wrap}>
      <Text style={[styles.label, focused && { color: colors.accentBright }]}>
        {label.toUpperCase()}
      </Text>

      <View>
        <Animated.View style={[styles.ring, error ? styles.ringError : null, ringStyle]} />
        <TextInput
          placeholderTextColor={colors.textFaint}
          selectionColor={colors.accent}
          {...inputProps}
          style={[styles.input, error ? styles.inputError : null, inputProps.style]}
          onFocus={(e) => {
            setFocused(true);
            focus.value = withTiming(1, { duration: motion.fast });
            inputProps.onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            focus.value = withTiming(0, { duration: motion.fast });
            inputProps.onBlur?.(e);
          }}
        />
      </View>

      {error ? (
        <Text style={styles.error}>{error}</Text>
      ) : hint ? (
        <Text style={styles.hint}>{hint}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: spacing.lg },
  label: {
    ...type.label,
    color: colors.textMuted,
    marginBottom: spacing.sm,
  },
  input: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg - 2,
    ...type.body,
  },
  inputError: { borderColor: colors.danger },
  /**
   * Sits behind the input and slightly outside it, so the glow reads as light
   * spilling past the edge rather than as a thicker border.
   */
  ring: {
    position: 'absolute',
    top: -3,
    left: -3,
    right: -3,
    bottom: -3,
    borderRadius: radius.xl,
    borderWidth: 2,
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
  },
  ringError: { borderColor: colors.danger, backgroundColor: colors.dangerSoft },
  hint: { ...type.caption, color: colors.textFaint, marginTop: spacing.sm },
  error: { ...type.caption, color: colors.danger, marginTop: spacing.sm },
});
