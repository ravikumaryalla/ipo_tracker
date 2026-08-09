/**
 * Icon wrapper over expo-symbols.
 *
 * expo-symbols is SF Symbols on iOS and Material Symbols everywhere else, and
 * the two name sets do not overlap. Critically, on Android the component only
 * renders when `name` is an *object* carrying an `android` key — pass a bare SF
 * Symbol string and you silently get nothing. Centralising the mapping here
 * means call sites say `<Icon name="dashboard" />` and cannot get that wrong.
 *
 * Add new icons to ICONS below rather than passing raw names through.
 */
import { SymbolView } from 'expo-symbols';
import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { colors } from '../../constants/theme';

/**
 * Left side is our name, right side is the Material Symbols name (Android/web)
 * paired with its SF Symbol counterpart for iOS.
 */
const ICONS = {
  dashboard: { android: 'dashboard', ios: 'chart.bar.fill' },
  accounts: { android: 'account_balance', ios: 'building.columns.fill' },
  ipos: { android: 'trending_up', ios: 'chart.line.uptrend.xyaxis' },
  applications: { android: 'receipt_long', ios: 'doc.text.fill' },
  settings: { android: 'settings', ios: 'gearshape.fill' },
  lock: { android: 'lock', ios: 'lock.fill' },
  unlock: { android: 'lock_open', ios: 'lock.open.fill' },
  fingerprint: { android: 'fingerprint', ios: 'faceid' },
  reveal: { android: 'visibility', ios: 'eye.fill' },
  hide: { android: 'visibility_off', ios: 'eye.slash.fill' },
  copy: { android: 'content_copy', ios: 'doc.on.doc.fill' },
  add: { android: 'add', ios: 'plus' },
  chevron: { android: 'chevron_right', ios: 'chevron.right' },
  back: { android: 'arrow_back', ios: 'chevron.left' },
  wallet: { android: 'wallet', ios: 'wallet.pass.fill' },
  savings: { android: 'savings', ios: 'indianrupeesign.circle.fill' },
  pie: { android: 'pie_chart', ios: 'chart.pie.fill' },
  check: { android: 'check_circle', ios: 'checkmark.circle.fill' },
  warning: { android: 'warning', ios: 'exclamationmark.triangle.fill' },
  info: { android: 'info', ios: 'info.circle.fill' },
  calendar: { android: 'calendar_month', ios: 'calendar' },
  empty: { android: 'inbox', ios: 'tray' },
  shield: { android: 'shield', ios: 'checkmark.shield.fill' },
  key: { android: 'key', ios: 'key.fill' },
  logout: { android: 'logout', ios: 'rectangle.portrait.and.arrow.right' },
  edit: { android: 'edit', ios: 'pencil' },
  trash: { android: 'delete', ios: 'trash.fill' },
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  size = 22,
  color = colors.textMuted,
  style,
}: {
  name: IconName;
  size?: number;
  color?: string;
  style?: ViewStyle;
}) {
  const symbol = ICONS[name];
  return (
    <SymbolView
      name={{ android: symbol.android, ios: symbol.ios, web: symbol.android }}
      size={size}
      tintColor={color}
      style={style}
      // The font loads asynchronously on Android; without a reserved box the
      // layout jumps once it arrives.
      fallback={<View style={[{ width: size, height: size }, style]} />}
    />
  );
}
