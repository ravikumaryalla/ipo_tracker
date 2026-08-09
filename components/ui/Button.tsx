/**
 * Buttons.
 *
 * The primary variant is a gradient with a glow beneath it; the rest are flat
 * tonal fills. Press feedback is a scale-down driven on the UI thread by
 * reanimated, so it stays responsive even when the JS thread is busy fetching —
 * which on this app is exactly when people are tapping.
 */
import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { colors, glow, gradients, motion, radius, spacing, type } from '../../constants/theme';
import { Icon, type IconName } from './Icon';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export function Button({
  title,
  onPress,
  variant = 'primary',
  loading = false,
  disabled = false,
  icon,
}: {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  loading?: boolean;
  disabled?: boolean;
  icon?: IconName;
}) {
  const isDisabled = disabled || loading;
  const pressed = useSharedValue(0);
  const reduceMotion = useReducedMotion();

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: reduceMotion ? 1 : 1 - pressed.value * 0.03 }],
    opacity: 1 - pressed.value * 0.15,
  }));

  const fg =
    variant === 'primary'
      ? '#FFFFFF'
      : variant === 'danger'
        ? colors.danger
        : variant === 'ghost'
          ? colors.accentBright
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
        variant === 'secondary' && styles.secondary,
        variant === 'danger' && styles.danger,
        variant === 'ghost' && styles.ghost,
        variant === 'primary' && !isDisabled && glow.accent,
        isDisabled && styles.disabled,
        animatedStyle,
      ]}
    >
      {variant === 'primary' && (
        <LinearGradient
          colors={gradients.primary}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
      )}
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <View style={styles.inner}>
          {icon ? <Icon name={icon} size={18} color={fg} /> : null}
          <Text style={[styles.label, { color: fg }]}>{title}</Text>
        </View>
      )}
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  button: {
    borderRadius: radius.lg,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
    overflow: 'hidden',
  },
  secondary: { backgroundColor: colors.surfaceRaised },
  danger: { backgroundColor: colors.dangerSoft },
  ghost: { backgroundColor: 'transparent' },
  disabled: { opacity: 0.45 },
  inner: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  label: { ...type.bodyStrong, fontSize: 15 },
});
