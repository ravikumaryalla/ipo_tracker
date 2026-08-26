/**
 * Brand lockup for the screens shown before the app proper: sign-in, sign-up,
 * vault setup and unlock.
 *
 * These screens are mostly empty space and a form, which is exactly where an
 * app feels cheapest. A solid glyph on a pale ring of its own hue gives them a
 * focal point without inventing chrome that the rest of the app does not have —
 * the flat palette's substitute for the gradient-and-halo this used to be.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors, radius, spacing, type } from '../../constants/theme';
import { Icon, type IconName } from './Icon';

const TONES = {
  accent: { fill: colors.accent, ring: colors.accentSoft },
  success: { fill: colors.success, ring: colors.successSoft },
  warning: { fill: colors.warning, ring: colors.warningSoft },
} as const;

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
  const { fill, ring } = TONES[tone];

  return (
    <View style={styles.wrap}>
      <View style={styles.markWrap}>
        <View style={[styles.ring, { backgroundColor: ring }]} pointerEvents="none" />
        <View style={[styles.mark, { backgroundColor: fill }]}>
          <Icon name={icon} size={26} color={colors.onAccent} />
        </View>
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
  ring: {
    position: 'absolute',
    width: 108,
    height: 108,
    borderRadius: 54,
  },
  mark: {
    width: 64,
    height: 64,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  eyebrow: { ...type.label, color: colors.accent, marginBottom: spacing.sm },
  title: { ...type.display, color: colors.text, textAlign: 'center' },
  subtitle: {
    ...type.body,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
});
