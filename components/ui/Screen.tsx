/**
 * Screen chrome: the gradient ground every screen sits on.
 *
 * The gradient is deliberately low-contrast. Its job is to stop the background
 * reading as one flat block so the surfaces above it have something to lift
 * away from — not to be noticed in its own right.
 */
import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { ScrollView, StyleSheet, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, gradients, spacing } from '../../constants/theme';

export function Screen({
  children,
  scroll = true,
  style,
  /** Adds bottom padding clearing the floating tab bar. */
  inset = false,
}: {
  children: React.ReactNode;
  scroll?: boolean;
  style?: ViewStyle;
  inset?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const bottomPad = spacing.xxl + (inset ? 72 + insets.bottom : 0);

  const backdrop = (
    <LinearGradient
      colors={gradients.ground}
      locations={[0, 0.55, 1]}
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
    />
  );

  if (!scroll) {
    return (
      <View style={styles.root}>
        {backdrop}
        <View style={[styles.flat, { paddingBottom: bottomPad }, style]}>{children}</View>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      {backdrop}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingBottom: bottomPad }, style]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {children}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  scroll: { flex: 1 },
  content: { padding: spacing.lg },
  flat: { flex: 1, padding: spacing.lg },
});
