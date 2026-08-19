/**
 * Segmented PIN entry.
 *
 * One bordered box holding a slot per digit, backed by a single hidden
 * TextInput. The slots are display only — all the real input handling belongs
 * to that one field, so there is no per-slot focus juggling and no chance of
 * the caret landing in the middle of a PIN.
 *
 * The input is `opacity: 0` rather than `display: 'none'`, which cannot take
 * focus, and it is stretched over the whole box so a tap anywhere brings up the
 * keypad.
 *
 * Masking is done by the slots rather than by `secureTextEntry`: on Android
 * that flag combined with `number-pad` can swap the keyboard out from under the
 * user and invites the password-autofill bar to appear over a field they cannot
 * see. The input is invisible either way, so nothing leaks.
 *
 * This holds the PIN in React state as a plain string, exactly as the `Field`
 * it replaces did — the security posture is unchanged.
 */
import React, { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, radius, spacing, type } from '../../constants/theme';

/** Digits only, never longer than the box can show. */
export function sanitisePin(value: string, length: number): string {
  return value.replace(/\D/g, '').slice(0, length);
}

export function PinInput({
  value,
  onChangeText,
  label,
  length = 6,
  error,
  hint,
  autoFocus = false,
  onSubmitEditing,
}: {
  value: string;
  /** Receives an already-sanitised value: digits only, at most `length`. */
  onChangeText: (value: string) => void;
  label?: string;
  length?: number;
  error?: string | null;
  hint?: string;
  autoFocus?: boolean;
  onSubmitEditing?: () => void;
}) {
  const input = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);

  const borderColor = error ? colors.danger : focused ? colors.accent : colors.border;

  return (
    <View style={styles.wrap}>
      {label ? <Text style={styles.label}>{label}</Text> : null}

      <Pressable
        accessibilityRole="none"
        onPress={() => input.current?.focus()}
        style={[styles.box, { borderColor }]}
      >
        {/* Decorative: the TextInput below is the control a screen reader
            should find, not six dashes read out one at a time. */}
        <View
          style={styles.slots}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
        >
          {Array.from({ length }, (_, i) => (
            <Text key={i} style={value.length > i ? styles.slotFilled : styles.slotEmpty}>
              {value.length > i ? '●' : '—'}
            </Text>
          ))}
        </View>

        <TextInput
          ref={input}
          value={value}
          onChangeText={(next) => onChangeText(sanitisePin(next, length))}
          keyboardType="number-pad"
          maxLength={length}
          autoFocus={autoFocus}
          onSubmitEditing={onSubmitEditing}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          accessibilityLabel={label ?? `${length}-digit PIN`}
          // An invisible field that can raise a selection magnifier or a paste
          // menu is a confusing way to lose a PIN.
          caretHidden
          contextMenuHidden
          selectTextOnFocus={false}
          autoComplete="off"
          autoCorrect={false}
          textContentType="none"
          importantForAutofill="no"
          style={styles.input}
        />
      </Pressable>

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
  label: { ...type.caption, color: colors.textMuted, marginBottom: spacing.sm },
  box: {
    height: 58,
    borderWidth: 1,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    justifyContent: 'center',
    // Clips nothing — it only anchors the absolutely-positioned input below.
    overflow: 'hidden',
  },
  slots: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-evenly',
    paddingHorizontal: spacing.lg,
  },
  slotEmpty: { ...type.body, color: colors.textFaint, fontSize: 18 },
  slotFilled: { ...type.body, color: colors.text, fontSize: 18 },
  input: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    // Invisible, but present and focusable: the slots above are only a picture
    // of what this field holds.
    opacity: 0,
    // Android measures the caret even when hidden; a matching text size keeps
    // the field's own layout from fighting the box height.
    fontSize: 18,
  },
  hint: { ...type.caption, color: colors.textMuted, marginTop: spacing.sm },
  error: { ...type.caption, color: colors.danger, marginTop: spacing.sm },
});
