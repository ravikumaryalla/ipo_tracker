/**
 * Screen chrome: the ground every screen sits on, plus an optional fixed header.
 *
 * The ground is flat grey; cards lift off it with a shadow rather than with a
 * contrasting fill. `header` renders outside the ScrollView so a screen-level
 * header stays put while the content moves under it.
 */
import React from 'react';
import { ScrollView, StyleSheet, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, spacing } from '../../constants/theme';

export function Screen({
  children,
  scroll = true,
  style,
  /** Adds bottom padding clearing the docked tab bar. */
  inset = false,
  /** Fixed header, rendered above the scroll area rather than inside it. */
  header,
}: {
  children: React.ReactNode;
  scroll?: boolean;
  style?: ViewStyle;
  inset?: boolean;
  header?: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const bottomPad = spacing.xxl + (inset ? 64 + insets.bottom : 0);
  // A screen-level header already clears the status bar and owns its own top
  // padding, so the content below it starts at zero. Routes rendering through
  // Screen otherwise have no native header (those that do get status-bar
  // clearance for free), so this is unconditional, not tied to `inset`.
  const topPad = header ? 0 : insets.top + spacing.lg;

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
        {header}
        <View style={[styles.flat, { paddingTop: topPad, paddingBottom: bottomPad }, style]}>
          {children}
        </View>
        {header ? null : statusBarShield}
      </View>
    );
  }

  return (
    <View style={styles.root}>
      {header}
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
      {header ? null : statusBarShield}
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
    backgroundColor: colors.bg,
  },
});
