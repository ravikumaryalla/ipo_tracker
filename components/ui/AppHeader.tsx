/**
 * Screen header for the tab routes.
 *
 * The tab screens run with `headerShown: false`, so they have no native header
 * to restyle — and they are the only screens that need actions the native
 * header cannot express declaratively: a bell carrying an unread dot, and a
 * bare `+`. Stack routes keep their native headers, which are restyled in
 * app/_layout.tsx and give back-gesture behaviour for free.
 *
 * Pass this to `Screen`'s `header` prop rather than rendering it inside the
 * scroll content, or it scrolls away.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, spacing, type } from '../../constants/theme';
import { Icon, type IconName } from './Icon';

export function HeaderAction({
  icon,
  label,
  onPress,
  color = colors.text,
  /** Draws the unread dot in the corner of the glyph. */
  badged = false,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  color?: string;
  badged?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={6}
      style={styles.action}
    >
      <Icon name={icon} size={22} color={color} />
      {badged ? <View style={styles.dot} /> : null}
    </Pressable>
  );
}

export function AppHeader({
  title,
  right,
}: {
  title: string;
  /** One or more `HeaderAction`s. */
  right?: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.bar, { paddingTop: insets.top, height: 56 + insets.top }]}>
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>
      {right ? <View style={styles.actions}>{right}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  title: { ...type.title, color: colors.text, flex: 1, minWidth: 0 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  action: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: {
    position: 'absolute',
    top: 9,
    right: 9,
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: colors.danger,
    borderWidth: 1.5,
    borderColor: colors.surface,
  },
});
