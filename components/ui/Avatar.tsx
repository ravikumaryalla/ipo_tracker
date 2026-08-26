/**
 * Initials avatar.
 *
 * Used wherever a list row needs to be scannable by shape before it is read —
 * the IPO list and the demat accounts list. Colour is derived from the label
 * rather than stored, so the same company or broker keeps the same colour
 * across screens and across sessions without a migration.
 */
import React from 'react';
import { StyleSheet, Text, View, type ViewStyle } from 'react-native';

import { colors, fonts } from '../../constants/theme';

/**
 * Picked from the design system's 600-weight ramps: all carry white text at
 * 4.5:1 or better, so `initials` stays legible on every one.
 */
const PALETTE = [
  '#1e88e5',
  '#8e24aa',
  '#43a047',
  '#fb8c00',
  '#e53935',
  '#1565c0',
  '#00897b',
  '#5e35b1',
] as const;

/** Stable across runs — a plain sum, not the JS string hash, which is not. */
function paletteFor(seed: string): string {
  let total = 0;
  for (let i = 0; i < seed.length; i += 1) total += seed.charCodeAt(i);
  return PALETTE[total % PALETTE.length];
}

/** "Vantage Logistics Ltd" → "VL"; "Zerodha" → "ZE". */
export function initialsFrom(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export function Avatar({
  initials,
  name,
  size = 40,
  color,
  style,
}: {
  /** Explicit initials. Omit to derive them from `name`. */
  initials?: string;
  /** Also seeds the colour when `color` is not given. */
  name?: string;
  size?: number;
  color?: string;
  style?: ViewStyle;
}) {
  const text = initials ?? (name ? initialsFrom(name) : '?');
  const background = color ?? paletteFor(name ?? text);

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.avatar,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: background },
        style,
      ]}
    >
      <Text style={[styles.text, { fontSize: size * 0.38 }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: { alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  text: { fontFamily: fonts.bodySemi, color: colors.onAccent },
});
