/**
 * Buttons.
 *
 * Solid accent fill for the primary action, tonal fills for the rest. Press
 * feedback is a scale-down driven on the UI thread by reanimated, so it stays
 * responsive even when the JS thread is busy fetching — which on this app is
 * exactly when people are tapping.
 *
 * Two size vocabularies coexist. `md`/`sm` is the original API that call sites
 * use; `small`/`medium`/`large` is the design system's. They map onto the same
 * three rows, so either spelling works.
 */
import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { colors, motion, radius, spacing, type } from '../../constants/theme';
import { Icon, type IconName } from './Icon';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/** `md`/`sm` are the legacy spelling; both resolve to the same three rows. */
type Size = 'small' | 'medium' | 'large' | 'md' | 'sm';

const SIZES = {
  small: { paddingVertical: spacing.sm, paddingHorizontal: spacing.md, fontSize: 13, icon: 15 },
  medium: { paddingVertical: spacing.md, paddingHorizontal: spacing.lg, fontSize: 14, icon: 18 },
  large: { paddingVertical: spacing.md + 2, paddingHorizontal: spacing.xl, fontSize: 16, icon: 20 },
} as const;

const SIZE_ALIAS: Record<Size, keyof typeof SIZES> = {
  sm: 'small',
  small: 'small',
  md: 'medium',
  medium: 'medium',
  large: 'large',
};

export function Button({
  title,
  onPress,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  icon,
}: {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  /** `sm` is for buttons packed into a card; its container owns the spacing. */
  size?: Size;
  loading?: boolean;
  disabled?: boolean;
  icon?: IconName;
}) {
  const isDisabled = disabled || loading;
  const pressed = useSharedValue(0);
  const reduceMotion = useReducedMotion();
  const dims = SIZES[SIZE_ALIAS[size]];

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: reduceMotion ? 1 : 1 - pressed.value * 0.03 }],
    opacity: 1 - pressed.value * 0.15,
  }));

  const fg = isDisabled
    ? colors.textFaint
    : variant === 'primary'
      ? colors.onAccent
      : variant === 'danger'
        ? colors.danger
        : variant === 'ghost'
          ? colors.accent
          : colors.text;

  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      onPress={onPress}
      disabled={isDisabled}
      onPressIn={() => {
        pressed.value = withTiming(1, { duration: motion.fast });
      }}
      onPressOut={() => {
        pressed.value = withTiming(0, { duration: motion.fast });
      }}
      style={[
        styles.button,
        { paddingVertical: dims.paddingVertical, paddingHorizontal: dims.paddingHorizontal },
        size === 'sm' || size === 'small' ? styles.small : null,
        variant === 'primary' && styles.primary,
        variant === 'secondary' && styles.secondary,
        variant === 'danger' && styles.danger,
        variant === 'ghost' && styles.ghost,
        isDisabled && styles.disabled,
        animatedStyle,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <View style={styles.inner}>
          {icon ? <Icon name={icon} size={dims.icon} color={fg} /> : null}
          <Text style={[styles.label, { fontSize: dims.fontSize, color: fg }]}>{title}</Text>
        </View>
      )}
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  button: {
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  small: { marginBottom: 0 },
  primary: { backgroundColor: colors.accent },
  /** Outlined: the design system's secondary action. */
  secondary: { backgroundColor: colors.surface, borderColor: colors.border },
  danger: { backgroundColor: colors.surface, borderColor: colors.danger },
  ghost: { backgroundColor: 'transparent' },
  disabled: { backgroundColor: colors.border, borderColor: 'transparent' },
  inner: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  label: { ...type.bodyStrong },
});
