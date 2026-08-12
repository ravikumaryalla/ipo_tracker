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
  // Routes rendering through Screen have no native header (those that do get
  // status-bar clearance for free), so this is unconditional, not tied to `inset`.
  const topPad = insets.top + spacing.lg;

  const backdrop = (
    <LinearGradient
      colors={gradients.ground}
      locations={[0, 0.55, 1]}
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
    />
  );

  // Scrolled content would otherwise slide underneath the status bar (the app
  // runs edge-to-edge, so the OS draws the clock/network/battery icons
  // directly over whatever is there) — this opaque strip sits above the
  // scroll content so later cards can never reach that row, not just the
  // first one that `topPad` clears.
  const statusBarShield = insets.top > 0 && (
    <View
      style={[styles.statusBarShield, { height: insets.top }]}
      pointerEvents="none"
    />
  );

  if (!scroll) {
    return (
      <View style={styles.root}>
        {backdrop}
        <View style={[styles.flat, { paddingTop: topPad, paddingBottom: bottomPad }, style]}>
          {children}
        </View>
        {statusBarShield}
      </View>
    );
  }

  return (
    <View style={styles.root}>
      {backdrop}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.content,
          { paddingTop: topPad, paddingBottom: bottomPad },
          style,
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {children}
      </ScrollView>
      {statusBarShield}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  scroll: { flex: 1 },
  content: { padding: spacing.lg },
  flat: { flex: 1, padding: spacing.lg },
  statusBarShield: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: gradients.ground[0],
  },
});
