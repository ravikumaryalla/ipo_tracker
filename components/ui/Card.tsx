/**
 * Card surfaces.
 *
 * A card is white on the grey ground; separation comes from a shadow, not from
 * a fill colour, so the four elevations differ only in how far they lift. The
 * design system's own scale is 0–3 and `elevation` is the prop that expresses
 * it.
 *
 * `variant` is the older API and is kept because ~15 screens pass it. It maps
 * onto the same scale: glass → 1, raised → 2, flat → 0. New code should pass
 * `elevation` directly; the names describe a translucency that the light
 * palette no longer has.
 */
import React from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';

import { colors, elevation as shadows, radius, spacing } from '../../constants/theme';

const VARIANT_ELEVATION = { glass: 1, raised: 2, flat: 0 } as const;

export function Card({
  children,
  style,
  variant = 'glass',
  elevation,
  padded = true,
}: {
  children: React.ReactNode;
  style?: ViewStyle;
  variant?: 'glass' | 'raised' | 'flat';
  /** Takes precedence over `variant` when both are given. */
  elevation?: 0 | 1 | 2 | 3;
  padded?: boolean;
}) {
  const level = elevation ?? VARIANT_ELEVATION[variant];

  return (
    <View
      style={[
        styles.card,
        shadows[level],
        // At rest a card is defined by its shadow. Level 0 has none, so it
        // needs the hairline to separate it from the surface behind it.
        level === 0 && styles.hairline,
        padded && { padding: spacing.lg },
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    marginBottom: spacing.md,
  },
  hairline: {
    borderWidth: 1,
    borderColor: colors.border,
  },
});
