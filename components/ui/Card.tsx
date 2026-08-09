/**
 * Card surfaces.
 *
 * Three variants, each a different height above the ground:
 *   glass  — translucent, lets the gradient through. The default.
 *   raised — opaque and elevated, for things that should feel actionable.
 *   flat   — no shadow, for cards nested inside another card.
 *
 * Every card carries a one-pixel sheen along its top edge. That highlight is
 * what sells "lit from above" and is the cheapest depth cue available — it
 * costs one gradient view and no blur.
 */
import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';

import { colors, elevation, gradients, radius, spacing } from '../../constants/theme';

export function Card({
  children,
  style,
  variant = 'glass',
  padded = true,
}: {
  children: React.ReactNode;
  style?: ViewStyle;
  variant?: 'glass' | 'raised' | 'flat';
  padded?: boolean;
}) {
  return (
    <View
      style={[
        styles.card,
        variant === 'glass' && styles.glass,
        variant === 'raised' && styles.raised,
        variant === 'flat' && styles.flat,
        padded && { padding: spacing.lg },
        style,
      ]}
    >
      <LinearGradient
        colors={gradients.cardSheen}
        style={styles.sheen}
        pointerEvents="none"
      />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.xl,
    borderWidth: 1,
    marginBottom: spacing.md,
    overflow: 'hidden',
  },
  glass: {
    backgroundColor: colors.surfaceGlass,
    borderColor: colors.borderSoft,
    ...elevation.low,
  },
  raised: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    ...elevation.medium,
  },
  flat: {
    backgroundColor: colors.surface,
    borderColor: colors.borderSoft,
  },
  /**
   * Only the top ~40% catches the light. Taller than this and it stops reading
   * as a highlight and starts reading as a second background colour.
   */
  sheen: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: '40%',
  },
});
