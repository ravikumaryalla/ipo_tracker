/**
 * Brand lockup for the screens shown before the app proper: sign-in, sign-up,
 * vault setup and unlock.
 *
 * These screens are mostly empty space and a form, which is exactly where an
 * app feels cheapest. A gradient glyph plus a halo gives them a focal point
 * without inventing chrome that the rest of the app does not have.
 */
import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors, gradients, radius, spacing, type } from '../../constants/theme';
import { Icon, type IconName } from './Icon';

export function BrandMark({
  icon = 'ipos',
  title,
  subtitle,
  tone = 'accent',
}: {
  icon?: IconName;
  title: string;
  subtitle?: string;
  tone?: 'accent' | 'success' | 'warning';
}) {
  const stops =
    tone === 'success'
      ? gradients.positive
      : tone === 'warning'
        ? ([colors.warning, '#E09B1F'] as const)
        : gradients.primary;

  return (
    <View style={styles.wrap}>
      <View style={styles.markWrap}>
        <LinearGradient colors={gradients.halo} style={styles.halo} pointerEvents="none" />
        <LinearGradient
          colors={stops}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.mark}
        >
          <Icon name={icon} size={26} color="#FFFFFF" />
        </LinearGradient>
      </View>

      <Text style={styles.eyebrow}>IPO TRACKER</Text>
      <Text style={styles.title}>{title}</Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', marginBottom: spacing.xxl },
  markWrap: { alignItems: 'center', justifyContent: 'center', marginBottom: spacing.xl },
  halo: {
    position: 'absolute',
    width: 180,
    height: 180,
    borderRadius: 90,
    opacity: 0.7,
  },
  mark: {
    width: 64,
    height: 64,
    borderRadius: radius.xl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  eyebrow: { ...type.label, color: colors.accentBright, marginBottom: spacing.sm },
  title: { ...type.display, color: colors.text, textAlign: 'center' },
  subtitle: {
    ...type.body,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
});
